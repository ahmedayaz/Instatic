/**
 * Agent server endpoints.
 *
 * Two HTTP entry points:
 *
 *   POST /api/agent
 *     Browser opens a streaming NDJSON request with { prompt, sessionId,
 *     pageContext }. The server runs the Claude Agent SDK with our page-builder
 *     MCP. Tool calls reach Claude as real MCP tools — both the read tools
 *     (handled server-side from the page snapshot) and write tools (bridged
 *     to the browser via toolRequest events).
 *
 *   POST /api/agent/tool-result
 *     Browser POSTs { bridgeId, requestId, result } to deliver the outcome of
 *     a write tool it just executed against the editor store. The server uses
 *     the bridgeId to find the in-flight MCP tool handler and resolve its
 *     pending promise so Claude sees the tool_result and continues.
 *
 * Auth: ambient Claude Code credentials (claude auth login) — Constraint #385.
 * No API key, no endpoint URL, no environment variable required.
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { nanoid } from 'nanoid'
import { Type, safeParseValue, formatValueErrors } from '@core/utils/typeboxHelpers'
import { buildSystemPrompt } from '../../src/core/agent/systemPrompt'
import { createPageBuilderMcpServer, type PageBuilderBridge } from '../agentTools'
import { jsonResponse } from '../http'
import type {
  AgentActionResult,
  AgentRequestBody,
  ServerStreamEvent,
} from '../../src/core/agent/types'

// ---------------------------------------------------------------------------
// Bridge registry — maps bridgeId → in-flight tool resolvers
// ---------------------------------------------------------------------------
//
// When the SDK calls a write MCP tool, the tool handler stores `{ resolve,
// reject }` keyed by a freshly-minted requestId. The browser receives the
// matching `toolRequest` stream event, applies the mutation locally, and POSTs
// to /api/agent/tool-result with `{ bridgeId, requestId, result }`. That POST
// looks up the entry here and resolves the resolver — the MCP tool handler
// returns the result to the SDK, the SDK sends tool_result back to Claude.

interface PendingToolResolver {
  resolve(result: AgentActionResult): void
  reject(err: Error): void
}

interface BridgeContext {
  pending: Map<string, PendingToolResolver>
}

// Module-level registry shared between the streaming handler and the
// /api/agent/tool-result endpoint. A bridge lives only for the duration of
// one stream — destroyBridge() is called from the stream's finally block.
const activeBridges = new Map<string, BridgeContext>()

function createBridgeContext(): { bridgeId: string; bridge: BridgeContext } {
  const bridgeId = nanoid()
  const bridge: BridgeContext = { pending: new Map() }
  activeBridges.set(bridgeId, bridge)
  return { bridgeId, bridge }
}

function destroyBridge(bridgeId: string): void {
  const bridge = activeBridges.get(bridgeId)
  if (!bridge) return
  if (bridge.pending.size > 0) {
    // Pending entries at stream-end mean the browser never POSTed a tool-result
    // for an in-flight tool call — usually a routing or transport bug. Surface
    // it so diagnosing a frozen agent loop doesn't require source diving.
    console.warn(
      `[agentHandler] Bridge ${bridgeId} closed with ${bridge.pending.size} pending tool result(s).`,
    )
  }
  for (const pending of bridge.pending.values()) {
    pending.reject(new Error('Agent stream ended before tool result arrived.'))
  }
  bridge.pending.clear()
  activeBridges.delete(bridgeId)
}

function resolvePendingToolResult(
  bridgeId: string,
  requestId: string,
  result: AgentActionResult,
): boolean {
  const bridge = activeBridges.get(bridgeId)
  if (!bridge) return false
  const pending = bridge.pending.get(requestId)
  if (!pending) return false
  bridge.pending.delete(requestId)
  pending.resolve(result)
  return true
}

// ---------------------------------------------------------------------------
// Request body schemas
// ---------------------------------------------------------------------------

const AgentRequestBodySchema = Type.Object({
  prompt: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String()),
  // pageContext stays loose at this boundary — its full schema lives in
  // src/core/agent/types and the rest of the request flow is typed against it.
  pageContext: Type.Unknown(),
})

// Render snapshot wire shape — set only when the bridged tool was
// `render_snapshot`. Other tools omit the field entirely.
const AgentToolResultSnapshotSchema = Type.Object({
  breakpointId: Type.String(),
  label: Type.String(),
  width: Type.Number(),
  capturedAt: Type.Number(),
  screenshot: Type.Object({
    status: Type.Union([
      Type.Literal('ok'),
      Type.Literal('unavailable'),
      Type.Literal('error'),
    ]),
    mimeType: Type.Optional(Type.String()),
    data: Type.Optional(Type.String()),
    width: Type.Optional(Type.Number()),
    height: Type.Optional(Type.Number()),
    error: Type.Optional(Type.String()),
  }),
  layout: Type.Object({
    breakpointId: Type.String(),
    viewport: Type.Object({
      width: Type.Number(),
      height: Type.Number(),
      scrollWidth: Type.Number(),
      scrollHeight: Type.Number(),
    }),
    nodes: Type.Array(Type.Unknown()),
    images: Type.Array(Type.Unknown()),
    warnings: Type.Array(Type.Unknown()),
  }),
})

const AgentToolResultBodySchema = Type.Object({
  bridgeId: Type.String({ minLength: 1 }),
  requestId: Type.String({ minLength: 1 }),
  result: Type.Object({
    success: Type.Boolean(),
    nodeId: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    snapshot: Type.Optional(AgentToolResultSnapshotSchema),
  }),
})

// ---------------------------------------------------------------------------
// NDJSON encoding
// ---------------------------------------------------------------------------

function encodeEvent(event: ServerStreamEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event) + '\n')
}

// ---------------------------------------------------------------------------
// SDK message → ServerStreamEvent translation
// ---------------------------------------------------------------------------

interface StreamingToolState {
  id: string
  name: string
  inputJson: string
}

interface AgentSdkStreamState {
  sessionId: string | null
  sawPartialAssistantMessage: boolean
  toolsByIndex: Map<number, StreamingToolState>
  toolNamesById: Map<string, string>
}

export function createAgentSdkStreamState(): AgentSdkStreamState {
  return {
    sessionId: null,
    sawPartialAssistantMessage: false,
    toolsByIndex: new Map(),
    toolNamesById: new Map(),
  }
}

export function getServerStreamEventsFromSdkMessage(
  message: unknown,
  state: AgentSdkStreamState,
): ServerStreamEvent[] {
  const sdkMessage = message as { type?: string }
  const events = getSessionEventsFromSdkMessage(message, state)

  if (sdkMessage.type === 'stream_event') {
    state.sawPartialAssistantMessage = true
    events.push(...getServerStreamEventsFromPartialMessage(message, state))
    return events
  }

  if (sdkMessage.type === 'assistant') {
    if (!state.sawPartialAssistantMessage) {
      events.push(...getServerStreamEventsFromCompleteAssistantMessage(message, state))
    }
    return events
  }

  if (sdkMessage.type === 'user') {
    events.push(...getServerStreamEventsFromUserMessage(message, state))
    return events
  }

  return events
}

function getSessionEventsFromSdkMessage(
  message: unknown,
  state: AgentSdkStreamState,
): ServerStreamEvent[] {
  const sessionId = getSdkSessionId(message)
  if (!sessionId || sessionId === state.sessionId) return []
  state.sessionId = sessionId
  return [{ type: 'session', sessionId }]
}

function getSdkSessionId(message: unknown): string | null {
  const sessionId = (message as { session_id?: unknown }).session_id
  return typeof sessionId === 'string' && sessionId.trim()
    ? sessionId.trim()
    : null
}

function getServerStreamEventsFromPartialMessage(
  message: unknown,
  state: AgentSdkStreamState,
): ServerStreamEvent[] {
  const event = (message as { event?: Record<string, unknown> }).event
  if (!event) return []

  if (event.type === 'content_block_delta') {
    const delta = event.delta as Record<string, unknown> | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return [{ type: 'text', text: delta.text }]
    }
    if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const tool = state.toolsByIndex.get(Number(event.index))
      if (tool) tool.inputJson += delta.partial_json
    }
    return []
  }

  if (event.type === 'content_block_start') {
    const block = event.content_block as Record<string, unknown> | undefined
    if (block?.type !== 'tool_use') return []

    const index = Number(event.index)
    const id = typeof block.id === 'string' ? block.id : `tool-${index}`
    const name = typeof block.name === 'string' ? block.name : 'tool'
    const input = block.input
    state.toolsByIndex.set(index, {
      id,
      name,
      inputJson: typeof input === 'string' ? input : '',
    })
    state.toolNamesById.set(id, name)
    return [{
      type: 'toolStatus',
      toolCallId: id,
      name,
      status: 'pending',
      input: input ?? {},
    }]
  }

  if (event.type === 'content_block_stop') {
    const index = Number(event.index)
    const tool = state.toolsByIndex.get(index)
    if (!tool) return []
    state.toolsByIndex.delete(index)
    const input = parseMaybeJson(tool.inputJson)
    return [{
      type: 'toolStatus',
      toolCallId: tool.id,
      name: tool.name,
      status: 'pending',
      input: input ?? {},
    }]
  }

  return []
}

function getServerStreamEventsFromCompleteAssistantMessage(
  message: unknown,
  state: AgentSdkStreamState,
): ServerStreamEvent[] {
  const events: ServerStreamEvent[] = []
  const blocks = getMessageContentBlocks(message)
  let text = ''

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text
      continue
    }

    if (block.type === 'tool_use') {
      const id = typeof block.id === 'string' ? block.id : `tool-${state.toolNamesById.size + 1}`
      const name = typeof block.name === 'string' ? block.name : 'tool'
      state.toolNamesById.set(id, name)
      events.push({
        type: 'toolStatus',
        toolCallId: id,
        name,
        status: 'pending',
        input: block.input ?? {},
      })
    }
  }

  if (text) events.unshift({ type: 'text', text })
  return events
}

function getServerStreamEventsFromUserMessage(
  message: unknown,
  state: AgentSdkStreamState,
): ServerStreamEvent[] {
  return getMessageContentBlocks(message)
    .filter((block) => block.type === 'tool_result' && typeof block.tool_use_id === 'string')
    .map((block): ServerStreamEvent => {
      const toolCallId = String(block.tool_use_id)
      return {
        type: 'toolStatus',
        toolCallId,
        name: state.toolNamesById.get(toolCallId) ?? 'tool',
        status: block.is_error ? 'error' : 'success',
        error: block.is_error ? extractToolErrorMessage(block) : undefined,
      }
    })
}

function extractToolErrorMessage(block: Record<string, unknown>): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => (typeof item.text === 'string' ? item.text : ''))
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }
  return 'Tool call failed.'
}

function getMessageContentBlocks(message: unknown): Array<Record<string, unknown>> {
  const content = (message as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content)
    ? content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object')
    : []
}

// Returns unknown by design — caller's responsibility to narrow. Used for
// best-effort parsing of streaming text chunks where the input may or may
// not be JSON. Safe boundary.
function parseMaybeJson(value: string): unknown {
  if (!value.trim()) return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

// ---------------------------------------------------------------------------
// SDK query options
// ---------------------------------------------------------------------------

// Toolset policy for the in-app AI panel.
//
// The panel's job is editing live sites. Filesystem mutations and shell
// access have no real use case here and would be a serious managed-mode risk
// (the same handler runs both self-hosted and managed). We block the whole
// filesystem/shell family. Claude keeps:
//   - the `page_builder` MCP (page mutations + read-only discovery)
//   - Skill (advisory guidance — pure-prompt skills like react-best-practices
//     still work; skills that depend on Read/Write/Bash become no-ops)
//   - WebFetch, WebSearch (looking up docs)
//   - Task, TodoWrite, AskUserQuestion (lifecycle / coordination)
//
// Real code authoring (custom modules, plugin scaffolding, running tests)
// belongs in a regular Claude Code terminal session, not this panel.
const PAGE_BUILDER_DISALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
]

type PageBuilderMcpServer = ReturnType<typeof createPageBuilderMcpServer>

export function buildAgentQueryOptions({
  systemPrompt,
  pageBuilderMcpServer,
  sessionId,
}: {
  // Array form so the static prefix can be cached. buildSystemPrompt() returns
  // [staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicSuffix] — the SDK
  // applies cache_control to everything before the boundary marker.
  systemPrompt: string[]
  pageBuilderMcpServer: PageBuilderMcpServer
  sessionId?: string
}): Options {
  const options: Options = {
    systemPrompt,
    cwd: process.cwd(),
    mcpServers: {
      page_builder: pageBuilderMcpServer,
    },
    includePartialMessages: true,
    // Skills are disabled in the in-app panel. Claude Code's skills (init,
    // review, brainstorming, simplify, etc.) are dev-workflow tools that
    // either don't apply here (no filesystem access) or actively hurt UX —
    // brainstorming, in particular, derails any vague prompt into a Q&A
    // ceremony when the user wanted Claude to just build.
    skills: [],
    // Block filesystem/shell tools at the deny-rule level. Deny rules are
    // evaluated before the permission mode and hold even in bypass modes.
    disallowedTools: PAGE_BUILDER_DISALLOWED_TOOLS,
    // canUseTool is the canonical pattern for in-app agents that have no CLI
    // to prompt the user for tool approvals. Anything that survives the
    // deny-rule check above is auto-approved here. The user reviews and
    // undoes AI changes via the editor's history (Cmd+Z).
    canUseTool: async (_toolName, input) => ({
      behavior: 'allow',
      updatedInput: input,
    }),
  }

  if (sessionId) options.resume = sessionId

  return options
}

function normalizeResumeSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

// ---------------------------------------------------------------------------
// handleAgentRequest — POST /api/agent
// ---------------------------------------------------------------------------

export async function handleAgentRequest(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return new Response('Invalid JSON body', { status: 400 })
  }

  const parsed = safeParseValue(AgentRequestBodySchema, rawBody)
  if (!parsed.ok) {
    return new Response(
      `Invalid request body: ${formatValueErrors(AgentRequestBodySchema, rawBody)}`,
      { status: 400 },
    )
  }
  const body: AgentRequestBody = parsed.value as AgentRequestBody
  const { prompt, pageContext } = body

  const systemPrompt = buildSystemPrompt(pageContext)
  const resumeSessionId = normalizeResumeSessionId(body.sessionId)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let bridgeId: string | null = null
      let streamClosed = false

      const closeStream = () => {
        if (streamClosed) return
        streamClosed = true
        try { controller.close() } catch { /* already closed */ }
      }

      const enqueueEvent = (event: ServerStreamEvent): void => {
        if (streamClosed) return
        try {
          controller.enqueue(encodeEvent(event))
        } catch {
          streamClosed = true
        }
      }

      try {
        const { bridgeId: id, bridge } = createBridgeContext()
        bridgeId = id

        const browserBridge: PageBuilderBridge = {
          enqueueEvent,
          callBrowser(name, input) {
            const requestId = nanoid()
            return new Promise<AgentActionResult>((resolve, reject) => {
              bridge.pending.set(requestId, { resolve, reject })
              enqueueEvent({ type: 'toolRequest', requestId, name, input })
            })
          },
        }

        // Tell the browser how to address tool-result responses.
        enqueueEvent({ type: 'bridgeReady', bridgeId })

        const pageBuilderMcpServer = createPageBuilderMcpServer(pageContext, browserBridge)
        const streamState = createAgentSdkStreamState()

        for await (const message of query({
          prompt,
          options: buildAgentQueryOptions({
            systemPrompt,
            pageBuilderMcpServer,
            sessionId: resumeSessionId,
          }),
        })) {
          for (const event of getServerStreamEventsFromSdkMessage(message, streamState)) {
            enqueueEvent(event)
          }

          if (message.type === 'assistant') {
            // Constraint #388: log auth/billing failures server-side, never
            // forward raw SDK error details to the browser.
            const sdkMsg = message as {
              type: 'assistant'
              message?: unknown
              error?: unknown
            }
            if (!sdkMsg.message) {
              console.error('[agentHandler] SDK assistant message unavailable (auth/billing error):', sdkMsg.error)
              enqueueEvent({
                type: 'error',
                message: 'Agent authentication or billing error. Check your Claude credentials.',
              })
              return
            }
          } else if (message.type === 'result') {
            const resultMsg = message as {
              type: 'result'
              is_error?: boolean
              subtype?: string
              errors?: string[]
            }
            if (resultMsg.is_error) {
              console.error('[agentHandler] SDK result error:', resultMsg.subtype, resultMsg.errors)
              enqueueEvent({
                type: 'error',
                message: 'Agent session ended with an error. Please try again.',
              })
              return
            }
          }
        }

        enqueueEvent({ type: 'done' })
      } catch (err) {
        const detail = err instanceof Error ? err.message : 'Unknown error'
        console.error('[agentHandler] query failed:', detail)
        enqueueEvent({
          type: 'error',
          message: 'Agent session failed. Please try again.',
        })
      } finally {
        if (bridgeId) destroyBridge(bridgeId)
        closeStream()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  })
}

