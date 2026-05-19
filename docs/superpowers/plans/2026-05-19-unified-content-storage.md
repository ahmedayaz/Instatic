# Unified content storage: pages, templates, components → data_tables

**Status:** Draft plan, not yet implemented.
**Author:** Design discussion 2026-05-19.
**Scope:** Storage + admin unification for pages, templates, and visual components.

## Motivation

Today the CMS stores content in three structurally different places:

| Concern | Storage |
|---|---|
| Posts + custom data tables | `data_tables` + `data_rows` + `data_row_versions` |
| Pages | `pages` + `page_versions` |
| Visual Components | `site.settings_json.visualComponents[]` |

We already migrated posts from a bespoke shape into `data_tables`. Keeping pages and VCs on their own shapes means:

- Three CRUD code paths, three version models, three import/export pipelines.
- No way to bulk-edit page SEO fields in a grid.
- No way to add custom fields to pages or components.
- Site-to-site transfer requires multiple custom exporters/importers.
- The "data tables" UI is already the best content browser in the product; pages and components don't get to use it.

The goal of this plan: make `data_tables` the single content storage layer. Posts, pages, templates (filtered pages), and components all become rows. Custom fields, bulk operations, and import/export then work uniformly.

This is a pre-release refactor. No backward compatibility, no shims, no parallel implementations, no data migrations. The local DB is dropped. The baseline migration is **rewritten in place** to ship the new shape from first boot.

## Non-goals

- Settings, breakpoints, runtime config, classes, package.json, files — stay in `site.settings_json`. These are global site state, not per-document content.
- Plugins, media, users, roles, sessions, audit, fonts — stay in their own tables. These are infrastructure, not content.
- A managed/hosted offering. The product remains self-hosted only.

## End-state architecture

### Tables

```
data_tables             definition rows (kinds: postType | page | component | data)
data_rows               every content row in the CMS
data_row_versions       one version model
data_row_redirects      unchanged
```

Removed:

```
pages                   DROP
page_versions           DROP
site.settings_json.visualComponents[]   removed from shell
```

The `site` table keeps a leaner `settings_json`:

```
{
  cmsSiteSchemaVersion: 1,
  site: {
    id, files, packageJson, runtime, breakpoints, settings, classes,
    createdAt, updatedAt
    // NO pages, NO visualComponents
  }
}
```

### Seeded tables

The baseline migration seeds three system tables. They look identical to user-created tables in the data store; the only difference is they ship out of the box, can't be deleted, can't be renamed, and have a stable id.

```
id: 'posts'       kind: 'postType'    slug: 'posts'        routeBase: '/posts'
id: 'pages'       kind: 'page'        slug: 'pages'        routeBase: ''
id: 'components'  kind: 'component'   slug: 'components'   routeBase: ''
```

System status is signalled by a new column on `data_tables`:

```
system  integer not null default 0     -- 1 = seeded, locked from rename/delete
```

Users can still add custom fields to any system table (e.g. add `category` to pages, `cardSize` to components). Built-in fields are flagged `builtIn: true` and cannot be renamed or removed.

### Built-in fields per kind

**`posts` (`kind: 'postType'`)** — unchanged:

```
title          text       required, builtIn
slug           text       required, builtIn
body           richText   markdown, builtIn
featuredMedia  media      image only, builtIn
seoTitle       text       builtIn
seoDescription longText   builtIn
```

**`pages` (`kind: 'page'`)** — new:

```
title              text         required, builtIn
slug               text         required, builtIn
body               pageTree     required, builtIn          ← new field type
seoTitle           text         builtIn
seoDescription     longText     builtIn
templateEnabled    boolean      builtIn
templateContext    select       options: ['entry'], builtIn
templateTableSlug  text         builtIn
templatePriority   number       integer, builtIn
templateConditions longText     builtIn (JSON-encoded array of conditions)
```

Template config gets five flat cells per the design decision — lets us sort/filter pages by `templatePriority` in the grid and treat `templateEnabled` as a first-class boolean for filters.

