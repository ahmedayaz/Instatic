/**
 * DomPanel — floating overlay showing the full node tree.
 *
 * Guideline #356 (Overlay Panel Style):
 * - Floating overlay: position absolute, draggable via header (useDraggablePanel)
 * - Glass backdrop: backdrop-filter blur + rgba tint + inset shadow
 * - fit-content height, max-height: 60vh — NOT full viewport height
 * - Header is the drag handle (36px) — PanelHeader shared component
 *
 * Guideline #357 (Compact UI Density):
 * - Row height: 28px (WCAG touch target NOT required for editor chrome)
 * - Font: 12px, icons: 14px
 *
 * Guideline #318 (Phase 3 Perf):
 * - Per-node Zustand selectors: only affected rows re-render on selection/hover
 * - DnD drag position tracked via refs; store updated once on dragEnd
 * - expandedNodeIds lives in DomTreeContext (UI-only) — never in siteSlice
 *
 * Guideline #321 (Phase 3 Architecture):
 * - DndContext wraps the whole tree; SortableContexts are per-parent group
 * - Search: flat filtered list bypasses tree rendering when query is active
 * - Ancestor auto-expand + scroll-to-selected on canvas selection change
 *
 * Accessibility:
 * - role="tree" on tree container
 * - data-panel attribute for event propagation guard (Guideline #192)
 * - data-testid="dom-panel" and "dom-panel-ready" for Playwright (Guideline #221)
 */
import { useEffect, useCallback, useRef, useState, useMemo } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { createPortal } from 'react-dom'
import { useEditorStore, selectActiveCanvasPage } from '@core/editor-store/store'
import { flattenSubtree } from '@core/page-tree/selectors'
import { getAncestorIds } from '../../hooks/useTreeWalkOrder'
import { registry } from '@core/module-engine/registry'
import { TreeNode } from './TreeNode'
import { useDomTree } from './DomTreeContext'
import { DomTreeProvider } from './DomTreeProvider'
import { DomPanelDndContext } from './DomPanelDndContext'
import { useDomPanelDnd } from './useDomPanelDnd'
import { TreeContainer, TreeIconSlot, TreeLabel, TreeRow } from '../../ui/Tree'
import { SearchBar } from '@ui/components/SearchBar'
import { PanelHeader } from '../shared/PanelHeader'
import { useDraggablePanel } from '../../hooks/useDraggablePanel'
import { cn } from '@ui/cn'
import type { IconComponent } from 'pixel-art-icons/types'
import { LayoutIcon } from 'pixel-art-icons/icons/layout'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { ImageIcon } from 'pixel-art-icons/icons/image'
import { SquareIcon } from 'pixel-art-icons/icons/square'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { ListBoxIcon } from 'pixel-art-icons/icons/list-box'
import { FileTextIcon } from 'pixel-art-icons/icons/file-text'
import { VideoIcon } from 'pixel-art-icons/icons/video'
import styles from './DomPanel.module.css'

const PANEL_STORAGE_KEY = 'pb-dom-panel'
const DEFAULT_WIDTH = 280
type PanelVariant = 'floating' | 'docked'

// ─── Search results (flat filtered list) ─────────────────────────────────────

interface SearchRow {
  nodeId: string
  displayName: string
  moduleId: string
}

interface SearchResultsProps {
  rows: SearchRow[]
  onSelect: (nodeId: string) => void
}

function SearchResults({ rows, onSelect }: SearchResultsProps) {
  if (rows.length === 0) {
    return (
      <div className={styles.noMatchMsg}>
        No elements match
      </div>
    )
  }
  return (
    <>
      {rows.map(({ nodeId, displayName, moduleId }) => (
        <TreeRow
          key={nodeId}
          depth={0}
          role="treeitem"
          aria-selected={false}
          tabIndex={0}
          onClick={() => onSelect(nodeId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onSelect(nodeId)
            }
          }}
        >
          <TreeIconSlot icon={getModuleIcon(moduleId)} iconSize={11} />
          <TreeLabel>
            {displayName}
          </TreeLabel>
        </TreeRow>
      ))}
    </>
  )
}

// ─── Inner panel (needs context from DomTreeProvider) ─────────────────────────

