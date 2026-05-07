/**
 * Node mutation actions for the active document tree.
 *
 * The 11 named tree-mutation actions (`insertNode`, `deleteNode`,
 * `updateNodeProps`, `setBreakpointOverride`, `clearBreakpointOverride`,
 * `renameNode`, `toggleNodeLocked`, `toggleNodeHidden`, `moveNode`,
 * `duplicateNode`, `wrapNode`) all delegate to `mutateActiveTree(fn)` and
 * MUST NOT contain their own `kind === 'visualComponent'` branch — that
 * routing is the sole job of `mutateActiveTree`. Gated by
 * `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`.
 */

import { registry } from '@core/module-engine/registry'
import { wouldCreateCycle } from '@core/visualComponents/recursionGuard'
import {
  createNode,
  insertNode,
  deleteNode,
  updateNodeProps,
  setBreakpointOverride,
  clearBreakpointOverride,
  renameNode,
  toggleNodeLocked,
  toggleNodeHidden,
  moveNode,
  moveNodes,
  duplicateNode,
  wrapNode,
  wrapNodes,
} from '@core/page-tree'
import { syncSlotInstances, applySlotSyncResult } from '@core/visualComponents/slotSync'
import { depthInTree } from './helpers'
import type { SiteSlice, SiteSliceHelpers } from './types'

export type NodeActions = Pick<
  SiteSlice,
  | 'insertNode'
  | 'insertComponentRef'
  | 'deleteNode'
  | 'deleteNodes'
  | 'updateNodeProps'
  | 'setBreakpointOverride'
  | 'clearBreakpointOverride'
  | 'renameNode'
  | 'toggleNodeLocked'
  | 'toggleNodeHidden'
  | 'moveNode'
  | 'moveNodes'
  | 'duplicateNode'
  | 'duplicateNodes'
  | 'wrapNode'
  | 'wrapNodes'
  | 'setNodeDynamicBinding'
  | 'clearNodeDynamicBinding'
>

