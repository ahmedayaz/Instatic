/**
 * ClassPicker — always-visible class chip manager.
 *
 * Replaces ClassesTab in the Properties Panel redesign (Spec #659 §2).
 * Now permanently visible (no tab click required — PP-2 acceptance criterion).
 *
 * Changes vs. ClassesTab:
 *   - Pill right-click context menu owns reorder/rename/remove actions — PP-8
 *   - Chip × has tooltip="Remove from this element" — PP-9
 *   - Class assignment UI lives directly under the selected element header
 *   - Uses reorderNodeClass store action (new in classSlice — Task #456)
 *
 * Architecture:
 *   - Always mounted when a node is selected (PropertiesPanel renders it unconditionally)
 *   - Active class styling is rendered by PropertiesPanel below the header class strip
 *   - Guideline #242: reorderNodeClass no-ops at array boundaries
 *   - Guideline #350: pixel-art-icons only; CloseIcon for × button
 *   - Constraint #451: X/Twitter logo icon is prohibited (use CloseIcon for × buttons)
 */

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useEditorStore, selectActiveCanvasPage } from '@core/editor-store/store'
import { useEditorPreference } from '../../preferences/editorPreferences'
import { Button } from '@ui/components/Button'
import { useDialogEscape } from '@ui/lib/useDialogEscape'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@ui/components/ContextMenu'
import { Input } from '@ui/components/Input'
import { ChevronUpIcon } from 'pixel-art-icons/icons/chevron-up'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { CornerDownLeftIcon } from 'pixel-art-icons/icons/corner-down-left'
import { EditIcon } from 'pixel-art-icons/icons/edit'
import { cn } from '@ui/cn'
import {
  generatedClassKindLabel,
  isGeneratedClassLocked,
  isUserVisibleClass,
} from '@core/page-tree/classUtils'
import { pillAccent } from '@ui/pillAccent'
import { recordClassUsage } from '../../preferences/classUsage'
import { useClassPickerSuggestions } from './useClassPickerSuggestions'
import type { CSSClass } from '@core/page-tree/schemas'
import dialogStyles from '../SiteCreateDialog/SiteCreateDialog.module.css'
import styles from './ClassPicker.module.css'

interface ClassContextMenuState {
  x: number
  y: number
  classId: string
}

// ---------------------------------------------------------------------------
// pillAccent lives in src/ui/pillAccent.ts so editor and admin surfaces share
// the exact same hash (so a "header" tag and a "header" class always pick the
// same tint).
// ---------------------------------------------------------------------------

function keyboardMenuPosition(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left + Math.min(rect.width - 8, 24),
    y: rect.top + Math.min(rect.height - 8, 24),
  }
}



// ---------------------------------------------------------------------------
// ClassPicker
// ---------------------------------------------------------------------------

export interface ClassPickerHandle {
  /** Focus the 'Add or create class…' input. */
  focusInput: () => void
}

interface ClassPickerProps {
  nodeId: string
  /**
   * Optional inline action rendered to the right of the 'Add or create class…'
   * input as a sibling cell in the same two-column row. The suggestions
   * dropdown spans both cells so search results can use the full row width.
   */
  trailingAction?: ReactNode
}

