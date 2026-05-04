/**
 * fontsRepository — server-side installer for Google Fonts.
 *
 * Workflow:
 *   1. The editor sends `{ family, variants[], subsets[] }` to the install endpoint.
 *   2. We hit the public Google Fonts CSS2 endpoint per (variant, subset) pair to
 *      retrieve a single `@font-face` rule that points at a CDN-hosted woff2 URL.
 *      We never give that URL to the browser — it stays server-side only.
 *   3. We download each woff2, write it to `<uploads>/fonts/<slug>/...woff2`.
 *   4. We return a `FontEntry` ready for the client to merge into `site.settings.fonts`.
 *
 * The hit Google Fonts surface (`https://fonts.googleapis.com/css2?...`) is the
 * keyless one — it doesn't require an API key, only a UA hint that supports
 * woff2 (we send a modern Chrome UA). The font binaries live at
 * `https://fonts.gstatic.com/s/...` and are CC/OFL licensed for redistribution.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { FontEntry, FontFile } from '@core/page-tree/schemas'
import { familySlug } from '@core/fonts/css'
import { compareVariants, parseVariant, variantsToCss2Axis } from '@core/fonts/variants'
import { findGoogleFont } from '@core/fonts/googleDirectory'

/**
 * UA spoof: Google's CSS2 endpoint inspects the User-Agent header to decide which
 * font format URL to inline. Modern Chrome on Linux gets the woff2 URL we need.
 * Without a UA the response defaults to .ttf, which is much larger.
 */
const WOFF2_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const GOOGLE_CSS2_BASE = 'https://fonts.googleapis.com/css2'
const GSTATIC_HOST_RE = /^https:\/\/fonts\.gstatic\.com\//

export class FontInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FontInstallError'
  }
}

export interface InstallGoogleFontInput {
  family: string
  variants: readonly string[]
  subsets: readonly string[]
}

/**
 * Sanitise + cross-check the install request against the bundled Google Fonts
 * directory. The request fails closed: only families we ship in the snapshot
 * can be installed, and only their advertised variants/subsets are honoured.
 */
function resolveGoogleRequest(input: InstallGoogleFontInput): {
  family: string
  category: string
  variants: string[]
  subsets: string[]
} {
  const family = (input.family ?? '').trim()
  if (!family) throw new FontInstallError('Missing font family')
  const directoryEntry = findGoogleFont(family)
  if (!directoryEntry) {
    throw new FontInstallError(`Unknown Google font family: ${family}`)
  }

  const allowedVariants = new Set(directoryEntry.variants)
  const allowedSubsets = new Set(directoryEntry.subsets)

  const variants = (input.variants ?? [])
    .filter((v): v is string => typeof v === 'string' && allowedVariants.has(v))
    .filter((v) => parseVariant(v) !== null)
  const subsets = (input.subsets ?? [])
    .filter((s): s is string => typeof s === 'string' && allowedSubsets.has(s))

  if (variants.length === 0) {
    throw new FontInstallError(`No supported variants requested for ${family}`)
  }
  if (subsets.length === 0) {
    throw new FontInstallError(`No supported subsets requested for ${family}`)
  }

  return {
    family,
    category: directoryEntry.category,
    variants: Array.from(new Set(variants)).sort(compareVariants),
    subsets: Array.from(new Set(subsets)),
  }
}

/**
 * Pull the CSS2 stylesheet for one (family × all-variants × single-subset) and
 * return it. Splitting per subset matches how the CSS2 endpoint emits separate
 * `@font-face` blocks per subset (each with its own `unicode-range`); we extract
 * the woff2 URLs from each block.
 */
async function fetchSubsetCss(
  family: string,
  axisSpec: string,
  subset: string,
): Promise<string> {
  // The `subset` query parameter is a documented CSS2 endpoint feature
  // — `&subset=latin` restricts the response to one subset.
  const url = `${GOOGLE_CSS2_BASE}?family=${encodeURIComponent(family)}:${axisSpec}&subset=${encodeURIComponent(subset)}&display=swap`
  const res = await fetch(url, { headers: { 'User-Agent': WOFF2_UA } })
  if (!res.ok) {
    throw new FontInstallError(`Google Fonts CSS request failed for ${family} / ${subset} (HTTP ${res.status})`)
  }
  return res.text()
}

interface ParsedFace {
  weight: number
  italic: boolean
  url: string
}

