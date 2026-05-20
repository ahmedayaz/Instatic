/**
 * HTML extraction — produces a `SearchDoc` from raw published HTML.
 *
 * No third-party HTML parsers (no cheerio). This is a state-machine token
 * loop that skips `<script>` and `<style>` blocks, collects text from
 * selected elements, and decodes basic HTML entities.
 *
 * The approach is deliberately conservative — it produces reasonable output
 * for well-formed HTML without parsing the DOM. It does NOT handle:
 *   • Malformed tag soup
 *   • CDATA sections
 *   • XML namespaces
 *   • Unicode edge cases in attribute values
 *
 * Those are acceptable for our use case because the CMS publisher emits
 * clean, well-formed HTML.
 */

import type { SearchDoc } from './backends/types'

// ---------------------------------------------------------------------------
// Entity decoder — covers the subset common in CMS-generated HTML
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#(\d+)|#x([\da-fA-F]+)|([a-zA-Z]+));/g, (_m, _full, dec, hex, named) => {
    if (dec) return String.fromCodePoint(parseInt(dec, 10))
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    if (named) return NAMED_ENTITIES[named.toLowerCase()] ?? _m
    return _m
  })
}

// ---------------------------------------------------------------------------
// State machine tokeniser
// ---------------------------------------------------------------------------

type ExtractState = {
  title: string
  headings: string[]
  bodyParts: string[]
  /** True while inside a <script> or <style> block. */
  inSkipBlock: boolean
  /** True while inside a heading element (h1–h4). */
  inHeading: boolean
  /** True while inside a <title> element. */
  inTitle: boolean
  /** Current heading level while inHeading is true. */
  headingLevel: number
  /** Text accumulator for the current heading. */
  headingBuf: string
  /** Text accumulator for the current <title>. */
  titleBuf: string
}

/** Very cheap lowercase ASCII check — avoids a new string allocation. */
function lc(s: string): string {
  return s.toLowerCase()
}

/** Extract the tag name from a raw tag token such as `<div class="x">`. */
function tagName(token: string): string {
  // token starts with '<' or '</'
  const start = token[1] === '/' ? 2 : 1
  let end = start
  while (end < token.length && !/[\s>]/.test(token[end])) end++
  return lc(token.slice(start, end))
}

/** True when the token is a closing tag. */
function isClosing(token: string): boolean {
  return token[1] === '/'
}

/**
 * Tokenise `html` into an array of strings, where each string is either:
 *   • A tag token   — starts with `<`, e.g. `<div class="x">`
 *   • A text node   — anything between tags
 *
 * Comments (`<!-- -->`) are treated as one token and skipped.
 * We do NOT handle processing instructions or doctypes specially (they start
 * with `<!` or `<?` — the tag detector handles `<!` as a skip token).
 */
function* tokenise(html: string): Generator<string> {
  let i = 0
  const len = html.length
  while (i < len) {
    if (html[i] === '<') {
      // Comment?
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4)
        if (end === -1) break
        yield html.slice(i, end + 3)
        i = end + 3
        continue
      }
      // Regular tag — find matching '>'.
      let j = i + 1
      let inAttrDq = false
      let inAttrSq = false
      while (j < len) {
        const ch = html[j]
        if (!inAttrDq && !inAttrSq) {
          if (ch === '"') { inAttrDq = true; j++; continue }
          if (ch === "'") { inAttrSq = true; j++; continue }
          if (ch === '>') { j++; break }
        } else if (inAttrDq && ch === '"') {
          inAttrDq = false
        } else if (inAttrSq && ch === "'") {
          inAttrSq = false
        }
        j++
      }
      yield html.slice(i, j)
      i = j
    } else {
      // Text node — collect until next '<'.
      const j = html.indexOf('<', i)
      if (j === -1) {
        yield html.slice(i)
        break
      }
      yield html.slice(i, j)
      i = j
    }
  }
}

/**
 * Walk the token stream and populate an `ExtractState`.
 * The heavy lifting of deciding what to keep vs skip lives here.
 */
function extractState(html: string): ExtractState {
  const st: ExtractState = {
    title: '',
    headings: [],
    bodyParts: [],
    inSkipBlock: false,
    inHeading: false,
    inTitle: false,
    headingLevel: 0,
    headingBuf: '',
    titleBuf: '',
  }

  for (const token of tokenise(html)) {
    // Skip HTML comments.
    if (token.startsWith('<!--')) continue

    if (!token.startsWith('<')) {
      // Text node.
      if (st.inSkipBlock) continue

      const decoded = decodeEntities(token)
        .replace(/\s+/g, ' ')
        .trim()

      if (!decoded) continue

      if (st.inTitle) {
        st.titleBuf += (st.titleBuf ? ' ' : '') + decoded
        continue
      }
      if (st.inHeading) {
        st.headingBuf += (st.headingBuf ? ' ' : '') + decoded
        continue
      }
      st.bodyParts.push(decoded)
      continue
    }

    // Tag token.
    const name = tagName(token)
    const closing = isClosing(token)

    // ── Skip blocks: <script>, <style>, <noscript> ──
    if (!closing && (name === 'script' || name === 'style' || name === 'noscript')) {
      st.inSkipBlock = true
      continue
    }
    if (closing && (name === 'script' || name === 'style' || name === 'noscript')) {
      st.inSkipBlock = false
      continue
    }

    if (st.inSkipBlock) continue

    // ── <title> ──
    if (!closing && name === 'title') {
      st.inTitle = true
      continue
    }
    if (closing && name === 'title') {
      st.title = st.titleBuf.trim()
      st.titleBuf = ''
      st.inTitle = false
      continue
    }

    // ── Headings h1–h4 ──
    const hMatch = /^h([1-4])$/.exec(name)
    if (hMatch) {
      const level = parseInt(hMatch[1], 10)
      if (!closing) {
        st.inHeading = true
        st.headingLevel = level
        st.headingBuf = ''
      } else if (st.inHeading && st.headingLevel === level) {
        if (st.headingBuf) st.headings.push(st.headingBuf.trim())
        st.headingBuf = ''
        st.inHeading = false
        st.headingLevel = 0
      }
      continue
    }
  }

  return st
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PageMeta {
  /** Stable id used as the document id in the search index (e.g. page slug without leading /). */
  id: string
  /** Full slug, e.g. "/blog/my-post". */
  slug: string
}

/**
 * Extract a `SearchDoc` from published HTML.
 *
 * @param html         Raw HTML from the publisher.
 * @param meta         Minimal page metadata (id + slug).
 * @param excerptLen   Maximum excerpt character length.
 */
export function extractSearchDoc(
  html: string,
  meta: PageMeta,
  excerptLen: number,
): SearchDoc {
  const st = extractState(html)

  // Best-effort title: prefer <title>, fall back to first h1.
  const title = st.title || st.headings[0] || meta.slug

  const headings = st.headings.join(' ')
  const content = st.bodyParts.join(' ')

  // Build excerpt from the first chunk of body content.
  const rawExcerpt = content.slice(0, excerptLen * 2)
  const excerpt = rawExcerpt.length > excerptLen
    ? rawExcerpt.slice(0, excerptLen).replace(/\s+\S*$/, '') + '…'
    : rawExcerpt

  return {
    id: meta.id,
    slug: meta.slug,
    title,
    headings,
    content,
    excerpt,
    indexedAt: new Date().toISOString(),
  }
}