**`components` (`kind: 'component'`)** — new:

```
name      text          required, builtIn
slug      text          required, builtIn
body      pageTree      required, builtIn
params    fieldSchema   builtIn                              ← new field type
classIds  longText      builtIn (JSON-encoded string array)
```

`params` reuses the `DataField` shape — same picker UI, same validation, smaller type surface.

`slots` are not stored as a field; they are *derived* from the tree by walking it for `base.slot-outlet` nodes (existing logic in `src/core/visualComponents/slotSync.ts`). The grid's component row exposes `slotCount` and `usageCount` as **computed columns** (read-only, derived at query time).

### New field types

#### `pageTree`

```ts
const PageTreeFieldSchema = Type.Object({
  type: Type.Literal('pageTree'),
  ...FieldCommonProps,
})
```

Cell value: `NodeTree<PageNode>` — the existing flat-map tree shape from `src/core/page-tree/treeSchema.ts`.

UI: cell renders `[ Open editor → ]`. Click navigates to the visual editor for that row (`/admin/site/<tableSlug>/<rowId>`). The visual editor reads and writes the tree via the same `saveDataRowDraft` API the data grid uses for any cell.

Validation: TypeBox schema reuses the existing `Type.Record(Type.String(), PageNodeSchema)` + `rootNodeId` shape. Stored as `cells_json[body]`.

#### `fieldSchema`

```ts
const FieldSchemaFieldSchema = Type.Object({
  type: Type.Literal('fieldSchema'),
  ...FieldCommonProps,
})
```

Cell value: `DataField[]` (the existing union).

UI: opens the same picker the user already gets when adding columns to a data table. Used for component params.

#### Updated `DATA_FIELD_TYPES`

```ts
export const DATA_FIELD_TYPES = [
  'text', 'longText', 'richText', 'number', 'boolean',
  'date', 'dateTime', 'select', 'multiSelect', 'url', 'email',
  'media', 'relation',
  'pageTree',      // new
  'fieldSchema',   // new
] as const
```

### Routing

The publisher already routes data rows via `tableRouteBase + '/' + slug`. With `pages` having `routeBase: ''`, a page at slug `home` publishes at `/home`. The home page slug convention (or homepage selection) is handled by a `site.settings_json.homepageSlug` field; existing site shell logic for that stays.

Components have `routeBase: ''` and are not directly routable. They are referenced from page trees by `base.visual-component-ref` nodes that store the row id.

### Publishing snapshot

`PublishedPageSnapshot` (`server/repositories/publish.ts`) currently stores the entire `SiteDocument` per page. This needs to shift:

```ts
interface PublishedPageSnapshot {
  cmsSnapshotVersion: 2
  pageRowId: string                          // was: pageId
  pageRow: DataRow                           // the page row including the body tree cell
  components: Record<string, DataRow>        // any VC rows referenced by the page tree
  site: SitePublishedShell                   // the lean shell (no pages, no VCs)
  runtimeAssets?: PublishedPageRuntimeAssets
  runtimePackageImportmap?: PublishedRuntimePackageImportmap
}
```

`cmsSnapshotVersion` bumps from 1 to 2. Pre-release: no existing snapshots are migrated; the migration drops `page_versions` and re-publishes are triggered from the fresh data.

## Refactor plan

The refactor lands in one coherent change-set. Because the local DB is dropped and rebuilt from the rewritten baseline migration, there are no data-copy migrations, no compatibility code, and no intermediate "old + new side-by-side" states.

The work breaks into five steps so it's reviewable, but they all ship together and the codebase only needs to be green at the end. Run `bun install && bun run dev` once to recreate the DB from the rewritten baseline.

### Step 1 — Add new field types

Files:

