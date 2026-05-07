/**
 * Site-level settings mutation: updateSiteSettings.
 *
 * Framework-related settings (colors, typography, spacing, preferences) live
 * in their own files under `./framework/`.
 */

import type { SiteSlice, SiteSliceHelpers } from './types'

export type SettingsActions = Pick<SiteSlice, 'updateSiteSettings'>

export function createSettingsActions({
  mutateSite,
}: SiteSliceHelpers): SettingsActions {
  return {
    updateSiteSettings: (patch) => {
      mutateSite((p) => {
        Object.assign(p.settings, patch)
      })
    },
  }
}
