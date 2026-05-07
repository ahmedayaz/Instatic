/**
 * Framework spacing — group CRUD helpers + store actions.
 */

import { nanoid } from 'nanoid'
import type {
  FrameworkSpacingGroup,
  SiteDocument,
  SiteSettings,
} from '@core/page-tree'
import {
  buildDefaultSpacingGroup,
  makeFreshSpacingGroup,
  nextSpacingTabValues,
} from '@core/framework/defaults'
import { reconcileFrameworkClasses } from './reconcile'
import { nextOrderValue } from './shared'
import type {
  SiteSlice,
  SiteSliceHelpers,
  UpdateFrameworkSpacingGroupPatch,
} from '../types'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function ensureFrameworkSpacing(
  site: SiteDocument,
): NonNullable<NonNullable<SiteSettings['framework']>['spacing']> {
  if (!site.settings.framework) {
    site.settings.framework = { colors: { tokens: [] } }
  }
  if (!site.settings.framework.spacing) {
    site.settings.framework.spacing = { groups: [], classes: [] }
  }
  site.settings.framework.spacing.groups ??= []
  site.settings.framework.spacing.classes ??= []
  return site.settings.framework.spacing
}

function applyFrameworkSpacingGroupPatch(
  group: FrameworkSpacingGroup,
  patch: UpdateFrameworkSpacingGroupPatch,
): void {
  if (patch.name !== undefined) group.name = patch.name
  if (patch.namingConvention !== undefined) group.namingConvention = patch.namingConvention
  if (patch.steps !== undefined) group.steps = patch.steps
  if (patch.baseScaleIndex !== undefined) group.baseScaleIndex = patch.baseScaleIndex
  if (patch.mode !== undefined) group.mode = patch.mode
  if (patch.isDisabled !== undefined) group.isDisabled = patch.isDisabled
  if (patch.min) group.min = { ...group.min, ...patch.min }
  if (patch.max) group.max = { ...group.max, ...patch.max }
  if (patch.manualSizes !== undefined) group.manualSizes = patch.manualSizes
  group.updatedAt = Date.now()
}

// ---------------------------------------------------------------------------
// Action factory
// ---------------------------------------------------------------------------

export type FrameworkSpacingActions = Pick<
  SiteSlice,
  | 'toggleFrameworkSpacingDisabled'
  | 'createFrameworkSpacingGroup'
  | 'updateFrameworkSpacingGroup'
  | 'duplicateFrameworkSpacingGroup'
  | 'resetFrameworkSpacingGroup'
  | 'deleteFrameworkSpacingGroup'
  | 'upsertFrameworkSpacingManualSize'
  | 'setFrameworkSpacingClassGenerators'
>

export function createFrameworkSpacingActions({
  get,
  mutateSite,
}: SiteSliceHelpers): FrameworkSpacingActions {
  return {
    toggleFrameworkSpacingDisabled: () => {
      mutateSite((site) => {
        const spacing = ensureFrameworkSpacing(site)
        spacing.isDisabled = !spacing.isDisabled
        reconcileFrameworkClasses(site)
      })
    },

    createFrameworkSpacingGroup: () => {
      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      // Read-only view of the (Immer-frozen) live site — `ensureFrameworkSpacing`
      // mutates and would throw on the frozen object when spacing (or framework)
      // is absent. The actual write happens inside `mutateSite` below.
      const groups = site.settings.framework?.spacing?.groups ?? []
      const { name, varName } = nextSpacingTabValues(groups)
      const order = nextOrderValue(groups)
      const group = makeFreshSpacingGroup(name, varName, order)

      mutateSite((draftSite) => {
        const draftSpacing = ensureFrameworkSpacing(draftSite)
        draftSpacing.groups.push(group)
        reconcileFrameworkClasses(draftSite)
      })
      return group
    },

    updateFrameworkSpacingGroup: (groupId, patch) => {
      mutateSite((site) => {
        const spacing = ensureFrameworkSpacing(site)
        const group = spacing.groups.find((g) => g.id === groupId)
        if (!group) return
        applyFrameworkSpacingGroupPatch(group, patch)
        reconcileFrameworkClasses(site)
      })
    },

    duplicateFrameworkSpacingGroup: (groupId) => {
      const { site } = get()
      if (!site) return null
      // Read-only view of the (Immer-frozen) live site — see note in
      // `createFrameworkSpacingGroup`. The actual write is inside `mutateSite`.
      const groups = site.settings.framework?.spacing?.groups ?? []
      const source = groups.find((g) => g.id === groupId)
      if (!source) return null

      const { name, varName } = nextSpacingTabValues(groups)
      const order = nextOrderValue(groups)
      const now = Date.now()
      const copy: FrameworkSpacingGroup = {
        ...structuredClone(source),
        id: nanoid(),
        name,
        namingConvention: varName,
        manualSizes: source.manualSizes?.map((m) => ({
          ...m,
          id: nanoid(),
          name: m.name.replace(source.namingConvention, varName),
        })),
        order,
        createdAt: now,
        updatedAt: now,
      }

      mutateSite((draftSite) => {
        const draftSpacing = ensureFrameworkSpacing(draftSite)
        draftSpacing.groups.push(copy)
        reconcileFrameworkClasses(draftSite)
      })
      return copy
    },

    resetFrameworkSpacingGroup: (groupId) => {
      mutateSite((site) => {
        const spacing = ensureFrameworkSpacing(site)
        const idx = spacing.groups.findIndex((g) => g.id === groupId)
        if (idx < 0) return
        const order = spacing.groups[idx].order
        spacing.groups[idx] = { ...buildDefaultSpacingGroup(order), id: groupId }
        reconcileFrameworkClasses(site)
      })
    },

    deleteFrameworkSpacingGroup: (groupId) => {
      mutateSite((site) => {
        const spacing = ensureFrameworkSpacing(site)
        spacing.groups = spacing.groups.filter((g) => g.id !== groupId)
        spacing.classes = spacing.classes?.filter((c) => c.tabId !== groupId) ?? []
        reconcileFrameworkClasses(site)
      })
    },

    upsertFrameworkSpacingManualSize: (groupId, sizeId, patch) => {
      mutateSite((site) => {
        const spacing = ensureFrameworkSpacing(site)
        const group = spacing.groups.find((g) => g.id === groupId)
        if (!group) return
        group.manualSizes ??= []
        const idx = group.manualSizes.findIndex((m) => m.id === sizeId)
        if (idx < 0) {
          if (typeof patch.name !== 'string' || patch.min === undefined || patch.max === undefined) return
          group.manualSizes.push({
            id: sizeId,
            name: patch.name,
            min: patch.min,
            max: patch.max,
          })
        } else {
          group.manualSizes[idx] = { ...group.manualSizes[idx], ...patch }
        }
        group.updatedAt = Date.now()
        reconcileFrameworkClasses(site)
      })
    },

    setFrameworkSpacingClassGenerators: (classes) => {
      mutateSite((site) => {
        const spacing = ensureFrameworkSpacing(site)
        spacing.classes = classes
        reconcileFrameworkClasses(site)
      })
    },
  }
}