- `src/core/data/schemas.ts` — add `PageTreeFieldSchema`, `FieldSchemaFieldSchema`, extend `DataFieldSchema` union, extend `DATA_FIELD_TYPES` tuple, add `'page'` and `'component'` to `DataTableKindSchema`, add `system: boolean` to `DataTableSchema`.
- `src/core/data/cells.ts` — add `readPageTreeCell`, `readFieldSchemaCell` helpers.
- `src/admin/pages/data/components/DataGrid/cells/PageTreeCell.tsx` — new cell renderer ("Open editor →" button, navigates to the visual editor).
- `src/admin/pages/data/components/DataGrid/cells/FieldSchemaCell.tsx` — new cell renderer (opens the field picker dialog).
- `src/admin/pages/data/utils/fieldIcons.ts` — icons for the two new types.
- `src/admin/pages/data/utils/fieldDefaults.ts` — default cell values.
- `src/admin/pages/data/components/DataGrid/cells/CellDisplayRenderer.tsx` — route to new renderers.
- `src/admin/pages/data/components/DataGrid/cells/CellEditorRenderer.tsx` — likewise.
- Architecture test update: `binding-compatibility-coverage.test.ts` (covers `DATA_FIELD_TYPES` exhaustively).

### Step 2 — Rewrite `001_baseline` so the new shape ships from boot

We **edit the existing baseline migration in place** (both `server/db/migrations-pg.ts` and `server/db/migrations-sqlite.ts`, identical migration id, dialect-translated DDL).

Changes inside `001_baseline`:

- **Remove** the `create table pages (...)` block.
- **Remove** the `create table page_versions (...)` block.
- **Add** the `system integer not null default 0` column to `data_tables` (default 1 for seeded rows).
- **Seed** three system tables instead of one:
  - `posts` — unchanged built-in fields, now also `system = 1`.
  - `pages` — built-in fields per the schema above (`title`, `slug`, `body` (pageTree), `seoTitle`, `seoDescription`, `templateEnabled`, `templateContext`, `templateTableSlug`, `templatePriority`, `templateConditions`), `system = 1`, `kind = 'page'`, `routeBase = ''`.
  - `components` — built-in fields (`name`, `slug`, `body` (pageTree), `params` (fieldSchema), `classIds`), `system = 1`, `kind = 'component'`, `routeBase = ''`.

The baseline ends up shorter, not longer — we delete two tables and add two seed rows.

Architecture tests touched:

- `migration-parity.test.ts` — keeps the same migration id `001_baseline` across dialects, just with the new contents.
- New: `data-tables-system-flag.test.ts` — guarantees the three system tables exist after a fresh boot and that their built-in fields are present.

### Step 3 — Delete the page repository and rewire callers

This is the largest single step in terms of files touched, but mechanical.

