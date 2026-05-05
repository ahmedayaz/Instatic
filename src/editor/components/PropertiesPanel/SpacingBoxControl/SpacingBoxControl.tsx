/**
 * SpacingBoxControl — visual box-model editor for padding & margin.
 *
 * Replaces the verbose 10-row stack (padding, paddingTop/Right/Bottom/Left,
 * margin, marginTop/Right/Bottom/Left) with a unified, token-aware widget:
 *
 *   ┌─────────────── Margin ────────────────┐
 *   │  \           [ md ]            /       │
 *   │    \                         /         │
 *   │      ┌─── Padding ────┐                │
 *   │ [sm] │  \   [md]   /  │   [sm]         │
 *   │      │ [m]    \   /   │                │
 *   │      │           X    │                │
 *   │      │ [m]    /  \    │                │
 *   │      │  /  [md]    \  │                │
 *   │      └────────────────┘                │
 *   │    /                         \         │
 *   │  /           [ md ]            \       │
 *   └────────────────────────────────────────┘
 *
 * Outer dashed rectangle = margin, inner solid rectangle = padding,
 * each crossed by corner-to-corner diagonals (dashed for margin, solid
 * for padding). The widget is locked to a square aspect ratio with the
 * padding box centred at exactly 50% of the margin box, so the diagonals
 * always pass through the padding's outer corners — classic Chrome
 * DevTools box-model look. Side inputs sit at the 12.5% line of each
 * axis so they're geometrically centred in their respective segments.
 *
 * Each side input is token-aware: typing `m` (or any step label) auto-
 * completes to the matching framework spacing variable (`var(--space-m)`).
 * The link button at the top of each box mirrors edits across all four
 * sides.
 *
 * Storage model:
 *   - The control owns paddingTop/Right/Bottom/Left and marginTop/Right/
 *     Bottom/Left as the source of truth.
 *   - The legacy `padding` / `margin` shorthand values are read for initial
 *     display (parsed into 4 sides) and **cleared** on first edit so the
 *     stored shape stays unambiguous.
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore } from '@core/editor-store/store'
import type { CSSPropertyBag } from '@core/page-tree/schemas'
import type { FrameworkSpacingGroup } from '@core/framework/schemas'
import { getVariableName } from '@core/framework/scale'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { cn } from '@ui/cn'
import styles from './SpacingBoxControl.module.css'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

const SIDES = ['top', 'right', 'bottom', 'left'] as const
type Side = (typeof SIDES)[number]
type Box = 'padding' | 'margin'

interface SpacingBoxControlProps {
  /** Stored values at the active breakpoint (no inherited base merge). */
  storedStyles: Record<string, unknown>
  /** Effective values including base-breakpoint inheritance — used for placeholders. */
  currentStyles: Record<string, unknown>
  onChange: (
    property: keyof CSSPropertyBag,
    value: string | number | undefined,
  ) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /**
   * Apply a transient style preview while a user hovers a token
   * suggestion. The preview is layered on top of the active class via
   * a higher-specificity rule and is NOT committed to history.
   */
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  /** Clear any active preview. Called on hover-leave / menu close. */
  onClearPreview?: () => void
}

interface SpacingToken {
  /** Step label (e.g. "md", "2xl"). */
  step: string
  /** CSS variable name including leading `--` (e.g. "--space-md"). */
  varName: string
  /** Full value expression to write into a property (e.g. "var(--space-md)"). */
  valueExpr: string
  /** Group display name — shown in autocomplete hints when groups > 1. */
  groupName: string
  /** Naming-convention prefix (e.g. "space"). */
  prefix: string
}

// ---------------------------------------------------------------------------
// Property key helpers
// ---------------------------------------------------------------------------

function sideKey(box: Box, side: Side): keyof CSSPropertyBag {
  // Build "paddingTop", "marginRight", etc.
  return `${box}${side[0].toUpperCase()}${side.slice(1)}` as keyof CSSPropertyBag
}

function shorthandKey(box: Box): keyof CSSPropertyBag {
  return box
}

// ---------------------------------------------------------------------------
// Shorthand parsing — turns "12px 8px" into {top:12px, right:8px, bottom:12px, left:8px}
// ---------------------------------------------------------------------------

