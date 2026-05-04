/**
 * CssCollector — accumulates CSS from rendered nodes, deduplicating by moduleId.
 *
 * Why moduleId-keyed deduplication?
 * ─────────────────────────────────
 * A typical page might contain 50 instances of "base.text".
 * Without dedup, every instance emits an identical CSS block → 50× overhead.
 *
 * With moduleId keying:
 * - 200-node page → at most N_unique_module_types CSS entries
 * - At 200 nodes (average 8 unique module types), this reduces published CSS by ~60–80%
 *   vs naive concatenation of every node's css output.
 * - Lookup/insert is O(1) per node (Map key = moduleId string).
 *
 * Raw CSS-string deduplication would also work but costs an O(n) hash per node.
 * moduleId keying is strictly faster for the common case (same module, same CSS).
 *
 * Reference: Performance analysis in Contribution #308.
 */

import type { SiteDocument } from '../page-tree/schemas'
import type { VCNode } from '../visualComponents/types'
import { generateClassCSS } from './classCss'

/**
 * Recursively collect all classIds from a VCNode tree (nested childNodes structure).
 *
 * VC trees use a nested representation (childNodes) rather than the flat-map
 * structure of Page.nodes. Both the node itself and its VC-level classIds are
 * collected so that any CSS class rules referenced inside a VC are included in
 * the published HTML `<style>` block.
 */
function collectVCNodeClassIds(node: VCNode, ids: Set<string>): void {
  if (node.classIds) {
    for (const id of node.classIds) {
      ids.add(id)
    }
  }
  if (node.childNodes) {
    for (const child of node.childNodes) {
      collectVCNodeClassIds(child, ids)
    }
  }
}

/**
 * Collect all CSS class declarations for the classes referenced across a
 * site's pages and VC trees. Used by the publisher to include class styles
 * inline in the published HTML `<style>` block.
 *
 * Only emits CSS for classes actually used by at least one node (tree-shaking).
 * Traverses both page nodes (flat map) and VisualComponent rootNode trees
 * (nested childNodes) so that classes used inside VCs are also included.
 * Sanitised via sanitizeModuleCSS (Constraint #228).
 *
 * @param site The site containing the class registry, page nodes, and VCs.
 * @returns A CSS string of all used class-name rules, or empty string if none.
 */
export function collectClassCSS(site: SiteDocument): string {
  // Defensive guard: corrupted/partial snapshots may have classes undefined
  if (!site.classes) return ''

  // Collect the set of used classIds across all pages
  const usedClassIds = new Set<string>()
  for (const page of site.pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.classIds) {
        for (const id of node.classIds) {
          usedClassIds.add(id)
        }
      }
    }
  }

  // Also collect classIds from all VisualComponent trees. VC nodes are rendered
  // inline by the publisher (renderVisualComponentRef) but live outside page.nodes —
  // their classIds must be collected separately so the CSS rules are included.
  if (site.visualComponents) {
    for (const vc of site.visualComponents) {
      // VC-level classIds (the component container)
      if (vc.classIds) {
        for (const id of vc.classIds) {
          usedClassIds.add(id)
        }
      }
      // Recursively collect from the VC node tree
      collectVCNodeClassIds(vc.rootNode, usedClassIds)
    }
  }

  if (usedClassIds.size === 0) return ''

  // Build a filtered class map containing only classes that are actually used
  const usedClasses: SiteDocument['classes'] = {}
  for (const id of usedClassIds) {
    if (site.classes[id]) {
      usedClasses[id] = site.classes[id]
    }
  }

  const css = generateClassCSS(usedClasses, site.breakpoints)
  return sanitizeModuleCSS(css)
}

/**
 * Strip any `</style>` closing tags from a CSS string before injection.
 *
 * Constraint #228: module CSS is inserted directly between `<style>…</style>` tags.
 * A module that returns `css: 'h1{color:red}</style><script>…</script><style>'`
 * would break out of the style block and inject arbitrary HTML/script.
 * Removing `</style>` (case-insensitive, optional whitespace before `>`) is
 * sufficient to prevent this — valid CSS never contains that sequence.
 *
 * CWE-79 (XSS via style block escape).
 */
export function sanitizeModuleCSS(css: string): string {
  return css.replace(/<\/style\s*>/gi, '')
}

export class CssCollector {
  private readonly seen = new Map<string, string>()

  /**
   * Add CSS for a module type. If this moduleId has already been added,
   * the new CSS is silently ignored (first-write-wins per module type).
   * CSS is sanitized via sanitizeModuleCSS() before storage (Constraint #228).
   */
  add(moduleId: string, css: string): void {
    if (!this.seen.has(moduleId)) {
      this.seen.set(moduleId, sanitizeModuleCSS(css))
    }
  }

  /** Return all collected CSS joined into a single string. */
  collect(): string {
    return Array.from(this.seen.values()).join('\n')
  }

  /** Number of unique module types that contributed CSS. */
  get size(): number {
    return this.seen.size
  }

  /** True if no CSS has been collected. */
  get isEmpty(): boolean {
    return this.seen.size === 0
  }

  /** Reset the collector for reuse. */
  clear(): void {
    this.seen.clear()
  }
}