- `server/repositories/site.ts` — delete all `pages` handling. `saveDraftSite` and `loadDraftSite` deal only with the site shell. Drop the `pageRows` query, the `withPageOwnership` helper, the `PageDraftRow` interface.
- `server/repositories/data/rows.ts` — verify `cells_json` round-trips `pageTree` cell values correctly (the existing JSON path handles it; this is mostly a test).
- `server/repositories/data/publish.ts` — `publishDataRow` already handles `data_row_versions`; extend it to build the right `PublishedPageSnapshot` shape when the row belongs to the `pages` table.
- `server/repositories/publish.ts` — update `PublishedPageSnapshot` to the new shape (`cmsSnapshotVersion: 1` — we don't need to bump a version that nobody else has read; the field stays at 1 with the new meaning).
- `server/publish/publicRenderer.ts` — read pages from `data_rows where table_id = 'pages' and status = 'published'`. The render function takes a `DataRow` (with `body` cell holding the tree) plus the referenced VC rows.
- `server/publish/loopPrefetch.ts` — already data-row-shaped; no changes expected.
- `src/core/page-tree/schemas.ts` — delete the standalone `PageSchema` and `Page` type alias. Anywhere that needed a `Page` now uses a derived view computed from a `DataRow` (`pageFromRow(row): { id, slug, title, tree, template? }`). Keep `PageNodeSchema` and `NodeTreeSchema` — they're still the tree shape, just now stored inside a cell.
- `src/core/persistence/validate.ts` — `validateSite` no longer expects `pages` or `visualComponents` in the site document.
- `src/admin/pages/site/` (the editor shell) — load the active page via the data API: `GET /admin/api/cms/data/tables/pages/rows/:rowId`. Save via `PATCH .../rows/:rowId` using the existing draft endpoint. The store's `siteSlice` adopts a `loadPage(rowId)` / `savePage(rowId, cells)` shape; `mutateActiveTree` still does what it does, but it operates on `cells.body` instead of `page.nodes`.
- Search & spotlight (`src/admin/spotlight/`) — point page providers at the data API.
- All callers of `useSitePages()` / `site.pages` — route through the data workspace store.

Architecture tests:

- New: `no-legacy-pages-table.test.ts` — fails if `pages` or `page_versions` appears in any migration file (defensive — they're gone, but this stops a regression).
- Update: `db-json-column-naming.test.ts` — no new violations introduced.

### Step 4 — Delete the VC-in-shell code path and rewire callers

- `src/core/visualComponents/schemas.ts` — keep `VisualComponentSchema` as the in-memory shape, but it is no longer referenced from `SiteDocumentSchema`. Add `dataRowToVisualComponent(row: DataRow): VisualComponent` adapter.
- `src/core/visualComponents/` — the internal helpers (`instantiate.ts`, `slotSync.ts`, `recursionGuard.ts`, `deletionImpact.ts`, `origin.ts`) work on the in-memory `VisualComponent` shape unchanged. The only change is *where they get the VC from*.
- `src/core/persistence/validate.ts` — drop `visualComponents` from the site validation.
- `server/repositories/site.ts` — drop `visualComponents` from the shell read/write paths (already partly done in Step 3 when stripping pages handling).
- Editor — load VCs via the data API: `GET /admin/api/cms/data/tables/components/rows`. Save edits via the same row API. The editor store's `siteSlice` adopts the new source.
- Publisher — include referenced VC rows in `PublishedPageSnapshot` (per Step 3).
- `base.visual-component-ref` resolution — looks up the referenced VC by `row.id` from the data API instead of by VC `id` from the site shell. The id space doesn't change.

Architecture tests:

- New: `no-vc-in-site-shell.test.ts` — fails if anything reads `visualComponents` off `SiteDocument`.

### Step 5 — Templates filter, import/export, cleanup

**Templates filter** — no storage work, just UI:

- `src/admin/pages/data/components/DataCanvas/DataCanvas.tsx` — for the `pages` table, add a filter row: `All / Pages / Templates / Drafts / Published`. "Templates" filters by `templateEnabled = true`; "Pages" filters by `templateEnabled = false`.
- `src/admin/pages/data/hooks/useDataWorkspace.ts` — expose the filter param to the rows query.
- `src/admin/shared/dialogs/TemplateSettingsDialog/` — keeps editing the same five cells; no new code path.

**Import/export** — one bundle, one endpoint each way:

```ts
const SiteBundleSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  exportedAt: Type.String(),
  site: SiteShellSchema,                    // lean shell
  tables: Type.Array(DataTableSchema),
  rows: Type.Array(DataRowSchema),
  media: Type.Optional(Type.Array(MediaAssetExportSchema)),
})
```

- `server/handlers/cms/export.ts` — new handler. Walks all tables + rows + (optionally) site shell + media. Returns the bundle.
- `server/handlers/cms/import.ts` — new handler. Validates with `SiteBundleSchema`, inserts in dependency order (tables → rows → versions → media refs).
- `src/admin/pages/data/components/DataSidebar/DataSidebar.tsx` — Import / Export actions at the bottom of the sidebar.
- Architecture test: `import-export-roundtrip.test.ts` — export → wipe DB → import → assert equality on table + row counts and a sampled deep-equal check.

**Cleanup:**

- Delete any `Page`-typed code paths that are now redundant (page-specific repositories, page-specific handlers if any survived). `fallow dead-code` will catch leftovers.
- Update `docs/superpowers/plans/2026-05-06-tree-unification.md` if it references old page storage.
- Update top-level `CLAUDE.md` "Stack at a glance" to mention that pages, posts, and components all live in `data_tables`.

## Performance — indexes and expected query shapes

The unified model is **not a performance downgrade**. The hot paths in a CMS — slug lookup, status filter, listing by updated time, and serving published snapshots — all run on indexed columns or pre-rendered snapshots, never on JSON path expressions. This is the same storage pattern WordPress (`wp_posts`) and Drupal (entity/field API) use to serve millions of sites.

### Existing indexes (kept as-is)

```sql
-- Public-route slug resolution
data_rows_table_slug_active_idx
  on data_rows (table_id, slug)
  where deleted_at is null and slug <> ''

-- Workspace list-by-recency
data_rows_table_idx
  on data_rows (table_id, updated_at desc)
  where deleted_at is null

-- Snapshot fetch
data_row_versions_row_latest_idx
  on data_row_versions (row_id, version_number desc)

-- Redirect lookup
data_row_redirects_source_idx
  on data_row_redirects (from_route_base, from_slug)
```

The denormalized `slug`, `status`, `table_id`, `updated_at`, `created_at`, and `published_at` columns mean every route, list, and filter query in the admin and on the public site hits indexed columns — never a JSON path.

### Planned additions

Added to `001_baseline` as part of this refactor:

```sql
-- Status filtering ("show only published pages")
create index data_rows_table_status_idx
  on data_rows (table_id, status, updated_at desc)
  where deleted_at is null

-- Author scoping ("show posts by me")
create index data_rows_table_author_idx
  on data_rows (table_id, author_user_id, updated_at desc)
  where deleted_at is null
```

Both are partial, both align with existing query shapes in `server/repositories/data/rows.ts`.

### Auto-indexed filterable fields

For custom-field filtering (e.g. "show pages where `category = 'blog'`"), a JSON path expression is unindexed by default — like an unindexed column on a dedicated table. Both engines support expression indexes:

```sql
-- Postgres
create index pages_category_idx on data_rows ((cells_json->>'category'))
  where table_id = 'pages'

-- SQLite
create index pages_category_idx on data_rows (json_extract(cells_json, '$.category'))
  where table_id = 'pages'
```

To make this declarative, `DataField` gains an optional `indexed: boolean` flag. When a field is added or updated with `indexed: true`, the repository runs the matching `create index` DDL. When the field is removed or `indexed` is cleared, `drop index` runs. The flag is exposed in the field settings dialog as "Index for fast filtering".

Implementation note: the index name is derived from `(tableId, fieldId)` so it's stable across renames-via-id. Postgres and SQLite both accept the same expression names; the dialect difference is `cells_json->>'X'` vs `json_extract(cells_json, '$.X')`. The repository builds the right DDL per dialect.

### Snapshot serving — render hot path

Published pages are served from `data_row_versions.snapshot_json` — pre-rendered HTML/CSS bundles. The runtime path is:

1. `slug` → `data_rows.id` (indexed lookup)
2. `data_rows.active_version_id` → `data_row_versions.snapshot_json` (PK lookup)
3. Stream bytes.

Two indexed point lookups, no JSON path eval, no rendering at request time. Storage shape of `cells_json` is irrelevant on the public render path.

### What we explicitly accept

- **Heavy ad-hoc analytics across cells with no index.** Unmeasured workload; not a hot path for a CMS; the answer is "mark the field as indexed and re-run".
- **Slightly looser query-planner stats on expression indexes vs native column indexes.** Negligible at the row volumes a self-hosted CMS hits (tens of thousands of rows, not millions).

## Test gates

Tests to add or update by step:

| Step | Test |
|---|---|
| 1 | `binding-compatibility-coverage.test.ts` (extend) |
| 1 | New cell renderer tests for `pageTree`, `fieldSchema` |
| 2 | `data-tables-system-flag.test.ts` (new) |
| 2 | `migration-parity.test.ts` (verify rewritten `001_baseline` stays parity-clean across dialects) |
| 3 | `no-legacy-pages-table.test.ts` (new) |
| 3 | Publisher integration tests — page render via data row |
| 3 | Editor persistence integration tests — page load/save via data API |
| 4 | `no-vc-in-site-shell.test.ts` (new) |
| 4 | VC instantiation tests retargeted at `dataRowToVisualComponent` |
| 5 | Data canvas filter tests |
| 5 | `import-export-roundtrip.test.ts` (new) |

## Risk register

- **Editor + publisher must flip together.** The editor's persistence and the publisher's read path both change in the same step. They land in one change-set so they are never out of sync — but the change is large. Mitigation: keep step 3 narrowly scoped, run `bun test` + a manual smoke (`bun run dev`, load a page, edit, publish) before opening the PR.
- **Performance on page load via `data_rows`.** Loading a page now goes through the data-row query path. The existing `data_rows_table_slug_active_idx` covers slug lookup. For the publisher hot path, snapshots are pre-rendered and stored by version, so runtime cost is a snapshot fetch, not a row scan.

That's it for risk. There are no data migrations to get wrong, no historical snapshots to honour, no parallel install bases to coordinate with — the DB is dropped, the baseline is rewritten, first boot creates the final shape.

## Open questions to resolve during implementation

These don't change the direction, but each needs a small in-context decision when the code is being written:

1. **VC param IDs** — `parseVCParam` already generates stable nanoid ids. When stored as `DataField[]` in a `fieldSchema` cell, the ids keep their existing shape. No coupling to the cell key.
2. **Component slug uniqueness** — the `components` table's `slug` cell is required-unique within the table (enforced by the existing `data_rows_table_slug_active_idx` partial index). Naming a VC reserves a slug; collisions get a `-2` suffix in the create-row flow.
3. **Page `settings` sub-object** — the current `Page.settings` blob holds page-render-time config. `seoTitle` / `seoDescription` are promoted to top-level cells; everything else in `settings` either moves into `cells.settings` (a generic JSON cell) or is dropped if it's now unused. Verify during step 3.
4. **Computed columns for `slotCount` / `usageCount`** — derived in the workspace hook, not stored. Don't denormalize.
5. **`base.visual-component-ref` resolution** — looks up the VC by row id from the data API. The id space is unchanged.

## Effort estimate

Honest range: **5–8 days of focused work** for a single implementer.

- Step 1 (new field types) — ~1 day
- Step 2 (rewrite `001_baseline`) — ~½ day
- Step 3 (rewire pages) — ~2–3 days, the largest mechanical change
- Step 4 (rewire components) — ~1 day
- Step 5 (filter + import/export + cleanup) — ~1–2 days

## Decision log

The design decisions captured in this plan (recorded so future readers don't re-litigate):

| Question | Decision | Rationale |
|---|---|---|
| Storage strategy | Full unification (Option B), not shims (Option A) | Single source of truth; pre-release is the cheapest time |
| Templates | Filtered view of Pages, not a separate table | Templates *are* pages with extra config |
| Page body | New `pageTree` field type, cell renders "Open editor →" | Tree is structured; cell is the handoff to the visual editor |
| Template config in row | Five flat cells | Lets us sort/filter pages by `templatePriority` and use `templateEnabled` as a first-class boolean filter |
| VC params | Reuse `DataField[]` via new `fieldSchema` field type | 95% shape overlap; same picker UI |
| Page version history | Start fresh — drop `page_versions` | Pre-release; no real history to preserve |
| Settings storage | Stays in `site.settings_json` | Genuinely global, not per-document |
| Scope of system tables | Pages, Components, Posts only | Plugins / users / media are infrastructure, not content |
| Migration strategy | Rewrite `001_baseline` in place; no data-copy migrations; drop the local DB | Pre-release; only the developer uses the DB on this machine; per CLAUDE.md "do not write a compatibility migration on top of a bad migration" |
