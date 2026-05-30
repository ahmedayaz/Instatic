/**
 * assetPlan — collect asset references from page fragments and CSS rules,
 * then normalise all URL-shaped values in the plan to FileMap keys so that
 * `applyAssetRewrites` can do exact-string replacement.
 *
 * Two sources of asset references:
 *   1. PageNode props — `src`, `href`, `srcset` values set by the HTML
 *      importer from element attributes.
 *   2. CSS rule styles — `url(...)` payloads recorded by Phase 1's
 *      `cssToStyleRules` in the returned `AssetRef[]`.
 *
 * After normalisation:
 *   - URL-shaped props in node fragments are replaced with their FileMap key
 *     (e.g. `"./images/hero.png"` → `"images/hero.png"`).
 *   - CSS `url('...')` expressions inside styles and breakpointStyles are
 *     rewritten to hold the FileMap key as the URL payload.
 *   - External URLs (`http://`, `https://`, `//`, `data:`, `mailto:`, `tel:`,
 *     `#fragment`) are left unchanged.
 *
 * The normalised pagePlans and styleRules are returned alongside the deduplicated
 * asset list; only files present in the FileMap are included.
 */

import type { PageNode } from '@core/page-tree'
import type { ImportFragment } from '@core/htmlImport'
import type {
  FileMap,
  ImportWarning,
  PagePlan,
  AssetRef,
  NewStyleRule,
} from './types'
import { guessMimeType } from './mimeTypes'

// ---------------------------------------------------------------------------
// Props that may contain relative asset URLs in page nodes
// ---------------------------------------------------------------------------

const URL_BEARING_PROPS: ReadonlySet<string> = new Set(['src', 'href', 'srcset'])

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CssFileResult {
  /** FileMap key of the CSS source file. */
  cssPath: string
  /** Rules produced by cssToStyleRules for this file. */
  rules: NewStyleRule[]
  /** Asset URL references found in the rules. */
  assetRefs: AssetRef[]
}

export interface AssetPlanResult {
  /** pagePlans with URL props in node fragments normalised to FileMap keys. */
  normalizedPagePlans: PagePlan[]
  /** Flat list of all style rules (from all CSS files) with url() values normalised. */
  normalizedStyleRules: NewStyleRule[]
  /** Deduplicated asset list for upload, keyed by FileMap path. */
  assets: { sourcePath: string; mimeType: string; bytes: Uint8Array }[]
  warnings: ImportWarning[]
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

/**
 * Collect and normalise all asset references in the import plan.
 *
 * @param pagePlans      — Raw PagePlans (node fragments have raw HTML URLs).
 * @param cssFileResults — Per-CSS-file parse results including AssetRef lists.
 * @param fileMap        — The FileMap to look up asset bytes.
 */
export function buildAssetPlan(
  pagePlans: PagePlan[],
  cssFileResults: CssFileResult[],
  fileMap: FileMap,
): AssetPlanResult {
  const warnings: ImportWarning[] = []
  /** Deduplicated assets by FileMap key. */
  const assetMap = new Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>()

  // --- Normalise node fragments ---
  const normalizedPagePlans: PagePlan[] = pagePlans.map((plan) => {
    const normalizedFragment = normalizeFragment(
      plan.nodeFragment,
      plan.source,
      fileMap,
      assetMap,
    )
    return { ...plan, nodeFragment: normalizedFragment }
  })

  // --- Normalise CSS rules ---
  const normalizedStyleRules: NewStyleRule[] = []
  for (const { cssPath, rules, assetRefs } of cssFileResults) {
    const normalized = normalizeRules(rules, assetRefs, cssPath, fileMap, assetMap)
    normalizedStyleRules.push(...normalized)
  }

  // --- Sweep up unreferenced binary/media files ---
  //
  // Anything the user bundled that classifies as image / font / binary lands
  // in the media library even when nothing in the imported HTML / CSS refers
  // to it. The intent is "I dragged a folder in, I expect to see those files
  // in my media library" — silently dropping the unreferenced ones makes the
  // wizard feel lossy. Page-source files (html, css, js, meta) are still
  // excluded; they're consumed by the page / rule pipelines.
  for (const [filePath, entry] of Object.entries(fileMap.files)) {
    if (assetMap.has(filePath)) continue
    const mimeType = entry.mimeType ?? guessMimeType(filePath)
    if (NON_ASSET_MIME_PREFIXES.some((prefix) => mimeType.toLowerCase().startsWith(prefix))) continue
    assetMap.set(filePath, { sourcePath: filePath, mimeType, bytes: entry.bytes })
  }

  const assets = Array.from(assetMap.values())

  return { normalizedPagePlans, normalizedStyleRules, assets, warnings }
}

// ---------------------------------------------------------------------------
// Node fragment normalisation
// ---------------------------------------------------------------------------

function normalizeFragment(
  fragment: ImportFragment,
  htmlFilePath: string,
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
): ImportFragment {
  const normalizedNodes: Record<string, PageNode> = {}

  for (const [id, node] of Object.entries(fragment.nodes)) {
    const newProps = normalizeNodeProps(node.props, htmlFilePath, fileMap, assetMap)
    normalizedNodes[id] = { ...node, props: newProps }
  }

  return { nodes: normalizedNodes, rootIds: fragment.rootIds }
}

function normalizeNodeProps(
  props: Record<string, unknown>,
  htmlFilePath: string,
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...props }

