/**
 * useDashboardLayout — persisted state for the dashboard grid + onboarding
 * panel.
 *
 * The dashboard is a per-user preference, not a per-site setting — every
 * admin gets to arrange and resize their own widgets. We persist to
 * localStorage so the layout sticks across sessions without round-tripping
 * the server. (When the team-level "shared dashboard preset" feature lands
 * later, it would layer on top by writing into a CMS-side prefs row.)
 *
 * Layout model — explicit grid positioning
 * ----------------------------------------
 * Each item carries `{ col, row, size, rows }` and renders at an
 * explicit grid position (`grid-column: col / span size`, `grid-row:
 * row / span rows`). The grid does NOT auto-flow — widgets stay
 * exactly where placed, and the user can leave gaps between cards.
 *
 * Drag-to-move + resize both run a collision-resolution pass after
 * the user-driven change: any other widget that ends up overlapping
 * the moved/resized one gets pushed down (row += height of the
 * authoritative widget) until the layout is overlap-free. The moved
 * item itself is pinned in place during resolution — it never moves
 * away from where the user dropped or resized it to.
 *
 * Schema is validated via TypeBox with `parseJsonWithFallback` so any
 * corrupted blob falls back to the default layout rather than bricking
 * the page.
 */
import { useCallback, useEffect, useState } from 'react'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'

// Bumped to v3 when explicit `col` / `row` positioning was added. Older
// v2 entries lacked positions and would all render at (1, 1) on top of
// each other; resetting to defaults gives them a sane curated layout
// instead. Older `pb-admin-dashboard-layout-v2` / `-v1` keys are
// orphaned (no migration helper) since this is per-user UI state, not
// content.
const STORAGE_KEY = 'pb-admin-dashboard-layout-v3'

// `col`, `row`, `rows` are all optional ON THE WIRE so older persisted
// layouts (v2 with only size+rows, v1 with only size) still parse —
// `normalizeLayout` below fills in defaults. The exported `DashboardItem`
// type is the normalized runtime shape (all four required).
const PersistedDashboardItemSchema = Type.Object({
  id: Type.String(),
  size: Type.Number(),
  rows: Type.Optional(Type.Number()),
  col: Type.Optional(Type.Number()),
  row: Type.Optional(Type.Number()),
})

// `onboardingCollapsed` is kept on the persisted schema as optional so
// older localStorage entries from before the "hide steps" toggle was
// removed still parse — `normalizeLayout` drops it.
const PersistedDashboardLayoutSchema = Type.Object({
  items: Type.Array(PersistedDashboardItemSchema),
  onboardingDismissed: Type.Boolean(),
  onboardingCollapsed: Type.Optional(Type.Boolean()),
})

type PersistedDashboardLayout = Static<typeof PersistedDashboardLayoutSchema>

export interface DashboardItem {
  id: string
  /** 1-based start column on the 12-column grid. */
  col: number
  /** 1-based start row. Rows are unbounded; the grid grows downward. */
  row: number
  /** Grid column span (3 .. 12). */
  size: number
  /** Grid row span (2 .. 8) — each row is GRID_ROW_HEIGHT px tall. */
  rows: number
}

export interface DashboardLayout {
  items: DashboardItem[]
  onboardingDismissed: boolean
}

/**
 * Pixel height of one grid row. The grid stylesheet's `grid-auto-rows`
 * MUST stay in sync — moving the value to a single TS constant means the
 * resize handler can compute row deltas from the pointer distance without
 * a magic number duplicated across files.
 */
export const GRID_ROW_HEIGHT = 70
/**
 * 1px between cells in VIEW mode. The grid sits on a darker surface
 * (`--editor-surface`) than the cards themselves (`--editor-surface-2`);
 * the 1px gap reads as a hairline of the parent surface peeking through.
 */
export const GRID_GAP = 1
/**
 * 16px between cells in CUSTOMIZE mode. The wider gutter exposes the
 * full perimeter of every card so the 8px edge resize handles can be
 * grabbed without overlapping the neighbour's handle. The CSS
 * `.editing` rule sets the same value on the grid's `--gap` custom
 * property; the JS snap math below uses this constant directly so
 * drag-to-move and edge-resize land on the right cell line.
 */
export const EDITING_GRID_GAP = 16
export const MIN_ROWS = 2
export const MAX_ROWS = 8
export const MIN_COLS = 3
export const MAX_COLS = 12

/**
 * Default layout uses ONLY first-party widget ids that the host ships
 * unconditionally. Plugin-owned widgets (Analytics → `visitors` /
 * `top-pages`, future plugins → their own ids) are NOT in the default
 * grid — installing the plugin adds the widget to the registry, but the
 * user has to drop it onto the grid via the "Add block" picker (or the
 * plugin can persist a layout update via the layout API after install).
 *
 * Rationale: a default layout that references plugin ids would leave
 * visual holes on a fresh install where the plugin isn't yet present —
 * bad first impression. Plugins surface via the block picker, the
 * grid only seeds with widgets the host definitely has.
 */
