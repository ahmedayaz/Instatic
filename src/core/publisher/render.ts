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

import type { Page, PageNode, SiteDocument } from '../page-tree/schemas'
import type { IModuleRegistry } from '../module-engine/types'
import { resolveProps } from '../page-tree/selectors'
import { resolveDynamicProps, type TemplateRenderDataContext } from '../templates/dynamicBindings'
import { classNamesForClassIds } from '../page-tree/classNames'
import { sanitizeModuleCSS, collectClassCSS } from './cssCollector'
import { generateFrameworkColorRootCss } from '../framework/colors'
import { generateFrameworkTypographyRootCss } from '../framework/typography'
import { generateFrameworkSpacingRootCss } from '../framework/spacing'
import { resolveFrameworkPreferences } from '../framework/preferences'
import { generateFontsCss } from '../fonts/css'
import { escapeHtml, isSafeUrl } from './utils'
import type { PublishedPageRuntimeAssets } from '../site-runtime/schemas'
import { hasPublishedRuntimeScripts, scriptTagsForRuntimeAssets } from '../site-runtime'
import { sanitizeRichtext } from '../sanitize'
import { instantiateVCAtRef, type InstantiatedVCNode } from '../visualComponents/instantiate'
import type { VCNode } from '../visualComponents/types'

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

// ---------------------------------------------------------------------------
// Visual Component inlining
// ---------------------------------------------------------------------------

/**
 * Adapt an InstantiatedVCNode to the PageNode shape required by the publisher walker.
 *
 * VCNode is structurally compatible with PageNode for all fields the walker reads
 * (moduleId, props, breakpointOverrides, children, classIds). The extra
 * InstantiatedVCNode fields (_owningRefId, _fromSlotContent) are not part of
 * PageNode and are harmlessly ignored by the walker. childNodes is explicitly
 * cleared here because instantiateVCAtRef always sets it to undefined on all
 * emitted nodes — the flat map is the canonical representation.
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
    childNodes: undefined,
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

  const rawSlotContent =
    node.props.slotContent !== null &&
    typeof node.props.slotContent === 'object' &&
    !Array.isArray(node.props.slotContent)
      ? (node.props.slotContent as Record<string, VCNode[]>)
      : {}

  const vc = ctx.site.visualComponents.find((v) => v.id === componentId)
  if (!vc) {
    return `<!-- pb: unknown component "${escapeHtml(componentId)}" -->`
  }

  const { nodes: instantiatedNodes, rootNodeId } = instantiateVCAtRef(
    vc,
    propOverrides,
    rawSlotContent,
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

  let html = renderNode(rootNodeId, syntheticCtx)

  // If the page-level ref node carries classIds, inject them onto the VC's root
  // element. The VC's own nodes contribute their classIds via the recursive call.
  if (node.classIds?.length) {
    const classAttr = classNamesForClassIds(ctx.site.classes, node.classIds)
      .map(escapeHtml)
      .join(' ')
    if (classAttr) html = injectClassIntoRootElement(html, classAttr)
  }

  return html
}

// ---------------------------------------------------------------------------
// Recursive renderer
// ---------------------------------------------------------------------------

export interface RenderContext {
  page: Page
  site: SiteDocument
  registry: IModuleRegistry
  breakpointId: string | undefined
  templateContext?: TemplateRenderDataContext
  /**
   * CSS deduplication map: moduleId → CSS string.
   * Each module type contributes at most one CSS entry regardless of instance count.
   * Decision #308: keying by moduleId is O(1); at 200 nodes saves ~60–80% CSS vs naive concat.
   */
  cssMap: Map<string, string>
}

/**
 * Render a single node and its entire subtree recursively (bottom-up).
 *
 * Children are rendered first; their HTML strings are passed as `renderedChildren`
 * to the parent node's render() call — exactly the contract in ModuleDefinition.
 *
 * @returns HTML string for this node and all its descendants
 */