export function createNodeActions(helpers: SiteSliceHelpers): NodeActions {
  const { get, set, mutatePage, mutateActiveTree } = helpers

  const actions: NodeActions = {
    insertNode: (moduleId, defaults, parentId, index) => {
      const mod = registry.get(moduleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      const newNode = createNode(moduleId, resolvedDefaults)
      mutateActiveTree((tree) => insertNode(tree, newNode, parentId, index))
      return newNode.id
    },

    insertComponentRef: (parentId, componentId) => {
      if (!componentId) return null

      const { activeDocument, site } = get()

      // In VC mode, guard against cyclic component references before insertion.
      if (activeDocument?.kind === 'visualComponent' && site) {
        if (wouldCreateCycle(site.visualComponents, activeDocument.vcId, componentId)) {
          console.warn('[component-system] cycle prevented by recursion guard')
          return null
        }
      }

      // Insert the VC ref node (no props beyond componentId + propOverrides).
      const refNodeId = actions.insertNode(
        'base.visual-component-ref',
        { componentId, propOverrides: {} },
        parentId,
      )

      // Immediately materialize slot-instance children for each slot param the VC declares.
      // `insertNode` → `mutateActiveTree` already pushed history; we mutate inside another
      // set() call here to keep the slot-instance insertion as part of the same logical action.
      const currentSite = get().site
      const vc = currentSite?.visualComponents.find((v) => v.id === componentId)
      if (vc) {
        set((state) => {
          if (!state.site) return
          const { activeDocument: ad } = state

          type NodeMap = Record<string, import('@core/page-tree/baseNode').BaseNode>
          const treeNodes: NodeMap | null = (() => {
            if (ad?.kind === 'visualComponent') {
              const activeVc = state.site!.visualComponents.find((v) => v.id === ad.vcId)
              return activeVc ? (activeVc.tree.nodes as NodeMap) : null
            }
            const pageId = ad?.kind === 'page' ? ad.pageId : state.activePageId
            const page = state.site!.pages.find((p) => p.id === pageId)
            return page ? (page.nodes as NodeMap) : null
          })()

          if (!treeNodes) return

          const vcRefNode = treeNodes[refNodeId]
          if (!vcRefNode) return

          const syncResult = syncSlotInstances(vcRefNode, vc, treeNodes)
          applySlotSyncResult(treeNodes, syncResult, refNodeId)
          state.site.updatedAt = Date.now()
        })
      }

      return refNodeId
    },

    deleteNode: (nodeId) => {
      mutateActiveTree((tree) => deleteNode(tree, nodeId))
      if (get().selectedNodeId === nodeId) set((state) => { state.selectedNodeId = null })
    },

    updateNodeProps: (nodeId, patch) => {
      mutateActiveTree((tree) => updateNodeProps(tree, nodeId, patch))
    },

    setBreakpointOverride: (nodeId, breakpointId, patch) => {
      mutateActiveTree((tree) => setBreakpointOverride(tree, nodeId, breakpointId, patch))
    },

    clearBreakpointOverride: (nodeId, breakpointId) => {
      mutateActiveTree((tree) => clearBreakpointOverride(tree, nodeId, breakpointId))
    },

    renameNode: (nodeId, label) => {
      mutateActiveTree((tree) => renameNode(tree, nodeId, label))
    },

    toggleNodeLocked: (nodeId) => {
      mutateActiveTree((tree) => toggleNodeLocked(tree, nodeId))
    },

    toggleNodeHidden: (nodeId) => {
      mutateActiveTree((tree) => toggleNodeHidden(tree, nodeId))
    },

    moveNode: (nodeId, newParentId, newIndex) => {
      mutateActiveTree((tree) => moveNode(tree, nodeId, newParentId, newIndex))
    },

    moveNodes: (nodeIds, newParentId, newIndex) => {
      if (nodeIds.length === 0) return
      mutateActiveTree((tree) => moveNodes(tree, nodeIds, newParentId, newIndex))
    },

    duplicateNode: (nodeId) => {
      let newId = ''
      mutateActiveTree((tree) => { newId = duplicateNode(tree, nodeId) })
      return newId
    },

    duplicateNodes: (nodeIds) => {
      if (nodeIds.length === 0) return []
      const newIds: string[] = []
      mutateActiveTree((tree) => {
        for (const id of nodeIds) {
          // Skip the root and any id missing from the tree — duplicateNode
          // throws on the root, and silently skipping orphans matches the
          // delete/move guards.
          if (!tree.nodes[id] || id === tree.rootNodeId) continue
          newIds.push(duplicateNode(tree, id))
        }
      })
      return newIds
    },

    deleteNodes: (nodeIds) => {
      if (nodeIds.length === 0) return
      mutateActiveTree((tree) => {
        // Delete each id; descendants of an already-deleted id are gone, so the
        // helper's "node not found" branch handles the redundant case cleanly.
        // We sort by depth-DESC so leaves go first, avoiding noisy throws when
        // a parent is deleted before its child in the same batch.
        const ordered = [...nodeIds].sort(
          (a, b) => depthInTree(tree, b) - depthInTree(tree, a),
        )
        for (const id of ordered) {
          if (id === tree.rootNodeId) continue
          if (!tree.nodes[id]) continue
          deleteNode(tree, id)
        }
      })
    },

    wrapNode: (nodeId, containerModuleId, defaults = {}) => {
      // Auto-resolve the module's schema defaults so the wrapper node renders correctly.
      // Without this, wrapNode(id, 'base.container') produces props:{} → props.tag=undefined
      // → React.createElement(undefined) → "Element type is invalid" crash (Task #414).
      const mod = registry.get(containerModuleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      let wrapperId = ''
      mutateActiveTree((tree) => { wrapperId = wrapNode(tree, nodeId, containerModuleId, resolvedDefaults) })
      return wrapperId
    },

    wrapNodes: (nodeIds, containerModuleId, defaults = {}) => {
      if (nodeIds.length === 0) return null
      // Same defaults-resolution rule as `wrapNode` (Task #414 — defaults must
      // come from the module registry so the wrapper renders).
      const mod = registry.get(containerModuleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      let wrapperId: string | null = null
      mutateActiveTree((tree) => {
        wrapperId = wrapNodes(tree, nodeIds, containerModuleId, resolvedDefaults)
      })
      return wrapperId
    },

    setNodeDynamicBinding: (nodeId, propKey, binding) => {
      mutatePage((page) => {
        const node = page.nodes[nodeId]
        if (!node) return
        node.dynamicBindings = {
          ...(node.dynamicBindings ?? {}),
          [propKey]: binding,
        }
      })
    },

    clearNodeDynamicBinding: (nodeId, propKey) => {
      mutatePage((page) => {
        const node = page.nodes[nodeId]
        if (!node?.dynamicBindings) return
        delete node.dynamicBindings[propKey]
        if (Object.keys(node.dynamicBindings).length === 0) {
          delete node.dynamicBindings
        }
      })
    },
  }

  return actions
}
