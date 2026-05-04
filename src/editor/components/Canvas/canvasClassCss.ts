import { bagToCSS } from '@core/publisher/classCss'
import { generateFrameworkColorRootCss } from '@core/framework/colors'
import { generateFrameworkTypographyRootCss } from '@core/framework/typography'
import { generateFrameworkSpacingRootCss } from '@core/framework/spacing'
import { resolveFrameworkPreferences } from '@core/framework/preferences'
import { generateFontsCss } from '@core/fonts/css'
import { cssClassSelector } from '@core/page-tree/classNames'
import type { CSSClass, SiteFontsSettings } from '@core/page-tree/schemas'
import type {
  FrameworkColorSettings,
  FrameworkPreferencesSettings,
  FrameworkSpacingSettings,
  FrameworkTypographySettings,
} from '@core/framework/schemas'

export function generateCanvasClassCSS(
  classes: Record<string, CSSClass>,
  breakpoints: Array<{ id: string; width: number }>,
  frameworkColors?: FrameworkColorSettings | null,
  frameworkTypography?: FrameworkTypographySettings | null,
  frameworkSpacing?: FrameworkSpacingSettings | null,
  frameworkPreferences?: FrameworkPreferencesSettings | null,
  fonts?: SiteFontsSettings | null,
): string {
  const blocks: string[] = []
  const preferences = resolveFrameworkPreferences(frameworkPreferences)
  // Fonts go first so `@font-face` declarations exist before any rule that
  // references the family — browsers tolerate the reverse order, but the
  // ordering keeps generated CSS easier to inspect.
  const fontsCss = generateFontsCss(fonts)
  if (fontsCss) blocks.push(fontsCss)
  const frameworkColorCss = generateFrameworkColorRootCss(frameworkColors)
  if (frameworkColorCss) blocks.push(frameworkColorCss)
  const frameworkTypographyCss = generateFrameworkTypographyRootCss(frameworkTypography, preferences)
  if (frameworkTypographyCss) blocks.push(frameworkTypographyCss)
  const frameworkSpacingCss = generateFrameworkSpacingRootCss(frameworkSpacing, preferences)
  if (frameworkSpacingCss) blocks.push(frameworkSpacingCss)

  for (const cls of Object.values(classes)) {
    const baseDecls = bagToCSS(cls.styles)
    if (baseDecls) {
      blocks.push(`${cssClassSelector(cls)} {\n${baseDecls}\n}`)
    }

    for (const [bpId, bpStyles] of Object.entries(cls.breakpointStyles)) {
      const decls = bagToCSS(bpStyles)
      if (!decls) continue
      if (!breakpoints.some((breakpoint) => breakpoint.id === bpId)) continue
      blocks.push(`[data-breakpoint-id="${escapeCssAttribute(bpId)}"] ${cssClassSelector(cls)} {\n${decls}\n}`)
    }
  }

  return blocks.join('\n\n')
}

function escapeCssAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