export const ClassPicker = forwardRef<ClassPickerHandle, ClassPickerProps>(
function ClassPickerInner({ nodeId, trailingAction }: ClassPickerProps, ref) {
  const site = useEditorStore((s) => s.site)
  const node = useEditorStore(
    useCallback(
      (s) => selectActiveCanvasPage(s)?.nodes[nodeId] ?? null,
      [nodeId],
    ),
  )
  const activeClassId = useEditorStore((s) => s.activeClassId)
  const setActiveClass = useEditorStore((s) => s.setActiveClass)
  const addNodeClass = useEditorStore((s) => s.addNodeClass)
  const removeNodeClass = useEditorStore((s) => s.removeNodeClass)
  const createClass = useEditorStore((s) => s.createClass)
  const renameClass = useEditorStore((s) => s.renameClass)
  const reorderNodeClass = useEditorStore((s) => s.reorderNodeClass)
  const setPreviewNodeClass = useEditorStore((s) => s.setPreviewNodeClass)
  const clearPreviewNodeClass = useEditorStore((s) => s.clearPreviewNodeClass)

  const [query, setQuery] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [contextMenu, setContextMenu] = useState<ClassContextMenuState | null>(null)
  const [renameTarget, setRenameTarget] = useState<CSSClass | null>(null)
  // Index of the suggestion currently highlighted via Arrow Up/Down.
  // -1 means "no explicit selection" — Enter then falls back to the typed
  // query (find existing or create new). Reset on every query change so the
  // user's most recent typing always dictates Enter behaviour by default.
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  // Shared "preview-on-hover" preference — also gates token + variable
  // autocomplete previews in other property controls (e.g. SpacingBoxControl).
  // Renamed from `classHoverPreview`; the toggle now covers every kind of
  // transient hover preview the Properties panel exposes.
  const hoverPreviewEnabled = useEditorPreference('hoverPreview')

  const inputRef = useRef<HTMLInputElement>(null)
  // The dropdown anchors to the input but takes the *row* width so search
  // results can use both columns when a trailingAction is present.
  const inputRowRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(ref, () => ({
    focusInput: () => {
      inputRef.current?.focus()
    },
  }))

  const assignedIds = node?.classIds ?? []
  const visibleAssignedIds = assignedIds.filter((id) => isUserVisibleClass(site?.classes[id]))
  const allClasses = Object.values(site?.classes ?? {}).filter(isUserVisibleClass)
  const contextClass = contextMenu ? site?.classes[contextMenu.classId] ?? null : null
  const contextClassIndex = contextMenu ? visibleAssignedIds.indexOf(contextMenu.classId) : -1

  // All suggestion-related derivations live in `useClassPickerSuggestions` so
  // this component stays focused on UI orchestration.
  const {
    candidates,
    candidatesById,
    isEmptyQuery,
    filteredSuggestions,
    recentIds,
    frequentIds,
    remainingCandidates,
    shouldShowAllSection,
    surfacedCount,
    flatNavIds,
    highlightedClassId,
    canCreateNew,
    hasSubmittableQuery,
    submitTooltip,
    exactMatchedClass,
    exactMatchAlreadyAssigned,
  } = useClassPickerSuggestions({
    allClasses,
    assignedIds,
    query,
    highlightedIndex,
    siteId: site?.id ?? null,
  })

  const suggestions = isEmptyQuery ? candidates : filteredSuggestions

  const openSuggestions = useCallback(() => {
    setShowSuggestions(true)
  }, [])

  const siteId = site?.id ?? null

  const handleAddExisting = useCallback(
    (classId: string) => {
      addNodeClass(nodeId, classId)
      setActiveClass(classId)
      clearPreviewNodeClass(nodeId, classId)
      if (siteId) recordClassUsage(siteId, classId)
      setQuery('')
      setShowSuggestions(false)
    },
    [nodeId, addNodeClass, setActiveClass, clearPreviewNodeClass, siteId],
  )

  const handleCreateAndAdd = useCallback(() => {
    const name = query.trim()
    if (!name) return
    try {
      const newClass = createClass(name)
      addNodeClass(nodeId, newClass.id)
      setActiveClass(newClass.id)
      clearPreviewNodeClass(nodeId)
      if (siteId) recordClassUsage(siteId, newClass.id)
      setQuery('')
      setShowSuggestions(false)
    } catch {
      // Class with this name already exists
    }
  }, [query, createClass, addNodeClass, nodeId, setActiveClass, clearPreviewNodeClass, siteId])

  // Shared submit logic for both the Enter key and the trailing enter-icon
  // button. Resolution priority:
  //   1. Arrow-key highlight wins — Enter adds the highlighted suggestion.
  //   2. Otherwise the typed input is the source of truth: an exact-name
  //      match adds that class; a brand-new name creates and adds it.
  //   3. Empty input or already-assigned exact match → no-op.
  // The "Enter adds whatever is in the input" behaviour is what lets a user
  // type "text" and get the class literally named "text", instead of the
  // first ranked suggestion (which would be a `text-*` utility).
  const submitQuery = () => {
    if (highlightedClassId) {
      handleAddExisting(highlightedClassId)
      return
    }
    if (isEmptyQuery) return
    if (exactMatchedClass) {
      if (!exactMatchAlreadyAssigned) handleAddExisting(exactMatchedClass.id)
      return
    }
    if (canCreateNew) handleCreateAndAdd()
  }

  const previewClass = useCallback(
    (classId: string) => {
      if (!hoverPreviewEnabled) return
      setPreviewNodeClass(nodeId, classId)
    },
    [hoverPreviewEnabled, nodeId, setPreviewNodeClass],
  )

  const clearPreviewClass = useCallback(
    (classId: string) => {
      clearPreviewNodeClass(nodeId, classId)
    },
    [clearPreviewNodeClass, nodeId],
  )

  useEffect(() => {
    if (!hoverPreviewEnabled) clearPreviewNodeClass(nodeId)
  }, [hoverPreviewEnabled, clearPreviewNodeClass, nodeId])

  useEffect(() => () => clearPreviewNodeClass(nodeId), [clearPreviewNodeClass, nodeId])

  // Scroll the highlighted suggestion into view inside the dropdown so Arrow
  // Down past the visible window keeps the active row on screen. The
  // ContextMenu manages its own overflow scroller; we don't have to know
  // which element it is — `scrollIntoView({ block: 'nearest' })` walks up
  // the ancestor chain and scrolls only the closest scrollable ancestor.
  //
  // Depends on the primitive `highlightedClassId` (not the `flatNavIds` array)
  // so the effect re-runs only when the highlighted class actually changes,
  // and the dep tracker stays stable without manual `useMemo`.
  useEffect(() => {
    if (!highlightedClassId) return
    const el = document.querySelector<HTMLElement>(
      `[data-class-suggestion-id="${CSS.escape(highlightedClassId)}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightedClassId])

  const closeSuggestions = useCallback(() => {
    clearPreviewNodeClass(nodeId)
    setShowSuggestions(false)
    setHighlightedIndex(-1)
  }, [clearPreviewNodeClass, nodeId])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const openClassContextMenu = useCallback(
    (classId: string, event: MouseEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      setContextMenu({ x: event.clientX, y: event.clientY, classId })
    },
    [],
  )

  const openKeyboardClassContextMenu = useCallback(
    (classId: string, event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      event.preventDefault()
      event.stopPropagation()
      setContextMenu({ ...keyboardMenuPosition(event.currentTarget), classId })
    },
    [],
  )

  const handleRename = useCallback(
    (name: string) => {
      if (!renameTarget) return
      renameClass(renameTarget.id, name)
      setRenameTarget(null)
    },
    [renameClass, renameTarget],
  )

  const removeAssignedClass = useCallback(
    (classId: string) => {
      if (activeClassId === classId) setActiveClass(null)
      removeNodeClass(nodeId, classId)
    },
    [activeClassId, nodeId, removeNodeClass, setActiveClass],
  )

  // Search-input keyboard dispatch. Inline-defined in the JSX would push the
  // component's cognitive complexity past the panel-wide threshold; named here
  // each branch reads as a separate intent.
  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submitQuery()
      return
    }
    if (e.key === 'Escape') {
      closeSuggestions()
      setHighlightedIndex(-1)
      return
    }
    if (e.key === 'ArrowDown') {
      if (flatNavIds.length === 0) return
      e.preventDefault()
      openSuggestions()
      setHighlightedIndex((prev) => {
        const next = prev + 1
        return next >= flatNavIds.length ? 0 : next
      })
      return
    }
    if (e.key === 'ArrowUp') {
      if (flatNavIds.length === 0) return
      e.preventDefault()
      openSuggestions()
      setHighlightedIndex((prev) => (prev <= 0 ? flatNavIds.length - 1 : prev - 1))
    }
  }

  return (
    <div className={styles.container}>
      <PillContextMenuPortal
        contextMenu={contextMenu}
        contextClass={contextClass}
        contextClassIndex={contextClassIndex}
        visibleAssignedCount={visibleAssignedIds.length}
        onClose={closeContextMenu}
        onEdit={(c) => setActiveClass(c.id)}
        onRename={(c) => setRenameTarget(c)}
        onMove={(c, direction) => reorderNodeClass(nodeId, c.id, direction)}
        onRemove={(c) => removeAssignedClass(c.id)}
      />

      {renameTarget && (
        <ClassRenameDialog
          initialValue={renameTarget.name}
          onCancel={() => setRenameTarget(null)}
          onRename={handleRename}
        />
      )}

      {/* Add-class input + optional trailing action (e.g. the Componentize
          button). Two-column grid when trailingAction is provided, single
          column otherwise. The suggestions dropdown anchors to the input but
          spans the full row. */}
      <div ref={inputRowRef} className={styles.inputRow} data-with-action={trailingAction != null}>
        <Input
          ref={inputRef}
          type="text"
          fieldSize="sm"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            // Typing always resets the explicit Arrow-key highlight — the
            // user's most recent intent is the typed string itself.
            setHighlightedIndex(-1)
            openSuggestions()
          }}
          onFocus={openSuggestions}
          onKeyDown={handleSearchKeyDown}
          placeholder="Add or create class…"
          aria-label="Add or create a CSS class"
          trailingSlot={
            <Button
              variant="ghost"
              size="micro"
              iconOnly
              disabled={!hasSubmittableQuery}
              tooltip={submitTooltip}
              aria-label="Submit class"
              onMouseDown={(e) => {
                // Keep focus on the input so the suggestions dropdown stays
                // open across the click and the user can keep typing.
                e.preventDefault()
              }}
              onClick={submitQuery}
            >
              <CornerDownLeftIcon size={11} color="currentColor" aria-hidden="true" />
            </Button>
          }
        />

        {trailingAction}

        {/* Suggestions dropdown — anchored to the input row so it spans both
            the input cell and the trailing-action cell. ContextMenu auto-flips
            between top/bottom based on viewport space. */}
        {showSuggestions && (suggestions.length > 0 || canCreateNew || !isEmptyQuery) && createPortal(
          <ContextMenu
            anchorRef={inputRowRef}
            side="auto"
            align="start"
            offset={6}
            matchAnchorWidth
            minWidth={240}
            // Cap the suggestions list height so long utility lists (e.g. the
            // generated `text-primary-*` / `bg-primary-*` scales) scroll
            // inside the dropdown instead of overflowing the viewport.
            maxHeight={320}
            zIndex={10000}
            ariaLabel="Class suggestions"
            onClose={closeSuggestions}
            triggerRef={inputRef}
          >
            {isEmptyQuery ? (
              <ClassSuggestionSections
                recentIds={recentIds}
                frequentIds={frequentIds}
                remainingClasses={shouldShowAllSection ? remainingCandidates : []}
                showAllHeader={shouldShowAllSection && surfacedCount > 0}
                resolveClass={(id) => candidatesById.get(id) ?? null}
                onPick={handleAddExisting}
                previewClass={previewClass}
                clearPreviewClass={clearPreviewClass}
                highlightedClassId={highlightedClassId}
              />
            ) : (
              <RankedSuggestionsList
                filteredSuggestions={filteredSuggestions}
                highlightedClassId={highlightedClassId}
                canCreateNew={canCreateNew}
                query={query}
                onPick={handleAddExisting}
                onCreateAndAdd={handleCreateAndAdd}
                previewClass={previewClass}
                clearPreviewClass={clearPreviewClass}
              />
            )}
          </ContextMenu>,
          document.body,
        )}
      </div>

      {/* Assigned class chips — rendered below the input row so the
          add-class control and Componentize button sit at the top of the
          panel, with the active chip stack underneath. */}
      {visibleAssignedIds.length > 0 && (
        <div className={styles.pillsContainer}>
          {visibleAssignedIds.map((id) => {
            const cls = site?.classes[id]
            if (!cls) return null
            const isActive = activeClassId === id
            return (
              <AssignedClassPill
                key={id}
                cls={cls}
                isActive={isActive}
                onToggle={() => setActiveClass(isActive ? null : id)}
                onContextMenu={(e) => openClassContextMenu(id, e)}
                onKeyboardContextMenu={(e) => openKeyboardClassContextMenu(id, e)}
                onRemove={() => removeAssignedClass(id)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// PillContextMenuPortal — portals the right-click menu over a single pill.
//
// Render the menu only when both `contextMenu` (the open-state record) and
// `contextClass` (the class it points at) are present. Each action takes the
// `cls` so the parent doesn't re-derive it; the menu always closes after the
// caller's action runs (so callers don't have to remember to call onClose).
// ---------------------------------------------------------------------------

interface PillContextMenuPortalProps {
  contextMenu: ClassContextMenuState | null
  contextClass: CSSClass | null
  contextClassIndex: number
  visibleAssignedCount: number
  onClose: () => void
  onEdit: (cls: CSSClass) => void
  onRename: (cls: CSSClass) => void
  onMove: (cls: CSSClass, direction: 'up' | 'down') => void
  onRemove: (cls: CSSClass) => void
}

function PillContextMenuPortal({
  contextMenu,
  contextClass,
  contextClassIndex,
  visibleAssignedCount,
  onClose,
  onEdit,
  onRename,
  onMove,
  onRemove,
}: PillContextMenuPortalProps): React.ReactPortal | null {
  if (!contextMenu || !contextClass) return null
  const locked = isGeneratedClassLocked(contextClass)
  const runAndClose = (fn: () => void) => () => {
    fn()
    onClose()
  }
  return createPortal(
    <ClassPillContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      canMoveUp={contextClassIndex > 0}
      canMoveDown={contextClassIndex >= 0 && contextClassIndex < visibleAssignedCount - 1}
      locked={locked}
      onClose={onClose}
      onEdit={runAndClose(() => onEdit(contextClass))}
      onRename={runAndClose(() => {
        if (!locked) onRename(contextClass)
      })}
      onMoveUp={runAndClose(() => onMove(contextClass, 'up'))}
      onMoveDown={runAndClose(() => onMove(contextClass, 'down'))}
      onRemove={runAndClose(() => onRemove(contextClass))}
    />,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// AssignedClassPill — a single class chip in the assigned-list strip.
//
// Owns the click-to-toggle, right-click context menu, keyboard
// (Enter/Space → toggle, ContextMenu/Shift+F10 → menu), and the inline
// remove button. The inline keyboard logic was inlined as an arrow function
// in the parent's `.map()` and was a non-trivial chunk of `ClassPickerInner`'s
// cognitive complexity.
// ---------------------------------------------------------------------------

interface AssignedClassPillProps {
  cls: CSSClass
  isActive: boolean
  onToggle: () => void
  onContextMenu: (event: MouseEvent<HTMLElement>) => void
  onKeyboardContextMenu: (event: KeyboardEvent<HTMLElement>) => void
  onRemove: () => void
}

function AssignedClassPill({
  cls,
  isActive,
  onToggle,
  onContextMenu,
  onKeyboardContextMenu,
  onRemove,
}: AssignedClassPillProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
      return
    }
    onKeyboardContextMenu(e)
  }

  return (
    <div
      className={cn(styles.pill, isActive ? styles.pillActive : styles.pillInactive)}
      data-accent={pillAccent(cls.name)}
      onClick={onToggle}
      role="button"
      aria-pressed={isActive}
      aria-label={`${isActive ? 'Deselect' : 'Edit'} class ${cls.name}`}
      tabIndex={0}
      onContextMenu={onContextMenu}
      onKeyDown={handleKeyDown}
    >
      <span className={styles.pillName}>{cls.name}</span>

      {/* Remove from this element (does NOT delete the class globally) */}
      <Button
        variant="ghost"
        size="micro"
        iconOnly
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        aria-label={`Remove class ${cls.name}`}
        tooltip="Remove from this element"
        dangerHover
        className={styles.pillRemoveBtn}
      >
        <CloseIcon size={10} color="currentColor" aria-hidden="true" />
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Typed-query suggestions — ranked filtered list + optional "Create new"
// affordance + empty-state fallback. Mirror of `ClassSuggestionSections` for
// the non-empty-query branch, kept separate so each branch's rendering reads
// linearly without an enclosing ternary in the parent component.
// ---------------------------------------------------------------------------

interface RankedSuggestionsListProps {
  filteredSuggestions: readonly CSSClass[]
  highlightedClassId: string | null
  canCreateNew: boolean
  query: string
  onPick: (classId: string) => void
  onCreateAndAdd: () => void
  previewClass: (classId: string) => void
  clearPreviewClass: (classId: string) => void
}

function RankedSuggestionsList({
  filteredSuggestions,
  highlightedClassId,
  canCreateNew,
  query,
  onPick,
  onCreateAndAdd,
  previewClass,
  clearPreviewClass,
}: RankedSuggestionsListProps) {
  return (
    <>
      {filteredSuggestions.map((cls) => {
        const isHighlighted = highlightedClassId === cls.id
        return (
          <ContextMenuItem
            key={cls.id}
            data-class-suggestion-id={cls.id}
            className={cn(isHighlighted && styles.suggestionHighlighted)}
            onClick={() => onPick(cls.id)}
            onMouseEnter={() => previewClass(cls.id)}
            onFocus={() => previewClass(cls.id)}
            onMouseLeave={() => clearPreviewClass(cls.id)}
            onBlur={() => clearPreviewClass(cls.id)}
          >
            <span className={styles.suggestionLabel}>{cls.name}</span>
            {generatedClassKindLabel(cls) && (
              <span className={styles.utilityBadge}>{generatedClassKindLabel(cls)}</span>
            )}
          </ContextMenuItem>
        )
      })}
      {canCreateNew && (
        <>
          {filteredSuggestions.length > 0 && <ContextMenuSeparator />}
          <ContextMenuItem onClick={onCreateAndAdd}>
            + Create &ldquo;{query.trim()}&rdquo;
          </ContextMenuItem>
        </>
      )}
      {filteredSuggestions.length === 0 && !canCreateNew && (
        <div className={styles.noMatch}>
          No classes match &ldquo;{query}&rdquo;
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Empty-query suggestions — Recent + Frequent + (optional) All
//
// Rendered as flat `ContextMenuItem`s grouped by section headers. Section
// headers are non-interactive `<div>`s; ContextMenu's keyboard navigation
// skips over them naturally because it scans for focusable items.
// ---------------------------------------------------------------------------

interface ClassSuggestionSectionsProps {
  recentIds: readonly string[]
  frequentIds: readonly string[]
  /** Empty array means "don't render the All section at all". */
  remainingClasses: readonly CSSClass[]
  /** True iff the All section header should be shown above `remainingClasses`. */
  showAllHeader: boolean
  resolveClass: (classId: string) => CSSClass | null
  onPick: (classId: string) => void
  previewClass: (classId: string) => void
  clearPreviewClass: (classId: string) => void
  /** ID of the class currently selected via Arrow Up/Down, or `null`. */
  highlightedClassId: string | null
}

function ClassSuggestionSections({
  recentIds,
  frequentIds,
  remainingClasses,
  showAllHeader,
  resolveClass,
  onPick,
  previewClass,
  clearPreviewClass,
  highlightedClassId,
}: ClassSuggestionSectionsProps) {
  const hasRecent = recentIds.length > 0
  const hasFrequent = frequentIds.length > 0
  const hasRemaining = remainingClasses.length > 0
  const hasAny = hasRecent || hasFrequent || hasRemaining

  const renderItem = (cls: CSSClass) => {
    const isHighlighted = highlightedClassId === cls.id
    return (
      <ContextMenuItem
        key={cls.id}
        data-class-suggestion-id={cls.id}
        className={cn(isHighlighted && styles.suggestionHighlighted)}
        onClick={() => onPick(cls.id)}
        onMouseEnter={() => previewClass(cls.id)}
        onFocus={() => previewClass(cls.id)}
        onMouseLeave={() => clearPreviewClass(cls.id)}
        onBlur={() => clearPreviewClass(cls.id)}
      >
        <span className={styles.suggestionLabel}>{cls.name}</span>
        {generatedClassKindLabel(cls) && (
          <span className={styles.utilityBadge}>{generatedClassKindLabel(cls)}</span>
        )}
      </ContextMenuItem>
    )
  }

  if (!hasAny) {
    return (
      <div className={styles.noMatch}>
        Type to search or create a class
      </div>
    )
  }

  return (
    <>
      {hasRecent && (
        <>
          <div className={styles.sectionHeader}>Recent</div>
          {recentIds.map((id) => {
            const cls = resolveClass(id)
            return cls ? renderItem(cls) : null
          })}
        </>
      )}
      {hasFrequent && (
        <>
          {hasRecent && <ContextMenuSeparator />}
          <div className={styles.sectionHeader}>Frequent</div>
          {frequentIds.map((id) => {
            const cls = resolveClass(id)
            return cls ? renderItem(cls) : null
          })}
        </>
      )}
      {hasRemaining && (
        <>
          {(hasRecent || hasFrequent) && <ContextMenuSeparator />}
          {showAllHeader && <div className={styles.sectionHeader}>All classes</div>}
          {remainingClasses.map(renderItem)}
        </>
      )}
    </>
  )
}

function ClassPillContextMenu({
  x,
  y,
  canMoveUp,
  canMoveDown,
  onClose,
  onEdit,
  onRename,
  onMoveUp,
  onMoveDown,
  onRemove,
  locked,
}: {
  x: number
  y: number
  canMoveUp: boolean
  canMoveDown: boolean
  locked: boolean
  onClose: () => void
  onEdit: () => void
  onRename: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
}) {
  const firstItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    firstItemRef.current?.focus()
  }, [])

  return (
    <ContextMenu x={x} y={y} ariaLabel="Class actions" onClose={onClose}>
      <ContextMenuItem ref={firstItemRef} onClick={onEdit}>
        <span aria-hidden="true"><EditIcon size={13} /></span>
        {locked ? 'View utility' : 'Edit styles'}
      </ContextMenuItem>
      <ContextMenuItem disabled={locked} onClick={onRename}>
        <span aria-hidden="true"><EditIcon size={13} /></span>
        Rename
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!canMoveUp} onClick={onMoveUp}>
        <span aria-hidden="true"><ChevronUpIcon size={13} /></span>
        Move up
      </ContextMenuItem>
      <ContextMenuItem disabled={!canMoveDown} onClick={onMoveDown}>
        <span aria-hidden="true"><ChevronDownIcon size={13} /></span>
        Move down
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem danger onClick={onRemove}>
        <span aria-hidden="true"><CloseIcon size={13} /></span>
        Remove from this element
      </ContextMenuItem>
    </ContextMenu>
  )
}

function ClassRenameDialog({
  initialValue,
  onCancel,
  onRename,
}: {
  initialValue: string
  onCancel: () => void
  onRename: (name: string) => void
}) {
  const [name, setName] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const trimmedName = name.trim()

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select())
  }, [])

  useDialogEscape(onCancel)

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!trimmedName) return

    try {
      onRename(trimmedName)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\[[^\]]+\]\s*/, '') : 'Unable to rename class')
    }
  }

  return createPortal(
    <div
      className={dialogStyles.backdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="class-rename-dialog-title"
        className={dialogStyles.dialog}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={dialogStyles.header}>
          <h2 id="class-rename-dialog-title" className={dialogStyles.title}>
            Rename selector
          </h2>
          <Button variant="ghost" size="xs" iconOnly aria-label="Close dialog" onClick={onCancel}>
            <CloseIcon size={12} color="currentColor" aria-hidden="true" />
          </Button>
        </div>
        <form className={dialogStyles.form} onSubmit={handleSubmit}>
          <label className={dialogStyles.field}>
            <span className={dialogStyles.label}>Name</span>
            <Input
              ref={inputRef}
              fieldSize="sm"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
              aria-label="Class name"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {error && <p role="alert" className={dialogStyles.errorText}>{error}</p>}
          <div className={dialogStyles.actions}>
            <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={!trimmedName}>
              Save
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
