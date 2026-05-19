/**
 * Spotlight state machine — §3.4 of the Command Spotlight master plan.
 *
 * A useReducer atom (not a Zustand slice) so spotlight state is isolated from
 * the editor store. The reducer is pure — all side effects live in the host
 * component (SpotlightRoot).
 *
 * The reducer itself only handles the three phase transitions (OPEN / CLOSE /
 * TOGGLE). Every other action requires `phase === 'open'` and is routed to
 * `applyOpenAction` in `stateHandlers.ts`, which dispatches to one tiny pure
 * helper per action type. Adding a new action = add a variant to
 * `SpotlightAction`, add a handler in `stateHandlers.ts`, add a case in
 * `applyOpenAction`. No giant switch to edit.
 *
 * Phase 2 additions:
 *   - argMode: tracks argument-collection flow for commands with args
 *   - pendingConfirm: tracks first-Enter on a destructive command (5 s window)
 */

import type { Command, ScopeFrame } from './types'
import { applyOpenAction } from './stateHandlers'

// ─── Arg mode ─────────────────────────────────────────────────────────────────

/**
 * State captured while collecting arguments for a command.
 * `argIndex` is the index of the arg currently being filled.
 * `values` holds all previously completed arg values keyed by arg.id.
 */
export interface ArgModeState {
  command: Command
  argIndex: number
  values: Record<string, string>
}

// ─── State ────────────────────────────────────────────────────────────────────

export interface SpotlightOpenState {
  phase: 'open'
  query: string
  /** Stack of active scopes; top of stack = active scope. Default: ['root']. */
  scopeStack: ScopeFrame[]
  highlightedIndex: number
  /** Async provider results keyed by providerId (Phase 3). */
  asyncResults: Record<string, Command[]>
  /** Provider ids currently in-flight (Phase 3). */
  loadingProviders: Set<string>
  /**
   * Phase 2: Arg-collection mode. Non-null when a command with `args` has been
   * selected and we're collecting one argument at a time via the input.
   */
  argMode: ArgModeState | null
  /**
   * Phase 2: ID of the destructive command awaiting a second Enter to confirm.
   * Cleared by CLEAR_PENDING_CONFIRM (timeout or Escape or second Enter runs).
   */
  pendingConfirm: string | null
}

export type SpotlightState =
  | { phase: 'closed' }
  | SpotlightOpenState

// ─── Actions ─────────────────────────────────────────────────────────────────

export type SpotlightAction =
  | { type: 'OPEN' }
  | { type: 'CLOSE' }
  | { type: 'TOGGLE' }
  | { type: 'SET_QUERY'; query: string }
  | { type: 'SET_HIGHLIGHTED'; index: number }
  | { type: 'HIGHLIGHT_NEXT' }
  | { type: 'HIGHLIGHT_PREV' }
  | { type: 'PUSH_SCOPE'; scopeId: string; pendingArgs?: Record<string, string> }
  | { type: 'POP_SCOPE' }
  | { type: 'SET_ASYNC_RESULTS'; providerId: string; results: Command[] }
  | { type: 'SET_LOADING_PROVIDER'; providerId: string; loading: boolean }
  /** Phase 3: reset all async results and loading state (scope change / close). */
  | { type: 'ASYNC_RESET' }
  | { type: 'RESULT_COUNT_CHANGED'; count: number }
  // ── Phase 2: Arg mode ────────────────────────────────────────────────────
  | { type: 'ENTER_ARG_MODE'; command: Command }
  | { type: 'SAVE_ARG_AND_ADVANCE'; argId: string; value: string }
  | { type: 'BACK_ARG' }
  | { type: 'EXIT_ARG_MODE' }
  // ── Phase 2: Destructive confirm ─────────────────────────────────────────
  | { type: 'SET_PENDING_CONFIRM'; commandId: string }
  | { type: 'CLEAR_PENDING_CONFIRM' }

// ─── Initial state ────────────────────────────────────────────────────────────

export const initialState: SpotlightState = { phase: 'closed' }

function makeOpenState(): SpotlightOpenState {
  return {
    phase: 'open',
    query: '',
    scopeStack: [{ scopeId: 'root', pendingArgs: {} }],
    highlightedIndex: 0,
    asyncResults: {},
    loadingProviders: new Set(),
    argMode: null,
    pendingConfirm: null,
  }
}

// ─── Reducer ──────────────────────────────────────────────────────────────────

export function spotlightReducer(
  state: SpotlightState,
  action: SpotlightAction,
): SpotlightState {
  switch (action.type) {
    case 'OPEN':
      return state.phase === 'open' ? state : makeOpenState()
    case 'CLOSE':
      return { phase: 'closed' }
    case 'TOGGLE':
      return state.phase === 'closed' ? makeOpenState() : { phase: 'closed' }
    default:
      // Every remaining action requires the palette to be open. If it isn't,
      // the action is a no-op and we preserve the closed-state reference.
      if (state.phase !== 'open') return state
      return applyOpenAction(state, action)
  }
}
