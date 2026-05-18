/**
 * PropertiesPanelBody — selects which inspector surface to show inside the
 * scrollable content area of the Properties panel.
 *
 * Five branches, in priority order:
 *   1. A class is selected via the Selectors panel → global selector inspector
 *      (no node context, just the rule + style sections).
 *   2. Multiple nodes are selected → multi-select inspector.
 *   3. No node + no selector, but we're inside a Visual Component canvas →
 *      show the VC's param surface.
 *   4. No node at all (page canvas with nothing selected) → empty hint.
 *   5. A `base.visual-component-ref` is selected → instance view (params +
 *      override matrix). Other nodes → ClassPicker + StyleSurface.
 *
 * This component is a pure router; it owns no state. PropertiesPanel composes
 * the moduleTabContent JSX once (via `renderModuleTabContent`) and passes it
 * in, which keeps the schema → control dispatch reusable across surfaces.
 */
import { EmptyState } from '@ui/components/EmptyState'
import { useEditorPermissions } from '@site/editorPermissionsContext'
import type { AnyModuleDefinition } from '@core/module-engine/types'
import type { CSSClass, PageNode } from '@core/page-tree/schemas'
import type { VisualComponent } from '@core/visualComponents/schemas'
import type { ActiveDocument } from '../../store/slices/uiSlice'
import { ClassPicker, type ClassPickerHandle } from './ClassPicker'
import { StyleSurface } from './StyleSurface'
import { ComponentRefView } from './ComponentRefView'
import { ComponentParamsOverview } from './ComponentParamsOverview'
import { ConvertToComponentButton } from './ConvertToComponentButton'
import { MultiSelectionInspector } from './MultiSelectionInspector'
import { SelectorInspector } from './SelectorInspector'
import styles from './PropertiesPanel.module.css'

interface PropertiesPanelBodyProps {
  selectedSelectorClass: CSSClass | null
  selectedSelectorClassId: string | null
  activeBreakpointId: string | undefined
  isMultiSelect: boolean
  selectedNodeIds: string[]
  selectedNode: PageNode | null
  selectedNodeId: string | null
  definition: AnyModuleDefinition | null | undefined
  activeDocument: ActiveDocument | null
  activeVc: VisualComponent | null
  activeClass: CSSClass | null
  activeClassId: string | null
  moduleTabContent: React.ReactNode
  classPickerRef: React.RefObject<ClassPickerHandle | null>
  onFocusClassPicker: () => void
}

export function PropertiesPanelBody(props: PropertiesPanelBodyProps): React.ReactNode {
  const {
    selectedSelectorClass,
    selectedSelectorClassId,
    activeBreakpointId,
    isMultiSelect,
    selectedNodeIds,
    selectedNode,
    selectedNodeId,
    definition,
    activeDocument,
    activeVc,
    activeClass,
    activeClassId,
    moduleTabContent,
    classPickerRef,
    onFocusClassPicker,
  } = props
  const permissions = useEditorPermissions()

  if (selectedSelectorClass) {
    return (
      <SelectorInspector cls={selectedSelectorClass} activeBreakpointId={activeBreakpointId} />
    )
  }

  if (isMultiSelect) {
    return <MultiSelectionInspector selectedNodeIds={selectedNodeIds} />
  }

  if (!selectedNode || !definition) {
    const inEmptyVcCanvas =
      activeDocument?.kind === 'visualComponent' &&
      selectedNodeId === null &&
      selectedSelectorClassId === null &&
      !!activeVc
    if (inEmptyVcCanvas && activeVc) {
      return <ComponentParamsOverview vc={activeVc} />
    }
    return (
      <EmptyState
        variant="centered"
        title="Select an element on the canvas to view its properties."
      />
    )
  }

  if (selectedNode.moduleId === 'base.visual-component-ref') {
    // Visual Component instance view (Task #438 / Contribution #619 §8.5).
    return (
      <ComponentRefView
        nodeId={selectedNodeId!}
        componentId={String(selectedNode.props.componentId ?? '')}
        propOverrides={(selectedNode.props.propOverrides ?? {}) as Record<string, unknown>}
      />
    )
  }

  // Default node surface — ClassPicker above StyleSurface.
  //
  // ClassPicker mutates the classes registry, so it is style-editing. Hide it
  // from callers without `site.style.edit` — a content-only Client can't add
  // or remove classes regardless.
  //
  // ConvertToComponentButton is structural (it adds a new VC to the registry
  // and replaces the selected subtree with a ref) — gate on structure.
  const showConvertToComponent =
    permissions.canEditStructure &&
    activeDocument?.kind !== 'visualComponent' &&
    selectedNode.moduleId !== 'base.body' &&
    selectedNode.moduleId !== 'base.visual-component-ref'

  return (
    <div className={styles.nodeArea}>
      {/* ClassPicker — always visible to style-edit-capable callers. Hidden
          for content-only Clients. */}
      {permissions.canEditStyle && (
        <div className={styles.headerClassPicker}>
          <ClassPicker
            ref={classPickerRef}
            nodeId={selectedNodeId!}
            trailingAction={
              showConvertToComponent
                ? <ConvertToComponentButton nodeId={selectedNodeId!} />
                : undefined
            }
          />
        </div>
      )}

      {/* Unified StyleSurface: Module section + CSS sections (scroll-anchor) */}
      <StyleSurface
        definition={definition}
        activeClass={activeClass}
        activeClassId={activeClassId}
        activeBreakpointId={activeBreakpointId}
        nodeId={selectedNodeId}
        moduleContent={moduleTabContent}
        onFocusClassPicker={onFocusClassPicker}
      />
    </div>
  )
}
