/**
 * Publisher — Recursive Renderer
 *
 * Converts a Page (flat-map PageNode tree) into a clean, standalone HTML document.
 * All string props are HTML-escaped before being passed to module render() functions.
 * CSS is deduplicated by moduleId — 50 heading nodes share one CSS entry.
 *
 * Constraint #211: escapeProps() must be called on every node before render().
 * Constraint #179: module render() is a pure function — no DOM, no React, no side effects.
 * Decision #308: CSS dedup keyed by moduleId reduces published CSS by ~60–80% on typical pages.
 */

import type { Page, PageNode, SiteDocument } from '@core/page-tree/schemas'
import type { AnyModuleDefinition, IModuleRegistry } from '@core/module-engine/types'
import { resolveProps } from '@core/page-tree/selectors'
import { resolveDynamicProps, type TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { buildPageFrame, buildSiteFrame, buildRouteFrame } from '@core/templates/contextFrames'
import { classNamesForClassIds } from '@core/page-tree/classNames'
import { sanitizeModuleCSS, collectClassCSS } from './cssCollector'
import { PUBLISHER_RESET_CSS } from './reset'
import { buildSiteFrameworkCss } from './frameworkCss'
import type { SiteCssBundle } from './siteCssBundle'
import { escapeHtml, isSafeUrl } from './utils'
import type { PublishedPageRuntimeAssets } from '@core/site-runtime/schemas'
import { hasPublishedRuntimeScripts, scriptTagsForRuntimeAssets } from '@core/site-runtime'
import { sanitizeRichtext } from '@core/sanitize'
import { instantiateVCAtRef, type InstantiatedVCNode } from '@core/visualComponents/instantiate'
import type { LoopFetchResult, LoopItem } from '@core/loops/types'
import { resolveHtmlTag } from '@modules/base/utils/htmlTag'
import { resolveAutoSizes } from './sizesResolver'

// Re-export canonical utilities so existing imports from this file keep working
// (render.test.ts imports escapeHtml / isSafeUrl from here)
export { escapeHtml, isSafeUrl } from './utils'

// ---------------------------------------------------------------------------
// Security — prop escaping (Constraint #211)
// ---------------------------------------------------------------------------

/**
 * URL-related prop key suffixes and exact keys.
 * These receive URL validation rather than HTML escaping.
 */
const URL_PROP_KEYS = new Set(['href', 'src', 'action', 'url'])
const URL_PROP_SUFFIXES = ['url', 'href', 'src']

/**
 * Richtext/HTML prop keys — passed through unescaped.
 * MUST have been sanitized (e.g. DOMPurify) at input time.
 */
const RICHTEXT_PROP_KEYS = new Set(['richtext', 'html'])
const RICHTEXT_PROP_SUFFIXES = ['html', 'richtext']

function isUrlKey(key: string): boolean {
  const k = key.toLowerCase()
  if (URL_PROP_KEYS.has(k)) return true
  return URL_PROP_SUFFIXES.some((s) => k.endsWith(s))
}

function isRichtextKey(key: string): boolean {
  const k = key.toLowerCase()
  if (RICHTEXT_PROP_KEYS.has(k)) return true
  return RICHTEXT_PROP_SUFFIXES.some((s) => k.endsWith(s))
}

/**
 * Escape all string props before passing them to a module's render() function.
 *
 * Rules:
 * - String props: HTML-escaped via escapeHtml()
 * - URL props (href/src/action/url suffixes): validated with isSafeUrl(), replaced with '#' if unsafe
 * - Richtext/HTML props: passed through as-is (must be sanitised at input time)
 * - Non-string props: unchanged
 */
export function escapeProps(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const escaped: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'string') {
      escaped[key] = value
      continue
    }

    if (isRichtextKey(key)) {
      // Richtext: defense-in-depth sanitization via DOMPurify (Constraint #368).
      // DOMPurify runs at write time (editor/Properties Panel boundary); this is a
      // second pass at the publisher boundary so that corrupted or injected richtext
      // values cannot reach the published HTML unsanitized.
      // sanitizeRichtext falls back to a regex strip if DOMPurify is unavailable
      // (e.g. server-side Bun context with no DOM).
      escaped[key] = sanitizeRichtext(value)
    } else if (isUrlKey(key)) {
      // URLs: block javascript: and vbscript: schemes; pass safe URLs through raw
      // so that module render() functions can HTML-escape them via safeUrl() from
      // modules/base/utils/escape.ts.  Publisher HTML-escaping plain strings is the
      // escapeProps() contract for non-URL string props; URL props deliberately skip
      // the escapeHtml() step here to avoid double-escaping when modules call safeUrl()
      // (which also applies escapeHtml internally).
      // Note: publishPage() manually escapeHtml()'s faviconUrl/fontImportUrl because
      // those are not passed to module render() — they go directly into HTML template
      // strings that never pass through a module's safeUrl() call.
      escaped[key] = isSafeUrl(value) ? value : '#'
    } else {
      // Plain strings: HTML-escape
      escaped[key] = escapeHtml(value)
    }
  }

  return escaped
}

// ---------------------------------------------------------------------------
// Class injection helper (Task #401 Bug 3)
// ---------------------------------------------------------------------------

