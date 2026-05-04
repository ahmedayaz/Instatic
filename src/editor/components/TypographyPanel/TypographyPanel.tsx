/**
 * TypographyPanel — docked sidebar UI for fluid type scales.
 *
 * Thin wrapper around the shared `FrameworkScalePanel` with a typography-specific
 * adapter (base size lives at `min.fontSize` / `max.fontSize`, ratio options
 * stop at the Major Sixth, the per-step preview is a sample text rendered at
 * the calculated px size, and the Class Generator targets `font-size` / line-
 * height / letter-spacing properties).
 */

import { type CSSProperties } from 'react'
import { useEditorStore } from '@core/editor-store/store'
import { TYPE_RATIO_OPTIONS } from '@core/framework/scale'
import type { SiteDocument } from '@core/page-tree/schemas'
import type {
  FrameworkTypographyClassGenerator,
  FrameworkTypographyGroup,
} from '@core/framework/schemas'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { TextColumsIcon } from 'pixel-art-icons/icons/text-colums'
import {
  FrameworkScalePanel,
  type ScaleAdapter,
} from '../shared/FrameworkScalePanel'
import { useFrameworkChangeConfirm } from '../shared/FrameworkChangeConfirmDialog'
import { FontsSection } from '../FontsSection'
import styles from '../shared/FrameworkScalePanel/FrameworkScalePanel.module.css'

interface TypographyPanelProps {
  variant?: 'docked'
}

const TYPOGRAPHY_CSS_PROPERTIES = [
  { value: 'font-size', label: 'font-size' },
  { value: 'line-height', label: 'line-height' },
  { value: 'letter-spacing', label: 'letter-spacing' },
] as const

const EMPTY_GROUPS: FrameworkTypographyGroup[] = []
const EMPTY_CLASSES: FrameworkTypographyClassGenerator[] = []

/**
 * Mirror the field-level effect of `applyFrameworkTypographyGroupPatch`
 * (in siteSlice) on a draft site for the *preview* path. Only fields
 * that influence which utility classes get generated need to be applied
 * — `name` etc. don't affect class IDs or class names so they're
 * intentionally skipped.
 */
function applyTypographyGroupPatchPreview(
  draft: SiteDocument,
  groupId: string,
  patch: Record<string, unknown>,
): void {
  const tg = draft.settings.framework?.typography
  if (!tg) return
  const group = tg.groups.find((g) => g.id === groupId)
  if (!group) return
  if (typeof patch.namingConvention === 'string') {
    group.namingConvention = patch.namingConvention
  }
  if (typeof patch.steps === 'string') group.steps = patch.steps
  if (typeof patch.mode === 'string') {
    group.mode = patch.mode as FrameworkTypographyGroup['mode']
  }
  if (typeof patch.isDisabled === 'boolean') group.isDisabled = patch.isDisabled
  if (Array.isArray(patch.manualSizes)) {
    group.manualSizes = patch.manualSizes as FrameworkTypographyGroup['manualSizes']
  }
}

function groupActionLabel(prefix: string, groupId: string): string {
  // The dialog header gets shortened — prefer "<prefix>" without the
  // raw group ID. Group name is unknown at this layer; the prefix
  // alone is informative enough.
  void groupId
  return prefix
}