function parseShorthand(input: string): Record<Side, string> {
  const fallback = { top: '', right: '', bottom: '', left: '' }
  const trimmed = input.trim()
  if (!trimmed) return fallback

  // Split on whitespace but keep var(--…) and calc(…) tokens intact.
  const parts: string[] = []
  let depth = 0
  let buf = ''
  for (const ch of trimmed) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && /\s/.test(ch)) {
      if (buf) {
        parts.push(buf)
        buf = ''
      }
    } else {
      buf += ch
    }
  }
  if (buf) parts.push(buf)

  switch (parts.length) {
    case 1:
      return { top: parts[0], right: parts[0], bottom: parts[0], left: parts[0] }
    case 2:
      return { top: parts[0], right: parts[1], bottom: parts[0], left: parts[1] }
    case 3:
      return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[1] }
    case 4:
      return { top: parts[0], right: parts[1], bottom: parts[2], left: parts[3] }
    default:
      return fallback
  }
}

// ---------------------------------------------------------------------------
// Spacing tokens — read from framework settings, expanded into autocomplete-ready entries
// ---------------------------------------------------------------------------

function expandTokensFromGroups(
  groups: ReadonlyArray<FrameworkSpacingGroup>,
): SpacingToken[] {
  const tokens: SpacingToken[] = []
  for (const group of groups) {
    if (group.isDisabled) continue
    const steps = group.steps
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const step of steps) {
      const varName = getVariableName(group.namingConvention, step)
      tokens.push({
        step,
        varName,
        valueExpr: `var(${varName})`,
        groupName: group.name,
        prefix: group.namingConvention,
      })
    }
  }
  return tokens
}

/**
 * Interprets the user's typed value into a final CSS expression.
 * Rules (in order):
 *   1. empty → undefined (means: clear the side)
 *   2. starts with a CSS function (`var`, `calc`, `min`, `max`, `clamp`) → keep as-is
 *   3. matches a known token step (case-insensitive) → resolve to `var(...)`
 *   4. matches a number-only string → append `px` (the convention for spacing)
 *   5. otherwise → keep as-is (lets users type "auto", "1rem", "5%", "50vh", …)
 */
function resolveTypedValue(
  raw: string,
  tokens: ReadonlyArray<SpacingToken>,
): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (/^(var|calc|min|max|clamp|env)\s*\(/i.test(trimmed)) return trimmed

  const match = tokens.find(
    (t) => t.step.toLowerCase() === trimmed.toLowerCase(),
  )
  if (match) return match.valueExpr

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return `${trimmed}px`
  return trimmed
}

/**
 * Heuristic: does the typed value look like a complete / partial *direct*
 * CSS value (number + unit, keyword like "auto") rather than a token-step
 * name? Used to hide the suggestion dropdown so direct values can be typed
 * and committed without the menu intercepting clicks.
 */
