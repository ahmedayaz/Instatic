/**
 * Framework spacing — store actions.
 *
 * The action implementations live in `./scaleGroups.ts` (shared with the
 * typography family). This file is the thin family-specific wrapper: it
 * binds the generic actions to family-specific names and types so the
 * SiteSlice's external API stays explicit (`createFrameworkSpacingGroup`,
 * not `createGroup`).
 */

import {
  buildDefaultSpacingGroup,
  makeFreshSpacingGroup,
  nextSpacingTabValues,
} from '@core/framework/defaults'
import { createScaleGroupActions } from './scaleGroups'
import type { SiteSlice, SiteSliceHelpers } from '../types'

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

export function createFrameworkSpacingActions(
  helpers: SiteSliceHelpers,
): FrameworkSpacingActions {
  const inner = createScaleGroupActions(helpers, {
    family: 'spacing',
    buildDefault: buildDefaultSpacingGroup,
    makeFresh: makeFreshSpacingGroup,
    nextTabValues: nextSpacingTabValues,
  })

  return {
    toggleFrameworkSpacingDisabled: inner.toggleDisabled,
    createFrameworkSpacingGroup: inner.createGroup,
    updateFrameworkSpacingGroup: inner.updateGroup,
    duplicateFrameworkSpacingGroup: inner.duplicateGroup,
    resetFrameworkSpacingGroup: inner.resetGroup,
    deleteFrameworkSpacingGroup: inner.deleteGroup,
    upsertFrameworkSpacingManualSize: inner.upsertManualSize,
    setFrameworkSpacingClassGenerators: inner.setClassGenerators,
  }
}
