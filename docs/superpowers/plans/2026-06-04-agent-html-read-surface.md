# Agent HTML Read Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the site-editor agent's JSON page-read surface (`inspect_page`, `inspect_node`, `search_nodes`, `list_classes`, `inspect_class`) with the publisher's annotated HTML + `<style>` CSS bundle, addressed by a bare `uid` attribute, rendered server-side on demand from the raw authoritative tree the browser posts.

**Architecture:** The browser stops flattening the page into a bespoke `SiteSnapshot` and instead POSTs the raw authoritative `{ page, site, selectedNodeId, activeBreakpointId }` in the chat request's `snapshot` field. A new server tool `read_page` renders that tree via the existing `publishPage(..., { annotateNodeIds: true })` + `buildSiteCssBundle` path (the same one `server/publish/publicRenderer.ts` already runs in-process), returning `{ html, css }`. Catalog tools (`list_modules`, `list_tokens`, `list_pages`, `list_breakpoints`) are re-sourced from the server registry + posted `site`. The publisher's `injectNodeId` annotation switches from `data-node-id="…"` to bare `uid="…"`.

**Tech Stack:** Bun, TypeScript, TypeBox (boundary validation), `@core/publisher` (`publishPage`, `renderNode`, `injectNodeId`), `server/publish/siteCssBundle` (`buildSiteCssBundle`), `@core/framework` + `@core/fonts` (token describers), `@core/module-engine` (registry).

**Predecessor spec:** [`docs/superpowers/specs/2026-06-04-agent-html-read-surface-design.md`](../specs/2026-06-04-agent-html-read-surface-design.md)

---

## File Structure

**Create:**
- `server/ai/tools/site/render.ts` — pure server-side render of the posted tree → `{ html, css }` and the catalog derivations (module list, tokens). The single place that owns "raw tree → agent-readable artifacts".
- `src/admin/pages/site/agent/siteAgentSnapshot.ts` — the new wire type `SiteAgentSnapshot` + the browser serializer that reads the live store and emits the raw tree.
- `src/__tests__/agent/readPage.test.ts` — tests for `render.ts` (annotated body, css bundle, catalog derivations).

**Modify:**
- `src/core/publisher/classInjection.ts` — `injectNodeId` emits `uid="…"`.
- `src/core/publisher/render.ts`, `renderContext.ts` — doc-comment references to `data-node-id`.
- `server/ai/tools/site/readTools.ts` — delete the 5 page-tree read tools; rewrite `list_modules`/`list_tokens`/`list_pages`/`list_breakpoints` to read from `SiteAgentSnapshot`; add `read_page`.
- `server/ai/tools/site/snapshot.ts` — replace `SiteSnapshot` with `SiteAgentSnapshot` re-export; delete `NodeInfo`/`ClassInfo` and the flattened module/token shapes no longer used over the wire (keep the catalog output shapes the tools return).
- `server/ai/tools/site/snapshotHelpers.ts` — delete `inspectPageNode`/`searchPageNodes`/`inspectPageClass`; keep/relocate `listSiteTokens` to read from `site`.
- `server/ai/tools/site/systemPrompt.ts` — derive dynamic suffix from `page`+`site`; update prefix guidance.
- `server/ai/handlers/chat.ts` — `buildSystemPromptForScope` + `emptySiteSnapshot` use `SiteAgentSnapshot`.
- `src/admin/pages/site/agent/pageContext.ts`, `agentSliceConfig.site.ts` — `buildSnapshot` returns `SiteAgentSnapshot`.
- `src/admin/pages/site/agent/executor.ts` — `runGetNodeHtml` annotates with `uid`.
- `src/admin/pages/site/agent/types.ts` — drop the dead `PageContext` flattened shape if now unused.

**Delete:**
- `src/admin/pages/site/agent/pageSnapshot.ts` — `buildPageSnapshot` (the flattener) and its helpers, after moving the module-describe logic into `server/ai/tools/site/render.ts`.

**Tests to update:**
- `src/__tests__/agent/agentTools.test.ts` — rewrite around `read_page` + catalog tools.
- `src/__tests__/agent/agentSlice.test.ts` — new snapshot shape.
- `scripts/bench/benches/snapshot-tokens.ts` — inline a local flattener or retire (Task 11).

