/**
 * AddGoogleFontDialog — modal that drives the install flow for one Google font.
 *
 * Two-step UX:
 *   1. Family picker: searchable list of bundled Google fonts with a live
 *      preview rendered in the family's own font (lazy-loaded via Google's
 *      keyless CSS endpoint — preview links live only inside the editor
 *      session and never end up in the published HTML).
 *   2. Variant + subset picker: multi-select grid of the variants and subsets
 *      the chosen family advertises. The user confirms; the server downloads
 *      the woff2 files and we receive a `FontEntry` to merge into site settings.
 *
 * The dialog is fully self-contained — close behaviour, focus management, and
 * fetch state all live here. The parent (`FontsSection`) only needs to mount it
 * when `open` is true and pass an `onInstalled(entry)` callback.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { FilterBar } from '@ui/components/FilterBar'
import { SearchBar } from '@ui/components/SearchBar'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import {
  installCmsGoogleFont,
  listCmsGoogleFonts,
} from '@core/persistence/cmsFonts'
import type { FontEntry } from '@core/page-tree/schemas'
import { compareVariants, parseVariant } from '@core/fonts/variants'
import { loadFontPreview, loadFontPreviewWithVariants } from '@core/fonts/preview'
import type { GoogleFontFamilyDto } from '@core/persistence/responseSchemas'
import styles from './FontsSection.module.css'

interface AddGoogleFontDialogProps {
  /** Families already installed (case-insensitive) — disabled in the picker. */
  installedFamilies: ReadonlySet<string>
  onCancel: () => void
  onInstalled: (entry: FontEntry) => void
}

// Initial batch sizes the previews on first render. The 2-column tile grid
// fits ~12-16 visible cards in a typical viewport, so 40 covers the first
// scroll fold + a buffer; further tiles light up as the user scrolls.
const PREVIEW_BATCH_SIZE = 40
const DEFAULT_PICKED_VARIANT = '400'
const DEFAULT_PICKED_SUBSET = 'latin'

/**
 * Category filter chip options. The first chip is `All`; the rest mirror the
 * five Google Fonts categories present in our bundled snapshot
 * (Sans Serif × 710, Display × 463, Serif × 347, Handwriting × 252, Monospace × 50).
 */
const CATEGORY_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'Sans Serif', label: 'Sans' },
  { value: 'Serif', label: 'Serif' },
  { value: 'Display', label: 'Display' },
  { value: 'Handwriting', label: 'Handwriting' },
  { value: 'Monospace', label: 'Mono' },
]

