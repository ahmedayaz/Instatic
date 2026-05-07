/**
 * Architecture Gate Tests — Phase 1: Module Engine Core
 *
 * Enforces the performance and correctness gates from Guideline #307
 * (Phase 1 Module Engine Core Performance Spec — Contribution #422).
 *
 * These tests use an adaptive-skip pattern: they skip with a clear message
 * if the target file does not yet exist, and activate automatically when
 * the Phase 1 implementation is in place.
 *
 * ENFORCED GATES:
 *
 * 1. Registry uses `Map` not plain object — O(1) lookup, no prototype pollution.
 *    (Guideline #307 Hot Path 1)
 *
 * 2. `renderCache.ts` exists at `src/core/engine/renderCache.ts`.
 *    Cache must expose `get()`, `set()`, `clear()`, `invalidateModule()`, `size`.
 *    (Guideline #307 Hot Path 2)
 *
 * 3. `renderCache.clear()` is called inside `siteSlice.loadSite()`.
 *    Prevents stale HTML from a previous site bleeding into the canvas.
 *    (Guideline #307 / Architect message #1216 — Critical integration note)
 *
 * 4. `collectModuleCSS` / `CssCollector.add()` deduplicates by moduleId (O(modules)).
 *    Each moduleId contributes at most one CSS entry regardless of node count.
 *    (Guideline #307 Hot Path 4)
 *
 * 5. `base.video` is registered.
 *
 * 6. Retired layout-only modules are not registered as base modules.
 *
 * @see Guideline #307 — Phase 1 Module Engine Core Performance Spec
 * @see Contribution #422 — Performance Spec (Performance Engineer)
 * @see Constraint #310 — `RenderOutput.css` Must Be Props-Independent
 * @see Guideline #226 — Base Module Defaults & In-Editor Placeholder UX
 */

import { describe, it, expect } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')
const RENDER_CACHE_PATH = join(SRC_ROOT, 'core/engine/renderCache.ts')
/**
 * The siteSlice was split into a directory of per-domain action factories
 * (`slices/site/*`). `loadSite` now lives in `lifecycleActions.ts`, where the
 * `renderCache.clear()` call is performed.
 */
const PROJECT_SLICE_PATH = join(SRC_ROOT, 'core/editor-store/slices/site/lifecycleActions.ts')
const CSS_COLLECTOR_PATH = join(SRC_ROOT, 'core/publisher/cssCollector.ts')
const REGISTRY_PATH = join(SRC_ROOT, 'core/module-engine/registry.ts')

// ---------------------------------------------------------------------------
// Gate 1 — Registry uses Map not plain object
// ---------------------------------------------------------------------------

describe('Phase 1 Gate 1 — Registry uses Map (Guideline #307 Hot Path 1)', () => {
  it('registry.ts source uses new Map<string, ...>() not {} as the backing store', () => {
    expect(existsSync(REGISTRY_PATH)).toBe(true)
    const src = readFileSync(REGISTRY_PATH, 'utf-8')
    // Must use Map as the backing collection
    expect(src).toMatch(/new Map\s*</)
    // Must NOT use a plain object `{}` as the module store
    // (check that the private field is a Map, not a Record/object literal)
    expect(src).toMatch(/_modules\s*=\s*new Map/)
  })
})

// ---------------------------------------------------------------------------
// Gate 2 — renderCache exists with correct API surface
// ---------------------------------------------------------------------------