/**
 * Tease out (weight, italic, url) tuples from a CSS2 response. Each
 * `@font-face` block contains exactly one `src: url(...)` for the requested
 * format (woff2). We tolerate extra whitespace / nested rules but stop at the
 * first comma in `src:` to avoid grabbing a fallback.
 */
function parseCss2Faces(css: string): ParsedFace[] {
  const faces: ParsedFace[] = []
  const blockRe = /@font-face\s*\{([^}]+)\}/g
  let match: RegExpExecArray | null
  while ((match = blockRe.exec(css)) !== null) {
    const block = match[1]
    const weightMatch = /font-weight\s*:\s*(\d+)/.exec(block)
    const styleMatch = /font-style\s*:\s*(italic|normal)/.exec(block)
    const urlMatch = /url\((https:\/\/[^)]+\.woff2)\)/.exec(block)
    if (!weightMatch || !styleMatch || !urlMatch) continue
    if (!GSTATIC_HOST_RE.test(urlMatch[1])) continue
    faces.push({
      weight: Number(weightMatch[1]),
      italic: styleMatch[1] === 'italic',
      url: urlMatch[1],
    })
  }
  return faces
}

async function downloadBinary(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { 'User-Agent': WOFF2_UA } })
  if (!res.ok) {
    throw new FontInstallError(`Failed to download font binary (HTTP ${res.status})`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Per-variant filename inside the family directory:
 *   `<weight><i?>-<subset>.woff2` → e.g. `400-latin.woff2`, `700italic-latin-ext.woff2`.
 *
 * Subset is restricted to the bundled directory's allow-list before this
 * function runs, so it's already a known token (latin, latin-ext, etc.) — but
 * we still strip anything outside `[a-z0-9-]` defensively in case Google adds
 * a future subset name we don't know about.
 */
function fontFilename(variant: string, subset: string): string {
  const safeSubset = subset.toLowerCase().replace(/[^a-z0-9-]/g, '')
  return `${variant}-${safeSubset || 'latin'}.woff2`
}

export async function installGoogleFont(
  input: InstallGoogleFontInput,
  uploadsDir: string,
): Promise<FontEntry> {
  const resolved = resolveGoogleRequest(input)
  const slug = familySlug(resolved.family)
  if (!slug) throw new FontInstallError('Family name has no usable slug')

  const targetDir = join(uploadsDir, 'fonts', slug)
  await mkdir(targetDir, { recursive: true })

  const axisSpec = variantsToCss2Axis(resolved.variants)
  if (!axisSpec) throw new FontInstallError('No usable variants for Google Fonts CSS request')

  const files: FontFile[] = []
  for (const subset of resolved.subsets) {
    const css = await fetchSubsetCss(resolved.family, axisSpec, subset)
    const faces = parseCss2Faces(css)
    if (faces.length === 0) {
      // Subset returned no faces — possibly Google dropped it. Skip rather
      // than fail the whole install.
      continue
    }
    for (const face of faces) {
      const variant = face.italic ? `${face.weight}italic` : String(face.weight)
      // Drop any face that came back with a weight the user didn't ask for —
      // CSS2 occasionally ships a wider set than requested for variable fonts.
      if (!resolved.variants.includes(variant)) continue
      const filename = fontFilename(variant, subset)
      const bytes = await downloadBinary(face.url)
      await writeFile(join(targetDir, filename), bytes)
      files.push({
        variant,
        subset,
        path: `/uploads/fonts/${slug}/${filename}`,
        format: 'woff2',
      })
    }
  }

  if (files.length === 0) {
    // Cleanup: empty directory is meaningless on disk.
    await rm(targetDir, { recursive: true, force: true })
    throw new FontInstallError(`Google Fonts returned no woff2 files for ${resolved.family}`)
  }

  const now = Date.now()
  return {
    id: nanoid(),
    source: 'google',
    family: resolved.family,
    variants: resolved.variants,
    subsets: resolved.subsets,
    files,
    category: resolved.category,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Remove every woff2 file for a family slug from disk. Called by the delete
 * endpoint after the client has dropped the entry from `site.settings.fonts`.
 * Idempotent — missing directory is not an error.
 */
export async function uninstallFontFamily(
  family: string,
  uploadsDir: string,
): Promise<void> {
  const slug = familySlug(family)
  if (!slug) return
  await rm(join(uploadsDir, 'fonts', slug), { recursive: true, force: true })
}