/**
 * Inject a class attribute into the ROOT element of an HTML string.
 *
 * The function locates the first opening element tag in `html` and modifies
 * only that tag — never a nested descendant. Two cases on the root tag:
 *
 * 1. Root tag already has `class="..."` → prepend the new classes.
 *    `<div class="existing">` → `<div class="class_name existing">`
 * 2. Root tag has no class attribute → insert one as the first attribute.
 *    `<button type="button">` → `<button class="class_name" type="button">`
 *
 * The classAttr string is pre-validated by the caller (class tokens, HTML-escaped).
 *
 * Comments / DOCTYPE / processing-instructions before the first element tag
 * are skipped — they don't take a class attribute. If `html` contains no
 * element tag at all (e.g. a comment-only placeholder, or empty string),
 * the original `html` is returned unchanged.
 *
 * Anchoring on the FIRST tag is essential: the previous implementation used
 * a non-anchored regex that could match a nested descendant's `class="..."`
 * when the root had no class — causing parent classes to be wrongly prepended
 * to the deepest classed element rather than to the root itself.
 */
function injectClassIntoRootElement(html: string, classAttr: string): string {
  // Find the first opening element tag. Anchored on `<[a-zA-Z]` so it skips
  // `<!--`, `<!DOCTYPE`, and `<?xml`-style prefixes.
  // `[^>]*` is safe because module render() output escapes attribute values
  // (so `>` cannot appear inside an attribute value here).
  const tagMatch = html.match(/<([a-zA-Z][\w-]*)\b([^>]*)>/)
  if (!tagMatch) return html

  const [fullMatch, tagName, attrs] = tagMatch
  const tagStart = tagMatch.index ?? 0

  // Does the ROOT tag already carry a class attribute?
  const classRe = /\bclass="([^"]*)"/
  const existingClass = attrs.match(classRe)

  let newAttrs: string
  if (existingClass) {
    // Prepend the new classes to the existing list (preserve cascade order)
    newAttrs = attrs.replace(classRe, `class="${classAttr} ${existingClass[1]}"`)
  } else {
    // Insert the class as the first attribute on the root tag
    newAttrs = ` class="${classAttr}"${attrs}`
  }

  const newTag = `<${tagName}${newAttrs}>`
  return html.slice(0, tagStart) + newTag + html.slice(tagStart + fullMatch.length)
}

/**
 * Inject a node's user-applied classIds onto its rendered root element.
 *
 * Resolves classIds against `site.classes` (skipping unknown ids), HTML-escapes
 * every token, joins them with spaces, and prepends the result onto the root
 * element's `class` attribute (or inserts a new attribute when there isn't
 * one). Returns the original `html` unchanged when the node has no classIds,
 * when every classId is unknown, or when `html` contains no element tag.
 *
 * Shared by renderNode, renderVisualComponentRef, and renderLoop — the
 * three call sites that emit a wrapper element on which page-author classes
 * must land. Keeping the logic in one helper means a new render path that
 * needs author-class support is one call, not five duplicated lines.
 */
function injectNodeClassIds(
  html: string,
  classIds: readonly string[] | undefined,
  site: SiteDocument,
): string {
  if (!classIds?.length) return html
  const classAttr = classNamesForClassIds(site.classes, classIds)
    .map(escapeHtml)
    .join(' ')
  if (!classAttr) return html
  return injectClassIntoRootElement(html, classAttr)
}

// ---------------------------------------------------------------------------
// Visual Component inlining
// ---------------------------------------------------------------------------

/**
 * Adapt an InstantiatedVCNode to the PageNode shape required by the publisher walker.
 *
 * VCNode is structurally compatible with PageNode for all fields the walker reads
 * (moduleId, props, breakpointOverrides, children, classIds). The extra
 * InstantiatedVCNode fields (_owningRefId, _fromSlotContent) are not part of
 * PageNode and are harmlessly ignored by the walker.
 * dynamicBindings is intentionally absent: VCNodes don't support template
 * bindings (those live only on page-level nodes).
 */
function instantiatedNodeToPageNode(node: InstantiatedVCNode): PageNode {
  return {
    id: node.id,
    moduleId: node.moduleId,
    props: node.props,
    breakpointOverrides: node.breakpointOverrides,
    children: node.children,
    label: node.label,
    locked: node.locked,
    hidden: node.hidden,
    classIds: node.classIds,
    propBindings: node.propBindings,
  }
}

/**
 * Render a base.visual-component-ref node by inlining its VC tree.
 *
 * Called from renderNode before the normal render() dispatch for all
 * base.visual-component-ref nodes. The VC is instantiated via
 * instantiateVCAtRef (which applies propOverrides and expands slot outlets),
 * then rendered recursively using a synthetic Page built from the flat
 * instantiated node map. The shared ctx.cssMap ensures CSS deduplication
 * across the whole page — a VC used three times contributes module CSS only once.
 *
 * The page-level ref node's own classIds are injected onto the VC's root
 * element after recursive rendering, preserving the page author's intent.
 */
