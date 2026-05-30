# Plugin CMS content access

A plan to give plugins read/write access to CMS content (`data_tables` + `data_rows`) through a permissioned, per-table-allowlisted `api.cms.content.*` surface — replacing the narrow `api.cms.pages.*` surface that exists today.

This is a plan, not a doc. It describes work that has not been built. When it ships, the lasting parts move into `docs/features/plugin-system.md` and `docs/features/content-storage.md`; this file is deleted.

---

## TL;DR

- **The gap.** Plugins today can list published pages (`{ id, slug, title, lastPublishedAt }`) and trigger a republish. They cannot read page bodies, edit drafts, create posts, mutate page trees, search content, or touch any user-managed `data_tables`. SEO suites, translators, importers, search indexers, and AI assistants are structurally blocked.
- **The shape.** One new surface — `api.cms.content.*` — that mirrors the structure plugins already understand from `api.cms.storage.*` (one CRUD per resource) but talks to the host's CMS content tables, not the plugin-private rows.
- **Per-table allowlist in the manifest.** `contentAccess[]` declares each table the plugin can reach plus the modes (`read`, `write`, `publish`, `delete`). The install consent dialog renders this verbatim. Same fail-closed shape as `networkAllowedHosts`.
- **Five new permissions.** `cms.content.read`, `cms.content.write`, `cms.content.publish`, `cms.content.delete`, `cms.content.tables.manage`. Split this way so the common case ("plugin reads + writes pages") doesn't carry the dangerous bits.
- **Tree-shaped fields go through the canonical mutation engine.** `api.cms.content.tree(entryId, fieldId).mutate([...ops])` dispatches each operation through `src/core/page-tree/mutations.ts`. No new mutation code; plugins ride the same gates the editor rides.
- **Hook events that are already declared finally get emitted.** `content.entry.created/updated/deleted` are types in `src/core/plugin-sdk/types/hooks.ts:8-10` but `grep` finds zero emit sites. This change fixes that and extends the payload with `actor` so plugins can avoid feedback loops on their own writes.
- **The old surface is deleted, not deprecated.** `api.cms.pages.*` and its two permissions (`cms.pages.read`, `cms.pages.publish`) are gone. `examples/plugins/seo-suite` and `examples/plugins/analytics` migrate to the new surface in the same change.
- **One PR.** Migration + repo additions + SDK types + bootstrap + handlers + deletions + docs + gate-test renames. The new code delegates to existing repositories; risk is bounded.

---

## Why this is a plan

Three specific things in the current system make this work worth doing now.

### 1. Plugin classes that should exist today cannot exist

`examples/plugins/` ships nine plugins. Four of them are limited by the content-access gap:

- `seo-suite` — sidecar-stores meta fields in a plugin-private resource keyed by `pageId`. Cannot read the actual page body to auto-suggest a meta description. Cannot write `og:image` directly onto the page entry.
- `analytics` — fine today (works through routes + frontend assets + scheduler), but cannot enrich events with the page title from `pages` because it can't read the source row.
- `search` — would have to scrape baked HTML from `uploads/published/`. Cannot index drafts. Cannot reach the structured `cells_json`.
- A future translator, importer, or AI assistant is structurally impossible.

### 2. Declared events that never fire are a footgun

`CmsServerEvents` in `src/core/plugin-sdk/types/hooks.ts` declares three event channels:

```ts
'content.entry.created': { tableSlug: string; entryId: string }
'content.entry.updated': { tableSlug: string; entryId: string }
'content.entry.deleted': { tableSlug: string; entryId: string }
```

`grep -rn "'content.entry"` over `server/` and `src/core/` finds zero call sites. Plugins that subscribe to them today silently never fire. Fix in the same change.

### 3. The current `api.cms.pages.*` surface is a one-off

`api.cms.pages.list/republish/republishAll` exists because pages were the first place a plugin needed visibility. The implementation is a per-table query (`listPluginPageSummaries` in `server/repositories/publish.ts:408` hardcodes `where data_rows.table_id = 'pages'`) and a republish handler that only takes a page id. Generalising means deleting the special case and re-implementing it as one row of the per-table table — which is the right shape anyway.

### What we leverage

| Concern | Lives in | Already does |
|---|---|---|
| `data_tables` + `data_rows` CRUD | `server/repositories/data/{tables,rows,publish}.ts` | List, get, create, save-draft, soft-delete, publish, move-to-table, cross-table slug search |
| System-table protection (`pages`, `posts`, `components`) | `data_tables.system` column + `softDeleteDataTable` refusal | Plugins inherit this — they cannot delete a system table |
| `NodeTree<TNode>` mutations | `src/core/page-tree/mutations.ts` + 11 named ops | The 11 ops (`insertNode`, `updateNodeProps`, `setBreakpointOverride`, …) the editor already exercises |
| Slot-instance sync on Visual Component drops | `syncSlotInstances` in `src/core/visualComponents/slotSync.ts` | Called after editor mutations; called after plugin tree mutations |
| Storage filter primitive | `StorageFilterOperator` in `src/core/plugin-sdk/storageSchemas.ts` | Operator-object filter (`eq/ne/gt/gte/lt/lte/in/like`) — reused verbatim |
| Sandbox crypto / hooks / settings / storage pattern | `server/plugins/host/handlers/*.ts` + `bootstrap/api.ts` | Pattern: one handler per RPC, sync VM-side `assertPermission` + async host-side authoritative check |
| Permission catalog + install consent dialog | `src/core/plugin-sdk/capabilities.ts` + admin install screen | Renders new permissions + the `contentAccess[]` allowlist for the operator to approve |
| Content capability family | `server/auth/capabilities.ts` — `content.create`, `content.edit.own/any`, `content.publish.own/any`, `content.manage` | Host-side authorization model the plugin handlers piggyback on for route callers |