function looksLikeDirectValue(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  // Starts with a digit, decimal point, minus, or `+` → numeric value.
  if (/^[\d.\-+]/.test(trimmed)) return true
  // Common CSS keywords for sizing.
  if (/^(auto|none|inherit|initial|unset|revert|max-content|min-content|fit-content)$/i.test(trimmed)) {
    return true
  }
  // CSS functions are also direct values.
  if (/^(var|calc|min|max|clamp|env)\s*\(/i.test(trimmed)) return true
  return false
}

/**
 * Should the current draft be live-previewed on the canvas while the user
 * is still typing? We err on the side of showing the change immediately
 * (matches Figma / Webflow / browser devtools behaviour), but skip cases
 * where the value is provably mid-typing and would render as garbage.
 *
 * Rules:
 *   - empty                     → previewable (means: clear the side)
 *   - exact token match         → previewable (resolves to var(--…))
 *   - number with optional unit → previewable (lets browser ignore unknown units)
 *   - whitelisted CSS keyword   → previewable
 *   - CSS function call         → previewable ONLY when parens are balanced
 *   - bare letters (e.g. "m" before tokens load, "au" → "auto")
 *                               → previewable: cheap, browser ignores garbage
 *
 * We deliberately don't try to be clever about partial keywords like "au"
 * vs "auto" — the browser silently drops invalid CSS values, so a brief
 * flicker is harmless and nothing breaks.
 */
function isLivePreviewable(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return true
  // Reject incomplete CSS function calls — `var(--spa` would write a
  // syntactically broken declaration that the engine rejects loudly.
  if (/^[a-z-]+\s*\(/i.test(trimmed)) {
    if (!trimmed.endsWith(')')) return false
    let depth = 0
    for (const ch of trimmed) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      if (depth < 0) return false
    }
    return depth === 0
  }
  return true
}

/**
 * Inverse of resolveTypedValue — produces the short-form display string
 * for a stored CSS value, so `var(--space-md)` shows as `md`.
 */
function displayValue(
  value: string | undefined,
  tokens: ReadonlyArray<SpacingToken>,
): string {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const match = tokens.find((t) => t.varName === extractVarName(trimmed))
  if (match) return match.step
  return trimmed
}

function extractVarName(value: string): string | null {
  const m = value.match(/^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)\s*$/)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// Side state — derived effective value per side & per box
// ---------------------------------------------------------------------------

interface BoxState {
  /** Effective per-side values (parsed from explicit side OR shorthand). */
  effective: Record<Side, string>
  /** Whether each side has an explicit stored value (vs derived from shorthand). */
  storedFlags: Record<Side, boolean>
  /** Whether the original shorthand is set (legacy data). */
  hasShorthand: boolean
  /** All four effective values are equal (and at least one is non-empty). */
  isUniform: boolean
}

function computeBoxState(
  storedStyles: Record<string, unknown>,
  box: Box,
): BoxState {
  const shorthand = pickString(storedStyles[shorthandKey(box)])
  const sidesFromShorthand = parseShorthand(shorthand)

  const effective: Record<Side, string> = { top: '', right: '', bottom: '', left: '' }
  const storedFlags: Record<Side, boolean> = {
    top: false,
    right: false,
    bottom: false,
    left: false,
  }

  for (const side of SIDES) {
    const explicit = pickString(storedStyles[sideKey(box, side)])
    if (explicit) {
      effective[side] = explicit
      storedFlags[side] = true
    } else if (sidesFromShorthand[side]) {
      effective[side] = sidesFromShorthand[side]
    }
  }

  const values = SIDES.map((s) => effective[s])
  const hasAny = values.some((v) => v !== '')
  const isUniform = hasAny && values.every((v) => v === values[0])

  return {
    effective,
    storedFlags,
    hasShorthand: shorthand !== '',
    isUniform,
  }
}

function pickString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return `${value}px`
  return ''
}

// ---------------------------------------------------------------------------
// SpacingBoxControl
// ---------------------------------------------------------------------------

