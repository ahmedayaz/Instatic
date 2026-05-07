/**
 * Framework preferences — single store action.
 */

import { DEFAULT_FRAMEWORK_PREFERENCES } from '@core/framework/preferences'
import type { SiteSlice, SiteSliceHelpers } from '../types'

export type FrameworkPreferencesActions = Pick<SiteSlice, 'updateFrameworkPreferences'>

export function createFrameworkPreferencesActions({
  mutateSite,
}: SiteSliceHelpers): FrameworkPreferencesActions {
  return {
    updateFrameworkPreferences: (patch) => {
      mutateSite((site) => {
        if (!site.settings.framework) {
          site.settings.framework = { colors: { tokens: [] } }
        }
        const current = site.settings.framework.preferences ?? DEFAULT_FRAMEWORK_PREFERENCES
        site.settings.framework.preferences = { ...current, ...patch }
      })
    },
  }
}
