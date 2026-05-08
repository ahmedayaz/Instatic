/**
 * useClassPickerSuggestions — derive the entire ClassPicker dropdown state
 * from the assigned-class set, the registry, and the typed query.
 *
 * Pure-derivation hook: reads `recordClassUsage`-backed history (per-site
 * localStorage) but writes nothing, dispatches no store actions, and runs
 * no effects. The component owns the *state inputs* (`query`,
 * `highlightedIndex`, `siteId`); we own everything that follows from them.
 *
 * Splitting these computations out of `ClassPicker.tsx` is what dropped its
 * cognitive complexity below the "critical" threshold and made the logic
 * testable without rendering React. See `useClassPickerSuggestions.test.ts`.
 */

import type { CSSClass } from '@core/page-tree/schemas'
import {
  CLASS_USAGE_RECENT_LIMIT,
  readSiteClassUsage,
  selectRecentAndFrequent,
} from '../../preferences/classUsage'

/** Per-site class-usage table — return type of `readSiteClassUsage`. */
type ClassUsageMap = ReturnType<typeof readSiteClassUsage>
import { rankBySuggestionScore } from './classPickerRanking'

// When the input is empty and Recent + Frequent (deduped) collectively surface
// at least this many classes, the dropdown skips the "All classes" section —
// the user already has plenty of relevant options without scrolling past every
// utility. Below the threshold we still pad with All so a near-empty history
// doesn't leave the dropdown sparse.
const SUFFICIENT_HISTORY_THRESHOLD = CLASS_USAGE_RECENT_LIMIT

export interface ClassPickerSuggestionsInput {
  /** Every user-visible class in the site, regardless of node assignment. */
  allClasses: readonly CSSClass[]
  /** IDs already assigned to the active node (visible or hidden). */
  assignedIds: readonly string[]
  /** Trimmed but case-preserving query (used for exact-name matching). */
  query: string
  /** The Arrow-Up/Down highlight index; -1 means "no explicit selection". */
  highlightedIndex: number
  /**
   * Site ID, used to scope the per-site usage history (localStorage). When
   * `null`, recent/frequent are empty — fresh installs show only the All
   * section without the personalised header.
   */
  siteId: string | null
  /**
   * Override `readSiteClassUsage(siteId)` — useful for tests so we don't have
   * to stub localStorage. Production callers omit this; the hook reads from
   * persisted usage only when `siteId` is non-null.
   */
  readUsage?: (siteId: string) => ClassUsageMap
}

export interface ClassPickerSuggestionsResult {
  trimmedQueryRaw: string
  isEmptyQuery: boolean

  /** Classes that aren't on the node yet — the universe the dropdown picks from. */
  candidates: CSSClass[]
  candidatesById: Map<string, CSSClass>

  /** Ranked filtered list when typing; same as `candidates` when empty. */
  filteredSuggestions: CSSClass[]

  recentIds: readonly string[]
  frequentIds: readonly string[]
  remainingCandidates: CSSClass[]
  shouldShowAllSection: boolean
  surfacedCount: number

  /** Final flat order driving Arrow-Up/Down navigation. */
  flatNavIds: string[]

  /** Clamped index into `flatNavIds`; -1 when out of range. */
  effectiveHighlightedIndex: number
  hasArrowSelection: boolean
  /** Primitive — safe `useEffect` dep. */
  highlightedClassId: string | null
  /** Highlighted class's display name, when any. */
  highlightedName: string | null

  /**
   * Exact-name match against ALL classes (assigned or not). Lets Enter add a
   * literal-name match instead of the first ranked suggestion.
   */
  exactMatchedClass: CSSClass | null
  exactMatchAlreadyAssigned: boolean
  canCreateNew: boolean

  /**
   * Whether pressing Enter has a meaningful effect (Arrow highlight wins,
   * otherwise the typed input creates / adds an unassigned exact match).
   */
  hasSubmittableQuery: boolean
  submitTooltip: string
}

