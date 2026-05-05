/**
 * base.visual-component-ref editor preview component.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration.
 *
 * Class application:
 * - The page-level ref node's own classIds arrive here via `mcClassName`
 *   (resolved by NodeRenderer). We forward that string as `rootMcClassName`
 *   to VCInlineTree so it lands on the VC's root element — same contract as
 *   the publisher's `injectClassIntoRootElement`.
 * - The site's `classes` registry is also forwarded so VCInlineTree can
 *   resolve each inlined VC node's classIds → class names.
 */
import React, { useCallback } from 'react'
import type { ModuleComponentProps } from '@core/module-engine/types'
import { useEditorStore } from '@core/editor-store/store'
import { instantiateVCAtRef } from '@core/visualComponents/instantiate'
import type { VCNode } from '@core/visualComponents/schemas'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { VCInlineTree } from './VCInlineTree'
import styles from './VisualComponentRef.module.css'

interface VisualComponentRefProps extends Record<string, unknown> {
  componentId: string
  /** Per-param value overrides — keyed by VCParam.id (stable across renames) */
  propOverrides: Record<string, unknown>
  slotContent: Record<string, unknown[]>
}

export const VisualComponentRefEditor: React.FC<ModuleComponentProps<VisualComponentRefProps>> = ({
  props,
  nodeId,
  mcClassName,
}) => {
  const componentId = typeof props.componentId === 'string' ? props.componentId : ''
  const propOverrides =
    props.propOverrides && typeof props.propOverrides === 'object' && !Array.isArray(props.propOverrides)
      ? (props.propOverrides as Record<string, unknown>)
      : {}
  const slotContent =
    props.slotContent && typeof props.slotContent === 'object' && !Array.isArray(props.slotContent)
      ? (props.slotContent as Record<string, VCNode[]>)
      : {}

  const vc = useEditorStore(
    useCallback(
      (s) => s.site?.visualComponents?.find((v) => v.id === componentId) ?? null,
      [componentId],
    ),
  )

  // Class registry — VCInlineTree resolves each inlined node's classIds against this.
  // Subscribing to the registry object keeps the rendered VC ref reactive to class
  // edits made elsewhere in the editor.
  const classes = useEditorStore((s) => s.site?.classes ?? null)

  if (!vc) {
    return (
      <div className={styles.unknown}>
        <BracesIcon size={12} color="currentColor" aria-hidden="true" />
        <span>{componentId ? `Unknown component: ${componentId}` : 'No component selected'}</span>
      </div>
    )
  }

  const { nodes, rootNodeId } = instantiateVCAtRef(vc, propOverrides, slotContent, nodeId)

  return (
    <VCInlineTree
      nodes={nodes}
      rootNodeId={rootNodeId}
      classes={classes}
      rootMcClassName={mcClassName}
    />
  )
}
