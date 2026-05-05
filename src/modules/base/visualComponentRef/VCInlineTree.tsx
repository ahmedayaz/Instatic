/**
 * VCInlineTree — lightweight React renderer for an instantiated VC node map.
 *
 * Architecture source: Contribution #619 §8.5
 *
 * Renders a flat VCNode map (produced by instantiateVCAtRef) as a React subtree.
 * Nodes are rendered using the module registry — no Zustand subscriptions, no
 * NodeWrapper (inner nodes are not selectable in this context).
 *
 * base.visual-component-ref nodes are delegated back to VisualComponentRefEditor
 * via the registry, which uses the store to look up the VC and recursively
 * renders another VCInlineTree. This provides natural recursive rendering with
 * cycle safety guaranteed by the recursion guard at write boundaries.
 *
 * Class resolution:
 * - Each node's `classIds` is resolved against the site's class registry and
 *   passed to the module component as `mcClassName`. This mirrors the publisher
 *   so that user CSS classes apply identically in the editor preview and in
 *   the published HTML.
 * - The page-level ref node's own classIds (`rootMcClassName`) are merged
 *   onto the VC root so styles on the ref instance reach the rendered output —
 *   same contract as the publisher's `injectClassIntoRootElement`.
 */

import { registry } from '@core/module-engine/registry'
import type { VCNode } from '@core/visualComponents/schemas'
import { classNamesForClassIds, type ClassRegistry } from '@core/page-tree/classNames'

interface VCInlineTreeProps {
  /** Flat node map from instantiateVCAtRef */
  nodes: Record<string, VCNode>
  /** ID of the root node — entry point for traversal */
  rootNodeId: string
  /** Site class registry — used to resolve each node's classIds → class names */
  classes: ClassRegistry
  /** Class string from the page-level ref node (its own classIds resolved) — merged onto the VC root */
  rootMcClassName?: string
}

export function VCInlineTree({ nodes, rootNodeId, classes, rootMcClassName }: VCInlineTreeProps) {
  return (
    <VCNodeRenderer
      nodeId={rootNodeId}
      nodes={nodes}
      classes={classes}
      extraClassName={rootMcClassName}
    />
  )
}

// ---------------------------------------------------------------------------
// VCNodeRenderer — recursive node renderer (no NodeWrapper, not selectable)
// ---------------------------------------------------------------------------

interface VCNodeRendererProps {
  nodeId: string
  nodes: Record<string, VCNode>
  classes: ClassRegistry
  /** Extra class string merged onto this node's mcClassName (root-only). */
  extraClassName?: string
}

function VCNodeRenderer({ nodeId, nodes, classes, extraClassName }: VCNodeRendererProps) {
  const node = nodes[nodeId]
  if (!node) return null
  if (node.hidden) return null

  const definition = registry.get(node.moduleId)
  if (!definition) return null

  const ComponentType = definition.component

  const children = node.children.map((childId) => (
    <VCNodeRenderer key={childId} nodeId={childId} nodes={nodes} classes={classes} />
  ))

  const ownClassNames = classNamesForClassIds(classes, node.classIds)
  const merged = [extraClassName, ...ownClassNames].filter(Boolean).join(' ')
  const mcClassName = merged.length > 0 ? merged : ''

  return (
    <ComponentType
      props={node.props as never}
      nodeId={node.id}
      isSelected={false}
      mcClassName={mcClassName}
    >
      {children}
    </ComponentType>
  )
}