export function renderNode(nodeId: string, ctx: RenderContext): string {
  const node: PageNode | undefined = ctx.page.nodes[nodeId]
  if (!node) return ''

  const def = ctx.registry.get(node.moduleId)
  if (!def) {
    // Unknown module — emit a comment so the page doesn't silently lose content
    return `<!-- pb: unknown module "${escapeHtml(node.moduleId)}" -->`
  }

  // Special case: visual-component-ref nodes inline the VC tree recursively.
  // This intercept happens BEFORE children rendering and render() dispatch because
  // the ref node's children (none — canHaveChildren: false) are irrelevant; the
  // VC body comes from instantiateVCAtRef, not from page.nodes children.
  if (node.moduleId === 'base.visual-component-ref') {
    return renderVisualComponentRef(node, ctx)
  }

  // 1. Render children first (bottom-up) — pass their HTML to the parent
  const renderedChildren = (node.children ?? []).map((childId) =>
    renderNode(childId, ctx),
  )

  // 2. Resolve effective props (base + breakpoint shallow-merge)
  const effectiveProps = resolveProps(node, ctx.breakpointId)
  const resolvedProps = resolveDynamicProps(effectiveProps, node.dynamicBindings, ctx.templateContext)

  // 3. Escape all string props (Constraint #211) before calling render()
  const safeProps = escapeProps(resolvedProps)

  // 4. Call the pure render() function
  const output = def.render(safeProps as never, renderedChildren)

  // 5. Collect CSS — one entry per moduleId (dedup).
  //    Sanitize before storage: strip </style> to prevent style-block escape (Constraint #228).
  if (output.css && !ctx.cssMap.has(node.moduleId)) {
    ctx.cssMap.set(node.moduleId, sanitizeModuleCSS(output.css))
  }

  // 6. Inject user-facing class names into the root HTML element.
  let html = output.html
  if (node.classIds?.length) {
    const classAttr = classNamesForClassIds(ctx.site.classes, node.classIds)
      .map(escapeHtml)
      .join(' ')
    if (classAttr) html = injectClassIntoRootElement(html, classAttr)
  }

  return html
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
}

/**
 * Sanitize a CSS property value for safe injection inside a `<style>` block.
 *
 * Strips `</style>` sequences to prevent breaking out of the style context
 * (same protection as sanitizeModuleCSS — applied to design-token values,
 * which are user-controlled site settings).  Also strips `{` and `}` to
 * prevent escaping the `:root {}` rule block (CSS injection, CWE-94).
 */
function sanitizeCssTokenValue(value: string): string {
  return value
    .replace(/<\/style\s*>/gi, '')
    .replace(/[{}]/g, '')
}

/**
 * Valid CSS custom property name: `--` followed by one or more alphanumeric,
 * hyphen, or underscore characters.  Rejects keys containing `;`, `{`, `}`,
 * spaces, etc. that could escape the :root {} rule block (CWE-94 / CSS injection).
 * The built-in tokens (--type-base-size, --type-ratio) satisfy this pattern.
 * User-supplied colorToken keys that fail the check are silently dropped —
 * they are invalid CSS identifiers and cannot be safely emitted.
 */
const CSS_CUSTOM_PROP_RE = /^--[a-zA-Z0-9_-]+$/

/**
 * Generate the CSS :root block for site design tokens.
 * Injects color tokens and typography scale as CSS custom properties.
 * Token values are sanitized to prevent CSS injection (Constraint #228 / CWE-94).
 * Token keys are validated against CSS_CUSTOM_PROP_RE to prevent key-side injection.
 */