  for (const propKey of URL_BEARING_PROPS) {
    const val = result[propKey]
    if (typeof val !== 'string' || val.length === 0) continue

    if (propKey === 'srcset') {
      result[propKey] = normalizeSrcset(val, htmlFilePath, fileMap, assetMap)
      continue
    }

    const fileMapKey = resolveAndRecord(val, htmlFilePath, fileMap, assetMap)
    if (fileMapKey !== null) result[propKey] = fileMapKey
    // If null: external URL or not in FileMap — leave original value
  }

  return result
}

/**
 * Normalise a `srcset` attribute value.
 * Format: `url1 2x, url2 1x` or `url1 800w, url2 1200w`.
 * Only the URL parts are replaced; the descriptor (2x, 800w) is preserved.
 */
function normalizeSrcset(
  srcset: string,
  htmlFilePath: string,
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
): string {
  const parts = srcset.split(',').map((s) => s.trim()).filter(Boolean)
  const normalized = parts.map((part) => {
    const [urlPart, ...descriptors] = part.split(/\s+/)
    if (!urlPart) return part
    const fileMapKey = resolveAndRecord(urlPart, htmlFilePath, fileMap, assetMap)
    const url = fileMapKey ?? urlPart
    return descriptors.length > 0 ? `${url} ${descriptors.join(' ')}` : url
  })
  return normalized.join(', ')
}

// ---------------------------------------------------------------------------
// CSS rule normalisation
// ---------------------------------------------------------------------------

