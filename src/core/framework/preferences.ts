/**
 * Resolve framework preferences with sensible Core Framework defaults.
 *
 * The settings.framework.preferences subtree is optional; when absent we fall
 * back to the same constants Core Framework uses (root_font_size=10, isRem=true,
 * minScreen=320, maxScreen=1400). Pulling this through a single helper keeps
 * the publisher and the canvas aligned with the editor without duplicating the
 * default constants in three different places.
 */

import type { FrameworkPreferencesSettings } from './schemas'
import {
  DEFAULT_FRAMEWORK_PREFERENCES,
  type FrameworkPreferences,
} from './scale'

export function resolveFrameworkPreferences(
  raw: FrameworkPreferencesSettings | null | undefined,
): FrameworkPreferences {
  if (!raw) return { ...DEFAULT_FRAMEWORK_PREFERENCES }
  return {
    rootFontSize:
      typeof raw.rootFontSize === 'number' && Number.isFinite(raw.rootFontSize) && raw.rootFontSize > 0
        ? raw.rootFontSize
        : DEFAULT_FRAMEWORK_PREFERENCES.rootFontSize,
    minScreenWidth:
      typeof raw.minScreenWidth === 'number' && Number.isFinite(raw.minScreenWidth) && raw.minScreenWidth > 0
        ? raw.minScreenWidth
        : DEFAULT_FRAMEWORK_PREFERENCES.minScreenWidth,
    maxScreenWidth:
      typeof raw.maxScreenWidth === 'number' && Number.isFinite(raw.maxScreenWidth) && raw.maxScreenWidth > 0
        ? raw.maxScreenWidth
        : DEFAULT_FRAMEWORK_PREFERENCES.maxScreenWidth,
    isRem: typeof raw.isRem === 'boolean' ? raw.isRem : DEFAULT_FRAMEWORK_PREFERENCES.isRem,
  }
}

export { DEFAULT_FRAMEWORK_PREFERENCES, type FrameworkPreferences }