function renderVisualComponentRef(node: PageNode, ctx: RenderContext): string {
  const componentId =
    typeof node.props.componentId === 'string' ? node.props.componentId.trim() : ''
  if (!componentId) {
    return '<!-- pb: visual-component-ref missing componentId -->'
  }

  const propOverrides =
    node.props.propOverrides !== null &&
    typeof node.props.propOverrides === 'object' &&
    !Array.isArray(node.props.propOverrides)
      ? (node.props.propOverrides as Record<string, unknown>)
      : {}

  const vc = ctx.site.visualComponents.find((v) => v.id === componentId)
  if (!vc) {
    return `<!-- pb: unknown component "${escapeHtml(componentId)}" -->`
  }

  // Build slotInstancesByName from this VC ref node's base.slot-instance children
  // in the page tree. Each slot-instance's children are the user-authored slot content.
  const slotInstancesByName: Record<string, string[]> = {}
  for (const childId of node.children ?? []) {
    const child = ctx.page.nodes[childId]
    if (child?.moduleId === 'base.slot-instance') {
      const slotName =
        typeof child.props.slotName === 'string' && child.props.slotName
          ? child.props.slotName
          : 'children'
      slotInstancesByName[slotName] = child.children ?? []
    }
  }

  const { nodes: instantiatedNodes, rootNodeId } = instantiateVCAtRef(
    vc,
    propOverrides,
    slotInstancesByName,
    ctx.page.nodes,
    node.id,
  )

  // Build a minimal synthetic Page from the instantiated flat node map.
  // Only nodes and rootNodeId are needed by the walker — other Page fields
  // are stubs (the VC has no URL, slug, or template configuration).
  const syntheticNodes: Record<string, PageNode> = {}
  for (const [id, vcNode] of Object.entries(instantiatedNodes)) {
    syntheticNodes[id] = instantiatedNodeToPageNode(vcNode)
  }

  const syntheticPage: Page = {
    id: `vc:${node.id}`,
    slug: '',
    title: '',
    nodes: syntheticNodes,
    rootNodeId,
  }

  // Reuse all context fields but swap the page for the VC's synthetic page.
  // Sharing cssMap is critical: CSS dedup is keyed by moduleId across the
  // whole published page, including all inlined VC instances.
  const syntheticCtx: RenderContext = {
    page: syntheticPage,
    site: ctx.site,
    registry: ctx.registry,
    breakpointId: ctx.breakpointId,
    templateContext: ctx.templateContext,
    cssMap: ctx.cssMap,
  }

  // The page-level ref node's classIds belong on the VC's root element;
  // the VC's own nodes contribute their classIds via the recursive call.
  return injectNodeClassIds(renderNode(rootNodeId, syntheticCtx), node.classIds, ctx.site)
}

// ---------------------------------------------------------------------------
// base.loop renderer
// ---------------------------------------------------------------------------

/**
 * Render a `base.loop` node by iterating its resolved data and round-robining
 * over the loop's children.
 *
 * For a loop with N children and M items, iteration `i` (0-indexed) renders
 * the loop's child at index `i mod N` with the loop's `entryStack` extended
 * by the iteration's item. Two children → alternating layouts; three →
 * cycle of three; etc. After each iteration the entry stack is restored
 * so the loop's siblings keep seeing the outer template entry (if any).
 *
 * Loops without resolved data (server pre-fetch failed, source unregistered,
 * or no data context like in editor canvas tests) render an HTML comment so
 * the page doesn't silently lose layout. Empty result sets render as empty
 * string — author can wrap the loop in a Container to apply "if empty, hide
 * the section" patterns later.
 *
 * Pagination:
 *   - 'none': all rendered items emitted, no extra markup.
 *   - 'infinite': items emitted, plus a `data-pb-loop-id` sentinel and the
 *     loop's nodeId is added to `ctx.infiniteLoopIds` so the publisher can
 *     inject the runtime script. The runtime fetches subsequent pages from
 *     `/_pb/loop/<loopId>?page=N` and appends rendered HTML.
 *
 * The loop's own `classIds` are injected onto a wrapping `<div>` so author-
 * applied classes (e.g. grid layout) actually take effect.
 */
function renderLoop(node: PageNode, ctx: RenderContext): string {
  const loopId = node.id
  const data = ctx.loopData?.get(loopId)
  // No pre-fetched data — most likely an editor preview or a test that did
  // not seed loopData. Emit a marker comment rather than an empty string so
  // diagnostics in the rendered output are visible.
  if (!data) {
    return `<!-- pb: loop "${escapeHtml(loopId)}" has no resolved data -->`
  }

  const variants = node.children ?? []
  if (variants.length === 0) {
    return '<!-- pb: loop has no child template -->'
  }
  if (data.items.length === 0) {
    return ''
  }

  // Make sure entryStack exists — bindings inside the loop body resolve
  // against this stack. Mutating in place is fine because the publisher
  // owns the context for this single render pass.
  if (!ctx.templateContext) {
    ctx.templateContext = { entryStack: [] }
  }
  const stack = ctx.templateContext.entryStack

  let body = ''
  data.items.forEach((item: LoopItem, i: number) => {
    const variantId = variants[i % variants.length]
    stack.push(item)
    try {
      body += renderNode(variantId, ctx)
    } finally {
      stack.pop()
    }
  })

  // Pagination signals — pagination='infinite' attaches a sentinel and
  // registers the loop's id so publishPage() can decide whether to emit
  // the runtime script.
  const props = node.props
  const isInfinite = props.pagination === 'infinite'
  let attrs = ` data-pb-loop="${escapeHtml(loopId)}"`
  attrs += ` data-pb-loop-page="${data.pageNumber}"`
  if (isInfinite) {
    attrs += ` data-pb-loop-mode="infinite"`
    attrs += ` data-pb-loop-has-more="${data.hasMore ? 'true' : 'false'}"`
    attrs += ` data-pb-loop-page-size="${typeof props.pageSize === 'number' ? Math.floor(props.pageSize) : 10}"`
    if (!ctx.infiniteLoopIds) ctx.infiniteLoopIds = new Set()
    ctx.infiniteLoopIds.add(loopId)
  }

  // Wrapper element — author-selectable via the shared htmlTag helper
  // (defaults to 'div'). `resolveHtmlTag` always returns a safe lowercase
  // tag name, so it's already escape-safe for interpolation.
  const tag = resolveHtmlTag(props.tag, props.customTag)
  const html = `<${tag}${attrs}>${body}</${tag}>`

  // Inject the loop's own classIds onto the wrapper element.
  return injectNodeClassIds(html, node.classIds, ctx.site)
}