function normalizeRules(
  rules: NewStyleRule[],
  assetRefs: AssetRef[],
  cssFilePath: string,
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
): NewStyleRule[] {
  if (assetRefs.length === 0) return rules

  // Group assetRefs by rule index for O(1) lookup
  const refsByRule = new Map<number, AssetRef[]>()
  for (const ref of assetRefs) {
    let bucket = refsByRule.get(ref.ruleIndex)
    if (!bucket) {
      bucket = []
      refsByRule.set(ref.ruleIndex, bucket)
    }
    bucket.push(ref)
  }

  const normalized = rules.map((rule, ruleIdx) => {
    const refs = refsByRule.get(ruleIdx)
    if (!refs || refs.length === 0) return rule

    const newStyles = { ...rule.styles } as Record<string, unknown>
    const newBpStyles: Record<string, Record<string, unknown>> = {}
    for (const [bpId, bpStyles] of Object.entries(rule.breakpointStyles)) {
      newBpStyles[bpId] = { ...(bpStyles as Record<string, unknown>) }
    }
    // Clone conditional layers so url() rewrites don't mutate the source plan.
    const newLayers = rule.conditionalLayers?.map((l) => ({
      ...l,
      styles: { ...(l.styles as Record<string, unknown>) },
    }))

    for (const ref of refs) {
      const fileMapKey = resolveAndRecord(ref.rawUrl, cssFilePath, fileMap, assetMap)
      if (fileMapKey === null) continue // external or not in FileMap

      if (ref.layerId !== undefined) {
        // url() inside a conditional layer (@media / @container / @supports).
        const layer = newLayers?.find((l) => l.id === ref.layerId)
        const val = layer?.styles[ref.property]
        if (layer && typeof val === 'string') {
          layer.styles[ref.property] = replaceRawUrlInValue(val, ref.rawUrl, fileMapKey)
        }
      } else if (ref.breakpointId === undefined) {
        const val = newStyles[ref.property]
        if (typeof val === 'string') {
          newStyles[ref.property] = replaceRawUrlInValue(val, ref.rawUrl, fileMapKey)
        }
      } else {
        const bpStyles = newBpStyles[ref.breakpointId]
        if (bpStyles) {
          const val = bpStyles[ref.property]
          if (typeof val === 'string') {
            bpStyles[ref.property] = replaceRawUrlInValue(val, ref.rawUrl, fileMapKey)
          }
        }
      }
    }

    return {
      ...rule,
      ...(newLayers !== undefined ? { conditionalLayers: newLayers } : {}),
      styles: newStyles,
      breakpointStyles: newBpStyles,
    }
  })

  // Orphan asset refs — those whose `ruleIndex` doesn't bind to any rule we
  // emitted. The CSS parser uses this for assets that live inside a dropped
  // at-rule we can't model (notably `@font-face`'s `src: url(...)`). We still
  // want the underlying file in `plan.assets` so the user gets the binary in
  // their media library; the @font-face declaration itself is lost, but the
  // file is recoverable.
  for (const [ruleIdx, refs] of refsByRule) {
    if (ruleIdx < normalized.length) continue
    for (const ref of refs) {
      resolveAndRecord(ref.rawUrl, cssFilePath, fileMap, assetMap)
    }
  }

  return normalized
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** URLs that should always pass through unchanged (external + special schemes). */
const EXTERNAL_URL_RE = /^https?:\/\/|^\/\/|^data:|^mailto:|^tel:|^#/

/**
 * MIME type prefixes that identify web document / script sources.
 *
 * Files with these types are processed by the pipeline as pages or style
 * sources, not uploaded to the media library.  An `<a href="about.html">`
 * anchor should never cause `about.html` to appear in `plan.assets`, even
 * if the file exists in the FileMap.
 */
const NON_ASSET_MIME_PREFIXES: readonly string[] = [
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
]

/**
 * Resolve a raw URL relative to `basePath`, look it up in the FileMap,
 * register the asset in `assetMap`, and return the FileMap key.
 *
 * Returns null when:
 *   - the URL is external / uses a special scheme,
 *   - the resolved path is not in the FileMap, or
 *   - the resolved file is a web document / script (HTML, CSS, JS) — those
 *     are page/style sources, not uploadable media assets.
 */
function resolveAndRecord(
  rawUrl: string,
  basePath: string,
  fileMap: FileMap,
  assetMap: Map<string, { sourcePath: string; mimeType: string; bytes: Uint8Array }>,
): string | null {
  if (!rawUrl || EXTERNAL_URL_RE.test(rawUrl)) return null

  const fileMapKey = resolveRelativePath(rawUrl, basePath)
  if (!fileMapKey) return null

  const entry = fileMap.files[fileMapKey]
  if (!entry) return null

  const mimeType = entry.mimeType ?? guessMimeType(fileMapKey)

  // HTML, CSS, and JS files are page/style sources — never upload them as
  // media assets.  An anchor <a href="other-page.html"> must not cause
  // "other-page.html" to appear in plan.assets.
  if (NON_ASSET_MIME_PREFIXES.some((prefix) => mimeType.toLowerCase().startsWith(prefix))) {
    return null
  }

  if (!assetMap.has(fileMapKey)) {
    assetMap.set(fileMapKey, { sourcePath: fileMapKey, mimeType, bytes: entry.bytes })
  }

  return fileMapKey
}

/**
 * Resolve a raw URL against a base file path to produce a FileMap key.
 * Returns null for traversal-escaping paths or empty strings.
 */
function resolveRelativePath(rawUrl: string, basePath: string): string | null {
  const baseDir = dirname(basePath)

  const resolved = rawUrl.startsWith('/')
    ? rawUrl.slice(1) // root-relative: strip leading /
    : joinPaths(baseDir, rawUrl)

  // Reject escaped or empty results
  if (!resolved || resolved.startsWith('../')) return null

  return resolved
}

/** Replace a raw URL payload inside a CSS `url()` expression with the FileMap key. */
function replaceRawUrlInValue(value: string, rawUrl: string, fileMapKey: string): string {
  // Escape the rawUrl for use in a regex
  const escaped = rawUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Match url(), url(''), url("") variants
  const re = new RegExp(`url\\(\\s*(['"]?)${escaped}\\1\\s*\\)`, 'g')
  return value.replace(re, `url('${fileMapKey}')`)
}

// ---------------------------------------------------------------------------
// Path utilities (duplicated from htmlPagePlan to keep modules self-contained)
// ---------------------------------------------------------------------------

function dirname(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return slash >= 0 ? filePath.slice(0, slash) : ''
}

function joinPaths(dir: string, relative: string): string {
  const base = dir ? dir.split('/') : []
  const parts = [...base, ...relative.split('/')]
  const resolved: string[] = []

  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (resolved.length > 0) resolved.pop()
    } else {
      resolved.push(part)
    }
  }

  return resolved.join('/')
}