---

## Task 1: Rename publisher annotation to bare `uid`

**Files:**
- Modify: `src/core/publisher/classInjection.ts:143-161`
- Modify (doc comments only): `src/core/publisher/render.ts:148-153`, `src/core/publisher/renderContext.ts:108-116`
- Test: `src/__tests__/publisher/injectNodeId.test.ts` (create if absent; otherwise add a case to the nearest existing publisher annotation test)

- [x] **Step 1: Write the failing test**

Tests added to `src/__tests__/publisher/annotateNodeIds.test.ts` (the plan suggested `injectNodeId.test.ts` if absent; the implementer added to the nearest existing annotation test file instead).

- [x] **Step 2: Run test to verify it fails**

- [x] **Step 3: Change the attribute name**

`injectNodeId` in `src/core/publisher/classInjection.ts` now emits `uid="…"`.

- [x] **Step 4: Update doc-comment references**

`render.ts` and `renderContext.ts` doc comments updated to `uid="<id>"`.

- [x] **Step 5: Run test + publisher suite to verify pass**

- [x] **Step 6: Commit**

Committed as `feat(publisher): annotate agent render with bare uid attribute` (614169195d2e).

---

## Task 2: Define the `SiteAgentSnapshot` wire type + browser serializer

**Files:**
- Create: `src/admin/pages/site/agent/siteAgentSnapshot.ts`
- Test: `src/__tests__/agent/siteAgentSnapshot.test.ts`

**Wire shape** — the raw authoritative tree. Only the active page carries full `nodes`; non-active pages are reduced to metadata with empty `nodes` so `list_pages` works while the payload stays bounded.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/agent/siteAgentSnapshot.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { buildSiteAgentSnapshot } from '@site/agent/siteAgentSnapshot'
import type { SiteDocument, Page } from '@core/page-tree'

function fixture(): { site: SiteDocument; active: Page } {
  const active: Page = {
    id: 'p1', title: 'Home', slug: 'index', rootNodeId: 'root',
    nodes: { root: { id: 'root', moduleId: 'base.body', children: [], props: {} } as Page['nodes'][string] },
  } as Page
  const other: Page = {
    id: 'p2', title: 'About', slug: 'about', rootNodeId: 'r2',
    nodes: { r2: { id: 'r2', moduleId: 'base.body', children: [], props: {} } as Page['nodes'][string] },
  } as Page
  const site = {
    pages: [active, other],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1280, icon: 'i' }],
    styleRules: {}, settings: { framework: {}, fonts: {} }, visualComponents: [],
  } as unknown as SiteDocument
  return { site, active }
}