The repository, mutation, slot-sync, filter, and capability layers do not change. The plan adds an SDK surface, a manifest field, a permission set, an RPC layer, and a hook-emission wiring.

---

## Goals and non-goals

### Goals

- One `api.cms.content.*` surface covering schema introspection, per-table CRUD, tree mutation, search, and published-snapshot read.
- A per-table allowlist (`contentAccess[]`) in the manifest, enforced at the host bridge and visible at install consent.
- Five granular permissions so plugins get only what they need.
- Plugin-actor attribution recorded on `data_rows.plugin_actor_id` for audit.
- `content.entry.created/updated/deleted` events emitted from the persist boundary, with an `actor` field plugins can use to skip their own writes.
- A `content.entry.cells` filter applied before persist, so plugins can normalize / auto-fill.
- The old `api.cms.pages.*` surface and its permissions deleted; in-repo plugins migrated.

### Non-goals

- **Cross-plugin storage access.** `api.cms.content` is for *CMS* tables (`data_tables`), not other plugins' `cms.storage` resources. Inter-plugin services are a separate plan.
- **Custom field types from plugins.** Extending the host's `DataField` union is its own plan (Gap A.4). This plan exposes the existing 15 field types in a narrowed projection (see [§5](#5-field-projection-for-the-plugin-boundary)); it does not allow plugins to add new field kinds.
- **Schema extensions on existing tables (`page.metaDescription` etc.).** Also Gap A.4. Plugins keep storing sidecar data in their own `cms.storage` resources until that lands.
- **Optimistic concurrency.** `data_rows` has no `revision` column today; last-write-wins. Reserved field in the SDK type for a future migration. See [§13](#13-deferred-questions).
- **Backwards compatibility with `api.cms.pages.*`.** Pre-release rule from `CLAUDE.md` applies — it's deleted in this change, not deprecated.

---

## The API surface

Every method is added to `ServerPluginApi.cms` in `src/core/plugin-sdk/types/serverApi.ts`. The shapes use TypeBox schemas defined in a new module `src/core/plugin-sdk/contentSchemas.ts`.

```ts
api.cms.content: {
  // ── Schema introspection ──────────────────────────────────────────────
  tables: {
    list(): Promise<ReadonlyArray<ContentTableSummary>>
    get(slug: string): Promise<ContentTableSchema | null>
    /**
     * Create a new user-managed table. Refuses if `system === true` would
     * be required (system tables are seeded only — never created by plugins).
     */
    create(input: CreateContentTableInput): Promise<ContentTableSchema>
  }

  // ── Per-table entry CRUD ─────────────────────────────────────────────
  table(slug: string): {
    list(options?: ContentListOptions): Promise<ContentListResult>
    get(entryId: string): Promise<ContentEntry | null>
    getBySlug(slug: string): Promise<ContentEntry | null>
    create(input: CreateContentEntryInput): Promise<ContentEntry>
    update(entryId: string, patch: UpdateContentEntryInput): Promise<ContentEntry>
    delete(entryId: string): Promise<void>
    publish(entryId: string, options?: { scheduledFor?: string }): Promise<ContentEntry>
    moveToTable(entryId: string, targetTableSlug: string): Promise<ContentEntry>
    createMany(inputs: ReadonlyArray<CreateContentEntryInput>): Promise<ReadonlyArray<ContentEntry>>
    updateMany(updates: ReadonlyArray<{ id: string; patch: UpdateContentEntryInput }>): Promise<ReadonlyArray<ContentEntry>>
    deleteMany(entryIds: ReadonlyArray<string>): Promise<{ deleted: number }>
  }

  // ── Tree-shaped fields ────────────────────────────────────────────────
  // Page bodies and any other `pageTree`-typed cells. Reads return the
  // tree; writes are dispatched through `applyTreeOperation` from
  // `@core/page-tree` — same engine the editor uses.
  tree(entryId: string, fieldId: string): {
    read(): Promise<NodeTree<TNode>>
    mutate(operations: ReadonlyArray<TreeOperation>): Promise<{ tree: NodeTree<TNode>; affectedNodeIds: string[] }>
    replace(tree: NodeTree<TNode>): Promise<void>
  }

  // ── Cross-table ──────────────────────────────────────────────────────
  search(query: string, limit?: number): Promise<ReadonlyArray<ContentSearchResult>>
  getPublishedSnapshot(entryId: string): Promise<PublishedSnapshot | null>
  republishAll(): Promise<{ count: number }>
}
```

### Type shapes — source-of-truth schemas

New file: `src/core/plugin-sdk/contentSchemas.ts`.

```ts
export const ContentTableSummarySchema = Type.Object({
  slug: Type.String(),
  name: Type.String(),
  kind: DataTableKindSchema,           // 'data' | 'postType' | ...
  routeBase: Type.String(),
  system: Type.Boolean(),
  primaryFieldId: Type.String(),
  fieldCount: Type.Integer(),
  rowCount: Type.Integer(),
})
export type ContentTableSummary = Static<typeof ContentTableSummarySchema>

export const ContentTableSchemaSchema = Type.Composite([
  ContentTableSummarySchema,
  Type.Object({
    singularLabel: Type.String(),
    pluralLabel: Type.String(),
    fields: Type.Array(PluginContentFieldSchema),  // see §5
  }),
])

export const ContentEntrySchema = Type.Object({
  id: Type.String(),
  tableSlug: Type.String(),
  slug: Type.String(),
  status: Type.Union([
    Type.Literal('draft'),
    Type.Literal('published'),
    Type.Literal('scheduled'),
    Type.Literal('archived'),
  ]),
  cells: Type.Record(Type.String(), Type.Unknown()),
  authorUserId: Type.Union([Type.String(), Type.Null()]),
  pluginActorId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  publishedAt: Type.Union([Type.String(), Type.Null()]),
  scheduledPublishAt: Type.Union([Type.String(), Type.Null()]),
})
export type ContentEntry = Static<typeof ContentEntrySchema>

/**
 * Reuses StorageListOptions verbatim — same operator family, same orderBy,
 * same limit/offset. Adds a status filter; default is 'any'.
 */
export const ContentListOptionsSchema = Type.Object({
  filter: Type.Optional(Type.Record(Type.String(), StorageFilterValueSchema)),
  orderBy: Type.Optional(Type.Record(Type.String(),
    Type.Union([Type.Literal('asc'), Type.Literal('desc')]))),
  status: Type.Optional(Type.Union([
    Type.Literal('any'),
    Type.Literal('draft'),
    Type.Literal('published'),
    Type.Literal('scheduled'),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false })
export type ContentListOptions = Static<typeof ContentListOptionsSchema>

export const TreeOperationSchema = Type.Union([
  Type.Object({ kind: Type.Literal('insertNode'), parentId: Type.String(), index: Type.Integer(), node: Type.Unknown() }),
  Type.Object({ kind: Type.Literal('updateNodeProps'), nodeId: Type.String(), props: Type.Record(Type.String(), Type.Unknown()) }),
  Type.Object({ kind: Type.Literal('setBreakpointOverride'), nodeId: Type.String(), breakpoint: Type.String(), props: Type.Record(Type.String(), Type.Unknown()) }),
  Type.Object({ kind: Type.Literal('clearBreakpointOverride'), nodeId: Type.String(), breakpoint: Type.String() }),
  Type.Object({ kind: Type.Literal('renameNode'), nodeId: Type.String(), name: Type.String() }),
  Type.Object({ kind: Type.Literal('toggleNodeLocked'), nodeId: Type.String() }),
  Type.Object({ kind: Type.Literal('toggleNodeHidden'), nodeId: Type.String() }),
  Type.Object({ kind: Type.Literal('moveNode'), nodeId: Type.String(), parentId: Type.String(), index: Type.Integer() }),
  Type.Object({ kind: Type.Literal('duplicateNode'), nodeId: Type.String() }),
  Type.Object({ kind: Type.Literal('wrapNode'), nodeId: Type.String(), wrapper: Type.Unknown() }),
  Type.Object({ kind: Type.Literal('deleteNode'), nodeId: Type.String() }),
])
export type TreeOperation = Static<typeof TreeOperationSchema>
```

The `TreeOperation` union mirrors the 11 named tree-mutation store actions documented in `docs/reference/page-tree.md` and listed in `CLAUDE.md` (search for "11 named tree-mutation store actions"). The plugin calls them by name; the host runs them through `applyTreeOperation` from `@core/page-tree` (re-exported barrel function), which is the same path `src/admin/pages/site/store/slices/site/` uses via `mutateActiveTree`. The architecture test `no-vc-mode-branches-in-mutations.test.ts` continues to gate the tree-agnostic invariant for both paths.

---

## Permissions

Five new permissions added to `PLUGIN_PERMISSION_VALUES` and `PLUGIN_CAPABILITIES` in `src/core/plugin-sdk/`.

| Permission | Risk | Plugin can | Maps to (route-bound calls) |
|---|---|---|---|
| `cms.content.read` | low | List/get entries from allowlisted tables, search, read trees, read published snapshots | `content.edit.any` (the read sub-cap) |
| `cms.content.write` | high | Create entries; update entry cells; mutate trees; move entries between tables | `content.create` + `content.edit.any` |
| `cms.content.publish` | high | Publish or schedule-publish entries; `republishAll()` | `content.publish.any` |
| `cms.content.delete` | high | Soft-delete entries | `content.manage` |
| `cms.content.tables.manage` | dangerous | Create user-managed tables (never system tables) | `data.tables.manage` |

The split mirrors the host's own granular content + data capabilities (`server/auth/capabilities.ts:34-39`, `77-81`). `delete` is separate so most plugins (the SEO/translator/AI cases) don't get it; `tables.manage` is `dangerous` because it lets a plugin add tables a future plugin upgrade then needs to remove.

### Effective authorization at call time

Two cases:

**Route-bound calls** (`api.cms.routes.*` handlers). The route's `user.capabilities` is the authoritative check. The route bridge already enforces the route's declared capability (`server/plugins/host/handlers/routes.ts`). For content RPCs, the host handler additionally requires:

1. The plugin's `cms.content.*` permission is granted (defense in depth).
2. The route user holds the matching `content.*` capability (kernel-of-correctness).
3. The targeted table is in the plugin's `contentAccess[]` for the requested mode.

**Non-route calls** (lifecycle hooks, schedule fires, hook listeners). The plugin acts as a system actor:

1. The plugin's permission is required.
2. `actorUserId` is `null` (already supported — see the comment in `server/repositories/data/publish.ts:117-124`: *"`null` is allowed for system actors that have no user context — e.g. the scheduled-publish tick"*).
3. The targeted table is in `contentAccess[]`.

In both cases the new `data_rows.plugin_actor_id` column records the plugin id for audit (see [§7](#7-audit-and-actor-attribution)).

---

## Manifest schema

The manifest gets one new top-level field: `contentAccess`.

```jsonc
{
  "id": "acme.seo-suite",
  "version": "1.0.0",
  "apiVersion": 1,
  "permissions": ["cms.content.read", "cms.content.write"],

  // Required when ANY of the cms.content.* permissions are granted.
  // The install consent screen renders this verbatim as:
  //   "This plugin can read and modify the following content tables:
  //      • Pages — read, write
  //      • Blog posts — read"
  "contentAccess": [
    { "table": "pages", "modes": ["read", "write"] },
    { "table": "posts", "modes": ["read"] }
  ],

  "entrypoints": { "server": "server/index.js" }
}
```

### Validation rules in `parsePluginManifest`

Enforced in `src/core/plugins/manifest.ts`:

1. `contentAccess` is **required** when any `cms.content.*` permission is in the granted set. Empty allowlist with a permission granted is rejected with a clear error.
2. Each `table` matches `/^[a-z][a-z0-9-]*$/` (the existing `MANIFEST_SLUG_PATTERN`).
3. Each `modes[]` entry is a subset of `["read", "write", "publish", "delete"]`. The host cross-checks at install time that each mode has its corresponding permission granted (e.g. `mode: "publish"` requires `cms.content.publish`).
4. No duplicate `table` entries.
5. `system` tables (`pages`, `posts`, `components`) are allowed in `contentAccess[]` — plugins can read/write them. The host's existing `system` flag prevents `tables.manage` from creating one with a colliding slug.

The new field follows the same shape as `networkAllowedHosts`: permission says "the plugin can touch content"; allowlist says "which tables." Fail-closed without the allowlist — defense in depth with the routes / hooks / VM bootstrap checks.

---

## Field projection for the plugin boundary

The host's `DataField` union has 15 types (`src/core/data/schemas.ts:224-240`). Three of them are too rich or recursive to expose at the JSON boundary safely:

- `fieldSchema` — recursive (a field whose value is `DataField[]`).
- `relation` — needs related-row resolution; expose as `{ id, targetTableSlug }` only.
- `pageTree` — exposed as type marker only; mutations go through `api.cms.content.tree(...)`.

Projection lives in `src/core/plugin-sdk/types/content.ts`:

```ts
export const PluginContentFieldSchema = Type.Union([
  Type.Object({ type: Type.Literal('text'),        id: Type.String(), label: Type.String(), required: Type.Optional(Type.Boolean()) }),
  Type.Object({ type: Type.Literal('longText'),    id: Type.String(), label: Type.String(), required: Type.Optional(Type.Boolean()) }),
  Type.Object({ type: Type.Literal('richText'),    id: Type.String(), label: Type.String(), required: Type.Optional(Type.Boolean()) }),
  Type.Object({ type: Type.Literal('number'),      id: Type.String(), label: Type.String(), required: Type.Optional(Type.Boolean()) }),
  Type.Object({ type: Type.Literal('boolean'),     id: Type.String(), label: Type.String() }),
  Type.Object({ type: Type.Literal('date'),        id: Type.String(), label: Type.String() }),
  Type.Object({ type: Type.Literal('dateTime'),    id: Type.String(), label: Type.String() }),
  Type.Object({ type: Type.Literal('select'),      id: Type.String(), label: Type.String(),
                options: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })) }),
  Type.Object({ type: Type.Literal('multiSelect'), id: Type.String(), label: Type.String(),
                options: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })) }),
  Type.Object({ type: Type.Literal('url'),         id: Type.String(), label: Type.String() }),
  Type.Object({ type: Type.Literal('email'),       id: Type.String(), label: Type.String() }),
  Type.Object({ type: Type.Literal('media'),       id: Type.String(), label: Type.String() }),
  Type.Object({ type: Type.Literal('relation'),    id: Type.String(), label: Type.String(), targetTableSlug: Type.String() }),
  Type.Object({ type: Type.Literal('pageTree'),    id: Type.String(), label: Type.String() }),
  // `fieldSchema` is intentionally omitted from v1.
])
```

`media` cells carry an asset id; the plugin can resolve URLs via `api.plugin.assetUrl` for plugin-shipped assets or the future media-read API. `relation` cells carry a target row id the plugin can `api.cms.content.table(targetTableSlug).get(id)`.

---

## Host wiring

### New RPC targets

Added to `server/plugins/protocol/targets.ts`'s `ALLOWED_API_TARGETS` (the array `plugin-sandbox-invariants.test.ts` locks):

```
cms.content.tables.list
cms.content.tables.get
cms.content.tables.create
cms.content.entries.list
cms.content.entries.get
cms.content.entries.getBySlug
cms.content.entries.create
cms.content.entries.update
cms.content.entries.delete
cms.content.entries.publish
cms.content.entries.moveTable
cms.content.entries.createMany
cms.content.entries.updateMany
cms.content.entries.deleteMany
cms.content.tree.read
cms.content.tree.mutate
cms.content.tree.replace
cms.content.search
cms.content.snapshot
cms.content.republishAll
```

Twenty targets. Same change updates `plugin-sandbox-invariants.test.ts` to lock the new list.

### Dispatcher + handlers

New file: `server/plugins/host/handlers/content.ts`. Pattern matches `handlers/storage.ts` exactly — one exported function per RPC. Each one:

1. Calls `assertHostPluginPermission(entry, '<permission>')`.
2. Calls a new helper `assertContentTableAccess(entry, tableSlug, mode)` that checks the manifest's `contentAccess[]`.
3. Delegates to a repository function from `server/repositories/data/`.
4. Calls `replyApiOk(msg.pluginId, msg.correlationId, result)`.

The dispatcher (`server/plugins/host/apiDispatch.ts`) gets 20 new `case` branches following the existing pattern.

### Repository delegations

Every handler delegates to existing or trivially-added repository functions:

| RPC | Delegate |
|---|---|
| `cms.content.tables.list` | `listDataTablesWithCounts` (existing) → filter to allowlist |
| `cms.content.tables.get` | `getDataTable` (existing) |
| `cms.content.tables.create` | `createDataTable` (existing), forced `system: false` |
| `cms.content.entries.list` | New `listDataRowsWithFilter(db, tableId, options)` — built on `listDataRows`'s SQL plus the operator-object filter from `StorageFilterOperator`. Dialect-naive (gate test `db-postgres-isms.test.ts`). |
| `cms.content.entries.get` | `getDataRow` (existing) |
| `cms.content.entries.getBySlug` | New `getDataRowBySlug(db, tableId, slug)` |
| `cms.content.entries.create` | `createDataRow` (existing) |
| `cms.content.entries.update` | `saveDataRowDraft` (existing); cells run through the new `content.entry.cells` filter first |
| `cms.content.entries.delete` | `softDeleteDataRow` (existing) |
| `cms.content.entries.publish` | `publishDataRow` (existing) — full pipeline (`publish.before` → frontend.assets → `publish.html` filter → `publish.after`) fires |
| `cms.content.entries.moveTable` | `updateDataRowTable` (existing) |
| `cms.content.entries.{create,update,delete}Many` | New: single `db.transaction()` wrapping N existing repo calls |
| `cms.content.tree.read` | Read `row.cells[fieldId]`; assert field type is `pageTree` |
| `cms.content.tree.mutate` | See [§6](#6-tree-mutation-dispatch) |
| `cms.content.tree.replace` | Validate via `validateSite`-style validator; `saveDataRowDraft` |
| `cms.content.search` | `searchDataRows` (existing) — filter results to allowlist |
| `cms.content.snapshot` | Read `data_row_versions` joined via `active_version_id`; optionally render via `renderPublishedDataRowTemplate` |
| `cms.content.republishAll` | `republishAllPages` (existing — currently called from `cms.pages.republishAll`) |

No new SQL beyond two thin helpers (`listDataRowsWithFilter`, `getDataRowBySlug`). Everything else is a delegation.

### VM bootstrap

In `server/plugins/quickjs/bootstrap/api.ts`, the `cms.pages.*` block is removed and replaced with `cms.content.*`:

```js
cms: {
  // ...existing routes / hooks / storage / settings / schedule / media...

  content: {
    tables: {
      list:   function ()      { assertPermission('cms.content.read');           return call('cms.content.tables.list',   []); },
      get:    function (slug)  { assertPermission('cms.content.read');           return call('cms.content.tables.get',    [String(slug)]); },
      create: function (input) { assertPermission('cms.content.tables.manage');  return call('cms.content.tables.create', [input]); },
    },
    table: function (slug) {
      const s = String(slug);
      return {
        list:        function (opt)   { assertPermission('cms.content.read');    return call('cms.content.entries.list',        [s, opt ?? {}]); },
        get:         function (id)    { assertPermission('cms.content.read');    return call('cms.content.entries.get',         [s, String(id)]); },
        getBySlug:   function (sl)    { assertPermission('cms.content.read');    return call('cms.content.entries.getBySlug',   [s, String(sl)]); },
        create:      function (i)     { assertPermission('cms.content.write');   return call('cms.content.entries.create',      [s, i]); },
        update:      function (id, p) { assertPermission('cms.content.write');   return call('cms.content.entries.update',      [s, String(id), p]); },
        delete:      function (id)    { assertPermission('cms.content.delete');  return call('cms.content.entries.delete',      [s, String(id)]); },
        publish:     function (id, o) { assertPermission('cms.content.publish'); return call('cms.content.entries.publish',     [s, String(id), o ?? {}]); },
        moveToTable: function (id, t) { assertPermission('cms.content.write');   return call('cms.content.entries.moveTable',   [s, String(id), String(t)]); },
        createMany:  function (inputs)  { assertPermission('cms.content.write');  return call('cms.content.entries.createMany', [s, inputs]); },
        updateMany:  function (updates) { assertPermission('cms.content.write');  return call('cms.content.entries.updateMany', [s, updates]); },
        deleteMany:  function (ids)     { assertPermission('cms.content.delete'); return call('cms.content.entries.deleteMany', [s, ids]); },
      };
    },
    tree: function (entryId, fieldId) {
      const e = String(entryId); const f = String(fieldId);
      return {
        read:    function ()    { assertPermission('cms.content.read');  return call('cms.content.tree.read',    [e, f]); },
        mutate:  function (ops) { assertPermission('cms.content.write'); return call('cms.content.tree.mutate',  [e, f, ops]); },
        replace: function (t)   { assertPermission('cms.content.write'); return call('cms.content.tree.replace', [e, f, t]); },
      };
    },
    search:               function (q, l)  { assertPermission('cms.content.read');    return call('cms.content.search',        [String(q), Number(l ?? 50)]); },
    getPublishedSnapshot: function (id)    { assertPermission('cms.content.read');    return call('cms.content.snapshot',      [String(id)]); },
    republishAll:         function ()      { assertPermission('cms.content.publish'); return call('cms.content.republishAll', []); },
  },
}
```

The sync `assertPermission` throws inside the VM match the existing pattern for routes, hooks, storage, etc. The host handler does the authoritative check.

---

## 6. Tree mutation dispatch

The most subtle handler. Page bodies live in `pageTree`-typed cells. Three things break if the plugin gets to replace the whole tree as opaque JSON:

1. `syncSlotInstances` (`src/core/visualComponents/slotSync.ts`) doesn't run.
2. Mutation gates in `src/core/page-tree/mutations.ts` (locked-node guards, container-only invariants, breakpoint-override rules) don't fire.
3. The architecture test `no-vc-mode-branches-in-mutations.test.ts` locks the tree-agnostic invariant for the editor's path. Plugin code that bypasses the canonical engine would silently break it.

The handler:

```ts
// server/plugins/host/handlers/content.ts (excerpt)
import { applyTreeOperation } from '@core/page-tree'
import { syncSlotInstances } from '@core/visualComponents'

export async function handleContentTreeMutate(
  msg: ContentTreeMutateApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.content.write')
  const [entryId, fieldId, operations] = msg.args

  const row = await getDataRow(db, entryId)
  if (!row) throw new Error(`Entry "${entryId}" not found`)

  const table = await getDataTable(db, row.tableId)
  if (!table) throw new Error(`Table for entry "${entryId}" missing`)
  assertContentTableAccess(entry, table.slug, 'write')

  const field = table.fields.find((f) => f.id === fieldId)
  if (!field || field.type !== 'pageTree') {
    throw new Error(`Field "${fieldId}" is not a pageTree field`)
  }

  let tree = row.cells[fieldId] as NodeTree<TNode>
  const affectedNodeIds: string[] = []
  for (const op of operations) {
    const result = applyTreeOperation(tree, op)   // throws on invalid op
    tree = result.tree
    affectedNodeIds.push(...result.affectedNodeIds)
  }

  // Same post-mutation sync the editor runs.
  tree = syncSlotInstances(tree)

  await saveDataRowDraft(
    db, entryId,
    { cells: { ...row.cells, [fieldId]: tree }, slug: row.slug },
    resolveActorUserId(msg),
    /* pluginActorId */ msg.pluginId,
  )

  await emitContentEntryUpdated(db, table.slug, entryId, {
    actor: { kind: 'plugin', pluginId: msg.pluginId },
    changedFieldIds: [fieldId],
  })

  replyApiOk(msg.pluginId, msg.correlationId, { tree, affectedNodeIds })
}
```

`applyTreeOperation` is a new pure function in `src/core/page-tree/` that dispatches by `op.kind` to the 11 existing named mutations. It is the same dispatcher `src/admin/pages/site/store/slices/site/` uses indirectly via `mutateActiveTree`. Adding it formalises the path that already exists.

### Reading drafts vs. published

`tree.read()` reads from `row.cells[fieldId]` — the live draft. For plugins that should not see drafts (e.g. a public search index that must not leak unpublished content), the manifest can declare `"mode": ["read-published"]` instead of `"read"`. The handler then reads from `data_row_versions.cells_json` joined via `active_version_id` — equivalent to the published snapshot. Falls back to `null` if the entry has never been published. See `read-published` row in [§4 manifest validation](#manifest-schema).

---

## 7. Audit and actor attribution

One column added to `data_rows`:

```sql
-- server/db/migrations-pg.ts and server/db/migrations-sqlite.ts (same id)
alter table data_rows add column plugin_actor_id text;
```

Same migration id in both dialect files; gate test `migration-parity.test.ts` enforces parity. `plugin_actor_id` is `null` for editor writes; the plugin id (`acme.seo-suite`) for plugin writes; recorded independently of `updated_by_user_id` so a route-bound call records both the human + the plugin.

The admin audit log (`server/repositories/audit.ts`) surfaces plugin-attributed changes ("Pages: 3 entries updated by plugin acme.seo-suite") in the existing log UI. No new audit surface — the column flows through the existing log query.

The `ContentEntry` schema exposes `pluginActorId` to plugin code so plugins can filter their own writes (alongside the more reliable `actor` field on hook events; see [§8](#8-hook-emission)).

---

## 8. Hook emission

Three events that exist in the type declaration but never fire today are emitted from the persist boundary. One filter is added.

### Events

```ts
// src/core/plugin-sdk/types/hooks.ts — extended payloads
'content.entry.created': {
  tableSlug: string
  entryId: string
  actor: ContentEntryActor
}
'content.entry.updated': {
  tableSlug: string
  entryId: string
  changedFieldIds: string[]
  actor: ContentEntryActor
}
'content.entry.deleted': {
  tableSlug: string
  entryId: string
  actor: ContentEntryActor
}

export type ContentEntryActor =
  | { kind: 'user'; userId: string }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'system' }            // schedules, scheduled-publish tick
```

Emission sites:

- `createDataRow` → `'content.entry.created'`
- `saveDataRowDraft` → `'content.entry.updated'` (host computes `changedFieldIds` by diffing `cells` keys + values)
- `softDeleteDataRow` → `'content.entry.deleted'`
- `publishDataRow` → `'content.entry.updated'` (status change counts as an update)

The `actor` field is the canonical loop guard. Plugins reacting to `content.entry.updated` filter on `actor.kind === 'user'` or `actor.pluginId !== api.plugin.id` to avoid responding to their own writes. The host does not add a loop guard — plugin authors decide.

### Filter

```ts
'content.entry.cells': Record<string, unknown>
```

Applied at the persist boundary in `saveDataRowDraft`. Plugins can validate, normalize, or auto-fill:

```ts
api.cms.hooks.filter('content.entry.cells', (cells, { tableSlug, entryId, actor }) => {
  if (tableSlug !== 'pages') return cells
  if (actor.kind === 'plugin' && actor.pluginId === api.plugin.id) return cells
  if (!cells.metaDescription) {
    return { ...cells, metaDescription: extractFirstParagraph(cells.body) }
  }
  return cells
})
```

The filter context follows the existing `CmsServerFilterContexts` shape — typed extras alongside `pluginId`.

---

## 9. Worked examples

### 9.1 SEO Suite — auto-fill meta description from body

```ts
// examples/plugins/seo-suite/server/index.ts (after migration)
import type { ServerPluginModule } from '@pagebuilder/plugin-sdk'

const mod: ServerPluginModule = {
  activate(api) {
    api.cms.hooks.on('content.entry.updated', async ({ tableSlug, entryId, changedFieldIds, actor }) => {
      if (tableSlug !== 'pages') return
      if (actor.kind === 'plugin' && actor.pluginId === api.plugin.id) return
      if (!changedFieldIds.includes('body')) return

      const entry = await api.cms.content.table('pages').get(entryId)
      if (!entry || entry.cells.metaDescription) return

      const body = await api.cms.content.tree(entryId, 'body').read()
      const firstParagraph = findFirstTextNode(body)
      if (!firstParagraph) return

      await api.cms.content.table('pages').update(entryId, {
        cells: { metaDescription: firstParagraph.slice(0, 160) },
      })
    })
  },
}
export default mod
```

Today this plugin cannot exist. After the change it is 20 lines.

### 9.2 Translator — clone a page into N languages

```ts
api.cms.routes.post('/translate/:id', 'content.create', async (ctx) => {
  const sourceId = new URL(ctx.req.url).pathname.split('/').at(-1) ?? ''
  const source = await api.cms.content.table('pages').get(sourceId)
  if (!source) return { __response: true, status: 404, headers: {}, body: 'not found' }

  const langs = ['cs', 'de', 'fr']
  const targets = await api.cms.content.table('pages').createMany(
    langs.map((lang) => ({
      slug: `${source.slug}-${lang}`,
      cells: { ...source.cells, title: `[${lang}] ${source.cells.title}` },
    })),
  )
  return { ok: true, count: targets.length }
})
```

### 9.3 Importer — bulk WordPress import in one transaction

```ts
api.cms.routes.post('/import-wp', 'plugins.configure', async (ctx) => {
  const { wxr } = (await ctx.req.json()) as { wxr: string }
  const posts = parseWxr(wxr)
  await api.cms.content.table('posts').createMany(
    posts.map((p) => ({
      slug: p.slug,
      cells: { title: p.title, body: htmlToNodeTree(p.body), publishedAt: p.date },
    })),
  )
  return { ok: true, imported: posts.length }
})
```

### 9.4 AI assistant — append a node to a page

```ts
api.cms.routes.post('/assist/:pageId', 'content.edit.any', async (ctx) => {
  const pageId = new URL(ctx.req.url).pathname.split('/').at(-1) ?? ''
  const { generatedNode } = await llmRequest(/* ... */)

  await api.cms.content.tree(pageId, 'body').mutate([
    { kind: 'insertNode', parentId: 'nd_root', index: 999, node: generatedNode },
  ])
  return { ok: true }
})
```

---

## 10. What gets deleted

Per the `CLAUDE.md` pre-release rule (no backward compatibility), the old surface is removed in the same change:

| Removed | Replaced by |
|---|---|
| `api.cms.pages.list()` | `api.cms.content.table('pages').list({ status: 'published' })` |
| `api.cms.pages.republish(id)` | `api.cms.content.table('pages').publish(id)` |
| `api.cms.pages.republishAll()` | `api.cms.content.republishAll()` |
| `cms.pages.read` permission | `cms.content.read` |
| `cms.pages.publish` permission | `cms.content.publish` |
| `PluginPageSummarySchema` | `ContentEntrySchema` |
| `listPluginPageSummaries` in `server/repositories/publish.ts` | `listDataRowsWithFilter` |
| `handlers/pages.ts` | merged into `handlers/content.ts` |
| RPC targets `cms.pages.{list,republish,republishAll}` | replaced by the 20 new `cms.content.*` targets |
| Gate test `plugin-cms-pages-surface.test.ts` | renamed to `plugin-cms-content-surface.test.ts` with the new surface assertions |

In-repo plugins migrated in the same change:
- `examples/plugins/seo-suite` — moves from sidecar storage to direct `pages` access.
- `examples/plugins/analytics` — drops `cms.pages.read` (it doesn't actually use the list).

---

## 11. Rollout plan — one change set

1. **Migration.** `alter table data_rows add column plugin_actor_id text` in both `server/db/migrations-pg.ts` and `server/db/migrations-sqlite.ts` with identical id; gate-tested by `migration-parity.test.ts`.
2. **Repository additions.** `listDataRowsWithFilter`, `getDataRowBySlug`, `createDataRowMany`, `updateDataRowMany`, `softDeleteDataRowMany` in `server/repositories/data/rows.ts`. All dialect-naive (gate: `db-postgres-isms.test.ts`).
3. **Mutation engine entrypoint.** `applyTreeOperation(tree, op): { tree, affectedNodeIds }` in `src/core/page-tree/mutations.ts`, exported via the barrel `@core/page-tree`.
4. **SDK schemas.** New `src/core/plugin-sdk/contentSchemas.ts` and `src/core/plugin-sdk/types/content.ts`. Exported from the SDK barrel `@core/plugin-sdk`.
5. **Permissions.** Extend `PLUGIN_PERMISSION_VALUES`, `PLUGIN_CAPABILITIES`, the `permissions` builder alias map.
6. **Manifest schema.** Add `contentAccess` to `parsePluginManifest` in `src/core/plugins/manifest.ts` with the [§4 validation rules](#validation-rules-in-parsepluginmanifest).
7. **VM bootstrap.** Replace the `cms.pages` block in `server/plugins/quickjs/bootstrap/api.ts` with the `cms.content` block from [§5 / §6](#host-wiring).
8. **Protocol.** Add new RPC targets to `server/plugins/protocol/targets.ts`; add `protocol/schemas/content.ts` with TypeBox message schemas; lock in `plugin-sandbox-invariants.test.ts`.
9. **Handlers.** `server/plugins/host/handlers/content.ts` (new); wire into `server/plugins/host/apiDispatch.ts`. Add `assertContentTableAccess(entry, slug, mode)` to `server/plugins/host/registry.ts` next to `assertHostPluginPermission`.
10. **Hook emission.** Call `hookBus.emit('content.entry.created/updated/deleted', { ... })` from `createDataRow / saveDataRowDraft / softDeleteDataRow / publishDataRow` with the `actor` payload. Add the `content.entry.cells` filter pass inside `saveDataRowDraft`.
11. **Delete the old surface.** Remove `cms.pages.*` API, permissions, types, RPC targets, handlers, repo function, gate test rename.
12. **Migrate in-repo plugins.** `examples/plugins/seo-suite` and `analytics` to the new surface.
13. **Docs.** Update `docs/features/plugin-system.md` (surface table, permission catalog, cookbook entry). Add hook reference in `docs/features/content-storage.md`. Update `CLAUDE.md`'s "11 named tree-mutation store actions" sentence to point at `applyTreeOperation` too.
14. **CLI.** Add `bun pb-plugin init --kind=content-editor` scaffold that pre-declares the typical permission set (`cms.content.read`, `cms.content.write`) and a `contentAccess` block.

One PR. `bun test && bun run build && bun run lint` must pass.

---

## 12. Gate tests

The architecture tests change with the surface they gate. Same change adds / updates / renames:

| Test | Change |
|---|---|
| `plugin-sandbox-invariants.test.ts` | Lock the new `ALLOWED_API_TARGETS` (20 added, 3 removed). |
| `plugin-cms-pages-surface.test.ts` | Renamed to `plugin-cms-content-surface.test.ts`. Asserts the `api.cms.content` shape, the 5 new permissions, and the `contentAccess[]` manifest field. |
| `migration-parity.test.ts` | Picks up the new `data_rows.plugin_actor_id` migration automatically (existing test). |
| New: `plugin-content-tree-via-engine.test.ts` | Architecture test: `server/plugins/host/handlers/content.ts` must NOT import `mutations.ts` directly — only via `applyTreeOperation` from the `@core/page-tree` barrel. Mirrors the spirit of `no-vc-mode-branches-in-mutations.test.ts`. |
| New: `plugin-content-access-enforced.test.ts` | Architecture test: every handler in `handlers/content.ts` calls `assertContentTableAccess` before any repository call. AST scan. |

---

## 13. Deferred questions

These do not block the change. They are worth resolving before plugins begin shipping against the new surface.

1. **Slug uniqueness in `createMany`.** Recommendation: fail-the-batch on any slug collision (transaction-safe; idempotent for importers). The alternative — partial success with a result-shape that reports failures — is a worse default for the importer case.
2. **Overlapping schedule + publish.** When `publish(id, { scheduledFor })` runs against an entry that already has `scheduled_publish_at` set, overwrite. Matches the editor's "Update schedule" button behaviour.
3. **`tree.replace()` validation depth.** Full validation via `validateSite` against the registered module registry. Reject on any unknown `kind`. The slow path is fine — `replace()` is rare (importers, snapshot restores).
4. **List filter on nested `cells_json` paths.** Dot-notation in filter keys (`cells.metaDescription`) using a dialect-naive `json_extract`-equivalent expression. Both adapters already support this for the host's admin filters.
5. **`plugin_actor_id` on republish.** When a plugin calls `publish()`, `published_by_user_id` stays `null` (system actor); `plugin_actor_id` records the plugin. The admin published-by column shows "Plugin acme.seo-suite" instead of "(system)".
6. **Optimistic concurrency.** Add `data_rows.revision integer not null default 0` in a follow-up migration; bump on every update; expose `revision` in `ContentEntry` and accept `ifRevision` on `update()`. Reserve the field shape now (already in the type above) so plugins compile against it from day one.

---

## Related

- `docs/features/plugin-system.md` — feature doc that gains a new permission catalog row + cookbook entry when this ships
- `docs/features/content-storage.md` — feature doc that gains the hook-event documentation
- `docs/reference/page-tree.md` — reference doc for the mutation engine the tree API plugs into
- `CLAUDE.md` — the agent rule book; the "11 named tree-mutation store actions" sentence is updated alongside this work
- Source-of-truth files (existing):
  - `src/core/plugin-sdk/capabilities.ts` — permission catalog
  - `src/core/plugin-sdk/types/serverApi.ts` — `ServerPluginApi` surface
  - `src/core/plugins/manifest.ts` — manifest parser
  - `src/core/page-tree/mutations.ts` — the 11 named mutations
  - `src/core/data/schemas.ts` — `DataField`, `DataRow`, `DataTable` types
  - `server/repositories/data/{tables,rows,publish}.ts` — content repository layer
  - `server/plugins/protocol/targets.ts` — `ALLOWED_API_TARGETS`
  - `server/plugins/host/apiDispatch.ts` — RPC dispatcher
  - `server/plugins/quickjs/bootstrap/api.ts` — VM-side `api` factory
  - `server/auth/capabilities.ts` — host capability catalog the new permissions map onto
- Gate tests:
  - `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`
  - `src/__tests__/architecture/migration-parity.test.ts`
  - `src/__tests__/architecture/db-postgres-isms.test.ts`
  - `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`