function DomPanelInner({ variant = 'floating' }: { variant?: PanelVariant }) {
  const page = useEditorStore(selectActiveCanvasPage)
  const panelState = useEditorStore((s) => s.domTreePanel)
  const setDomTreePanel = useEditorStore((s) => s.setDomTreePanel)
  const toggleDomTreePanel = useEditorStore((s) => s.toggleDomTreePanel)
  const setFocusedPanel = useEditorStore((s) => s.setFocusedPanel)
  const focusedPanel = useEditorStore((s) => s.focusedPanel)
  // Per-node selector — only this ref updates when selection changes (Guideline #318)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)

  const focusRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const { expandAll, collapseAll, expandNode, isExpanded } = useDomTree()

  const [searchQuery, setSearchQuery] = useState('')

  // ── Draggable panel position ───────────────────────────────────────────────
  const { panelRef, headerDragProps, panelPositionStyle } = useDraggablePanel(
    'dom',
    () => ({ x: 16, y: 16 }),
  )

  // ─── DnD sensors ──────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },  // small threshold prevents accidental drags
    }),
  )

  const treeAreaRef = useRef<HTMLDivElement>(null)
  const dnd = useDomPanelDnd({ page, treeAreaRef, expandNode, isExpanded })

  // ─── Restore panel width/other state from localStorage on mount ────────────
  useEffect(() => {
    try {
      const stored = localStorage.getItem(PANEL_STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (typeof parsed.width === 'number') {
          setDomTreePanel({ width: parsed.width })
        }
      }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Persist panel state to localStorage on change ────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({ width: panelState.width }))
    } catch { /* ignore */ }
  }, [panelState.width])

  // ─── Ancestor auto-expand + scroll-to-selected ────────────────────────────
  // When the canvas selection changes, ensure the selected node is visible in
  // the tree (expand all its ancestors) and scroll the tree to it.
  useEffect(() => {
    if (!page || !selectedNodeId) return

    // Auto-expand all ancestors of the selected node so it is visible in the tree
    const ancestorIds = getAncestorIds(page.nodes, page.rootNodeId, selectedNodeId)
    for (const ancestorId of ancestorIds) {
      expandNode(ancestorId)
    }

    // Scroll the selected row into view after the expand animation settles
    requestAnimationFrame(() => {
      const row = treeRef.current?.querySelector(`[data-node-id="${selectedNodeId}"]`)
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    })
  // expandNode is a stable useCallback — safe to include
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId, page])

  // ─── Focus management: F6 moves focus into panel ──────────────────────────
  useEffect(() => {
    if (focusedPanel === 'domTree' && focusRef.current) {
      focusRef.current.focus()
    }
  }, [focusedPanel])

  // ─── Keyboard shortcuts at panel level ────────────────────────────────────
  const handlePanelKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'F6') {
        e.preventDefault()
        useEditorStore.getState().cycleFocusedPanel()
      }
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+E = expand all, Ctrl+W = collapse all
        if (e.key === 'e' && page) {
          e.preventDefault()
          expandAll(flattenSubtree(page, page.rootNodeId))
        }
        if (e.key === 'w') {
          e.preventDefault()
          collapseAll()
        }
        // Ctrl+F = focus search
        if (e.key === 'f') {
          e.preventDefault()
          searchInputRef.current?.focus()
        }
      }
    },
    [page, expandAll, collapseAll],
  )

  // ─── DnD drag-end: commit one validated move to store ────────────────────
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const target = dnd.handleDragEnd(event)
      if (!target) return

      // TODO(Phase-N): wire DnD reordering inside VC mode.
      // moveNode operates on page.nodes; VC nodes live in vc.rootNode and require
      // a dedicated moveNodeInVc store action that mutates the nested VCNode tree.
      if (page?.id.startsWith('vc-virtual:')) return

      try {
        useEditorStore.getState().moveNode(target.draggedId, target.parentId, target.index)
      } catch (err) {
        console.warn('[DomPanel] Ignored stale drag/drop target:', err)
      }
    },
    [dnd, page],
  )

  // ─── Search: flat filtered list of matching nodes ─────────────────────────
  const searchRows = useMemo<SearchRow[]>(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query || !page) return []
    return flattenSubtree(page, page.rootNodeId)
      .map((nodeId) => {
        const node = page.nodes[nodeId]
        if (!node) return null
        const def = registry.get(node.moduleId)
        const displayName = node.label ?? def?.name ?? node.moduleId
        return { nodeId, displayName, moduleId: node.moduleId }
      })
      .filter((row): row is SearchRow => {
        if (!row) return false
        return row.displayName.toLowerCase().includes(query)
      })
  }, [searchQuery, page])

  const collapsed = panelState.collapsed
  const width = panelState.width || DEFAULT_WIDTH

  // Fully hidden when collapsed — toolbar LayersButton is the toggle to reopen
  if (collapsed) return null

  const dragOverlay = (
    <DragOverlay dropAnimation={null}>
      {dnd.activeId && dnd.activeLabel && dnd.activeModuleId ? (
        <TreeRow depth={0} className={styles.dragOverlayRow}>
          <TreeIconSlot
            icon={getModuleIcon(dnd.activeModuleId)}
            iconSize={11}
            iconColor="var(--editor-text-subtle)"
          />
          <TreeLabel>{dnd.activeLabel}</TreeLabel>
        </TreeRow>
      ) : null}
    </DragOverlay>
  )

  return (
    <div
      ref={panelRef as React.RefObject<HTMLDivElement>}
      data-panel=""
      data-testid={page ? 'dom-panel-ready' : 'dom-panel'}
      role="complementary"
      aria-label="DOM tree panel"
      tabIndex={-1}
      onKeyDown={handlePanelKeyDown}
      onFocus={() => setFocusedPanel('domTree')}
      onClick={(e) => e.stopPropagation()}
      // Width is state-driven (resizable panel) — CSS var injection
      // Panel position is drag-driven — CSS var injection from useDraggablePanel
      style={
        variant === 'floating'
          ? { '--panel-w': `${width}px`, ...panelPositionStyle } as React.CSSProperties
          : undefined
      }
      className={cn(styles.panel, variant === 'docked' && styles.panelDocked)}
    >
      {/* Focusable surface for F6 focus cycling */}
      <div ref={focusRef} tabIndex={-1} className={styles.focusTrap} aria-hidden="true" />

      {/* ─── Shared Panel Header — drag handle + close button ─────────────── */}
      <PanelHeader
        panelId="dom"
        title="Layers"
        onClose={toggleDomTreePanel}
        dragHandleProps={variant === 'floating' ? headerDragProps : undefined}
      />

      {/* ─── Panel content ────────────────────────────────────────────────── */}
      <>
        <SearchBar
          ref={searchInputRef}
          data-testid="dom-tree-search"
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder="Search layers…"
          aria-label="Search layers"
          className={styles.searchBar}
        />

        {/* ── Tree / search results — scrollable area ───────────────────── */}
        <div ref={treeAreaRef} className={styles.treeArea}>
          {!page ? (
            <div className={styles.emptyMsg}>
              Loading site...
            </div>
          ) : searchQuery.trim() ? (
            /* ── Search results mode: flat filtered list ── */
            <TreeContainer
              ariaLabel="Page element tree"
              testId="dom-panel-tree"
            >
              <SearchResults
                rows={searchRows}
                onSelect={(nodeId) => useEditorStore.getState().selectNode(nodeId)}
              />
            </TreeContainer>
          ) : (
            /* ── Normal tree mode ── */
            <DndContext
              sensors={sensors}
              onDragStart={dnd.handleDragStart}
              onDragMove={dnd.handleDragMove}
              onDragEnd={handleDragEnd}
              onDragCancel={dnd.handleDragCancel}
            >
              <DomPanelDndContext.Provider value={dnd.contextValue}>
                <TreeContainer
                  ariaLabel="Page element tree"
                  testId="dom-panel-tree"
                  containerRef={treeRef}
                >
                  {(() => {
                    // The "no elements yet" hint is appropriate ONLY for empty
                    // pages whose rootNode is the standard base.root wrapper.
                    // VC canvases whose rootNode is the converted module
                    // itself (e.g. a single Button) must still render the
                    // tree — the rootNode IS the content there.
                    const rootNode = page.nodes[page.rootNodeId]
                    const isEmptyPage =
                      rootNode?.moduleId === 'base.root' &&
                      rootNode.children.length === 0
                    return isEmptyPage ? (
                      <div className={styles.emptyMsg}>
                        This page has no elements yet. Use the + button to add a module.
                      </div>
                    ) : (
                      <TreeNode nodeId={page.rootNodeId} depth={0} />
                    )
                  })()}
                </TreeContainer>
              </DomPanelDndContext.Provider>
              {typeof document === 'undefined'
                ? dragOverlay
                : createPortal(dragOverlay, document.body)}
            </DndContext>
          )}
        </div>
      </>
    </div>
  )
}

export function DomPanel({ variant = 'floating' }: { variant?: PanelVariant }) {
  return (
    <DomTreeProvider>
      <DomPanelInner variant={variant} />
    </DomTreeProvider>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getModuleIcon(moduleId: string): IconComponent {
  switch (moduleId) {
    case 'base.container':
      return LayoutIcon
    case 'base.text':
      return TextStartTIcon
    case 'base.image':
      return ImageIcon
    case 'base.link':
      return LinkIcon
    case 'base.list':
      return ListBoxIcon
    case 'base.root':
      return FileTextIcon
    case 'base.video':
      return VideoIcon
    case 'base.button':
    default:
      return SquareIcon
  }
}