const DEFAULT_LAYOUT: DashboardLayout = {
  items: [
    { id: 'storage',   col: 1,  row: 1,  size: 12, rows: 4 },
    { id: 'pages',     col: 1,  row: 5,  size: 3,  rows: 3 },
    { id: 'posts',     col: 4,  row: 5,  size: 3,  rows: 3 },
    { id: 'media',     col: 7,  row: 5,  size: 3,  rows: 3 },
    { id: 'status',    col: 10, row: 5,  size: 3,  rows: 3 },
    { id: 'activity',  col: 1,  row: 8,  size: 6,  rows: 5 },
    { id: 'publish',   col: 7,  row: 8,  size: 6,  rows: 5 },
    { id: 'plugins',   col: 1,  row: 13, size: 6,  rows: 5 },
    { id: 'domain',    col: 7,  row: 13, size: 6,  rows: 3 },
  ],
  onboardingDismissed: false,
}

// ---------------------------------------------------------------------------
// Collision resolution
// ---------------------------------------------------------------------------

/**
 * AABB overlap on the integer grid. Two items overlap iff their column
 * ranges intersect AND their row ranges intersect (both half-open).
 */
function overlaps(a: DashboardItem, b: DashboardItem): boolean {
  return !(
    a.col + a.size <= b.col ||
    b.col + b.size <= a.col ||
    a.row + a.rows <= b.row ||
    b.row + b.rows <= a.row
  )
}

/**
 * Push every item that overlaps `pinned` (or that overlaps an already-pushed
 * item) downward until the layout is overlap-free. The pinned item never
 * moves — that's the whole point: when the user drops or resizes a card,
 * the card stays exactly where they put it and the world bends around it.
 *
 * Algorithm:
 *
 *   1. Add `pinned` to a "settled" set.
 *   2. Sweep the remaining items in increasing (row, col) order.
 *   3. For each item, push its row down until it stops overlapping any
 *      already-settled item, then add it to the settled set.
 *
 * Sorting by (row, col) before the sweep keeps the result deterministic
 * — two different DnD sessions that land in the same final state always
 * produce the same array.
 *
 * The "push down only" choice (never left/right) trades some pack density
 * for predictability: the user already chose a column, so we never
 * silently shift them sideways.
 */
function resolveCollisions(items: readonly DashboardItem[], pinnedId: string): DashboardItem[] {
  const pinned = items.find((i) => i.id === pinnedId)
  if (!pinned) return [...items]

  const others = items
    .filter((i) => i.id !== pinnedId)
    .map((i) => ({ ...i }))
    .sort((a, b) => (a.row - b.row) || (a.col - b.col))

  const settled: DashboardItem[] = [{ ...pinned }]

  for (const item of others) {
    // Push `item` downward until it stops colliding with any settled
    // sibling. Bounded loop guard so a degenerate input can't lock the
    // tab — in practice resolution converges in 1–2 passes.
    let safety = 200
    while (settled.some((s) => overlaps(s, item)) && safety-- > 0) {
      // Find the deepest overlapping settled item and jump just past
      // its bottom edge. This collapses the worst case from "scan
      // every row one-by-one" to "one jump per blocker".
      const blocker = settled
        .filter((s) => overlaps(s, item))
        .reduce((deepest, s) => (s.row + s.rows > deepest.row + deepest.rows ? s : deepest))
      item.row = blocker.row + blocker.rows
    }
    settled.push(item)
  }

  // Preserve original `items` order for stable React keys / DOM identity.
  // The settled array's traversal order is the sorted sweep order, which
  // is not what the caller passed in.
  const byId = new Map(settled.map((s) => [s.id, s]))
  return items.map((i) => byId.get(i.id) ?? i)
}

// ---------------------------------------------------------------------------
// Normalisation (persisted → runtime)
// ---------------------------------------------------------------------------

function normalizeItem(
  item: { id: string; size: number; rows?: number; col?: number; row?: number },
  fallbackIndex: number,
): DashboardItem {
  return {
    id: item.id,
    size: item.size,
    rows: typeof item.rows === 'number' && item.rows >= MIN_ROWS ? item.rows : MIN_ROWS,
    // For older layouts that lack `col` / `row`, stack each item in
    // column 1 with an ever-increasing row — guarantees no overlap so
    // the collision resolver doesn't have to fix imported data.
    col: typeof item.col === 'number' && item.col >= 1 ? item.col : 1,
    row: typeof item.row === 'number' && item.row >= 1
      ? item.row
      : 1 + fallbackIndex * (typeof item.rows === 'number' ? item.rows : MIN_ROWS),
  }
}

function normalizeLayout(layout: PersistedDashboardLayout): DashboardLayout {
  return {
    items: layout.items.map((item, idx) => normalizeItem(item, idx)),
    onboardingDismissed: layout.onboardingDismissed,
  }
}