export function useClassPickerSuggestions(
  input: ClassPickerSuggestionsInput,
): ClassPickerSuggestionsResult {
  const {
    allClasses,
    assignedIds,
    query,
    highlightedIndex,
    siteId,
    readUsage = readSiteClassUsage,
  } = input

  const trimmedQueryRaw = query.trim()
  const trimmedQuery = trimmedQueryRaw.toLowerCase()
  const isEmptyQuery = trimmedQuery.length === 0

  const candidates = allClasses.filter((c) => !assignedIds.includes(c.id))
  const candidatesById = new Map(candidates.map((c) => [c.id, c]))

  // Empty query → unfiltered candidates; typed query → ranked relevance.
  // Ranking tiers (in classPickerRanking):
  //   4 = exact name | 3 = prefix | 2 = word boundary | 1 = substring
  // shorter names win within a tier, then alphabetical.
  const filteredSuggestions = isEmptyQuery
    ? candidates
    : rankBySuggestionScore(candidates, trimmedQuery)

  // Empty-query layout: surface Recent + Frequent first, then optionally an
  // "All classes" section so fresh sites with sparse history stay browsable.
  const usage: ClassUsageMap = isEmptyQuery && siteId ? readUsage(siteId) : {}
  const { recent: recentIds, frequent: frequentIds } = isEmptyQuery
    ? selectRecentAndFrequent(usage, candidates.map((c) => c.id))
    : { recent: [] as string[], frequent: [] as string[] }
  const surfacedSet = new Set<string>([...recentIds, ...frequentIds])
  const surfacedCount = surfacedSet.size
  const remainingCandidates = candidates.filter((c) => !surfacedSet.has(c.id))
  const shouldShowAllSection =
    isEmptyQuery && (surfacedCount === 0 || surfacedCount < SUFFICIENT_HISTORY_THRESHOLD)

  // Flat list of class IDs in their final display order (Recent → Frequent →
  // All when input is empty, ranked filteredSuggestions when typing).
  const flatNavIds: string[] = isEmptyQuery
    ? [
        ...recentIds,
        ...frequentIds,
        ...(shouldShowAllSection ? remainingCandidates.map((c) => c.id) : []),
      ]
    : filteredSuggestions.map((c) => c.id)

  // Clamp the stored highlight to the live suggestion list rather than
  // "fixing it up" through a setState-in-effect.
  const effectiveHighlightedIndex =
    highlightedIndex >= 0 && highlightedIndex < flatNavIds.length ? highlightedIndex : -1
  const hasArrowSelection = effectiveHighlightedIndex >= 0
  const highlightedClassId = hasArrowSelection
    ? flatNavIds[effectiveHighlightedIndex] ?? null
    : null
  const highlightedName = highlightedClassId
    ? candidatesById.get(highlightedClassId)?.name ?? null
    : null

  // Exact-name match against ALL user-visible classes (including ones already
  // assigned). Drives the Enter-with-typed-input path: typing an existing
  // unassigned name adds that class; typing something new creates and adds it.
  const exactMatchedClass = !isEmptyQuery
    ? allClasses.find((c) => c.name === trimmedQueryRaw) ?? null
    : null
  const exactMatchAlreadyAssigned =
    exactMatchedClass !== null && assignedIds.includes(exactMatchedClass.id)
  const canCreateNew = !isEmptyQuery && exactMatchedClass === null

  // Enter has a meaningful effect when one of these is true; otherwise it's
  // a no-op (empty input, or query matches an already-assigned class with
  // no Arrow-nav highlight).
  const hasSubmittableQuery =
    hasArrowSelection ||
    canCreateNew ||
    (exactMatchedClass !== null && !exactMatchAlreadyAssigned)

  const submitTooltip = deriveSubmitTooltip({
    hasArrowSelection,
    highlightedName,
    canCreateNew,
    trimmedQueryRaw,
    exactMatchedClass,
    exactMatchAlreadyAssigned,
  })

  return {
    trimmedQueryRaw,
    isEmptyQuery,
    candidates,
    candidatesById,
    filteredSuggestions,
    recentIds,
    frequentIds,
    remainingCandidates,
    shouldShowAllSection,
    surfacedCount,
    flatNavIds,
    effectiveHighlightedIndex,
    hasArrowSelection,
    highlightedClassId,
    highlightedName,
    exactMatchedClass,
    exactMatchAlreadyAssigned,
    canCreateNew,
    hasSubmittableQuery,
    submitTooltip,
  }
}

/**
 * Build the submit-button tooltip from the current input + selection state.
 *
 * Priority mirrors the picker's submit logic:
 *   1. Arrow-key highlight wins — describe adding the highlighted class.
 *   2. Otherwise the typed input is the source of truth: a brand-new name
 *      becomes a "Create class" hint; an exact match becomes "Add class"
 *      (or "already on this element" when it's already assigned).
 *   3. Empty input falls back to the static instructional copy.
 */
function deriveSubmitTooltip(args: {
  hasArrowSelection: boolean
  highlightedName: string | null
  canCreateNew: boolean
  trimmedQueryRaw: string
  exactMatchedClass: CSSClass | null
  exactMatchAlreadyAssigned: boolean
}): string {
  const {
    hasArrowSelection,
    highlightedName,
    canCreateNew,
    trimmedQueryRaw,
    exactMatchedClass,
    exactMatchAlreadyAssigned,
  } = args
  if (hasArrowSelection && highlightedName) return `Add class “${highlightedName}”`
  if (canCreateNew && trimmedQueryRaw) return `Create class “${trimmedQueryRaw}”`
  if (exactMatchedClass && !exactMatchAlreadyAssigned) return `Add class “${exactMatchedClass.name}”`
  if (exactMatchedClass && exactMatchAlreadyAssigned) {
    return `“${exactMatchedClass.name}” is already on this element`
  }
  return 'Type a class name to add or create'
}
