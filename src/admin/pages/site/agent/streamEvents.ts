/**
 * Server → browser stream protocol.
 *
 * Owns the NDJSON envelope schema (`ServerStreamEventSchema`) used to validate
 * each line the server emits, and the `processStreamEvent` reducer that folds
 * one validated event into the agent slice's message state.
 *
 * Wire protocol (server → browser, NDJSON, one ServerStreamEvent per line):
 *   bridgeReady   first event; carries bridgeId for tool-result POSTs
 *   text          chunk of assistant text
 *   toolCall      driver issued a tool call (status: pending)
 *   toolResult    a previously-issued tool call completed (ok/error)
 *   toolRequest   server asks the browser to apply a write tool
 *   session       Claude Agent SDK session id (for follow-up resume)
 *   usage         per-turn token + cost totals
 *   error         server-side terminal error
 *   done          stream finished cleanly
 *
 * When a `toolRequest` arrives, the browser dispatches it through the
 * executor (which validates inputs and mutates the Zustand store), then POSTs
 * the result via `postToolResult` so the server-side MCP tool handler can
 * return the result to Claude. There is no separate <pb:actions> DSL — every
 * page mutation is a real MCP tool call.
 */

import { nanoid } from 'nanoid'
import { aiToolError, type AiToolOutput } from '@core/ai'
import { Type } from '@core/utils/typeboxHelpers'
import type { EditorStoreSliceCreator } from '@site/store/types'
import { postToolResult } from './agentApi'
import type { AgentSlice } from './agentSlice'
import type {
  AgentBridgeRuntime,
  AgentTextStreamSink,
  AgentToolCall,
  ServerStreamEvent,
} from './types'

// ---------------------------------------------------------------------------
// Stream-event schema
//
// Discriminated union mirrors ServerStreamEvent from ./types. Tool-input
// payloads pass through as Unknown — the executor validates each call's input
// at the dispatch boundary. The schema here catches malformed envelopes from
// the server, which is the failure mode the streaming reader needs to defend
// against.
// ---------------------------------------------------------------------------

export const ServerStreamEventSchema = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Type.String() }),
  Type.Object({
    type: Type.Literal('bridgeReady'),
    bridgeId: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('toolRequest'),
    requestId: Type.String(),
    toolName: Type.String(),
    input: Type.Unknown(),
  }),
  Type.Object({
    type: Type.Literal('toolCall'),
    toolCallId: Type.String(),
    toolName: Type.String(),
    input: Type.Unknown(),
    status: Type.Literal('pending'),
  }),
  Type.Object({
    type: Type.Literal('toolResult'),
    toolCallId: Type.String(),
    toolName: Type.String(),
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
  }),
  Type.Object({ type: Type.Literal('session'), sessionId: Type.String() }),
  Type.Object({
    type: Type.Literal('usage'),
    promptTokens: Type.Number(),
    completionTokens: Type.Number(),
    costUsd: Type.Optional(Type.Number()),
  }),
  Type.Object({ type: Type.Literal('done') }),
  Type.Object({ type: Type.Literal('error'), message: Type.String() }),
])

// `set` as the slice creator hands it to its actions — the processor only
// touches AgentSlice keys, so a narrow AgentSlice-typed setter is sufficient.
export type EditorStoreSet = Parameters<EditorStoreSliceCreator<AgentSlice>>[0]

// ---------------------------------------------------------------------------
// Stream event processor
// ---------------------------------------------------------------------------

export async function processStreamEvent(
  event: ServerStreamEvent,
  assistantId: string,
  textSink: AgentTextStreamSink,
  set: EditorStoreSet,
  bridge: AgentBridgeRuntime,
  signal: AbortSignal | null,
  dispatchTool: (toolName: string, input: unknown) => Promise<AiToolOutput>,
): Promise<void> {
  switch (event.type) {
    case 'text': {
      textSink.append(assistantId, event.text)
      break
    }

    case 'bridgeReady': {
      bridge.bridgeId = event.bridgeId
      break
    }

    case 'toolRequest': {
      // Defensive: the dispatcher already converts caught throws into
      // `{ ok: false, error }`, but if anything ever escapes (or if
      // the bridge evolves) we still need to ALWAYS POST a result so the
      // server's bridge resolver fires and the driver loop sees a tool
      // error rather than hanging forever.
      let result: AiToolOutput
      try {
        result = await dispatchTool(event.toolName, event.input)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[AgentSlice] tool ${event.toolName} threw unexpectedly:`, err)
        result = aiToolError(`Browser exception: ${message}`)
      }
      if (!bridge.bridgeId) {
        console.error('[AgentSlice] toolRequest received before bridgeReady')
        break
      }
      await postToolResult(bridge.bridgeId, event.requestId, result, signal)
      break
    }

    case 'toolCall': {
      // Driver issued a tool call (status: pending). Drain any pending text
      // deltas BEFORE adding the block so the chronological order
      // text → tool → text is preserved.
      textSink.flush()
      set((state) => {
        const msg = state.agentMessages.find((m) => m.id === assistantId)
        if (!msg) return
        const inputAsRecord = event.input && typeof event.input === 'object'
          ? (event.input as Record<string, unknown>)
          : null
        const existing = msg.blocks.find(
          (block): block is { kind: 'toolCall'; toolCall: AgentToolCall } =>
            block.kind === 'toolCall' && block.toolCall.externalId === event.toolCallId,
        )
        if (existing) {
          // Re-emitted (e.g. Anthropic's content_block_start then _stop):
          // refresh the input but keep the pending status.
          if (inputAsRecord) existing.toolCall.params = inputAsRecord
          return
        }
        msg.blocks.push({
          kind: 'toolCall',
          toolCall: {
            id: nanoid(),
            externalId: event.toolCallId,
            actionType: event.toolName,
            params: inputAsRecord ?? {},
            result: null,
            status: 'pending',
          },
        })
      })
      break
    }

    case 'toolResult': {
      // Paired with the preceding `toolCall` (matched by toolCallId).
      // Flip its status to success/error + attach the result envelope so
      // the UI can render any failure message inline with the badge.
      textSink.flush()
      set((state) => {
        const msg = state.agentMessages.find((m) => m.id === assistantId)
        if (!msg) return
        const block = msg.blocks.find(
          (b): b is { kind: 'toolCall'; toolCall: AgentToolCall } =>
            b.kind === 'toolCall' && b.toolCall.externalId === event.toolCallId,
        )
        if (!block) return
        block.toolCall.status = event.ok ? 'success' : 'error'
        block.toolCall.result = {
          ok: event.ok,
          error: event.ok ? undefined : event.error ?? 'Tool call failed.',
        }
      })
      break
    }

    case 'usage': {
      // Token + cost totals — persisted server-side automatically. Nothing
      // to do in the UI for now (Phase 6 surfaces these in the audit page).
      break
    }

    case 'session': {
      set({
        agentSessionId: event.sessionId,
      })
      break
    }

    case 'error': {
      // Surface the server's error message verbatim — drivers already
      // classify and shape these to be user-facing (auth/billing/quota
      // shows actionable copy, raw stack traces are stripped at the driver
      // boundary). The admin needs the actual reason, not a "Something
      // went wrong" placeholder; this surface is admin-only (capability
      // gated) so info-disclosure concerns don't apply.
      console.error('[AgentSlice] Server error event:', event.message)
      set({ agentError: event.message })
      break
    }

    case 'done':
    default:
      break
  }
}