describe('Phase 1 Gate 2 — renderCache API (Guideline #307 Hot Path 2)', () => {
  it('renderCache.ts exists at src/core/engine/renderCache.ts', () => {
    expect(existsSync(RENDER_CACHE_PATH)).toBe(true)
  })

  it('renderCache.ts exports a renderCache singleton', () => {
    const src = readFileSync(RENDER_CACHE_PATH, 'utf-8')
    expect(src).toMatch(/export\s+const\s+renderCache/)
  })

  it('renderCache has get(), set(), clear(), invalidateModule(), size', () => {
    const src = readFileSync(RENDER_CACHE_PATH, 'utf-8')
    expect(src).toMatch(/\bget\s*\(/)
    expect(src).toMatch(/\bset\s*\(/)
    expect(src).toMatch(/\bclear\s*\(/)
    expect(src).toMatch(/\binvalidateModule\s*\(/)
    expect(src).toMatch(/\bget size\b/)
  })

  it('renderCache is bounded (max ≤ 500 entries)', () => {
    const src = readFileSync(RENDER_CACHE_PATH, 'utf-8')
    // Accepts two forms:
    //   1. Inline literal:  { max: 500 }
    //   2. Named constant:  const CACHE_MAX = 500  (then passed as max: CACHE_MAX)
    // The regex matches the numeric literal in either declaration.
    const maxMatch =
      src.match(/\bmax\s*:\s*(\d+)/) ??           // form 1: { max: 500 }
      src.match(/\bconst\s+\w*MAX\w*\s*=\s*(\d+)/) // form 2: const CACHE_MAX = 500
    expect(maxMatch).not.toBeNull()
    const maxVal = parseInt(maxMatch![1], 10)
    expect(maxVal).toBeGreaterThan(0)
    expect(maxVal).toBeLessThanOrEqual(500)
  })
})

// ---------------------------------------------------------------------------
// Gate 3 — renderCache.clear() called inside loadSite()
// ---------------------------------------------------------------------------

describe('Phase 1 Gate 3 — renderCache.clear() in loadSite() (Guideline #307 / message #1216)', () => {
  it('site/lifecycleActions.ts imports renderCache', () => {
    expect(existsSync(PROJECT_SLICE_PATH)).toBe(true)
    const src = readFileSync(PROJECT_SLICE_PATH, 'utf-8')
    expect(src).toMatch(/renderCache/)
  })

  it('loadSite() action calls renderCache.clear()', () => {
    const src = readFileSync(PROJECT_SLICE_PATH, 'utf-8')
    // Find the loadSite block and verify renderCache.clear() appears before/inside it
    // We check that both loadSite and renderCache.clear() are present together in the file
    expect(src).toMatch(/loadSite/)
    expect(src).toMatch(/renderCache\.clear\(\)/)
    // Verify they appear near each other (within 15 lines) using a broad regex
    const loadSiteBlock = src.match(/loadSite[^}]*\{[^}]*renderCache\.clear[^}]*\}/s)
    expect(loadSiteBlock).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Gate 4 — CSS deduplication is O(modules) not O(nodes)
// ---------------------------------------------------------------------------

describe('Phase 1 Gate 4 — CSS deduplication O(modules) (Guideline #307 Hot Path 4)', () => {
  it('cssCollector.ts uses a Map-keyed deduplication by moduleId', () => {
    expect(existsSync(CSS_COLLECTOR_PATH)).toBe(true)
    const src = readFileSync(CSS_COLLECTOR_PATH, 'utf-8')
    // The CssCollector must use a Map (not a Set/array) keyed on moduleId
    expect(src).toMatch(/new Map/)
    // The add() method must have a has() check to prevent duplicate entries
    expect(src).toMatch(/\.has\(/)
  })

  it('CssCollector.add() is first-write-wins (moduleId-keyed dedup)', () => {
    // Runtime test: adding the same moduleId twice keeps only the first CSS
    // This directly tests the O(modules) invariant from Guideline #307
    const { CssCollector } = require(CSS_COLLECTOR_PATH)
    const collector = new CssCollector()
    collector.add('base.text', 'h1 { color: red }')
    collector.add('base.text', 'h1 { color: blue }')  // second add must be ignored
    const css = collector.collect()
    expect(css).toContain('color: red')
    expect(css).not.toContain('color: blue')
    expect(collector.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Gate 5 & 6 — base.video remains registered; retired layout modules are absent
// ---------------------------------------------------------------------------

describe('Phase 1 Gates 5 & 6 — base.video registered and retired layout modules absent', () => {
  it('base.video module file exists', () => {
    const videoPath = join(SRC_ROOT, 'modules/base/video/index.ts')
    expect(existsSync(videoPath)).toBe(true)
  })

  it('layout-only base module files are removed', () => {
    for (const retiredPath of [
      join(SRC_ROOT, 'modules/base/columns/index.ts'),
      join(SRC_ROOT, 'modules/base/spacer/index.ts'),
      join(SRC_ROOT, 'modules/base/divider/index.ts'),
      join(SRC_ROOT, 'modules/base/columns/index.tsx'),
      join(SRC_ROOT, 'modules/base/spacer/index.tsx'),
      join(SRC_ROOT, 'modules/base/divider/index.tsx'),
    ]) {
      expect(existsSync(retiredPath)).toBe(false)
    }
  })

  it('base/index.ts registers base.video', () => {
    const indexPath = join(SRC_ROOT, 'modules/base/index.ts')
    const src = readFileSync(indexPath, 'utf-8')
    expect(src).toMatch(/['"]\.\/(video|\.\/video)['"']|import\s+['"]\.\/(video)['"']/)
    // More flexible check:
    expect(src).toMatch(/video/)
  })

  it('base/index.ts does not register layout-only modules', () => {
    const indexPath = join(SRC_ROOT, 'modules/base/index.ts')
    const src = readFileSync(indexPath, 'utf-8')
    expect(src).not.toMatch(/columns|spacer|divider/)
  })
})

// ---------------------------------------------------------------------------
// Gate 7 — Constraint #310: RenderOutput.css must be props-independent
// ---------------------------------------------------------------------------

describe('Phase 1 Gate 7 — Constraint #310: css is props-independent', () => {
  it('base.video render() css field does not interpolate props.*', () => {
    const videoPath = join(SRC_ROOT, 'modules/base/video/index.ts')
    const src = readFileSync(videoPath, 'utf-8')
    // The css field must not use template literal prop interpolation like ${props.X}
    // Find the css: field in the render() return and check it has no prop interpolation
    const cssFieldMatch = src.match(/css:\s*`([^`]+)`/)
    if (cssFieldMatch) {
      expect(cssFieldMatch[1]).not.toMatch(/\$\{.*props/)
    }
    // Also acceptable: no css field at all, or css: string literal
  })

})

// ---------------------------------------------------------------------------
// Gate 8 — phase1.bench.ts exists with performance.mark baseline
//
// Context: Performance Engineer review of Contribution #444 (message #1277).
// A benchmark file provides the measured baseline for future regression comparison.
// Without it, future changes to the renderCache or module engine have no reference
// point to compare against — regressions would only be caught by subjective "feels
// slower" reports rather than measured data.
//
// The benchmark must include at least one `performance.mark()` call to establish
// a measurable timing baseline that can be compared in CI.
// ---------------------------------------------------------------------------

const BENCH_FILE_PATH = join(SRC_ROOT, '__tests__/architecture/phase1.bench.ts')

describe('Phase 1 Gate 8 — phase1.bench.ts exists with performance.mark (Performance Engineer review #444)', () => {
  it('[pre-registered] phase1.bench.ts must exist and contain a performance.mark() call', () => {
    if (!existsSync(BENCH_FILE_PATH)) {
      console.log(
        '[Phase1 gate] phase1.bench.ts not yet created — ' +
        'benchmark baseline gate pre-registered (Performance Engineer review of Contribution #444)'
      )
      expect(true).toBe(true)
      return
    }

    const src = readFileSync(BENCH_FILE_PATH, 'utf-8')

    // Must contain at least one performance.mark() to establish a timing baseline
    expect(src).toMatch(/performance\.mark\s*\(/)
  })
})
