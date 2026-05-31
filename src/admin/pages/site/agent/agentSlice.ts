/**
 * Agent store slice — drives the AI Assistant panel.
 *
 * The browser opens a streaming NDJSON request against `/admin/api/ai/chat/
 * ${scope}` (the Vite proxy forwards to the local Bun agent server, which runs
 * the Claude Agent SDK with ambient Claude Code credentials — Constraint #385).
 * The NDJSON wire protocol and its per-event handling live in `streamEvents.ts`;
 * the HTTP plumbing (tool-result POSTs, conversation bootstrap) lives in
 * `agentApi.ts`; the site-specific page snapshot lives in `pageContext.ts`.
 * This module owns only the slice factory: state, actions, and the
 * send/stream-read loop.
 *
 * Guideline #254 (Performance):
 *   Text deltas are batched via rAF buffer before committing to the store
 *   to prevent excessive React re-renders during streaming.
 */

import { nanoid } from 'nanoid'
import type { EditorStoreSliceCreator } from '@site/store/types'
import type { AiToolOutput } from '@core/ai'
import { safeParseJson } from '@core/utils/jsonValidate'
import { ApiError } from '@core/http'
import {
  listConversations,
  getConversation,
  deleteConversation,
  updateConversationProvider,
  type ConversationView,
} from '@admin/ai/api'
import {
  createConversationForScope,
  fetchScopeDefault,
  rehydrateMessages,
} from './agentApi'
import { processStreamEvent, ServerStreamEventSchema } from './streamEvents'
import type {
  AgentBridgeRuntime,
  AgentMessage,
  AgentRequestBody,
  AgentTextStreamSink,
  AgentToolScope,
  ServerStreamEvent,
} from './types'

// ---------------------------------------------------------------------------
// Scope-agnostic config — the site editor and the content workspace each
// supply their own. See `createAgentSlice(config)` below.
// ---------------------------------------------------------------------------

export interface AgentSliceConfig {
  /**
   * Conversation scope. Used in URL paths (`/admin/api/ai/chat/${scope}`,
   * `?scope=${scope}`), conversation-create body, and the per-scope default
   * lookup. Keep it aligned with `server/ai/runtime/types.ts → ToolScope`.
   */
  readonly scope: AgentToolScope
  /**
   * Build the per-request snapshot. The slice has no knowledge of the host
   * store's shape; the config closure pulls from whatever store the host
   * mounted the agent in (site editor reads page tree; content workspace
   * reads active doc + collections).
   */
  buildSnapshot(): unknown
  /**
   * Dispatch a write-tool request. The slice forwards the server's
   * `toolRequest` event to this function and POSTs the result back; the
   * config's implementation talks to the host's bridge (executor.ts for
   * site, contentBridge.ts for content, …).
   */
  dispatchTool(toolName: string, input: unknown): Promise<AiToolOutput>
  /**
   * Optional copy override for the "no AI provider configured" error so
   * each scope can point the user at the right /admin/ai page.
   */
  readonly noProviderMessage?: string
}

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface AgentSlice {
  // ── UI state ───────────────────────────────────────────────────────────────
  isAgentOpen: boolean
  isAgentStreaming: boolean
  agentMessages: AgentMessage[]
  agentError: string | null
  agentSessionId: string | null
  /**
   * Active conversation row id in `ai_conversations`. Created lazily on the
   * first sendAgentMessage call (uses the site default credential/model);
   * persisted across messages in this editor session. Reset by
   * clearAgentMessages or startNewAgentConversation.
   */
  agentConversationId: string | null
  /** Currently-active (credentialId, modelId) — surfaced by the model picker. */
  agentActiveCredentialId: string | null
  agentActiveModelId: string | null
  /** Conversation summaries for the history popover. */
  agentConversations: ConversationView[]

  // ── Actions ────────────────────────────────────────────────────────────────
  openAgent(): void
  closeAgent(): void
  toggleAgent(): void

  /**
   * Send a user message and stream the assistant response.
   * Routes via the Vite proxy `/admin/api/ai/chat/site` → local Bun server →
   * driver resolved from the conversation's credential.
   *
   * Creates the conversation row on first call using the site default. If no
   * default is configured server-side, surfaces a "set up a provider" error.
   */
  sendAgentMessage(content: string): Promise<void>

  /** Abort an in-progress streaming request. */
  abortAgent(): void

  /** Clear all messages, reset error state, and forget the active conversation. */
  clearAgentMessages(): void

  /** Fetch the latest conversation list (site scope) for the history popover. */
  loadAgentConversations(): Promise<void>

  /** Load an existing conversation: hydrate messages and set it as active. */
  loadAgentConversation(id: string): Promise<void>

  /**
   * Start a brand-new conversation thread. Same as clearAgentMessages but
   * surfaces a distinct intent: the user wants to start a new chat (the
   * next sendAgentMessage will create a fresh conversation row).
   */
  startNewAgentConversation(): void

  /**
   * Soft-delete a conversation. Clears the active one if it matches.
   */
  deleteAgentConversation(id: string): Promise<void>

  /**
   * Change which credential + model the current conversation uses. If a
   * conversation row exists, PUTs the change so the next send uses the new
   * provider. If no current conversation, stages the values for the next
   * conversation-create call.
   */
  setAgentProvider(credentialId: string, modelId: string): Promise<void>
}