// ---------------------------------------------------------------------------
// Recursive renderer
// ---------------------------------------------------------------------------

/**
 * Resolved loop data for one `base.loop` node, produced by the server's
 * `prefetchLoopData()` helper before publishing.
 */
export interface ResolvedLoopRenderData extends LoopFetchResult {
  /** 1-indexed page number when the loop is in `infinite` mode. */
  pageNumber: number
  /** Whether more rows remain past the current page. */
  hasMore: boolean
}

/**
 * Resolved media-asset payload attached to a prop at render time. The pure
 * render function reads `props._resolvedMediaByKey[<propKey>]` to get the
 * variant ladder / BlurHash / intrinsic dimensions for any of its
 * image/media-typed props, and uses it to emit responsive markup. Falls
 * back to the raw prop string when undefined, so non-CMS URLs or pages
 * built before `prefetchMediaAssets` ran still render correctly.
 */
export interface RenderResolvedMedia {
  publicPath: string
  width: number | null
  height: number | null
  altText: string
  blurHash: string | null
  variants: ReadonlyArray<{
    width: number
    height: number
    format: 'webp' | 'jpeg' | 'png' | 'avif'
    path: string
    sizeBytes: number
  }>
  posterPath: string | null
}

export interface RenderContext {
  page: Page
  site: SiteDocument
  registry: IModuleRegistry
  breakpointId: string | undefined
  templateContext?: TemplateRenderDataContext
  /**
   * Pre-fetched media assets, keyed by `public_path`. Populated by
   * `server/publish/mediaPrefetch.ts` before `publishPage()` is called.
   * Used to enrich image / media props with srcset, sizes, BlurHash, and
   * intrinsic dimensions before each module's `render()` runs.
   */
  mediaAssets?: Map<string, RenderResolvedMedia>
  /**
   * CSS deduplication map: moduleId → CSS string.
   * Each module type contributes at most one CSS entry regardless of instance count.
   * Decision #308: keying by moduleId is O(1); at 200 nodes saves ~60–80% CSS vs naive concat.
   */
  cssMap: Map<string, string>
  /**
   * Pre-fetched loop data, keyed by loop nodeId. Populated by
   * `server/publish/loopPrefetch.ts` before `publishPage()` is called.
   * Loops without an entry here render empty.
   */
  loopData?: Map<string, ResolvedLoopRenderData>
  /**
   * Set of loop nodeIds on the page that requested the infinite-scroll
   * runtime. The publisher reads this after rendering to decide whether
   * to inject the `loop-runtime.js` `<script>` tag.
   */
  infiniteLoopIds?: Set<string>
}

/**
 * Specialised renderers keyed by moduleId. Looked up by `renderNode` before
 * the standard bottom-up walk. Each entry replaces the entire
 * "render children → resolve props → call render() → inject classes" flow
 * because the moduleId's semantics need a different shape:
 *
 * - `base.visual-component-ref`: inlines a Visual Component tree recursively,
 *   consuming its `base.slot-instance` children for slot fills.
 * - `base.loop`: iterates a `LoopEntitySource` and renders its child template
 *   once per item with a freshly pushed entry-stack frame.
 *
 * Adding a new specialised render path is a single Map entry plus its
 * renderer function — no edit to renderNode's body. The map is built
 * lazily on first access so the forward references to the renderers stay
 * legal under TDZ.
 */
let specialNodeRenderers: Map<string, (node: PageNode, ctx: RenderContext) => string> | null = null
function getSpecialNodeRenderers(): Map<string, (node: PageNode, ctx: RenderContext) => string> {
  if (specialNodeRenderers) return specialNodeRenderers
  specialNodeRenderers = new Map<string, (node: PageNode, ctx: RenderContext) => string>([
    ['base.visual-component-ref', renderVisualComponentRef],
    ['base.loop', renderLoop],
  ])
  return specialNodeRenderers
}

/**
 * Attach every resolved media asset on this node, keyed by prop key, so
 * modules with multiple media props (e.g. base.video with `videoUrl` +
 * `poster`) can read each one independently. The render() boundary preserves
 * non-string values, so `_resolvedMediaByKey` survives `escapeProps` untouched.
 *
 * Render functions read `props._resolvedMediaByKey?.<propKey>` and fall back
 * to the raw prop string when it's absent — for non-CMS URLs, pages built
 * before the prefetch ran, or the editor canvas preview that doesn't run
 * the prefetch.
 */
