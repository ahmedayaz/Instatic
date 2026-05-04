/**
 * Framework spacing — fluid spacing scales.
 *
 * Sister of `framework/typography.ts`. The math, mode handling, naming, and
 * class-pattern expansion are identical between the two — both files are
 * thin adapters over `createFrameworkScaleModule` in `scaleModule.ts`.
 *
 * Spacing-specific bits:
 *   - the per-group base size lives at `group.min.size` / `group.max.size`,
 *   - the supported CSS properties are padding/margin/gap (not font-size),
 *   - the supported scale ratios extend up to Perfect Octave (2)
 *     (declared in `scale.ts::SPACING_RATIO_OPTIONS`).
 */

import type { CSSPropertyBag } from '../page-tree/schemas'
import type {
  FrameworkSpacingClassGenerator,
  FrameworkSpacingGroup,
  FrameworkSpacingSettings,
} from './schemas'
import { createFrameworkScaleModule } from './scaleModule'

const PROPERTY_KEYMAP: Record<string, keyof CSSPropertyBag> = {
  padding: 'padding',
  'padding-top': 'paddingTop',
  'padding-right': 'paddingRight',
  'padding-bottom': 'paddingBottom',
  'padding-left': 'paddingLeft',
  margin: 'margin',
  'margin-top': 'marginTop',
  'margin-right': 'marginRight',
  'margin-bottom': 'marginBottom',
  'margin-left': 'marginLeft',
  gap: 'gap',
  'row-gap': 'rowGap',
  'column-gap': 'columnGap',
}

const spacingModule = createFrameworkScaleModule<FrameworkSpacingGroup, FrameworkSpacingClassGenerator>({
  family: 'spacing',
  getMinBaseSize: (group) => group.min.size,
  getMaxBaseSize: (group) => group.max.size,
  getMinScaleConfig: (group) => group.min,
  getMaxScaleConfig: (group) => group.max,
  propertyKeymap: PROPERTY_KEYMAP,
  classTags: ['framework', 'utility', 'spacing'],
})

export function generateFrameworkSpacingVariables(
  settings: FrameworkSpacingSettings | null | undefined,
  preferences: Parameters<typeof spacingModule.generateVariables>[1],
) {
  return spacingModule.generateVariables(settings, preferences)
}

export function generateFrameworkSpacingRootCss(
  settings: FrameworkSpacingSettings | null | undefined,
  preferences: Parameters<typeof spacingModule.generateRootCss>[1],
): string {
  return spacingModule.generateRootCss(settings, preferences)
}

export function generateFrameworkSpacingUtilityClasses(
  settings: FrameworkSpacingSettings | null | undefined,
) {
  return spacingModule.generateUtilityClasses(settings)
}