describe('buildSiteAgentSnapshot', () => {
  it('posts the active page with full nodes', () => {
    const { site, active } = fixture()
    const snap = buildSiteAgentSnapshot(active, site, { selectedNodeId: 'root', activeBreakpointId: 'desktop' })
    expect(snap.page.id).toBe('p1')
    expect(Object.keys(snap.page.nodes)).toEqual(['root'])
    expect(snap.selectedNodeId).toBe('root')
    expect(snap.activeBreakpointId).toBe('desktop')
  })

  it('strips non-active pages\' nodes to keep the payload bounded', () => {
    const { site, active } = fixture()
    const snap = buildSiteAgentSnapshot(active, site, { selectedNodeId: null, activeBreakpointId: 'desktop' })
    const other = snap.site.pages.find((p) => p.id === 'p2')!
    expect(other.title).toBe('About')
    expect(Object.keys(other.nodes)).toEqual([]) // emptied
    const activeInSite = snap.site.pages.find((p) => p.id === 'p1')!
    expect(Object.keys(activeInSite.nodes)).toEqual(['root']) // active intact
  })

  it('preserves site-level styleRules and settings', () => {
    const { site, active } = fixture()
    const snap = buildSiteAgentSnapshot(active, site, { selectedNodeId: null, activeBreakpointId: 'desktop' })
    expect(snap.site.styleRules).toBeDefined()
    expect(snap.site.settings).toBeDefined()
    expect(snap.site.breakpoints).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/agent/siteAgentSnapshot.test.ts`
Expected: FAIL — module `@site/agent/siteAgentSnapshot` not found.

- [ ] **Step 3: Implement the serializer**

Create `src/admin/pages/site/agent/siteAgentSnapshot.ts`:

```ts
/**
 * The raw authoritative tree the site-editor agent posts each turn.
 *
 * Replaces the old flattened `SiteSnapshot`. The server renders this directly
 * (publishPage + buildSiteCssBundle) instead of consuming a bespoke flattened
 * shape — single source of truth, server owns all derivation.
 *
 * Only the ACTIVE page carries full `nodes`. Non-active pages keep metadata
 * (id/title/slug) with emptied `nodes`, because server-side rendering and CSS
 * collection only ever touch the active page + site-level styleRules. This
 * bounds the per-turn payload on multi-page sites.
 */

import type { Page, SiteDocument } from '@core/page-tree'

export interface SiteAgentSnapshot {
  /** Active page, full node map — the tree the agent reads and mutates. */
  page: Page
  /** Site document: styleRules/settings/breakpoints intact; non-active pages emptied. */
  site: SiteDocument
  selectedNodeId: string | null
  activeBreakpointId: string
}

export interface SiteAgentSnapshotOptions {
  selectedNodeId: string | null
  activeBreakpointId: string
}

export function buildSiteAgentSnapshot(
  page: Page,
  site: SiteDocument,
  options: SiteAgentSnapshotOptions,
): SiteAgentSnapshot {
  const pages = site.pages.map((p) =>
    p.id === page.id ? p : { ...p, nodes: {} },
  )
  return {
    page,
    site: { ...site, pages },
    selectedNodeId: options.selectedNodeId,
    activeBreakpointId: options.activeBreakpointId,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/agent/siteAgentSnapshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/pages/site/agent/siteAgentSnapshot.ts src/__tests__/agent/siteAgentSnapshot.test.ts
git commit -m "feat(agent): add raw-tree SiteAgentSnapshot wire shape + serializer"
```

---

## Task 3: Server render module — annotated HTML + CSS from the posted tree

**Files:**
- Create: `server/ai/tools/site/render.ts`
- Test: `src/__tests__/agent/readPage.test.ts`

This module owns: `renderAgentPage(snap)` → `{ html, css }`, plus the catalog derivations used by Task 4 (`describeModules(registry)`, tokens from `site`). It depends only on `@core` + `server/publish/siteCssBundle`, so it is unit-testable without HTTP.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/agent/readPage.test.ts`:

```ts
import { describe, expect, it, beforeAll } from 'bun:test'
import type { SiteAgentSnapshot } from '@site/agent/siteAgentSnapshot'

let renderAgentPage: typeof import('../../../server/ai/tools/site/render')['renderAgentPage']

beforeAll(async () => {
  await import('../../../src/modules/base') // register base modules in this process
  ;({ renderAgentPage } = await import('../../../server/ai/tools/site/render'))
})

function snap(): SiteAgentSnapshot {
  const page = {
    id: 'p1', title: 'Home', slug: 'index', rootNodeId: 'root',
    nodes: {
      root: { id: 'root', moduleId: 'base.body', children: ['t'], props: {} },
      t: { id: 't', moduleId: 'base.text', children: [], props: { text: 'Hi', tag: 'h1' } },
    },
  }
  const site = {
    pages: [page],
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1280, icon: 'i' }],
    styleRules: {}, visualComponents: [],
    settings: { framework: {}, fonts: {} },
  }
  return { page, site, selectedNodeId: null, activeBreakpointId: 'desktop' } as unknown as SiteAgentSnapshot
}

describe('renderAgentPage', () => {
  it('returns an annotated body with uid attributes and a <style> css bundle', () => {
    const { html, css } = renderAgentPage(snap())
    expect(html).toContain('uid="t"')          // node addressable
    expect(html).toContain('Hi')               // content present
    expect(html).not.toContain('<head>')       // body only, not full document
    expect(css.startsWith('<style>')).toBe(true)
    expect(css).toContain('</style>')
  })
})
```

> If `base.text` renders different markup, relax the content assertions to what the module actually emits — keep the `uid="t"` and `<style>` assertions, which are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/agent/readPage.test.ts`
Expected: FAIL — `server/ai/tools/site/render` not found.

- [ ] **Step 3: Implement the render module**

Create `server/ai/tools/site/render.ts`:

```ts
/**
 * Server-side render of the agent's posted tree into the HTML read surface.
 *
 * `renderAgentPage` produces exactly the artifacts the token benchmark proved
 * cheaper than the JSON snapshot: the annotated `<body>` (each element tagged
 * `uid="<nodeId>"`) plus the page's `<style>` bundle (framework tokens +
 * utilities + module CSS, class rules with `@media` breakpoint blocks, and
 * page-scoped user stylesheets). Reset CSS is omitted — it is page-independent
 * browser-normalisation boilerplate the agent never reasons about.
 *
 * Same `publishPage` + `buildSiteCssBundle` path that
 * `server/publish/publicRenderer.ts` runs in-process; here we ask for
 * `annotateNodeIds` and slice the body out of the full document.
 */

import { registry } from '@core/module-engine'
import { publishPage } from '@core/publisher'
import { buildSiteCssBundle } from '../../../publish/siteCssBundle'
import type { SiteAgentSnapshot } from '@site/agent/siteAgentSnapshot'

export interface AgentPageRender {
  /** Annotated inner <body> HTML (uid="<nodeId>" on each element). */
  html: string
  /** The page's CSS wrapped in a <style> block; '' when the page has no CSS. */
  css: string
}

/** Extract the inner `<body>` HTML from a full published document. */
function extractBody(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/)
  return m ? m[1] : html
}

export function renderAgentPage(snap: SiteAgentSnapshot): AgentPageRender {
  const { page, site } = snap
  const { html: fullDocument } = publishPage(page, site, registry, {
    annotateNodeIds: true,
  })
  const html = extractBody(fullDocument)

  const bundle = buildSiteCssBundle(site, registry, page)
  const cssBody = [
    bundle.framework.content,
    bundle.style.content,
    bundle.userStyles.content,
  ].filter(Boolean).join('\n\n')
  const css = cssBody ? `<style>\n${cssBody}\n</style>` : ''

  return { html, css }
}
```

> Import-path note: `server/ai/tools/site/render.ts` → `server/publish/siteCssBundle.ts` is `../../../publish/siteCssBundle`. Verify the relative depth against the actual file location when implementing; adjust if the tree differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/agent/readPage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ai/tools/site/render.ts src/__tests__/agent/readPage.test.ts
git commit -m "feat(agent): render posted tree to annotated HTML + css bundle"
```

---

## Task 4: Move module/token catalog derivation server-side

The old `list_modules`/`list_tokens` read `availableModules`/`tokens` off the flattened snapshot. With the raw tree posted, derive modules from the server `registry` and tokens from `site.settings`. Move the module-describe helpers out of the soon-deleted `pageSnapshot.ts`.

**Files:**
- Modify: `server/ai/tools/site/render.ts` (add `describeAgentModules`, `describeAgentTokens`)
- Modify: `server/ai/tools/site/snapshotHelpers.ts` (rework `listSiteTokens` to take `site`)
- Test: extend `src/__tests__/agent/readPage.test.ts`

- [x] **Step 1: Write the failing test (extend readPage.test.ts)**

- [x] **Step 2: Run test to verify it fails**

- [x] **Step 3: Move the module-describe logic into render.ts**

Pure helpers lifted from `pageSnapshot.ts` into `server/ai/tools/site/render.ts`: `moduleDefinitionToModuleInfo`, `genericStyleHintsForModule`, `schemaToModuleProps`, `controlToModuleProp`, `toSerializableRecord`, `toSerializableValue`. Return types are the server's existing `ModuleInfo`/`SnapshotTokens` shapes from `./snapshot`.

- [x] **Step 4: Rework `listSiteTokens` — `filterTokenFamily` moved to `render.ts`**

`filterTokenFamily(tokens, family?)` exported from `render.ts`. The full `list_tokens` rewire to `describeAgentTokens` carries into Task 5 when `readTools.ts` switches to `SiteAgentSnapshot`.

- [x] **Step 5: Run test to verify it passes**

- [x] **Step 6: Commit**

Committed as `feat(agent): derive module/token catalog server-side from registry + site` (f231b4bf3c11).

---

## Task 5: Rewire the site tools — add `read_page`, delete the 5 JSON page tools, re-source catalogs

**Files:**
- Modify: `server/ai/tools/site/readTools.ts`
- Modify: `server/ai/tools/site/snapshot.ts`

- [ ] **Step 1: Add `read_page` and delete the page-tree tools**

In `server/ai/tools/site/readTools.ts`:
- Change `asSnap` to cast to `SiteAgentSnapshot`.
- DELETE tools: `inspectPageTool`, `searchNodesTool`, `inspectNodeTool`, `listClassesTool`, `inspectClassTool` and their input schemas + helper imports (`inspectPageClass`, `inspectPageNode`, `searchPageNodes`).
- ADD `read_page`:

```ts
import { renderAgentPage } from './render'

const ReadPageInput = Type.Object({})

const readPageTool: AiTool = {
  name: 'read_page',
  scope: 'site',
  execution: 'server',
  description:
    "Return the active page as the published HTML the agent edits: an annotated <body> where every element carries uid=\"<nodeId>\" (pass that id verbatim to write tools), plus the page's CSS in a <style> block (design-token vars, utility classes, your classes, and @media breakpoint rules). One call gives the whole page + its styles — no per-node looping. Class handles are the class names you see in the CSS/`class=` attributes.",
  inputSchema: ReadPageInput,
  handler: async (_input, ctx) => {
    const snap = asSnap(ctx.snapshot)
    return renderAgentPage(snap)
  },
}
```

- Update `listModulesTool` to use `describeAgentModules()` filtered by `category`; update `listClassesTool`… (deleted); update `listTokensTool` to `describeAgentTokens(snap.site)` + family filter; update `listPagesTool` to map `snap.site.pages`; update `listBreakpointsTool` to read `snap.site.breakpoints` + `snap.activeBreakpointId`.

New barrel:

```ts
export const siteReadTools: AiTool[] = [
  readPageTool,
  listModulesTool,
  listTokensTool,
  listPagesTool,
  listBreakpointsTool,
]
```

- [ ] **Step 2: Update `snapshot.ts`**

In `server/ai/tools/site/snapshot.ts`:
- Re-export `SiteAgentSnapshot` as the canonical site snapshot type: `export type { SiteAgentSnapshot } from '@site/agent/siteAgentSnapshot'` — **unless** server-importing-from-src/admin is disallowed by an architecture gate. Check `src/__tests__/architecture/` for any rule blocking `server/` → `src/admin/` imports. If blocked, MOVE `SiteAgentSnapshot` to a server-owned or `@core` location (e.g. define it in `server/ai/tools/site/snapshot.ts` and have the browser serializer import it from there is also blocked the other way — so the honest home is `@core/page-tree`-adjacent or a shared `src/core/agent/` type). Resolve the import direction here; the type is just `{ page: Page; site: SiteDocument; selectedNodeId; activeBreakpointId }`.
- DELETE `NodeInfo`, `ClassInfo`, and the bespoke `SiteSnapshot` interface. KEEP the module/token output shapes (`ModuleInfo`, `SnapshotTokens`, etc.) the catalog tools still return — they are the tool RESULT contracts.

- [ ] **Step 3: Run the agent tool tests (expected: red — fixed in Task 8)**

Run: `bun test src/__tests__/agent/agentTools.test.ts`
Expected: FAIL (asserts deleted symbols) — rewritten in Task 8. Do NOT fix here.

- [ ] **Step 4: Typecheck the server tool surface**

Run: `bunx tsc -b 2>&1 | grep -E "readTools|snapshot|render" | head`
Expected: no errors in these files (other files may error until Task 6-7 land).

- [ ] **Step 5: Commit**

```bash
git add server/ai/tools/site/readTools.ts server/ai/tools/site/snapshot.ts
git commit -m "feat(agent): replace JSON page-read tools with read_page (HTML+CSS)"
```

---

## Task 6: Derive the system prompt from the raw tree

**Files:**
- Modify: `server/ai/tools/site/systemPrompt.ts`
- Modify: `server/ai/handlers/chat.ts:289-320` (`buildSystemPromptForScope`, `emptySiteSnapshot`)

- [ ] **Step 1: Update `buildSiteSystemPrompt` to take `SiteAgentSnapshot`**

In `server/ai/tools/site/systemPrompt.ts`:
- Change the import + signature to `SiteAgentSnapshot`.
- Rewrite `buildDynamicSuffix` to read from `snap.page` + `snap.site`:
  - `pageTitle` ← `snap.page.title`; `rootNodeId` ← `snap.page.rootNodeId`.
  - `selected` ← `snap.selectedNodeId ?? 'none'`.
  - `active` ← `snap.activeBreakpointId`.
  - breakpoints ← `snap.site.breakpoints`.
  - pages ← `snap.site.pages` (id/slug/active where `active = p.id === snap.page.id`).
- Update the static prefix "Editing existing content" line: replace `getNodeHtml to read a subtree's HTML, or search_nodes / inspect_page to find a target` with `read_page to read the whole page as annotated HTML + CSS (every element carries uid="<nodeId>"), or getNodeHtml for one subtree; then updateNodeProps / replaceNodeHtml addressing nodes by their uid`.

- [ ] **Step 2: Update chat.ts**

In `server/ai/handlers/chat.ts`:
- Replace the `SiteSnapshot` import (line 41) with `SiteAgentSnapshot`.
- `buildSystemPromptForScope` (line ~294): `buildSiteSystemPrompt((snapshot ?? emptySiteAgentSnapshot()) as SiteAgentSnapshot)`.
- Replace `emptySiteSnapshot()` (line ~307) with `emptySiteAgentSnapshot()` returning a valid empty tree:

```ts
function emptySiteAgentSnapshot(): SiteAgentSnapshot {
  return {
    page: { id: '', title: 'Untitled', slug: '', rootNodeId: '', nodes: {} } as SiteAgentSnapshot['page'],
    site: { pages: [], breakpoints: [], styleRules: {}, visualComponents: [], settings: { framework: {}, fonts: {} } } as unknown as SiteAgentSnapshot['site'],
    selectedNodeId: null,
    activeBreakpointId: '',
  }
}
```

- [ ] **Step 3: Run the system-prompt tests**

Run: `bun test src/__tests__/architecture/agent-system-prompt-no-module-enumeration.test.ts`
Expected: PASS (the prefix still enumerates no modules). If it asserts exact prefix text, update the expectation to the new wording.

- [ ] **Step 4: Commit**

```bash
git add server/ai/tools/site/systemPrompt.ts server/ai/handlers/chat.ts
git commit -m "feat(agent): build site system prompt from raw tree snapshot"
```

---

## Task 7: Browser side — post the raw tree, annotate getNodeHtml

**Files:**
- Modify: `src/admin/pages/site/agent/pageContext.ts`
- Modify: `src/admin/pages/site/agent/agentSliceConfig.site.ts`
- Modify: `src/admin/pages/site/agent/executor.ts:305-333` (`runGetNodeHtml`)
- Delete: `src/admin/pages/site/agent/pageSnapshot.ts`

- [ ] **Step 1: Rewrite `pageContext.ts` to emit the raw snapshot**

Replace `buildPageContext` / `buildCurrentPageContext` bodies so they call `buildSiteAgentSnapshot(activePage, state.site, { selectedNodeId, activeBreakpointId })`. The empty-state branch returns `null` page handling — when there is no active page/site, return an empty `SiteAgentSnapshot` (mirror `emptySiteAgentSnapshot`, or skip and let the server default handle it). Keep `buildCurrentPageContext(get)` as the exported entry the slice config uses.

```ts
import { buildSiteAgentSnapshot, type SiteAgentSnapshot } from './siteAgentSnapshot'

export function buildCurrentPageContext(get: () => EditorStore): SiteAgentSnapshot | undefined {
  const state = get()
  const activePage = state.site?.pages.find((p) => p.id === state.activePageId) ?? state.site?.pages[0]
  if (!activePage || !state.site) return undefined
  return buildSiteAgentSnapshot(activePage, state.site, {
    selectedNodeId: state.selectedNodeId,
    activeBreakpointId: state.activeBreakpointId,
  })
}
```

(`config.buildSnapshot` may return `undefined`; the POST sends `snapshot: undefined` → server falls back to `emptySiteAgentSnapshot`. Confirm `AgentRequestBody.snapshot` is optional — it is, `Type.Optional(Type.Unknown())`.)

- [ ] **Step 2: Update `agentSliceConfig.site.ts`**

Its `buildSnapshot` already calls `buildCurrentPageContext(...)`; just ensure the type still lines up (it returns `SiteAgentSnapshot | undefined` now). Update the JSDoc line "snapshots the live page tree via buildCurrentPageContext" → "posts the raw live page tree (active page + site) via buildCurrentPageContext".

- [ ] **Step 3: Annotate `runGetNodeHtml` with uid**

In `src/admin/pages/site/agent/executor.ts`, in `runGetNodeHtml`, set `annotateNodeIds: true` on the `RenderContext`:

```ts
const ctx: RenderContext = {
  page: targetPage,
  site,
  registry,
  breakpointId: undefined,
  cssMap: new Map(),
  annotateNodeIds: true,
}
```

(If `RenderContext` requires other fields the current literal omits, TypeScript will flag them — it currently compiles, so only add `annotateNodeIds`.)

- [ ] **Step 4: Delete the flattener**

```bash
git rm src/admin/pages/site/agent/pageSnapshot.ts
```

Remove any remaining imports of `buildPageSnapshot` (grep): the bench (Task 11) and `pageContext.ts` (rewritten Step 1). Also drop the now-dead `PageContext` flattened type from `src/admin/pages/site/agent/types.ts` if nothing else references it (grep first).

- [ ] **Step 5: Typecheck the admin agent surface**

Run: `bunx tsc -b 2>&1 | grep -E "agent/|executor|pageContext" | head`
Expected: no errors in these files.

- [ ] **Step 6: Commit**

```bash
git add src/admin/pages/site/agent/pageContext.ts src/admin/pages/site/agent/agentSliceConfig.site.ts src/admin/pages/site/agent/executor.ts src/admin/pages/site/agent/types.ts
git commit -m "feat(agent): post raw tree snapshot; annotate getNodeHtml with uid"
```

---

## Task 8: Rewrite the agent tests for the new surface

**Files:**
- Modify: `src/__tests__/agent/agentTools.test.ts`
- Modify: `src/__tests__/agent/agentSlice.test.ts`

- [ ] **Step 1: Rewrite `agentTools.test.ts`**

Delete the assertions for `buildPageSnapshot`/`searchPageNodes`/`inspectPageNode`/`inspectPageClass`. Replace with:
- a `read_page` test (build a `SiteAgentSnapshot` fixture, call the tool handler via the registry or `renderAgentPage` directly, assert `html` contains `uid="…"` and `css` starts with `<style>`),
- `list_modules` returns `base.text` (and excludes `base.body`),
- `list_tokens` returns colors/typography/fonts and filters by `family`,
- `list_pages` maps the site pages with `isHomepage` for slug `index`.

Reuse the fixture shape from `readPage.test.ts` Step 1.

- [ ] **Step 2: Update `agentSlice.test.ts`**

Wherever it builds/asserts the posted snapshot shape, switch to `SiteAgentSnapshot` (`page`/`site`/`selectedNodeId`/`activeBreakpointId`) instead of the flattened fields.

- [ ] **Step 3: Run the agent test suite**

Run: `bun test src/__tests__/agent/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/agent/agentTools.test.ts src/__tests__/agent/agentSlice.test.ts
git commit -m "test(agent): cover read_page + catalog tools, drop JSON-snapshot tests"
```

---

## Task 9: Update architecture tests + tool-count references

**Files:**
- Modify: any test naming the deleted tools or counting site tools (grep below)
- Modify: `server/ai/tools/site/writeTools.ts:10` (header comment "17 total")

- [ ] **Step 1: Find references to deleted tool names**

Run: `grep -rn "inspect_page\|inspect_node\|search_nodes\|list_classes\|inspect_class" src/__tests__/ server/ docs/`
Expected: a short list. Update each: remove the name or replace with `read_page` where the intent was "the read surface".

- [ ] **Step 2: Update the writeTools header comment**

`server/ai/tools/site/writeTools.ts` line ~10 says "15 mutation tools + render_snapshot + getNodeHtml = 17 total." That count is unchanged (write tools untouched), but verify and leave accurate.

- [ ] **Step 3: Run the architecture suite**

Run: `bun test src/__tests__/architecture/`
Expected: PASS. If a gate forbids `server/` importing `@site/...` (the `SiteAgentSnapshot` re-export in Task 5), this is where it fails — resolve by relocating the type per Task 5 Step 2's note.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(agent): update architecture refs for HTML read surface"
```

---

## Task 10: Update documentation

**Files:**
- Modify: `docs/editor.md` (agent read/write surface section, if present)
- Modify: any `docs/features/` or `docs/` page describing `inspect_page`/the JSON read tools

- [ ] **Step 1: Find docs referencing the old tools**

Run: `grep -rn "inspect_page\|search_nodes\|list_classes\|data-node-id\|SiteSnapshot" docs/`
Expected: a list of doc hits.

- [ ] **Step 2: Update prose**

For each: describe the new surface — `read_page` returns annotated HTML (`uid="<nodeId>"`) + a `<style>` CSS bundle; the agent addresses nodes by `uid`; catalog tools (`list_modules`/`list_tokens`/`list_pages`/`list_breakpoints`) remain. Note the snapshot now posts the raw `{ page, site }` tree.

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit -m "docs: describe agent HTML read surface (read_page + uid)"
```

---

## Task 11: Update or retire the token benchmark

**Files:**
- Modify: `scripts/bench/benches/snapshot-tokens.ts`

The bench imported `buildPageSnapshot` (now deleted). Decide:
- **Retire:** the decision it informed is made; delete the bench + its README section.
- **Keep as regression guard:** inline a minimal local flattener (copy the old `buildPageSnapshot` mapping into the bench file) so the JSON-vs-HTML comparison still runs.

- [ ] **Step 1: Pick and apply**

Default to **keep with an inlined flattener** (cheap insurance the win doesn't regress). Replace the `buildPageSnapshot` import with a local `flattenForBench(page, site, registry, opts)` function pasted from the deleted file. Replace the HTML side's `data-node-id` count regex with `uid="` (Task 1 changed the attribute):

```ts
const annotatedTags = (htmlBody.match(/uid="/g) ?? []).length
```

- [ ] **Step 2: Typecheck the bench**

Run: `bunx tsc -b 2>&1 | grep "snapshot-tokens" | head`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/benches/snapshot-tokens.ts scripts/bench/README.md
git commit -m "chore(bench): inline flattener + count uid tags after read-surface swap"
```

---

## Task 12: Full verification + browser smoke test

- [ ] **Step 1: Build**

Run: `bun run build`
Expected: `tsc -b && vite build` clean (no errors in files this plan touched; pre-existing failures from parallel sessions are not yours — triage with `git diff --name-only`).

- [ ] **Step 2: Test**

Run: `bun test`
Expected: green for `src/__tests__/agent/`, `src/__tests__/publisher/`, `src/__tests__/architecture/`.

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: clean on touched `.ts` files.

- [ ] **Step 4: Browser smoke test**

Start `bun run dev`, open `http://127.0.0.1:5173/admin/site`, log in (`ai@ai.com` / `qwerty123456`). In the agent panel:
1. Ask the agent to read the page → confirm it calls `read_page` and gets annotated HTML + CSS (check the tool result in the network tab or conversation).
2. Ask it to edit a specific existing element (e.g. "change the hero heading text") → confirm it addresses the node by its `uid` and the edit lands on the canvas.

Expected: read→write round-trip works; the edited node updates live.

- [ ] **Step 5: Final commit (if any doc/cleanup remains)**

```bash
git add -A
git commit -m "chore(agent): finalize HTML read surface migration"
```

---

## Notes / known limitations (carry into review)

- **Plugin canvas modules:** `read_page` and `list_modules` render/enumerate from the *server* registry (base modules registered via `import '../../src/modules/base'`). Canvas modules registered only in the browser plugin host are the one parity risk — same gap that exists for `list_modules` today. Out of scope for MVP; flag if a plugin module fails to render server-side.
- **`SiteAgentSnapshot` type home:** if an architecture gate blocks `server/` → `src/admin/` imports, the type must live in a neutral location both can import (Task 5 Step 2). Resolve before merging.