export function TypographyPanel({ variant = 'docked' }: TypographyPanelProps) {
  const isOpen = useEditorStore((s) => s.typographyPanelOpen)
  const setOpen = useEditorStore((s) => s.setTypographyPanelOpen)
  const onToggleDisabled = useEditorStore((s) => s.toggleFrameworkTypographyDisabled)
  const onCreateGroup = useEditorStore((s) => s.createFrameworkTypographyGroup)
  const onUpdateGroup = useEditorStore((s) => s.updateFrameworkTypographyGroup)
  const onDuplicateGroup = useEditorStore((s) => s.duplicateFrameworkTypographyGroup)
  const onResetGroup = useEditorStore((s) => s.resetFrameworkTypographyGroup)
  const onDeleteGroup = useEditorStore((s) => s.deleteFrameworkTypographyGroup)
  const onUpsertManualSize = useEditorStore((s) => s.upsertFrameworkTypographyManualSize)
  const onSetClassGenerators = useEditorStore((s) => s.setFrameworkTypographyClassGenerators)
  const confirmFrameworkChange = useFrameworkChangeConfirm()

  const wrappedToggleDisabled = () =>
    confirmFrameworkChange({
      actionLabel: 'Disable typography framework',
      applyChange: (draft) => {
        const tg = draft.settings.framework?.typography
        if (tg) tg.isDisabled = !tg.isDisabled
      },
      commit: onToggleDisabled,
    })

  const wrappedDeleteGroup = (groupId: string) =>
    confirmFrameworkChange({
      actionLabel: groupActionLabel('Delete typography scale', groupId),
      applyChange: (draft) => {
        const tg = draft.settings.framework?.typography
        if (!tg) return
        tg.groups = (tg.groups ?? []).filter((g) => g.id !== groupId)
      },
      commit: () => onDeleteGroup(groupId),
    })

  const wrappedUpdateGroup = (
    groupId: string,
    patch: Parameters<typeof onUpdateGroup>[1],
  ) =>
    confirmFrameworkChange({
      actionLabel: groupActionLabel('Update typography scale', groupId),
      applyChange: (draft) => applyTypographyGroupPatchPreview(draft, groupId, patch),
      commit: () => onUpdateGroup(groupId, patch),
    })

  const wrappedSetClassGenerators = (next: FrameworkTypographyClassGenerator[]) =>
    confirmFrameworkChange({
      actionLabel: 'Update typography class generators',
      applyChange: (draft) => {
        const tg = draft.settings.framework?.typography
        if (tg) tg.classes = next
      },
      commit: () => onSetClassGenerators(next),
    })

  const adapter: ScaleAdapter<FrameworkTypographyGroup, FrameworkTypographyClassGenerator> = {
    title: 'Typography',
    panelId: 'typography',
    selectGroups: (state) => state.site?.settings.framework?.typography?.groups ?? EMPTY_GROUPS,
    selectClasses: (state) => state.site?.settings.framework?.typography?.classes ?? EMPTY_CLASSES,
    selectIsDisabled: (state) =>
      Boolean(state.site?.settings.framework?.typography?.isDisabled),
    ratioOptions: TYPE_RATIO_OPTIONS,
    classGeneratorProperties: TYPOGRAPHY_CSS_PROPERTIES,
    scalesSectionIcon: TextStartTIcon,
    baseSizeLabel: 'Font size',
    readBaseSize: (group, side) => Number(group[side].fontSize),
    patchBaseSize: (side, value) => ({
      [side]: { fontSize: value },
    }),
    renderPreview: (sizePx) => (
      <span
        className={styles.previewText}
        style={{ fontSize: `${Math.max(8, sizePx)}px` } as CSSProperties}
      >
        Aa
      </span>
    ),
    onToggleDisabled: wrappedToggleDisabled,
    onCreateGroup,
    onUpdateGroup: wrappedUpdateGroup,
    onDuplicateGroup,
    onResetGroup,
    onDeleteGroup: wrappedDeleteGroup,
    onUpsertManualSize,
    onSetClassGenerators: wrappedSetClassGenerators,
    extraSections: [
      {
        id: 'fonts',
        title: 'Fonts',
        // Show above Scales — fonts are loaded once per site and live above
        // the scale-tweaking workflow.
        position: 'top',
        defaultOpen: true,
        icon: TextColumsIcon,
        render: () => <FontsSection />,
      },
    ],
  }

  return (
    <FrameworkScalePanel
      variant={variant}
      isOpen={isOpen}
      onClose={() => setOpen(false)}
      adapter={adapter}
    />
  )
}
