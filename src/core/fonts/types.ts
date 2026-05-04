/**
 * Re-export of font-related types from `page-tree/types`. Lets the rest of the
 * fonts subsystem `import { FontEntry, ... } from '@core/fonts/types'` without
 * threading the page-tree path through every file.
 */

export type {
  FontEntry,
  FontFile,
  FontSource,
  SiteFontsSettings,
} from '@core/page-tree/schemas'

/**
 * Parsed variant — `weight` is the numeric CSS font-weight; `italic` is true
 * when the variant tag ends in "italic".
 */
export interface ParsedVariant {
  weight: number
  italic: boolean
}

/**
 * Bundled Google Fonts directory entry — the shape produced by
 * `scripts/build-google-fonts.ts` and consumed by the editor UI.
 */
export interface GoogleFontFamily {
  family: string
  category: string
  subsets: string[]
  variants: string[]
  popularity: number
}

export interface GoogleFontDirectory {
  fetchedAt: string
  families: GoogleFontFamily[]
}