function readFromStorage(): DashboardLayout {
  if (typeof window === 'undefined') return DEFAULT_LAYOUT
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = parseJsonWithFallback(raw, PersistedDashboardLayoutSchema, DEFAULT_LAYOUT)
    return normalizeLayout(parsed)
  } catch (err) {
    console.error('[dashboard] failed to read layout from localStorage:', err)
    return DEFAULT_LAYOUT
  }
}

function writeToStorage(layout: DashboardLayout): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  } catch (err) {
    console.error('[dashboard] failed to persist layout to localStorage:', err)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DashboardLayoutApi {
  layout: DashboardLayout
  /** Append a widget if it's not already on the grid. Lands at row 1, col 1
   *  by default; the caller can specify a position to drop into a specific
   *  cell. Collision resolution pushes any overlapping siblings down. */
  addWidget: (id: string, size: number, rows?: number, col?: number, row?: number) => void
  /** Drop a widget from the grid. */
  removeWidget: (id: string) => void
  /** Replace the items array wholesale. Used by the page-level visibility
   *  filter that drops items whose definition is no longer registered. */
  setItems: (next: readonly DashboardItem[]) => void
  /** Move a widget to a new grid position. Triggers collision resolution
   *  that pushes any conflicting siblings downward; the moved widget stays
   *  pinned at the target. */
  moveWidget: (id: string, col: number, row: number) => void
  /** Update a widget's column span. Triggers collision resolution. */
  resize: (id: string, size: number) => void
  /** Update a widget's row span (vertical height). Triggers collision
   *  resolution — the typical use case is "grow a card and the cards
   *  below it slide further down". */
  resizeRows: (id: string, rows: number) => void
  /** Permanently dismiss the onboarding panel for this user. */
  dismissOnboarding: () => void
  /** Bring the onboarding panel back after dismissal. */
  restoreOnboarding: () => void
}

export function useDashboardLayout(): DashboardLayoutApi {
  const [layout, setLayout] = useState<DashboardLayout>(() => readFromStorage())

  useEffect(() => {
    writeToStorage(layout)
  }, [layout])

  const addWidget = useCallback(
    (id: string, size: number, rows: number = 3, col: number = 1, row: number = 1) => {
      setLayout((curr) => {
        if (curr.items.some((i) => i.id === id)) return curr
        const nextItems = [...curr.items, { id, size, rows, col, row }]
        return { ...curr, items: resolveCollisions(nextItems, id) }
      })
    },
    [],
  )

  const removeWidget = useCallback((id: string) => {
    setLayout((curr) => ({ ...curr, items: curr.items.filter((i) => i.id !== id) }))
  }, [])

  const setItems = useCallback((next: readonly DashboardItem[]) => {
    setLayout((curr) => ({ ...curr, items: [...next] }))
  }, [])

  const moveWidget = useCallback((id: string, col: number, row: number) => {
    setLayout((curr) => {
      const target = curr.items.find((i) => i.id === id)
      if (!target) return curr
      const clampedCol = Math.max(1, Math.min(MAX_COLS - target.size + 1, col))
      const clampedRow = Math.max(1, row)
      // Already at the target → noop (avoids spurious React updates).
      if (target.col === clampedCol && target.row === clampedRow) return curr
      const nextItems = curr.items.map((i) =>
        i.id === id ? { ...i, col: clampedCol, row: clampedRow } : i,
      )
      return { ...curr, items: resolveCollisions(nextItems, id) }
    })
  }, [])

  const resize = useCallback((id: string, size: number) => {
    setLayout((curr) => {
      const target = curr.items.find((i) => i.id === id)
      if (!target || target.size === size) return curr
      // Clamp so size + col doesn't extend past column 12.
      const clampedSize = Math.max(MIN_COLS, Math.min(MAX_COLS - target.col + 1, size))
      const nextItems = curr.items.map((i) =>
        i.id === id ? { ...i, size: clampedSize } : i,
      )
      return { ...curr, items: resolveCollisions(nextItems, id) }
    })
  }, [])

  const resizeRows = useCallback((id: string, rows: number) => {
    setLayout((curr) => {
      const target = curr.items.find((i) => i.id === id)
      if (!target || target.rows === rows) return curr
      const clampedRows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows))
      const nextItems = curr.items.map((i) =>
        i.id === id ? { ...i, rows: clampedRows } : i,
      )
      return { ...curr, items: resolveCollisions(nextItems, id) }
    })
  }, [])

  const dismissOnboarding = useCallback(() => {
    setLayout((curr) => ({ ...curr, onboardingDismissed: true }))
  }, [])

  const restoreOnboarding = useCallback(() => {
    setLayout((curr) => ({ ...curr, onboardingDismissed: false }))
  }, [])

  return {
    layout,
    addWidget,
    removeWidget,
    setItems,
    moveWidget,
    resize,
    resizeRows,
    dismissOnboarding,
    restoreOnboarding,
  }
}