// ---------------------------------------------------------------------------
// handleAgentToolResult — POST /api/agent/tool-result
// ---------------------------------------------------------------------------

export async function handleAgentToolResult(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = safeParseValue(AgentToolResultBodySchema, rawBody)
  if (!parsed.ok) {
    return jsonResponse(
      { error: `Invalid request body: ${formatValueErrors(AgentToolResultBodySchema, rawBody)}` },
      { status: 400 },
    )
  }

  const { bridgeId, requestId, result } = parsed.value as {
    bridgeId: string
    requestId: string
    result: AgentActionResult
  }
  const ok = resolvePendingToolResult(bridgeId, requestId, result)
  if (!ok) {
    // Stream may have closed before this POST landed (user aborted, agent
    // loop ended, server dropped the connection, or the request hit the
    // server-side timeout). Log enough detail to tell which.
    const bridge = activeBridges.get(bridgeId)
    if (!bridge) {
      console.warn(
        `[agentHandler] tool-result POST for unknown/expired bridge ${bridgeId} (requestId=${requestId}); ` +
        `the streaming response likely closed before the browser POSTed.`,
      )
    } else {
      console.warn(
        `[agentHandler] tool-result POST for unknown requestId ${requestId} on bridge ${bridgeId}; ` +
        `tool may have already timed out server-side.`,
      )
    }
    return jsonResponse({ ok: false }, { status: 404 })
  }
  return jsonResponse({ ok: true })
}