export function AddGoogleFontDialog({
  installedFamilies,
  onCancel,
  onInstalled,
}: AddGoogleFontDialogProps) {
  const [families, setFamilies] = useState<GoogleFontFamilyDto[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [selected, setSelected] = useState<GoogleFontFamilyDto | null>(null)
  const [pickedVariants, setPickedVariants] = useState<string[]>([])
  const [pickedSubsets, setPickedSubsets] = useState<string[]>([])
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [previewBudget, setPreviewBudget] = useState(PREVIEW_BATCH_SIZE)

  // Close on Escape — same convention as FrameworkChangeConfirmDialog.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  // Fetch the Google Fonts directory once on mount.
  useEffect(() => {
    let cancelled = false
    listCmsGoogleFonts()
      .then((entries) => {
        if (cancelled) return
        setFamilies(entries)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Failed to load Google fonts list')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const filtered = useMemo(() => {
    if (!families) return []
    const q = query.trim().toLowerCase()
    return families.filter((f) => {
      if (category !== 'all' && f.category !== category) return false
      if (q && !f.family.toLowerCase().includes(q)) return false
      return true
    })
  }, [families, query, category])

  // Lazily load preview CSS for the first N visible families. Loading every
  // family at once would inject ~1500 link tags — IntersectionObserver is the
  // ideal control, but a fixed budget per scroll-batch is simpler and still
  // keeps the network footprint bounded.
  useEffect(() => {
    if (!filtered.length) return
    const slice = filtered.slice(0, previewBudget)
    for (const entry of slice) loadFontPreview(entry.family)
  }, [filtered, previewBudget])

  /**
   * Reset the preview budget back to the first batch when the user types a
   * new query — done from the change handler (not a sync setState in an
   * effect, which `react-hooks/set-state-in-effect` rightly forbids).
   */
  function handleQueryChange(next: string) {
    setQuery(next)
    setPreviewBudget(PREVIEW_BATCH_SIZE)
  }

  function handleCategoryChange(next: string) {
    setCategory(next)
    setPreviewBudget(PREVIEW_BATCH_SIZE)
  }

  function handlePick(entry: GoogleFontFamilyDto) {
    setSelected(entry)
    setInstallError(null)
    // Pre-load every advertised variant so the variants step renders each
    // weight in its own weight/style. Same transient-CDN guarantee as the
    // family-picker preview: never reaches published HTML.
    loadFontPreviewWithVariants(entry.family, entry.variants)
    // Pick sensible defaults: 400 if available, otherwise the lightest
    // variant. Latin if available, otherwise the first listed subset. Users
    // can change anything on the next step.
    const defaultVariant = entry.variants.includes(DEFAULT_PICKED_VARIANT)
      ? DEFAULT_PICKED_VARIANT
      : (entry.variants[0] ?? '')
    setPickedVariants(defaultVariant ? [defaultVariant] : [])
    const defaultSubset = entry.subsets.includes(DEFAULT_PICKED_SUBSET)
      ? DEFAULT_PICKED_SUBSET
      : (entry.subsets[0] ?? '')
    setPickedSubsets(defaultSubset ? [defaultSubset] : [])
  }

  async function handleInstall() {
    if (!selected || installing) return
    if (pickedVariants.length === 0 || pickedSubsets.length === 0) return
    setInstalling(true)
    setInstallError(null)
    try {
      const entry = await installCmsGoogleFont({
        family: selected.family,
        variants: pickedVariants,
        subsets: pickedSubsets,
      })
      onInstalled(entry)
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : 'Font install failed')
    } finally {
      setInstalling(false)
    }
  }

  return createPortal(
    <div
      className={styles.backdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget && !installing) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-font-dialog-title"
        className={styles.dialog}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.dialogHeader}>
          <h2 id="add-font-dialog-title" className={styles.dialogTitle}>
            {selected ? `Add font — ${selected.family}` : 'Add Google font'}
          </h2>
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label="Close add-font dialog"
            onClick={onCancel}
            disabled={installing}
          >
            <CloseIcon size={12} aria-hidden="true" />
          </Button>
        </div>

        <div className={styles.dialogBody}>
          {selected ? (
            <VariantsAndSubsetsStep
              family={selected}
              pickedVariants={pickedVariants}
              pickedSubsets={pickedSubsets}
              onPickedVariantsChange={setPickedVariants}
              onPickedSubsetsChange={setPickedSubsets}
            />
          ) : (
            <FamilyPickerStep
              families={filtered}
              loading={families === null && !loadError}
              loadError={loadError}
              query={query}
              category={category}
              installedFamilies={installedFamilies}
              onQueryChange={handleQueryChange}
              onCategoryChange={handleCategoryChange}
              onPick={handlePick}
              onLoadMorePreviews={() => setPreviewBudget((n) => n + PREVIEW_BATCH_SIZE)}
            />
          )}

          {installError && (
            <p role="alert" className={styles.errorAlert}>{installError}</p>
          )}
        </div>

        <div className={styles.dialogActions}>
          {selected ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setSelected(null)}
                disabled={installing}
              >
                Back
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="button"
                onClick={() => { void handleInstall() }}
                disabled={
                  installing
                  || pickedVariants.length === 0
                  || pickedSubsets.length === 0
                }
              >
                {installing ? (
                  <>
                    <LoaderIcon size={12} aria-hidden="true" /> Installing…
                  </>
                ) : (
                  'Install font'
                )}
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ─── Family picker step ─────────────────────────────────────────────────────

interface FamilyPickerStepProps {
  families: GoogleFontFamilyDto[]
  loading: boolean
  loadError: string | null
  query: string
  category: string
  installedFamilies: ReadonlySet<string>
  onQueryChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onPick: (entry: GoogleFontFamilyDto) => void
  onLoadMorePreviews: () => void
}

function FamilyPickerStep({
  families,
  loading,
  loadError,
  query,
  category,
  installedFamilies,
  onQueryChange,
  onCategoryChange,
  onPick,
  onLoadMorePreviews,
}: FamilyPickerStepProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const handleScroll = useCallback(() => {
    const el = listRef.current
    if (!el) return
    // Trigger another preview batch when the user nears the bottom — same
    // mechanic IntersectionObserver would give us, with one fewer subscription.
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
      onLoadMorePreviews()
    }
  }, [onLoadMorePreviews])

  return (
    <>
      <SearchBar
        value={query}
        onValueChange={onQueryChange}
        placeholder="Search Google Fonts…"
        aria-label="Search Google Fonts"
        className={styles.pickerSearch}
        autoFocus
      />

      <FilterBar<string>
        items={CATEGORY_FILTERS}
        value={category}
        onValueChange={onCategoryChange}
        groupLabel="Filter by category"
      />

      {loadError ? (
        <p role="alert" className={styles.errorAlert}>{loadError}</p>
      ) : loading ? (
        <p className={styles.pickerInfo}>Loading Google Fonts…</p>
      ) : families.length === 0 ? (
        <p className={styles.pickerEmpty}>No fonts match "{query}".</p>
      ) : (
        <div
          ref={listRef}
          className={styles.pickerList}
          role="listbox"
          aria-label="Google fonts"
          onScroll={handleScroll}
        >
          {families.map((entry) => {
            const installed = installedFamilies.has(entry.family.toLowerCase())
            return (
              <button
                key={entry.family}
                type="button"
                role="option"
                aria-selected={false}
                aria-label={`${entry.family}${installed ? ' (already installed)' : ''}`}
                disabled={installed}
                className={styles.pickerItem}
                onClick={() => { if (!installed) onPick(entry) }}
              >
                <span
                  className={styles.pickerName}
                  // Inline font-family is the entire point: each tile renders
                  // its name in its own font once the lazy-loaded preview
                  // CSS resolves. Falls back to system sans until then.
                  style={{ fontFamily: `"${entry.family}", system-ui, sans-serif` } as CSSProperties}
                >
                  {entry.family}
                </span>
                <span className={styles.pickerMeta}>
                  <span className={styles.pickerCategory}>{entry.category}</span>
                  {installed && (
                    <span className={styles.pickerInstalled}>Installed</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

// ─── Variants + subsets step ───────────────────────────────────────────────

interface VariantsAndSubsetsStepProps {
  family: GoogleFontFamilyDto
  pickedVariants: string[]
  pickedSubsets: string[]
  onPickedVariantsChange: (variants: string[]) => void
  onPickedSubsetsChange: (subsets: string[]) => void
}

const DEFAULT_PREVIEW_TEXT = 'The quick brown fox jumps over the lazy dog'

function VariantsAndSubsetsStep({
  family,
  pickedVariants,
  pickedSubsets,
  onPickedVariantsChange,
  onPickedSubsetsChange,
}: VariantsAndSubsetsStepProps) {
  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT)
  const sortedVariants = useMemo(
    () => [...family.variants].sort(compareVariants),
    [family.variants],
  )
  const sortedSubsets = useMemo(() => [...family.subsets].sort(), [family.subsets])
  const variantsSet = useMemo(() => new Set(pickedVariants), [pickedVariants])
  const subsetsSet = useMemo(() => new Set(pickedSubsets), [pickedSubsets])

  // Pick the heaviest selected weight as the hero preview's font-weight so the
  // user immediately sees what their highest-weight choice looks like. Defaults
  // to 400 if nothing's selected.
  const heroWeight = useMemo(() => {
    const weights = pickedVariants
      .map((v) => parseVariant(v)?.weight)
      .filter((w): w is number => typeof w === 'number')
    return weights.length > 0 ? Math.max(...weights) : 400
  }, [pickedVariants])

  function toggleVariant(variant: string) {
    if (variantsSet.has(variant)) {
      onPickedVariantsChange(pickedVariants.filter((v) => v !== variant))
    } else {
      onPickedVariantsChange([...pickedVariants, variant].sort(compareVariants))
    }
  }

  function toggleSubset(subset: string) {
    if (subsetsSet.has(subset)) {
      onPickedSubsetsChange(pickedSubsets.filter((s) => s !== subset))
    } else {
      onPickedSubsetsChange([...pickedSubsets, subset].sort())
    }
  }

  const allVariantsPicked = pickedVariants.length === sortedVariants.length
  const allSubsetsPicked = pickedSubsets.length === sortedSubsets.length

  return (
    <>
      {/* Hero preview — large editable pangram in the actual font. Uses
          contenteditable rather than a textarea so the rendered text can
          breathe (no scrollbar / no input chrome). */}
      <div className={styles.preview}>
        <div className={styles.previewMeta}>
          <span className={styles.previewFamilyName}>{family.family}</span>
          <span className={styles.previewCategory}>{family.category}</span>
        </div>
        <p
          className={styles.previewSample}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          aria-label="Preview text"
          style={{
            fontFamily: `"${family.family}", system-ui, sans-serif`,
            fontWeight: heroWeight,
          } as CSSProperties}
          onInput={(event) => {
            const next = event.currentTarget.textContent ?? ''
            // Don't store an empty preview — keeps the placeholder reading
            // sensible and the contentEditable area visible.
            setPreviewText(next || DEFAULT_PREVIEW_TEXT)
          }}
        >
          {previewText}
        </p>
      </div>

      {/* Variants — each row renders the variant's own weight + style as a
          live sample so the user sees the font, not just a label. */}
      <div className={styles.dialogSection}>
        <div className={styles.dialogSectionHeader}>
          <h3 className={styles.dialogSectionTitle}>
            Variants ({pickedVariants.length}/{sortedVariants.length})
          </h3>
          <button
            type="button"
            className={styles.dialogSectionSelectAll}
            onClick={() =>
              onPickedVariantsChange(allVariantsPicked ? [] : [...sortedVariants])
            }
          >
            {allVariantsPicked ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <ul className={styles.variantList} role="list">
          {sortedVariants.map((variant) => {
            const parsed = parseVariant(variant)
            const checked = variantsSet.has(variant)
            return (
              <li key={variant}>
                <label
                  className={styles.variantRow}
                  data-checked={checked ? 'true' : undefined}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleVariant(variant)}
                    aria-label={variantLabel(variant)}
                  />
                  <span
                    className={styles.variantSample}
                    style={{
                      fontFamily: `"${family.family}", system-ui, sans-serif`,
                      fontWeight: parsed?.weight ?? 400,
                      fontStyle: parsed?.italic ? 'italic' : 'normal',
                    } as CSSProperties}
                  >
                    {variantLabel(variant)}
                  </span>
                  <span className={styles.variantWeightLabel}>
                    {parsed?.weight ?? variant}{parsed?.italic ? ' i' : ''}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      </div>

      {/* Subsets — pill toggles. Aria-pressed encodes the on/off state so
          assistive tech reads it as a toggle button, not a checkbox. */}
      <div className={styles.dialogSection}>
        <div className={styles.dialogSectionHeader}>
          <h3 className={styles.dialogSectionTitle}>
            Subsets ({pickedSubsets.length}/{sortedSubsets.length})
          </h3>
          <button
            type="button"
            className={styles.dialogSectionSelectAll}
            onClick={() =>
              onPickedSubsetsChange(allSubsetsPicked ? [] : [...sortedSubsets])
            }
          >
            {allSubsetsPicked ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <ul className={styles.subsetChips} role="list">
          {sortedSubsets.map((subset) => {
            const checked = subsetsSet.has(subset)
            return (
              <li key={subset}>
                <button
                  type="button"
                  className={styles.subsetChip}
                  aria-pressed={checked}
                  onClick={() => toggleSubset(subset)}
                >
                  {subset}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </>
  )
}

/**
 * Format a variant tag for the checkbox label.
 *   "400"        → "Regular 400"
 *   "700italic"  → "Bold 700 Italic"
 *   "300italic"  → "Light 300 Italic"
 */
function variantLabel(variant: string): string {
  const parsed = parseVariant(variant)
  if (!parsed) return variant
  const weightName = WEIGHT_NAMES[parsed.weight] ?? `Weight ${parsed.weight}`
  return parsed.italic ? `${weightName} Italic` : weightName
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
}