// Session-id is in-memory only. While the editor stays open, follow-up
// messages reuse the SDK session id (Claude has continuity across the
// thread). On page reload the message thread vanishes too, so starting
// fresh is the right behaviour — we don't want a ghost session from a
// thread the user can no longer see. A future "saved conversations" UI
// will persist threads + their session ids explicitly with a "new chat"
// button to start fresh.

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

declare module '@site/store/types' {
  interface EditorStore extends AgentSlice {}
}

/**
 * Slice factory — site editor + content workspace each call this with their
 * own scope/snapshot/dispatcher config. Returns a Zustand state creator the
 * host store composes via the usual `...createAgentSlice(config)(...args)`
 * spread.
 *
 * Return type is intentionally an `EditorStoreSliceCreator<AgentSlice>` so
 * the site editor's existing composition keeps working. The content
 * workspace's standalone AgentSlice-only store calls it with a small cast
 * (see `contentAgentStore.ts`) — both at compile time and at runtime the
 * slice only touches AgentSlice keys, so wider stores compose cleanly.
 */
export function createAgentSlice(
  config: AgentSliceConfig,
): EditorStoreSliceCreator<AgentSlice> {
  return (set, get) => {
  // AbortController held in closure (not reactive — intentional, not needed in UI)
  let _abortController: AbortController | null = null

  // rAF-buffered text accumulation (Guideline #254). Pending deltas are
  // flushed once per animation frame, OR explicitly before any tool-call
  // block is added so chronological ordering is preserved.
  let _pendingText = ''
  let _pendingAssistantId = ''
  let _rafHandle = 0

  /**
   * Append `text` to the last text block of `msg`, or push a new text block
   * if the trailing block is a tool call. This is what keeps text/tool
   * ordering chronological — text that arrives after a tool call goes into
   * its own block AFTER the tool, not concatenated into earlier text.
   */
  function appendTextToBlocks(msg: AgentMessage, text: string): void {
    const last = msg.blocks[msg.blocks.length - 1]
    if (last && last.kind === 'text') {
      last.text += text
    } else {
      msg.blocks.push({ kind: 'text', text })
    }
  }

  function flushPendingText() {
    _rafHandle = 0
    if (!_pendingText || !_pendingAssistantId) return
    const text = _pendingText
    const id = _pendingAssistantId
    _pendingText = ''
    set((state) => {
      const msg = state.agentMessages.find((m) => m.id === id)
      if (msg) appendTextToBlocks(msg, text)
    })
  }

  function scheduleFlush() {
    if (_rafHandle === 0) {
      _rafHandle = requestAnimationFrame(flushPendingText)
    }
  }

  function appendTextDelta(assistantId: string, text: string) {
    _pendingAssistantId = assistantId
    _pendingText += text
    scheduleFlush()
  }

  // Single text-stream sink passed into processStreamEvent. The sink's
  // `flush()` is called from the toolCall/toolResult handlers to drain any
  // pending text deltas BEFORE a tool-call block is added — that's what keeps
  // the visual order in the panel chronologically correct.
  const textSink: AgentTextStreamSink = {
    append: appendTextDelta,
    flush: flushPendingText,
  }

  return {
    // ── State ────────────────────────────────────────────────────────────────
    isAgentOpen: false,
    isAgentStreaming: false,
    agentMessages: [],
    agentError: null,
    agentSessionId: null,
    agentConversationId: null,
    agentActiveCredentialId: null,
    agentActiveModelId: null,
    agentConversations: [],

    // ── UI actions ───────────────────────────────────────────────────────────
    openAgent() {
      set({ isAgentOpen: true })
    },

    closeAgent() {
      set({ isAgentOpen: false })
    },

    toggleAgent() {
      set((s) => ({ isAgentOpen: !s.isAgentOpen }))
    },

    abortAgent() {
      _abortController?.abort()
      _abortController = null
      set({ isAgentStreaming: false })
    },

    clearAgentMessages() {
      set({
        agentMessages: [],
        agentError: null,
        agentSessionId: null,
        agentConversationId: null,
        agentActiveCredentialId: null,
        agentActiveModelId: null,
      })
    },

    startNewAgentConversation() {
      // Same shape as clearAgentMessages — kept as a separate action for
      // intent clarity (the UI's "+ New chat" button calls this).
      set({
        agentMessages: [],
        agentError: null,
        agentSessionId: null,
        agentConversationId: null,
        agentActiveCredentialId: null,
        agentActiveModelId: null,
      })
    },

    async loadAgentConversations() {
      try {
        const conversations = await listConversations(config.scope)
        set({ agentConversations: conversations })
      } catch (err) {
        console.error('[AgentSlice] Failed to load conversations:', err)
      }
    },

    async loadAgentConversation(id: string) {
      try {
        const conv = await getConversation(id)
        set({
          agentConversationId: conv.id,
          agentActiveCredentialId: conv.credentialId,
          agentActiveModelId: conv.modelId,
          agentMessages: rehydrateMessages(conv.messages),
          agentError: null,
        })
      } catch (err) {
        console.error('[AgentSlice] Failed to load conversation:', err)
        set({
          agentError: err instanceof ApiError ? err.message : 'Failed to load conversation.',
        })
      }
    },

    async deleteAgentConversation(id: string) {
      try {
        await deleteConversation(id)
        set((state) => {
          state.agentConversations = state.agentConversations.filter((c) => c.id !== id)
          if (state.agentConversationId === id) {
            state.agentConversationId = null
            state.agentMessages = []
            state.agentActiveCredentialId = null
            state.agentActiveModelId = null
          }
        })
      } catch (err) {
        console.error('[AgentSlice] Failed to delete conversation:', err)
      }
    },

    async setAgentProvider(credentialId: string, modelId: string) {
      const currentId = get().agentConversationId
      // Always reflect the picker selection locally so the dropdown's
      // displayed value updates immediately.
      set({ agentActiveCredentialId: credentialId, agentActiveModelId: modelId })
      if (!currentId) return  // staged for the next conversation-create call
      try {
        await updateConversationProvider(currentId, credentialId, modelId)
      } catch (err) {
        console.error('[AgentSlice] Failed to update provider:', err)
        set({ agentError: 'Failed to update conversation provider.' })
      }
    },

    // ── sendAgentMessage ─────────────────────────────────────────────────────
    async sendAgentMessage(content) {
      if (get().isAgentStreaming) return // one request at a time

      const userMsg: AgentMessage = {
        id: nanoid(),
        role: 'user',
        blocks: [{ kind: 'text', text: content }],
        timestamp: Date.now(),
      }

      const assistantId = nanoid()
      const assistantMsg: AgentMessage = {
        id: assistantId,
        role: 'assistant',
        blocks: [],
        timestamp: Date.now(),
      }

      set((state) => {
        state.agentMessages.push(userMsg)
        state.agentMessages.push(assistantMsg)
        state.agentError = null
        state.isAgentStreaming = true
      })

      _abortController = new AbortController()
      const bridge: AgentBridgeRuntime = { bridgeId: null }

      try {
        const snapshot = config.buildSnapshot()

        // Ensure we have a conversation row before streaming. Created lazily
        // from the staged picker values OR the scope default. If neither, we
        // surface a clear actionable error.
        let conversationId = get().agentConversationId
        if (!conversationId) {
          const staged = {
            credentialId: get().agentActiveCredentialId,
            modelId: get().agentActiveModelId,
          }
          let credentialId = staged.credentialId
          let modelId = staged.modelId
          if (!credentialId || !modelId) {
            const scopeDefault = await fetchScopeDefault(config.scope)
            if (!scopeDefault) {
              set({
                agentError:
                  config.noProviderMessage
                  ?? `No AI provider configured for the "${config.scope}" scope. Open /admin/ai/providers to add a credential, then /admin/ai/defaults to pick one.`,
              })
              set((state) => {
                const msg = state.agentMessages.find((m) => m.id === assistantId)
                if (msg && msg.blocks.length === 0) {
                  msg.blocks.push({ kind: 'text', text: '_(no AI provider configured)_' })
                }
              })
              return
            }
            credentialId = scopeDefault.credentialId
            modelId = scopeDefault.modelId
          }
          const conv = await createConversationForScope(
            config.scope,
            credentialId,
            modelId,
            JSON.stringify(snapshot),
          )
          conversationId = conv.id
          set({
            agentConversationId: conversationId,
            agentActiveCredentialId: credentialId,
            agentActiveModelId: modelId,
          })
        }

        const body: AgentRequestBody = {
          conversationId,
          prompt: content,
          snapshot,
        }
        const res = await fetch(`/admin/api/ai/chat/${config.scope}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: _abortController.signal,
        })

        if (!res.ok) {
          if (res.status === 502) {
            console.error('[AgentSlice] 502 — agent server unreachable')
            set({ agentError: 'AI server is not running. Start it with: bun run dev' })
            set((state) => {
              const msg = state.agentMessages.find((m) => m.id === assistantId)
              if (msg && msg.blocks.length === 0) {
                msg.blocks.push({ kind: 'text', text: '_(agent error)_' })
              }
            })
            return
          }
          throw new Error(`Agent request failed: ${res.status} ${res.statusText}`)
        }

        if (!res.body) throw new Error('Agent response has no body')

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let lineBuffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          lineBuffer += decoder.decode(value, { stream: true })
          const lines = lineBuffer.split('\n')
          lineBuffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            const parsed = safeParseJson(trimmed, ServerStreamEventSchema)
            if (!parsed.ok) continue
            const event = parsed.value as ServerStreamEvent
            await processStreamEvent(
              event,
              assistantId,
              textSink,
              set,
              bridge,
              _abortController?.signal ?? null,
              config.dispatchTool,
            )
          }
        }

        flushPendingText()
      } catch (err) {
        // Abort the fetch so any in-flight MCP tool handler on the server
        // rejects cleanly (via destroyBridge in the stream's finally block)
        // instead of waiting forever for a tool-result that won't arrive.
        _abortController?.abort()

        if (err instanceof Error && err.name === 'AbortError') {
          flushPendingText()
        } else {
          // Admin-only surface (capability gated) — show the actual
          // failure cause so the operator can act. Network / unexpected
          // throws still get a prefix so they're distinguishable from
          // server-classified driver errors.
          const detail = err instanceof Error ? err.message : String(err)
          console.error('[AgentSlice] sendAgentMessage error:', err)
          set({ agentError: `Agent request failed: ${detail}` })
          set((state) => {
            const msg = state.agentMessages.find((m) => m.id === assistantId)
            if (msg && msg.blocks.length === 0) {
              msg.blocks.push({ kind: 'text', text: '_(agent error)_' })
            }
          })
        }
      } finally {
        _abortController = null
        set({ isAgentStreaming: false })
      }
    },
  }
  }
}