function attachResolvedMediaByKey(
  safeProps: Record<string, unknown>,
  def: AnyModuleDefinition,
  resolvedProps: Record<string, unknown>,
  mediaAssets: Map<string, RenderResolvedMedia> | undefined,
): void {
  if (!mediaAssets || mediaAssets.size === 0) return
  const byKey: Record<string, RenderResolvedMedia> = {}
  for (const [propKey, control] of Object.entries(def.schema)) {
    if (control.type !== 'image' && control.type !== 'media') continue
    const value = resolvedProps[propKey]
    if (typeof value !== 'string') continue
    const resolved = mediaAssets.get(value)
    if (resolved) byKey[propKey] = resolved
  }
  if (Object.keys(byKey).length > 0) {
    safeProps._resolvedMediaByKey = byKey
  }
}

/**
 * Pre-resolve `sizes='auto'` on image modules by walking the ancestor chain
 * for an explicit pixel-valued cap (typically a parent container's
 * `max-width`). The resolved string lands on `props._resolvedAutoSizes`. The
 * module's render() reads it next to its own `sizes` prop and emits the
 * result as the final `sizes` attribute. Cheap on most pages: the resolver
 * caches the parent map per Page and short-circuits as soon as it finds a
 * constraining ancestor.
 */
function attachResolvedAutoSizes(
  safeProps: Record<string, unknown>,
  def: AnyModuleDefinition,
  node: PageNode,
  resolvedProps: Record<string, unknown>,
  ctx: RenderContext,
): void {
  if (resolvedProps['sizes'] !== 'auto') return
  const hasImageProp = Object.values(def.schema).some((c) => c.type === 'image')
  if (!hasImageProp) return
  const resolvedSizes = resolveAutoSizes(node.id, ctx.page, ctx.site)
  if (resolvedSizes) {
    safeProps._resolvedAutoSizes = resolvedSizes
  }
}

/**
 * Standard bottom-up render path: children first, then resolve props, attach
 * resolved assets, call the module's pure render(), collect deduped CSS,
 * inject author classes onto the root element.
 *
 * `base.body` emits no wrapper element — its render returns naked children
 * HTML — so there's nothing to inject classes onto here. Root-level classIds
 * are applied to `<body>` by `publishPage` instead.
 */
function renderStandardNode(
  node: PageNode,
  def: AnyModuleDefinition,
  ctx: RenderContext,
): string {
  const renderedChildren = (node.children ?? []).map((childId) => renderNode(childId, ctx))

  // Resolve effective props (base + breakpoint shallow-merge for
  // breakpointOverridable schema keys only — content props always publish
  // their base value because HTML is a single document) and apply dynamic
  // template bindings.
  const effectiveProps = resolveProps(node, ctx.breakpointId, def.schema)
  const resolvedProps = resolveDynamicProps(effectiveProps, node.dynamicBindings, ctx.templateContext)

  // Escape all string props (Constraint #211) before calling render(), then
  // attach derived assets that survive the escape boundary unchanged.
  const safeProps = escapeProps(resolvedProps)
  attachResolvedMediaByKey(safeProps, def, resolvedProps, ctx.mediaAssets)
  attachResolvedAutoSizes(safeProps, def, node, resolvedProps, ctx)

  const output = def.render(safeProps as never, renderedChildren)

  // CSS dedup — one entry per moduleId. Sanitize before storage to neutralise
  // any `</style` so the HTML5 RAWTEXT tokenizer cannot escape the
  // surrounding <style> block (Constraint #228).
  if (output.css && !ctx.cssMap.has(node.moduleId)) {
    ctx.cssMap.set(node.moduleId, sanitizeModuleCSS(output.css))
  }

  // base.body has no wrapper element — its classIds go on <body> in publishPage.
  if (node.moduleId === 'base.body') return output.html
  return injectNodeClassIds(output.html, node.classIds, ctx.site)
}

/**
 * Render a single node and its entire subtree recursively.
 *
 * Two paths: specialised renderers (looked up by moduleId) for nodes whose
 * semantics replace the normal walk (`base.visual-component-ref`,
 * `base.loop`); otherwise the standard bottom-up flow in
 * `renderStandardNode`.
 *
 * @returns HTML string for this node and all its descendants
 */
export function renderNode(nodeId: string, ctx: RenderContext): string {
  const node = ctx.page.nodes[nodeId]
  if (!node) return ''

  const def = ctx.registry.get(node.moduleId)
  if (!def) {
    // Unknown module — emit a comment so the page doesn't silently lose content
    return `<!-- pb: unknown module "${escapeHtml(node.moduleId)}" -->`
  }

  const specialRenderer = getSpecialNodeRenderers().get(node.moduleId)
  if (specialRenderer) return specialRenderer(node, ctx)

  return renderStandardNode(node, def, ctx)
}

// ---------------------------------------------------------------------------
// Page publisher
// ---------------------------------------------------------------------------

interface PublishedPage {
  /** Filename for this page in the ZIP archive, e.g. "index.html", "about-us.html" */
  filename: string
  /** Complete <!DOCTYPE html> document — no editor dependencies */
  html: string
}