export function SpacingBoxControl({
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: SpacingBoxControlProps) {
  const groups = useEditorStore(
    (s) => s.site?.settings.framework?.spacing?.groups,
  )
  const tokens = useMemo(
    () => expandTokensFromGroups(groups ?? []),
    [groups],
  )

  // ── Per-box state ──────────────────────────────────────────────────────
  const padding = useMemo(
    () => computeBoxState(storedStyles, 'padding'),
    [storedStyles],
  )
  const margin = useMemo(
    () => computeBoxState(storedStyles, 'margin'),
    [storedStyles],
  )

  const paddingFallback = useMemo(
    () => computeBoxState(currentStyles, 'padding'),
    [currentStyles],
  )
  const marginFallback = useMemo(
    () => computeBoxState(currentStyles, 'margin'),
    [currentStyles],
  )

  // ── Linked-mode toggles (UI state) ─────────────────────────────────────
  // Default to linked when the four effective sides are uniform (or empty).
  const [paddingLinked, setPaddingLinked] = useState<boolean>(() =>
    padding.isUniform || allEmpty(padding.effective),
  )
  const [marginLinked, setMarginLinked] = useState<boolean>(() =>
    margin.isUniform || allEmpty(margin.effective),
  )

  // Auto-relink when external changes (undo/breakpoint switch, chip-apply
  // while split) bring the four sides back into uniform shape. Update during
  // render — React 19 idiom — instead of in an effect.
  // We don't auto-unlink: the user opted into split-mode deliberately.
  if (!paddingLinked && padding.isUniform) setPaddingLinked(true)
  if (!marginLinked && margin.isUniform) setMarginLinked(true)

  // ── Last-focused side (for chip-apply target) ──────────────────────────
  const [focused, setFocused] = useState<{ box: Box; side: Side } | null>(null)

  // ── Apply value to a box ───────────────────────────────────────────────
  const applyValue = useCallback(
    (box: Box, side: Side | 'all', resolved: string | undefined) => {
      const isLinked = box === 'padding' ? paddingLinked : marginLinked
      const sidesToWrite: Side[] =
        side === 'all' || isLinked ? [...SIDES] : [side]

      // Always clear the legacy shorthand so the stored shape is unambiguous.
      onChange(shorthandKey(box), undefined)

      for (const s of sidesToWrite) {
        onChange(sideKey(box, s), resolved)
      }
    },
    [paddingLinked, marginLinked, onChange],
  )

  // ── Clear a box ────────────────────────────────────────────────────────
  const clearBox = useCallback(
    (box: Box) => {
      onRemove(shorthandKey(box))
      for (const s of SIDES) onRemove(sideKey(box, s))
    },
    [onRemove],
  )

  // ── Preview value (transient, not history-tracked) ─────────────────────
  const previewValue = useCallback(
    (box: Box, side: Side, resolved: string | undefined) => {
      if (!onPreview) return
      const isLinked = box === 'padding' ? paddingLinked : marginLinked
      const sidesToWrite: Side[] = isLinked ? [...SIDES] : [side]
      const patch: Partial<CSSPropertyBag> = {}
      for (const s of sidesToWrite) {
        // Cast to never because CSSPropertyBag values are typed per-key;
        // we trust the resolved value matches the property's expected type.
        ;(patch as Record<string, unknown>)[sideKey(box, s)] = resolved
      }
      onPreview(patch)
    },
    [paddingLinked, marginLinked, onPreview],
  )

  const clearPreview = useCallback(() => {
    onClearPreview?.()
  }, [onClearPreview])

  return (
    <div className={styles.root}>
      <SpacingBox
        box="margin"
        label="Margin"
        state={margin}
        fallback={marginFallback}
        linked={marginLinked}
        onToggleLinked={() => setMarginLinked((v) => !v)}
        focused={focused?.box === 'margin' ? focused.side : null}
        setFocused={(side) => setFocused({ box: 'margin', side })}
        tokens={tokens}
        onSideValue={(side, resolved) => applyValue('margin', side, resolved)}
        onSidePreview={(side, resolved) => previewValue('margin', side, resolved)}
        onClearPreview={clearPreview}
        onClear={() => clearBox('margin')}
        nested={
          <SpacingBox
            box="padding"
            label="Padding"
            state={padding}
            fallback={paddingFallback}
            linked={paddingLinked}
            onToggleLinked={() => setPaddingLinked((v) => !v)}
            focused={focused?.box === 'padding' ? focused.side : null}
            setFocused={(side) => setFocused({ box: 'padding', side })}
            tokens={tokens}
            onSideValue={(side, resolved) =>
              applyValue('padding', side, resolved)
            }
            onSidePreview={(side, resolved) =>
              previewValue('padding', side, resolved)
            }
            onClearPreview={clearPreview}
            onClear={() => clearBox('padding')}
          />
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// SpacingBox — one of margin / padding
// ---------------------------------------------------------------------------

interface SpacingBoxProps {
  box: Box
  label: string
  state: BoxState
  fallback: BoxState
  linked: boolean
  onToggleLinked: () => void
  focused: Side | null
  setFocused: (side: Side) => void
  tokens: ReadonlyArray<SpacingToken>
  onSideValue: (side: Side, resolved: string | undefined) => void
  onSidePreview: (side: Side, resolved: string | undefined) => void
  onClearPreview: () => void
  onClear: () => void
  nested?: React.ReactNode
}

function SpacingBox({
  box,
  label,
  state,
  fallback,
  linked,
  onToggleLinked,
  focused,
  setFocused,
  tokens,
  onSideValue,
  onSidePreview,
  onClearPreview,
  onClear,
  nested,
}: SpacingBoxProps) {
  // Set count (used to enable/disable Clear button).
  const setCount = SIDES.filter((s) => state.storedFlags[s]).length + (state.hasShorthand ? 1 : 0)

  return (
    <div className={cn(styles.box, styles[`box--${box}`])} data-linked={linked ? 'true' : undefined}>
      <div className={styles.boxHeader}>
        <span className={styles.boxLabel}>{label}</span>
        <div className={styles.boxHeaderActions}>
          <Button
            type="button"
            variant="ghost"
            size="micro"
            iconOnly
            onClick={onToggleLinked}
            aria-pressed={linked}
            aria-label={linked ? `Unlink ${label} sides` : `Link all ${label} sides`}
            tooltip={linked ? 'Linked — edits all four sides' : 'Split — edit each side separately'}
            className={cn(styles.linkBtn, linked && styles.linkBtnActive)}
          >
            <LinkIcon size={12} aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="micro"
            iconOnly
            onClick={onClear}
            disabled={setCount === 0}
            aria-label={`Clear ${label}`}
            tooltip={`Clear ${label}`}
            className={styles.clearBtn}
          >
            <CloseIcon size={12} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className={styles.boxBody}>
        {/* Corner-to-corner diagonals — dashed for margin (echoes the
         *  dashed margin border), solid for padding. The padding box's
         *  opaque-ish background covers the margin diagonals where they
         *  overlap, producing a continuous "diagonal that turns dashed
         *  beyond the padding boundary" effect. */}
        <BoxDiagonals dashed={box === 'margin'} />

        {SIDES.map((side) => (
          <SideInput
            key={side}
            box={box}
            side={side}
            value={state.effective[side]}
            placeholder={fallback.effective[side]}
            isSet={state.storedFlags[side] || state.hasShorthand}
            isLinkedTarget={linked && state.isUniform}
            isFocusedTarget={focused === side}
            tokens={tokens}
            onCommit={(resolved) => onSideValue(side, resolved)}
            onFocus={() => setFocused(side)}
            onPreview={(resolved) => onSidePreview(side, resolved)}
            onClearPreview={onClearPreview}
          />
        ))}

        {/* Centre cell — only rendered when there's a nested box to host
         *  (margin holds the padding box). Padding has nothing inside its
         *  centre — the diagonals do the visual work and free the space
         *  for the side inputs to read clearly. */}
        {nested && <div className={styles.boxInner}>{nested}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// BoxDiagonals — SVG overlay drawing two corner-to-corner diagonals.
// preserveAspectRatio="none" stretches the lines to the actual box size so
// they reach exact corners. Stroke width is held in CSS.
// ---------------------------------------------------------------------------

function BoxDiagonals({ dashed }: { dashed: boolean }) {
  return (
    <svg
      className={styles.boxDiagonals}
      aria-hidden="true"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <line
        x1="0"
        y1="0"
        x2="100"
        y2="100"
        className={cn(styles.diagonal, dashed && styles.diagonalDashed)}
      />
      <line
        x1="100"
        y1="0"
        x2="0"
        y2="100"
        className={cn(styles.diagonal, dashed && styles.diagonalDashed)}
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// SideInput — token-aware input on a box edge
// ---------------------------------------------------------------------------

interface SideInputProps {
  box: Box
  side: Side
  value: string
  placeholder: string
  isSet: boolean
  isLinkedTarget: boolean
  isFocusedTarget: boolean
  tokens: ReadonlyArray<SpacingToken>
  onCommit: (resolved: string | undefined) => void
  onFocus: () => void
  onPreview: (resolved: string | undefined) => void
  onClearPreview: () => void
}

function SideInput({
  box,
  side,
  value,
  placeholder,
  isSet,
  isLinkedTarget,
  isFocusedTarget,
  tokens,
  onCommit,
  onFocus,
  onPreview,
  onClearPreview,
}: SideInputProps) {
  const display = displayValue(value, tokens)
  const placeholderDisplay = displayValue(placeholder, tokens) || '0'

  // Local draft so we don't fire onChange on every keystroke (which would
  // round-trip through Immer + re-validate every press).
  const [draft, setDraft] = useState(display)
  const [isEditing, setIsEditing] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)

  // Sync external value → draft when not actively editing. React 19 idiom:
  // adjust state during render by tracking the previous external value.
  const [lastExternalDisplay, setLastExternalDisplay] = useState(display)
  if (!isEditing && display !== lastExternalDisplay) {
    setLastExternalDisplay(display)
    setDraft(display)
  }

  // Filter tokens by typed prefix for the autocomplete dropdown.
  // When there's no query, the "Suggested" section is hidden entirely —
  // returning [] here lets the "Tokens" section render the full scale.
  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase()
    if (!q) return []
    return tokens
      .filter(
        (t) =>
          t.step.toLowerCase().startsWith(q) ||
          t.step.toLowerCase().includes(q),
      )
      .slice(0, 8)
  }, [draft, tokens])

  const commit = useCallback(
    (raw: string) => {
      const resolved = resolveTypedValue(raw, tokens)
      onClearPreview()
      onCommit(resolved)
      setIsEditing(false)
    },
    [tokens, onCommit, onClearPreview],
  )

  // Preview a hovered token's value on the canvas. Only the resolved value
  // is forwarded — the parent decides which sides the preview affects
  // (single side or all four, depending on the linked toggle).
  const previewToken = useCallback(
    (rawValue: string) => {
      const resolved = resolveTypedValue(rawValue, tokens)
      onPreview(resolved)
    },
    [tokens, onPreview],
  )

  // Live-preview a typed draft. Updates the canvas on every keystroke so
  // users see their values applied without having to press Enter / Tab /
  // blur — matches the behaviour of every modern visual builder. When the
  // current draft is provably incomplete (e.g. `var(--spa`), we skip the
  // update and keep the last valid preview on screen instead of writing
  // garbage to the engine.
  const previewDraft = useCallback(
    (rawValue: string) => {
      if (!isLivePreviewable(rawValue)) return
      const resolved = resolveTypedValue(rawValue, tokens)
      onPreview(resolved)
    },
    [tokens, onPreview],
  )

  // Hide the dropdown when the user is typing a direct CSS value
  // (numbers, units, "auto", calc(...), etc.) — non-token typing should
  // commit on Enter/Tab/Blur without the menu intercepting outside-clicks.
  const isDirectValue = looksLikeDirectValue(draft)
  const showMenu = isEditing && !isDirectValue

  // Split tokens into "Suggested" (matching the typed query) and "All" (the
  // remaining tokens) so users always see the full scale even when they
  // haven't started typing.
  const queryTrim = draft.trim().toLowerCase()
  const suggestedSet = new Set(suggestions.map((t) => t.varName))
  const allOthers = tokens.filter((t) => !suggestedSet.has(t.varName))
  const showSuggestedHeader = queryTrim.length > 0 && suggestions.length > 0
  const showAllHeader = allOthers.length > 0

  return (
    <div
      className={cn(
        styles.segment,
        styles[`segment--${side}`],
        isLinkedTarget && styles.segmentLinked,
        isFocusedTarget && styles.segmentFocused,
      )}
      data-state={isSet ? 'set' : 'unset'}
      onClick={() => inputRef.current?.focus()}
    >
      <Input
        ref={inputRef}
        type="text"
        fieldSize="xs"
        value={draft}
        placeholder={placeholderDisplay}
        spellCheck={false}
        autoComplete="off"
        aria-label={`${box} ${side}`}
        className={styles.sideInput}
        onFocus={() => {
          setIsEditing(true)
          onFocus()
        }}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          previewDraft(next)
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(display)
            setIsEditing(false)
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Tab') {
            // Allow default tab behaviour but commit the current value.
            commit((e.target as HTMLInputElement).value)
          }
        }}
      />

      {showMenu &&
        createPortal(
          <ContextMenu
            anchorRef={inputRef}
            side="auto"
            align="start"
            offset={4}
            width={Math.max(inputRef.current?.getBoundingClientRect().width ?? 132, 132)}
            minWidth={132}
            ariaLabel={`${box} ${side} spacing tokens`}
            triggerRef={inputRef}
            onClose={() => {
              onClearPreview()
            }}
            onMouseLeave={() => onClearPreview()}
          >
            {showSuggestedHeader && (
              <div className={styles.sideMenuHeader} aria-hidden="true">
                Suggested
              </div>
            )}
            {showSuggestedHeader &&
              suggestions.map((t) => (
                <ContextMenuItem
                  key={`suggested-${t.varName}`}
                  onMouseDown={(e) => {
                    // mousedown beats blur — commits the token before the input loses focus.
                    e.preventDefault()
                    commit(t.step)
                  }}
                  onMouseEnter={() => previewToken(t.step)}
                  className={styles.sideMenuItem}
                >
                  <span className={styles.sideMenuToken}>{t.step}</span>
                  <span className={styles.sideMenuVar} title={t.valueExpr}>
                    {t.varName}
                  </span>
                </ContextMenuItem>
              ))}
            {showAllHeader && (
              <div className={styles.sideMenuHeader} aria-hidden="true">
                {showSuggestedHeader ? 'All tokens' : 'Tokens'}
              </div>
            )}
            {(showAllHeader ? allOthers : tokens).map((t) => (
              <ContextMenuItem
                key={`all-${t.varName}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  commit(t.step)
                }}
                onMouseEnter={() => previewToken(t.step)}
                className={styles.sideMenuItem}
              >
                <span className={styles.sideMenuToken}>{t.step}</span>
                <span className={styles.sideMenuVar} title={t.valueExpr}>
                  {t.varName}
                </span>
              </ContextMenuItem>
            ))}
          </ContextMenu>,
          document.body,
        )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allEmpty(map: Record<Side, string>): boolean {
  return SIDES.every((s) => !map[s])
}
