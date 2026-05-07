/**
 * Framework typography — group CRUD helpers + store actions.
 */

import { nanoid } from 'nanoid'
import type {
  FrameworkTypographyGroup,
  SiteDocument,
  SiteSettings,
} from '@core/page-tree'
import {
  buildDefaultTypographyGroup,
  makeFreshTypographyGroup,
  nextTypographyTabValues,
} from '@core/framework/defaults'
import { reconcileFrameworkClasses } from './reconcile'
import { nextOrderValue } from './shared'
import type {
  SiteSlice,
  SiteSliceHelpers,
  UpdateFrameworkTypographyGroupPatch,
} from '../types'

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function ensureFrameworkTypography(
  site: SiteDocument,
): NonNullable<NonNullable<SiteSettings['framework']>['typography']> {
  if (!site.settings.framework) {
    site.settings.framework = { colors: { tokens: [] } }
  }
  if (!site.settings.framework.typography) {
    site.settings.framework.typography = { groups: [], classes: [] }
  }
  site.settings.framework.typography.groups ??= []
  site.settings.framework.typography.classes ??= []
  return site.settings.framework.typography
}

function applyFrameworkTypographyGroupPatch(
  group: FrameworkTypographyGroup,
  patch: UpdateFrameworkTypographyGroupPatch,
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

export type FrameworkTypographyActions = Pick<
  SiteSlice,
  | 'toggleFrameworkTypographyDisabled'
  | 'createFrameworkTypographyGroup'
  | 'updateFrameworkTypographyGroup'
  | 'duplicateFrameworkTypographyGroup'
  | 'resetFrameworkTypographyGroup'
  | 'deleteFrameworkTypographyGroup'
  | 'upsertFrameworkTypographyManualSize'
  | 'setFrameworkTypographyClassGenerators'
>

export function createFrameworkTypographyActions({
  get,
  mutateSite,
}: SiteSliceHelpers): FrameworkTypographyActions {
  return {
    toggleFrameworkTypographyDisabled: () => {
      mutateSite((site) => {
        const typography = ensureFrameworkTypography(site)
        typography.isDisabled = !typography.isDisabled
        reconcileFrameworkClasses(site)
      })
    },

    createFrameworkTypographyGroup: () => {
      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      // Read-only view of the (Immer-frozen) live site — `ensureFrameworkTypography`
      // mutates and would throw on the frozen object when typography (or framework)
      // is absent. The actual write happens inside `mutateSite` below.
      const groups = site.settings.framework?.typography?.groups ?? []
      const { name, varName } = nextTypographyTabValues(groups)
      const order = nextOrderValue(groups)
      const group = makeFreshTypographyGroup(name, varName, order)

      mutateSite((draftSite) => {
        const draftTypography = ensureFrameworkTypography(draftSite)
        draftTypography.groups.push(group)
        reconcileFrameworkClasses(draftSite)
      })
      return group
    },

    updateFrameworkTypographyGroup: (groupId, patch) => {
      mutateSite((site) => {
        const typography = ensureFrameworkTypography(site)
        const group = typography.groups.find((g) => g.id === groupId)
        if (!group) return
        applyFrameworkTypographyGroupPatch(group, patch)
        reconcileFrameworkClasses(site)
      })
    },

    duplicateFrameworkTypographyGroup: (groupId) => {
      const { site } = get()
      if (!site) return null
      // Read-only view of the (Immer-frozen) live site — see note in
      // `createFrameworkTypographyGroup`. The actual write is inside `mutateSite`.
      const groups = site.settings.framework?.typography?.groups ?? []
      const source = groups.find((g) => g.id === groupId)
      if (!source) return null

      const { name, varName } = nextTypographyTabValues(groups)
      const order = nextOrderValue(groups)
      const now = Date.now()
      const copy: FrameworkTypographyGroup = {
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
        const draftTypography = ensureFrameworkTypography(draftSite)
        draftTypography.groups.push(copy)
        reconcileFrameworkClasses(draftSite)
      })
      return copy
    },

    resetFrameworkTypographyGroup: (groupId) => {
      mutateSite((site) => {
        const typography = ensureFrameworkTypography(site)
        const idx = typography.groups.findIndex((g) => g.id === groupId)
        if (idx < 0) return
        const order = typography.groups[idx].order
        typography.groups[idx] = { ...buildDefaultTypographyGroup(order), id: groupId }
        reconcileFrameworkClasses(site)
      })
    },

    deleteFrameworkTypographyGroup: (groupId) => {
      mutateSite((site) => {
        const typography = ensureFrameworkTypography(site)
        typography.groups = typography.groups.filter((g) => g.id !== groupId)
        typography.classes = typography.classes?.filter((c) => c.tabId !== groupId) ?? []
        reconcileFrameworkClasses(site)
      })
    },

    upsertFrameworkTypographyManualSize: (groupId, sizeId, patch) => {
      mutateSite((site) => {
        const typography = ensureFrameworkTypography(site)
        const group = typography.groups.find((g) => g.id === groupId)
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

    setFrameworkTypographyClassGenerators: (classes) => {
      mutateSite((site) => {
        const typography = ensureFrameworkTypography(site)
        typography.classes = classes
        reconcileFrameworkClasses(site)
      })
    },
  }
}