export interface PublishPageOptions {
  breakpointId?: string
  templateContext?: TemplateRenderDataContext
  runtimeAssets?: PublishedPageRuntimeAssets
  /**
   * Pre-fetched data for every `base.loop` node on the page, keyed by
   * loop nodeId. Produced server-side by `prefetchLoopData()` before
   * publishing. Loops without an entry here render an empty string in
   * the published page (and an HTML comment in dev/preview).
   */
  loopData?: Map<string, ResolvedLoopRenderData>
  /**
   * Pre-fetched media assets keyed by `public_path`. Produced server-side
   * by `prefetchMediaAssets()` before publishing. Lets the publisher
   * attach the resolved variant ladder / BlurHash / dimensions to each
   * image-prop'd node so the module render() can emit responsive markup
   * without any I/O of its own.
   */
  mediaAssets?: Map<string, RenderResolvedMedia>
  /**
   * Optional URL hint for the loop runtime — used to construct
   * "Load more" endpoint URLs in `data-pb-loop-endpoint` attributes
   * when the page contains an infinite-mode loop. Defaults to
   * `/_pb/loop/`.
   */
  loopEndpointBaseUrl?: string
  /**
   * How site-wide CSS (reset, framework, user classes) is emitted into the
   * published HTML.
   *
   * - `'inline'` (default): one `<style>` block in `<head>` containing reset +
   *   framework CSS (variables + generated utilities) + module CSS + user
   *   class CSS. Best for self-contained exports, the iframe runtime preview,
   *   and tests.
   * - `'external'`: emits three `<link rel="stylesheet">` tags pointing at the
   *   pre-built site CSS bundle (`/_pb/css/<filename>`). The HTML stays small,
   *   the bundles are content-hashed for `Cache-Control: immutable` reuse
   *   across page navigations. Pass `cssBundle` + `cssAssetBaseUrl` to use this
   *   mode.
   *
   * In external mode any per-page module CSS that would have been inlined is
   * skipped here — it's assumed to live in `cssBundle.framework.content`,
   * which is what `buildSiteCssBundle()` produces. This keeps every visitor's
   * three CSS files cacheable.
   */
  cssEmission?: 'inline' | 'external'
  /**
   * Pre-built site CSS bundle. Required when `cssEmission === 'external'`.
   * Computed once per published-snapshot via `buildSiteCssBundle(site, registry)`.
   */
  cssBundle?: SiteCssBundle
  /**
   * Base URL prepended to each bundle filename to form the `<link href>`
   * value, e.g. `'/_pb/css/'`. Defaults to `'/_pb/css/'`.
   */
  cssAssetBaseUrl?: string
  /**
   * Pre-serialised `<script type="importmap">` body + its SHA-256 hash.
   *
   * Emitted in `<head>` and the hash is added to the page's CSP
   * `script-src` so the inline tag passes a strict policy. Built on the
   * server side from the site's locked runtime dependencies + the populated
   * `bun install` cache — plugins use bare imports like
   * `import * as THREE from 'three'` and the browser resolves them to
   * `/_pb/runtime/cache/<hash>/...` paths served from the host.
   */
  runtimePackageImportmap?: PublishedRuntimePackageImportmap
}

/**
 * Pre-serialised importmap + the SHA-256 of its body, ready to drop into
 * `<head>` and `Content-Security-Policy`. Computed once on the server by
 * `buildRuntimePackageImportmap` so the body the browser hashes matches the
 * body we hash for the CSP directive.
 */
export interface PublishedRuntimePackageImportmap {
  /** Exact JSON text emitted inside `<script type="importmap">…</script>`. */
  body: string
  /** Base64-encoded SHA-256 of `body` — used as `'sha256-<value>'` in CSP. */
  sha256: string
}

/**
 * Build the `<style>` block (inline mode) or `<link>` tags (external mode)
 * that go into `<head>`.
 *
 * Cascade order is identical in both modes: reset → framework (tokens +
 * generated utilities + module CSS) → user class CSS. User class CSS loads
 * last so it wins specificity ties — same behaviour as the previous
 * in-`<style>` cascade.
 */
function buildStyleHead(
  cssEmission: 'inline' | 'external',
  options: PublishPageOptions,
  site: SiteDocument,
  cssMap: Map<string, string>,
): string {
  if (cssEmission === 'external') {
    if (!options.cssBundle) {
      throw new Error('publishPage: cssEmission "external" requires options.cssBundle')
    }
    const baseUrl = options.cssAssetBaseUrl ?? '/_pb/css/'
    const links = [options.cssBundle.reset, options.cssBundle.framework, options.cssBundle.style]
      // Skip empty bundles — emitting `<link>` to a 0-byte file is a wasted
      // request. `framework.css` and `style.css` are routinely empty on a
      // fresh site (no framework configured, no classes defined).
      .filter((file) => file.content.length > 0)
      .map((file) => `  <link rel="stylesheet" href="${escapeHtml(baseUrl + file.filename)}">`)
      .join('\n')
    return links ? `${links}\n` : ''
  }

  const frameworkCss = buildSiteFrameworkCss(site)
  const moduleCss = Array.from(cssMap.values()).join('\n')
  const classCss = collectClassCSS(site)
  const allCss = [PUBLISHER_RESET_CSS, frameworkCss, moduleCss, classCss]
    .filter(Boolean)
    .join('\n')
  return `  <style>\n${allCss}\n  </style>\n`
}

/**
 * Convert a page title/slug to a safe HTML filename.
 * "About Us" → "about-us.html", "index" → "index.html"
 */
function slugToFilename(slug: string, title: string): string {
  const base = (slug || title || 'page')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return base === '' || base === 'index' ? 'index.html' : `${base}.html`
}

