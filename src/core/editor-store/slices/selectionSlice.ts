import type { StateCreator } from 'zustand'
import type { EditorStore } from '../types'
import { isUserVisibleClass } from '@core/page-tree/classUtils'
import type { BaseNode } from '@core/page-tree/baseNode'

export interface SelectionSlice {
  /** Currently selected node ID — null if nothing is selected */
  selectedNodeId: string | null
  /** Hovered node ID — null if no hover */
  hoveredNodeId: string | null
  /** Breakpoint frame that owns the current canvas hover; null means global hover */
  hoveredBreakpointId: string | null

  selectNode: (id: string | null) => void
  hoverNode: (id: string | null, breakpointId?: string | null) => void
  clearSelection: () => void
}

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@core/editor-store/types' {
  interface EditorStore extends SelectionSlice {}
}

export const createSelectionSlice: StateCreator<EditorStore, [], [], SelectionSlice> = (set, get) => ({
  selectedNodeId: null,
  hoveredNodeId: null,
  hoveredBreakpointId: null,

  selectNode: (id) => {
    const current = get()
    const shouldCollapseProperties = !id && !current.selectedSelectorClassId
    const selectedChanged = !Object.is(current.selectedNodeId, id)
    const panelChanged = !Object.is(current.propertiesPanel.collapsed, shouldCollapseProperties)
    const nextActiveClassId = getSelectionActiveClassId(current, id)
    const activeClassChanged = !Object.is(current.activeClassId, nextActiveClassId)

    if (!selectedChanged && !panelChanged && !activeClassChanged) return

    set((state) => ({
      selectedNodeId: id,
      selectedSelectorClassId: id ? null : state.selectedSelectorClassId,
      activeClassId: nextActiveClassId,
      propertiesPanel: panelChanged
        ? { ...state.propertiesPanel, collapsed: shouldCollapseProperties }
        : state.propertiesPanel,
    }))
  },
  hoverNode: (id, breakpointId = null) => set({
    hoveredNodeId: id,
    hoveredBreakpointId: id ? breakpointId : null,
  }),
  clearSelection: () => set({
    selectedNodeId: null,
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    activeClassId: null,
  }),
})

function getSelectionActiveClassId(state: EditorStore, nodeId: string | null): string | null {
  if (!nodeId) return null

  const node = findSelectableNode(state, nodeId)
  if (!node?.classIds?.length || !state.site) return null

  const visibleClassIds = node.classIds.filter((classId) => {
    const cls = state.site?.classes[classId]
    return cls && isUserVisibleClass(cls)
  })

  if (visibleClassIds.length === 0) return null
  if (state.activeClassId && visibleClassIds.includes(state.activeClassId)) {
    return state.activeClassId
  }
  return visibleClassIds[0]
}

function findSelectableNode(state: EditorStore, nodeId: string): BaseNode | null {
  if (!state.site) return null

  const activeDocument = state.activeDocument
  if (activeDocument?.kind === 'visualComponent') {
    const component = state.site.visualComponents?.find((vc) => vc.id === activeDocument.vcId)
    const node = component ? findNodeInTree(component.rootNode, nodeId) : null
    if (node) return node
  }

  for (const page of state.site.pages) {
    const node = page.nodes[nodeId]
    if (node) return node
  }

  return null
}

function findNodeInTree<T extends { id: string; childNodes?: T[] }>(
  node: T,
  nodeId: string,
): T | null {
  if (node.id === nodeId) return node

  for (const child of node.childNodes ?? []) {
    const match = findNodeInTree(child, nodeId)
    if (match) return match
  }

  return null
}