function buildRootCss(site: SiteDocument): string {
  const { colorTokens, framework, fonts } = site.settings
  const declarations = Object.entries(colorTokens)
    .filter(([k]) => CSS_CUSTOM_PROP_RE.test(k))
    .map(([k, v]) => `  ${k}: ${sanitizeCssTokenValue(v)};`)
    .join('\n')
  const legacyRootCss = declarations ? `:root {\n${declarations}\n}` : ''
  const preferences = resolveFrameworkPreferences(framework?.preferences)
  // Fonts emit @font-face rules + --font-<slug> tokens. Emit first so any rule
  // that references a font family resolves against an already-declared face.
  // All `src` URLs are restricted to /uploads/fonts/ — no CDN linkage in the
  // published page (Constraint: published HTML never reaches Google).
  const fontsCss = generateFontsCss(fonts)
  const frameworkColorCss = generateFrameworkColorRootCss(framework?.colors)
  const frameworkTypographyCss = generateFrameworkTypographyRootCss(framework?.typography, preferences)
  const frameworkSpacingCss = generateFrameworkSpacingRootCss(framework?.spacing, preferences)
  return [fontsCss, legacyRootCss, frameworkColorCss, frameworkTypographyCss, frameworkSpacingCss]
    .filter(Boolean)
    .join('\n')
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
 * Publish a single page to a standalone HTML document.
 *
 * - Walks the node tree bottom-up, collecting HTML and CSS.
 * - Deduplicates CSS across all nodes (one entry per moduleId).
 * - Injects site design tokens as CSS :root custom properties.
 * - Embeds the deduplicated CSS in a single <style> block — no external stylesheets.
 * - No editor code, no React, no framework runtime in the output.
 *
 * @param page         The page to publish
 * @param site      The site (used for settings, title, tokens)
 * @param registry     The module registry
 * @param breakpointId Optional breakpoint to publish at (uses breakpoint prop overrides)
 */
export function publishPage(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
  breakpointIdOrOptions?: string | PublishPageOptions,
  templateContext?: TemplateRenderDataContext,
): PublishedPage {
  const options: PublishPageOptions =
    typeof breakpointIdOrOptions === 'object' && breakpointIdOrOptions !== null
      ? breakpointIdOrOptions
      : { breakpointId: breakpointIdOrOptions, templateContext }
  const { breakpointId, runtimeAssets } = options
  const cssMap = new Map<string, string>()
  const ctx: RenderContext = {
    page,
    site,
    registry,
    breakpointId,
    templateContext: options.templateContext,
    cssMap,
  }

  // Render entire tree from root
  const bodyHtml = renderNode(page.rootNodeId, ctx)

  // Assemble deduplicated CSS: design tokens, module CSS, then class CSS (Phase C)
  const rootCss = buildRootCss(site)
  const moduleCss = Array.from(cssMap.values()).join('\n')
  const classCss = collectClassCSS(site)
  const allCss = [rootCss, moduleCss, classCss].filter(Boolean).join('\n')

  const { settings } = site
  const pageTitle = escapeHtml(settings.metaTitle ?? page.title ?? site.name)
  const metaDesc = settings.metaDescription
    ? `\n  <meta name="description" content="${escapeHtml(settings.metaDescription)}">`
    : ''
  // URL-validate icon and font URLs — isSafeUrl() blocks javascript:/vbscript: schemes.
  // escapeHtml() then makes the validated URL safe for HTML attribute injection.
  const favicon =
    settings.faviconUrl && isSafeUrl(settings.faviconUrl)
      ? `\n  <link rel="icon" href="${escapeHtml(settings.faviconUrl)}">`
      : ''
  const fontImport =
    settings.fontImportUrl && isSafeUrl(settings.fontImportUrl)
      ? `\n  <link rel="stylesheet" href="${escapeHtml(settings.fontImportUrl)}">`
      : ''

  const headRuntimeScripts = scriptTagsForRuntimeAssets(runtimeAssets, 'head')
  const bodyEndRuntimeScripts = scriptTagsForRuntimeAssets(runtimeAssets, 'body-end')
  const hasRuntimeScripts = hasPublishedRuntimeScripts(runtimeAssets)
  const scriptSource = hasRuntimeScripts ? "'self'" : "'none'"
  const workerSource = hasRuntimeScripts ? "'self' blob:" : "'none'"

  // Constraint #227: every published page must carry a Content-Security-Policy meta tag.
  // Runtime-enabled pages only allow self-hosted external script assets.
  const csp =
    `\n  <meta http-equiv="Content-Security-Policy"` +
    ` content="default-src 'self'; script-src ${scriptSource};` +
    ` style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;` +
    ` frame-src 'none'; worker-src ${workerSource};">`

  // WCAG 2.1 AA SC 3.1.1: lang attribute must reflect the site's declared language.
  // Escape the tag value — even a BCP-47 tag is user-controlled and must be safe for HTML output.
  const langAttr = escapeHtml(settings.language ?? 'en')

  const html =
    `<!DOCTYPE html>\n` +
    `<html lang="${langAttr}">\n` +
    `<head>\n` +
    `  <meta charset="UTF-8">\n` +
    `  <meta name="viewport" content="width=device-width, initial-scale=1.0">${csp}\n` +
    `  <title>${pageTitle}</title>${metaDesc}${favicon}${fontImport}\n` +
    `  <style>\n${allCss}\n  </style>\n` +
    `${headRuntimeScripts ? `${headRuntimeScripts}\n` : ''}` +
    `</head>\n` +
    `<body>\n` +
    `${bodyHtml}\n` +
    `${bodyEndRuntimeScripts ? `${bodyEndRuntimeScripts}\n` : ''}` +
    `</body>\n` +
    `</html>`

  return {
    filename: slugToFilename(page.slug, page.title),
    html,
  }
}