/**
 * Seed the page/site/route frames a caller may have omitted from its
 * TemplateRenderDataContext. Every published page needs all four frames
 * populated so dynamic bindings against those sources resolve — even on
 * plain (non-template, non-loop) pages. Caller-provided values always
 * win; missing slots fall back to defaults derived from the page/site.
 */
function composeTemplateContext(
  page: Page,
  site: SiteDocument,
  incoming: TemplateRenderDataContext | undefined,
): TemplateRenderDataContext {
  const provided = incoming ?? { entryStack: [] }
  const pageFrame = provided.page ?? buildPageFrame(page)
  return {
    entryStack: provided.entryStack,
    page: pageFrame,
    site: provided.site ?? buildSiteFrame(site),
    viewer: provided.viewer ?? null,
    route: provided.route ?? buildRouteFrame(pageFrame.permalink),
  }
}

/**
 * Compute the `<body>` opening tag, lifting user class names from the
 * root PageNode onto `<body>` directly. base.body emits no wrapper
 * element, so root-level classIds belong on `<body>` itself — clean HTML
 * with no freeloader `<div>`.
 */
function computeBodyOpenTag(page: Page, site: SiteDocument): string {
  const rootNode = page.nodes[page.rootNodeId]
  if (!rootNode?.classIds?.length) return '<body>'
  const classAttr = classNamesForClassIds(site.classes, rootNode.classIds)
    .map(escapeHtml)
    .join(' ')
  return classAttr ? `<body class="${classAttr}">` : '<body>'
}

/**
 * `<head>` metadata tags derived from site settings + page.
 *
 * - `title` falls back through metaTitle → page.title → site.name.
 * - URL-typed settings (faviconUrl, fontImportUrl) are validated by
 *   isSafeUrl() (blocks `javascript:` / `vbscript:` schemes) and then
 *   escapeHtml()'d for safe attribute interpolation.
 * - `lang` honours WCAG 2.1 AA SC 3.1.1 and escapes the BCP-47 tag
 *   because settings.language is user-controlled.
 */
interface DocumentMetaTags {
  pageTitle: string
  metaDesc: string
  favicon: string
  fontImport: string
  langAttr: string
}

function buildDocumentMetaTags(site: SiteDocument, page: Page): DocumentMetaTags {
  const { settings } = site
  const metaDesc = settings.metaDescription
    ? `\n  <meta name="description" content="${escapeHtml(settings.metaDescription)}">`
    : ''
  const favicon =
    settings.faviconUrl && isSafeUrl(settings.faviconUrl)
      ? `\n  <link rel="icon" href="${escapeHtml(settings.faviconUrl)}">`
      : ''
  const fontImport =
    settings.fontImportUrl && isSafeUrl(settings.fontImportUrl)
      ? `\n  <link rel="stylesheet" href="${escapeHtml(settings.fontImportUrl)}">`
      : ''
  return {
    pageTitle: escapeHtml(settings.metaTitle ?? page.title ?? site.name),
    metaDesc,
    favicon,
    fontImport,
    langAttr: escapeHtml(settings.language ?? 'en'),
  }
}

/**
 * Runtime / importmap / loop-runtime `<script>` tags + the flags the CSP
 * builder needs. Centralising every "do we need a script tag?" branch in
 * one place keeps publishPage straight-line and makes adding a new
 * head-or-body-end runtime asset a single-file change.
 */
interface RuntimeAssetsBlock {
  headRuntimeScripts: string
  bodyEndRuntimeScripts: string
  loopRuntimeScript: string
  importmapTag: string
  importmap: PublishedRuntimePackageImportmap | undefined
  anyScriptTag: boolean
}

function buildRuntimeAssetsBlock(
  options: PublishPageOptions,
  ctx: RenderContext,
): RuntimeAssetsBlock {
  const { runtimeAssets } = options
  const headRuntimeScripts = scriptTagsForRuntimeAssets(runtimeAssets, 'head')
  const bodyEndRuntimeScripts = scriptTagsForRuntimeAssets(runtimeAssets, 'body-end')
  const hasRuntimeScripts = hasPublishedRuntimeScripts(runtimeAssets)

  // Loop runtime is a self-hosted script bundle served at a known fixed
  // path; only injected when at least one loop on the page uses
  // pagination='infinite'. This keeps the "no JS by default" line for
  // pages that don't need it.
  const hasInfiniteLoops = (ctx.infiniteLoopIds?.size ?? 0) > 0
  const loopEndpointBaseUrl = options.loopEndpointBaseUrl ?? '/_pb/loop/'
  const loopRuntimeScript = hasInfiniteLoops
    ? `  <script type="module" src="/_pb/assets/loop-runtime.js" data-pb-loop-endpoint="${escapeHtml(loopEndpointBaseUrl)}" defer></script>`
    : ''

  // Site-dependency importmap. When present we emit a `<script type="importmap">`
  // tag in `<head>` (must precede any `<script type="module">`) and pin its
  // SHA-256 into `script-src` so the inline tag passes strict CSP.
  const importmap = options.runtimePackageImportmap
  const importmapTag = importmap
    ? `  <script type="importmap">${importmap.body}</script>`
    : ''

  return {
    headRuntimeScripts,
    bodyEndRuntimeScripts,
    loopRuntimeScript,
    importmapTag,
    importmap,
    anyScriptTag: hasRuntimeScripts || hasInfiniteLoops || Boolean(importmap),
  }
}

/**
 * Build the Content-Security-Policy `<meta>` tag (Constraint #227).
 *
 * `script-src` defaults to `'none'`; if any script tag is on the page it
 * relaxes to `'self'` (runtime cache URLs live under the same origin).
 * The inline importmap additionally needs its base64 SHA-256 listed so
 * strict CSP doesn't reject it.
 */
function buildContentSecurityPolicy(
  anyScriptTag: boolean,
  importmap: PublishedRuntimePackageImportmap | undefined,
): string {
  const scriptSourceParts: string[] = [anyScriptTag ? "'self'" : "'none'"]
  if (importmap) scriptSourceParts.push(`'sha256-${importmap.sha256}'`)
  const scriptSource = scriptSourceParts.join(' ')
  const workerSource = anyScriptTag ? "'self' blob:" : "'none'"
  return (
    `\n  <meta http-equiv="Content-Security-Policy"` +
    ` content="default-src 'self'; script-src ${scriptSource};` +
    ` style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;` +
    ` frame-src 'none'; worker-src ${workerSource};">`
  )
}

/**
 * Optional `<head>` / body-end line that must be omitted entirely when
 * the source string is empty. Keeps the assembled HTML free of stray
 * blank lines when a section has no content.
 */
function lineOrEmpty(content: string): string {
  return content ? `${content}\n` : ''
}

interface AssembledDocumentParts {
  langAttr: string
  csp: string
  pageTitle: string
  metaDesc: string
  favicon: string
  fontImport: string
  styleHeadHtml: string
  importmapTag: string
  headRuntimeScripts: string
  bodyOpenTag: string
  bodyHtml: string
  bodyEndRuntimeScripts: string
  loopRuntimeScript: string
}

function assembleHtmlDocument(parts: AssembledDocumentParts): string {
  return (
    `<!DOCTYPE html>\n` +
    `<html lang="${parts.langAttr}">\n` +
    `<head>\n` +
    `  <meta charset="UTF-8">\n` +
    `  <meta name="viewport" content="width=device-width, initial-scale=1.0">${parts.csp}\n` +
    `  <title>${parts.pageTitle}</title>${parts.metaDesc}${parts.favicon}${parts.fontImport}\n` +
    parts.styleHeadHtml +
    lineOrEmpty(parts.importmapTag) +
    lineOrEmpty(parts.headRuntimeScripts) +
    `</head>\n` +
    `${parts.bodyOpenTag}\n` +
    `${parts.bodyHtml}\n` +
    lineOrEmpty(parts.bodyEndRuntimeScripts) +
    lineOrEmpty(parts.loopRuntimeScript) +
    `</body>\n` +
    `</html>`
  )
}

/**
 * Publish a single page to a standalone HTML document.
 *
 * - Walks the node tree bottom-up, collecting HTML and CSS.
 * - Deduplicates CSS across all nodes (one entry per moduleId).
 * - Injects site design tokens as CSS :root custom properties.
 * - Embeds the deduplicated CSS in a single <style> block — no external stylesheets.
 * - No editor code, no React, no framework runtime in the output.
 *
 * Each `<head>` / body concern lives in its own helper (template-context
 * defaulting, body-tag class injection, meta tags, runtime assets, CSP,
 * document assembly). This function is straight-line orchestration:
 * adding a new head feature means editing one helper, not threading
 * another ternary through 150 lines.
 */
export function publishPage(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
  options: PublishPageOptions = {},
): PublishedPage {
  const cssMap = new Map<string, string>()
  const ctx: RenderContext = {
    page,
    site,
    registry,
    breakpointId: options.breakpointId,
    templateContext: composeTemplateContext(page, site, options.templateContext),
    cssMap,
    loopData: options.loopData,
    mediaAssets: options.mediaAssets,
    infiniteLoopIds: undefined,
  }

  // Render entire tree from root. The walker also accumulates module CSS
  // into `cssMap`; in external mode that result is discarded because the
  // same data is already in the pre-built `framework.css` bundle.
  const bodyHtml = renderNode(page.rootNodeId, ctx)

  // Cascade order (both inline/external): reset → framework (tokens +
  // generated utilities + module CSS) → user class CSS. User classes load
  // last so they win specificity ties on identically-specific selectors.
  const styleHeadHtml = buildStyleHead(options.cssEmission ?? 'inline', options, site, cssMap)

  const meta = buildDocumentMetaTags(site, page)
  const runtime = buildRuntimeAssetsBlock(options, ctx)
  const csp = buildContentSecurityPolicy(runtime.anyScriptTag, runtime.importmap)

  const html = assembleHtmlDocument({
    langAttr: meta.langAttr,
    csp,
    pageTitle: meta.pageTitle,
    metaDesc: meta.metaDesc,
    favicon: meta.favicon,
    fontImport: meta.fontImport,
    styleHeadHtml,
    importmapTag: runtime.importmapTag,
    headRuntimeScripts: runtime.headRuntimeScripts,
    bodyOpenTag: computeBodyOpenTag(page, site),
    bodyHtml,
    bodyEndRuntimeScripts: runtime.bodyEndRuntimeScripts,
    loopRuntimeScript: runtime.loopRuntimeScript,
  })

  return {
    filename: slugToFilename(page.slug, page.title),
    html,
  }
}
