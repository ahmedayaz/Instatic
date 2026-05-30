# Plugin schema extensions and custom field types

A plan to let plugins (1) add fields to existing CMS tables — including the system tables `pages`, `posts`, `components` — and (2) ship entirely new field-type kinds with their own cell editors. This completes the content-access story started in `2026-05-30-plugin-cms-content-access.md` by turning SEO / translation / e-commerce / structured-metadata plugins from "parallel admin pages linked by row id" into native edit-in-place workflows that look indistinguishable from first-party fields.

This is a plan, not a doc. It describes work that has not been built. When it ships, the lasting parts move into `docs/features/plugin-system.md` and `docs/features/content-storage.md`; this file is deleted.

---

## TL;DR

- **The gap.** Plugins today can declare their own private `resources` (plugin-scoped `data_rows` rows) but cannot add a column to the host's `pages`, `posts`, `components`, or any user-managed table. They also cannot ship a new field-type kind — the `DataField` union at `src/core/data/schemas.ts:224-240` is closed, the cell-editor switch at `src/admin/pages/data/components/DataGrid/cells/CellEditorRenderer.tsx:51-100` is exhaustively narrowed with a `never` check, and the field-list in the data-table editor is hard-wired to the 15 built-in types.
- **What works today.** The host's data model **already supports user-added custom fields on system tables** — `system: true` on `data_tables` only protects rename / delete (`server/repositories/data/tables.ts:286-315`), and the migrations explicitly note "Users can add custom fields to them" (`migrations-pg.ts:240`, `migrations-sqlite.ts:220`). The path exists; plugins just can't reach it.
- **The fix is two narrowly-scoped additions.** Part 1 — schema extensions: a manifest `schemaExtensions[]` array that the host applies to `data_tables.fields_json` at activate-time, marking each plugin-contributed field with `pluginId` ownership. Part 2 — custom field types: a `custom` variant on the closed `DataField` union plus a `manifest.fieldTypes[]` declaration + an editor-bundle entrypoint that ships the React cell/detail components.
- **Two new permissions, deliberately split.** `cms.schema.extend` (high) covers adding fields to existing tables using BUILT-IN types. `editor.fieldTypes.register` (high) covers shipping new field-type kinds. SEO Suite needs only the first; an e-commerce plugin adding a `money` field needs both. Splitting keeps the install-consent dialog honest.
- **Field id namespacing.** Every plugin-contributed field id is `<pluginId>.<fieldName>` (e.g. `acme.seo-suite.metaDescription`). The dot inside the id is allowed in `cells_json` keys but new validation rejects user-added ids that contain a dot — `metaDescription` is fine; `acme.foo` is not. No collision risk between user fields, plugin A's fields, and plugin B's fields.
- **Custom field type values are opaque to the host.** The host stores `cells_json[fieldId]` as whatever the plugin's `valueSchema` validates to. The host does NOT introspect those values for binding pickers, search indexers, or content extraction — the field type owns its data semantics end to end. (Built-in field types remain introspectable.)
- **Lifecycle is explicit.** `activate` upserts plugin-owned fields into `data_tables.fields_json`. `deactivate` marks them `hidden: true` (rows keep their values; UI hides them; binding pickers exclude them). `uninstall` requires operator confirmation when any row carries a non-null value in a plugin-owned field — uninstall is a delete, not a reversible action.
- **Bundled with the A.2 plan.** `api.cms.content.table('pages').update(id, { cells: { 'acme.seo-suite.metaDescription': '...' } })` works because the cell key is just a string in `cells_json`. No bridge changes; the plugin reads / writes its own field through the existing content API.
- **One PR.** Manifest extension + new permission entries + activate-time field upsert + cell editor switch extension + bundle externals for `editor/fieldTypes/*` + migration for the new `pluginId` + `hidden` columns on the field object + docs + the SEO suite plugin migrated as the canonical example. ~900 LOC added; ~150 LOC trimmed (sidecar code in seo-suite).

---

## Why this is a plan

Three specific things in the current system make this work worth doing now.

### 1. SEO Suite, Translator, E-commerce all need this and all hit the same wall

The `examples/plugins/seo-suite` plugin today (and any external SEO suite) stores `seoTitle` / `seoDescription` / `ogImage` in a plugin-private resource keyed by page id. Two consequences both visible to the operator:

- Editing meta tags happens on a SEPARATE admin page from editing the page. The author has to remember to update both.
- The plugin has no way to render its fields inline in the content authoring UI (`src/admin/pages/content/`) — the content form is built from the table's `fields[]` and the plugin can't add to it.

The A.2 content-access plan unblocks the **read** side of this (the plugin can fetch the page entry to do auto-fill), but not the **write-in-place** side (the operator still has two pages to update). Plugins like Translator (adds `translations[locale]` to existing entries) and E-commerce (adds `price`, `inventory`, `sku` to a `Product` table) hit the same wall.

### 2. The system-table machinery already supports custom fields

The migrations at `server/db/migrations-pg.ts:240` and `migrations-sqlite.ts:220` explicitly state:

> The three system tables (`pages`, `posts`, `components`) are seeded and locked from rename and delete (system = true). **Users can add custom fields to them.**

`softDeleteDataTable` (`server/repositories/data/tables.ts:286-315`) refuses to delete `system: true` tables. `buildPostTypeDefaultFields()` (`src/core/data/fields.ts:124-167`) seeds built-in fields with `builtIn: true`. `isPostTypeBuiltInFieldId` (`fields.ts:49-51`) flags those for special treatment in the field editor. The UI at `src/admin/pages/data/components/NewFieldDialog/` already lets a user add custom fields to a system table.

Plugin code can't reach any of this. There is no `cms.tables.write` SDK. The plugin's only options today are (a) sidecar storage as above, (b) trying to mutate `fields_json` via a custom route (which would corrupt the validation chain because there's no per-field `pluginId` stamp).

### 3. The cell-editor switch is closed and that's the right design — but with one new variant

`CellEditorRenderer` (`src/admin/pages/data/components/DataGrid/cells/CellEditorRenderer.tsx:44-103`) is an exhaustive switch over `DataField.type` with a `_exhaustive: never` check. The architecture test `binding-compatibility-coverage.test.ts` (referenced in `schemas.ts:250`) locks the field-type list end-to-end. Adding a new built-in type today means: schema + cell component + binding compat + display + grid + form + filter — every layer.

Plugins should NOT add new BUILT-IN types — that would break the exhaustivity gate. Instead, a single new variant `{ type: 'custom', fieldTypeId, ... }` is added to the union. The switch grows one case: `case 'custom': return <PluginFieldTypeMount fieldTypeId={field.fieldTypeId} ... />`. Inside the mount, the plugin's registered React component renders — but the host's switch stays exhaustive. **One escape hatch, well-typed, gated by permission.**

### What we leverage

| Concern | Lives in | Already does |
|---|---|---|
| `data_tables.fields_json` as the schema source of truth | `server/repositories/data/tables.ts:131`, `migrations-{pg,sqlite}.ts:200-240` | All field state lives here; `normalizeDataTableFields` runs on read |
| `system: true` flag on system tables | `data_tables.system` column + `softDeleteDataTable` refusal | Plugins inherit the rename / delete protection automatically |
| `builtIn: true` flag on built-in fields | `FieldCommonProps.builtIn` in `schemas.ts:88` + `isPostTypeBuiltInFieldId` in `fields.ts:49-51` | Pattern to mirror: a `pluginId` flag distinguishes plugin-owned from user / built-in |
| Cell editor switch | `CellEditorRenderer` at `src/admin/pages/data/components/DataGrid/cells/CellEditorRenderer.tsx:51-100` | Single dispatch point; adding one `custom` branch is all the UI surgery needed |
| Plugin editor entrypoint + bundle externals pattern | `src/core/plugin-sdk/cli/build.ts:69-77` (`HOST_RUNTIME_EXTERNALS`) | The exact mechanism used today for `editor.panels.register` and `editor.canvas.registerOverlay` — `react` + `@pagebuilder/host-ui` externalized at build time, resolved at runtime via the host's import map |
| Plugin host UI primitives + hooks | `src/admin/plugin-host-ui/` + `src/admin/plugin-host-hooks/` | Plugins get `Button`, `Stack`, `Card`, `Input`, `useEditorStore`, `usePluginSettings` — the cell components compile against this stable surface |
| Activate-time host upsert pattern | `pluginScheduleRegistration.ts:registerPluginSchedule` + the boot hook in `server/plugins/runtime.ts:activateInstalledServerPlugins` | The exact pattern for "plugin's `activate` causes the host to upsert a DB row" — schema extensions reuse it directly |
| Plugin manifest validation pipeline | `src/core/plugins/manifest.ts` | TypeBox-validated + dialect-naive — new manifest fields slot in cleanly |
| `api.cms.content.*` from the A.2 plan | `2026-05-30-plugin-cms-content-access.md` | Plugins read / write plugin-owned cells through the SAME content API. No special SDK surface required for the data-access side. |

The data model, the field validator, the cell-editor dispatch, the manifest pipeline, and the bundle externals system already exist. The plan adds (a) manifest fields and a permission pair, (b) ownership stamps on fields, (c) one `custom` variant on the union and one corresponding cell mount, (d) lifecycle wiring on activate / deactivate / uninstall.

---

## Goals and non-goals

### Goals

- Plugins declare schema extensions in their manifest, the host applies them on activation, and they appear in both the Data workspace's grid and the Content workspace's edit form.
- Plugin-owned fields are visually distinguishable from user / built-in fields (the field row in `FieldsSection.tsx` carries the plugin's icon + name; the cell label adds a small badge).
- Plugins ship new field-type kinds as React components in their editor bundle, externalising `react` / `@pagebuilder/host-ui` / `@pagebuilder/host-hooks`.
- Field id collisions are structurally impossible: plugin-owned ids are `<pluginId>.<name>`, user-added ids are pattern-restricted to NOT contain a dot, built-in ids are reserved string literals.
- `api.cms.content.*` from the A.2 plan reads / writes plugin-owned fields through the SAME cell-key path — no new content-access RPCs.
- Deactivate / uninstall lifecycle is explicit and operator-visible. Deactivate hides the fields without data loss; uninstall is a destructive action that requires confirmation if non-null cells exist.
- The SEO Suite plugin (`examples/plugins/seo-suite`) is migrated in the same change to use schema extensions for `seoTitle` / `seoDescription` / `ogImage` and to ship a custom `seoKeywords` chip-input field type. Its plugin-private `seo-entries` resource is deleted.

### Non-goals

- **Migration of existing plugin-private sidecar data into newly-extended fields.** Pre-release: there is no production data. The SEO Suite plugin's migration is a clean cut; the resource is deleted.
- **Cross-table field types** (e.g. a field type that aggregates across tables). The plan is per-cell — one field type renders one cell value.
- **Plugin-supplied SQL-level filters on plugin fields.** Filtering uses the existing `StorageFilterOperator` against the cell value as the host sees it (string / number / boolean / array). Field types that store complex values are filterable by their JSON path the same way other JSON cells are. No custom-SQL escape hatch.
- **Server-side rendering of cell display in the Data workspace grid.** The grid's `CellDisplayRenderer` is a React component running in the admin, same as the editor. There is no "publish-time bake" for cell display — that already lives in the page rendering path (Visual Components reading from cells).
- **Adding new MIME types or storage shapes for `media` cells.** Plugins can register a `custom` field type whose value is a media id, but they cannot extend the media storage adapter through this plan (that's the existing `media.storage.adapter` permission).
- **Per-locale schemas.** The Translator example uses a custom field type that opens its own locale-switcher UI inside one field's cell editor. A formal "this field has N locale variants" schema is a separate plan.
- **Backwards compatibility with hand-rolled sidecar storage.** Per `CLAUDE.md` pre-release rule — SEO Suite migrates fully; nothing wraps the old shape.

---

## The manifest surface

### Schema extensions

```jsonc
{
  "id": "acme.seo-suite",
  "version": "1.0.0",
  "apiVersion": 1,
  "permissions": ["cms.content.read", "cms.content.write", "cms.schema.extend"],

  "contentAccess": [
    { "table": "pages", "modes": ["read", "write"] }
  ],

  "schemaExtensions": [
    {
      "table": "pages",
      "fields": [
        {
          "id": "metaTitle",                           // → resolved as 'acme.seo-suite.metaTitle'
          "type": "text",
          "label": "Meta title",
          "description": "Used as <title>. Defaults to the page title.",
          "maxLength": 70,
          "section": "SEO",                            // groups related fields in the form UI
          "displayOrder": 100
        },
        {
          "id": "metaDescription",
          "type": "longText",
          "label": "Meta description",
          "maxLength": 160,
          "section": "SEO",
          "displayOrder": 101
        },
        {
          "id": "ogImage",
          "type": "media",
          "label": "OG image",
          "mediaKind": "image",
          "section": "SEO",
          "displayOrder": 102
        }
      ]
    }
  ]
}
```

Each field declares the same shape the host already accepts for user-added fields (the existing `DataField` discriminated union), plus three plugin-aware extras: `section` (string, optional — the host renders fields with the same `section` value as a labeled group in the Content workspace's form), `displayOrder` (number, optional — sort key inside a section; defaults to `Number.MAX_SAFE_INTEGER`), and the `id` (which the host expands to `<pluginId>.<id>` at validate time).

### Custom field types

```jsonc
{
  "permissions": ["editor.fieldTypes.register", "cms.schema.extend"],

  "fieldTypes": [
    {
      "id": "seoKeywords",                             // → 'acme.seo-suite.seoKeywords'
      "label": "SEO keywords",
      "description": "Multi-tag input for OG / Twitter meta keywords."
    }
  ],

  "entrypoints": {
    "editor": "editor/index.js"                       // registers the cell components
  },

  "schemaExtensions": [
    {
      "table": "pages",
      "fields": [
        {
          "id": "keywords",
          "type": "custom",
          "fieldTypeId": "acme.seo-suite.seoKeywords", // references the manifest entry
          "label": "Keywords",
          "section": "SEO",
          "displayOrder": 103
        }
      ]
    }
  ]
}
```

The manifest declares the field type's existence (label + description for the install consent dialog); the editor entrypoint provides the implementation via `api.editor.fieldTypes.register(...)` at activation time. The two halves must match — the host rejects activation if the entrypoint tries to register an id not declared in `manifest.fieldTypes[]`.

### Validation rules in `parsePluginManifest`

Enforced in `src/core/plugins/manifest.ts`:

1. `schemaExtensions` is allowed only when `cms.schema.extend` is in `permissions[]`.
2. `fieldTypes` is allowed only when `editor.fieldTypes.register` is in `permissions[]`.
3. Each `schemaExtensions[].table` matches the existing `MANIFEST_SLUG_PATTERN` and must appear in `contentAccess[]` with `write` mode.
4. Each field `id` matches the resource-field pattern (`/^[a-zA-Z_][a-zA-Z0-9_-]*$/`) and **must not contain a dot** — the host adds the `<pluginId>.` prefix at storage time.
5. Each field's `type` is either a built-in (`text`, `longText`, `richText`, `number`, `boolean`, `date`, `dateTime`, `select`, `multiSelect`, `url`, `email`, `media`, `relation`) or `custom`. Note: `pageTree` and `fieldSchema` are NOT permitted in plugin extensions in v1 — those types hold structural data the host owns end-to-end.
6. When `type === 'custom'`, `fieldTypeId` must match one of the plugin's own `fieldTypes[]` entries OR the registered id of another plugin that holds `editor.fieldTypes.register`. Cross-plugin field-type reuse is allowed; the dependent plugin declares `fieldTypeDependencies: ['vendor.product/typeName']` so the install consent dialog flags the dependency.
7. `relation` fields with a `targetTableSlug` that matches a built-in (`pages` / `posts` / `components`) or any user table are accepted; relation against a non-existent table is rejected at activation, not parse, because the operator may install plugins in any order.
8. No duplicate field ids within one extension. No duplicate `(table, fieldId)` pairs across multiple `schemaExtensions[]` entries.

The new field shape adds two host-managed runtime properties (NOT manifest-declarable) that flow through the schema:

```ts
interface PluginOwnedField extends DataField {
  pluginId: string         // owner; host-stamped at upsert
  hidden?: boolean         // true when the plugin is deactivated; UI hides; data preserved
}
```

---

## Permissions

Two new entries in `src/core/plugin-sdk/capabilities.ts`:

| Permission | Risk | Plugin can | Maps to (operator-visible label) |
|---|---|---|---|
| `cms.schema.extend` | high | Add fields to allowlisted tables using built-in types or custom types it (or a declared peer plugin) registered | "Add custom fields to your content tables" |
| `editor.fieldTypes.register` | high | Register new field-type kinds with their own React cell + detail components | "Add new field kinds to the editor's field library" |

Both added to `PLUGIN_PERMISSION_VALUES` (`src/core/plugin-sdk/types/permissions.ts`) and the `permissions` alias map (`src/core/plugin-sdk/builders/permissions.ts`) as `cmsSchemaExtend` and `editorFieldTypesRegister`.

The install consent dialog renders both permissions plus, for `cms.schema.extend`, an inline list of the actual extensions:

```
This plugin will add fields to your content:
  • Pages: "Meta title", "Meta description", "OG image", "Keywords" (4 new fields)
  • Posts: "Author bio" (1 new field)
```

…and for `editor.fieldTypes.register`:

```
This plugin will add new field kinds you can use:
  • SEO keywords — Multi-tag input for OG / Twitter meta keywords.
```

These render from the manifest fields directly — no plugin code runs during the consent screen.

---

## Schema additions on `data_tables.fields_json`

Two new properties on every field shape, host-managed (NOT manifest-declarable). Stored inside the JSON blob so no `data_tables` schema migration is needed:

```ts
// src/core/data/schemas.ts — added to FieldCommonProps
const FieldCommonProps = {
  id: Type.String(),
  label: Type.String(),
  required: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String()),
  builtIn: Type.Optional(Type.Boolean()),
  // NEW
  pluginId: Type.Optional(Type.String()),
  hidden: Type.Optional(Type.Boolean()),
  section: Type.Optional(Type.String()),
  displayOrder: Type.Optional(Type.Number()),
}
```

Plus one new field-type variant:

```ts
const CustomFieldSchema = Type.Object({
  type: Type.Literal('custom'),
  ...FieldCommonProps,
  /** Namespaced field-type id — `<pluginId>.<typeName>`. */
  fieldTypeId: Type.String(),
  /** Optional plugin-supplied per-instance config (e.g. min/max chips). Validated by the plugin, not the host. */
  config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

export const DataFieldSchema = Type.Union([
  // ... existing 15 variants ...
  CustomFieldSchema,
])
```

`normalizeDataTableFields` (`src/core/data/fields.ts:32-34`) already runs every field through `DataFieldSchema` on read via `filterArray`, so the new variant + properties are picked up automatically — including on existing rows when a plugin gets activated after the table was created.

---

## The editor SDK surface

### Field-type registration

Added to `EditorPluginApi` in `src/core/plugin-sdk/types/editorApi.ts`:

```ts
api.editor: {
  // ... existing commands / toolbar / panels / canvas / store / palette ...

  fieldTypes: {
    /**
     * Register a custom field-type kind. The id MUST match one of the plugin's
     * declared `manifest.fieldTypes[]` entries. Re-registration replaces the
     * previous components (normal on hot-reload during `pb-plugin dev`).
     *
     * Requires the `editor.fieldTypes.register` permission. The components
     * run in the admin's React tree — no QuickJS sandbox involved.
     */
    register: <TValue = unknown>(
      fieldTypeId: string,
      definition: PluginFieldTypeDefinition<TValue>,
    ) => void
  }
}
```

### `PluginFieldTypeDefinition`

```ts
export interface PluginFieldTypeDefinition<TValue> {
  /** Initial value for a fresh cell. The host calls this when creating new rows. */
  defaultValue: () => TValue

  /**
   * TypeBox schema for one cell value. Run at the persist boundary by the
   * host BEFORE writing to data_rows.cells_json. Mismatches throw a typed
   * `CustomFieldValueError` the content form catches and renders inline.
   */
  valueSchema: import('@sinclair/typebox').TSchema

  /** Cell editor for the Data workspace grid (compact, single-line). */
  cell: PluginFieldCellComponent<TValue>

  /** Detail editor for the Content workspace form + Data workspace inspector. */
  detail: PluginFieldDetailComponent<TValue>

  /**
   * Optional grid display renderer. Falls back to `String(value)` if omitted.
   * Used for read-only display in the data grid when not actively editing.
   */
  display?: PluginFieldDisplayComponent<TValue>

  /**
   * Optional filter-bar control. When omitted, the field is not filterable
   * in the data grid. Receives the current filter operator + emits new ones.
   */
  filter?: PluginFieldFilterComponent<TValue>
}

export interface PluginFieldCellProps<TValue> {
  field: { id: string; label: string; fieldTypeId: string; config?: Record<string, unknown> }
  value: TValue
  onChange: (next: TValue) => void
  onCommit?: () => void
  readOnly?: boolean
  rowId?: string
}
export type PluginFieldCellComponent<TValue> =
  import('react').ComponentType<PluginFieldCellProps<TValue>>

// detail / display / filter follow the same shape with React.ComponentType<...>.
```

The component props mirror the host's existing `CellEditorProps` (`src/admin/pages/data/types.ts:9-24`) so plugin code and host code share one mental model. The plugin's component renders inside a host-provided wrapper that supplies the section + label chrome; the plugin owns the value-editing UX inside the cell.

---

## Cell-editor switch — the one new branch

In `src/admin/pages/data/components/DataGrid/cells/CellEditorRenderer.tsx`, between the `pageTree` and `fieldSchema` cases:

```tsx
case 'custom':
  return (
    <PluginFieldTypeMount
      field={field}
      value={rest.value}
      onChange={rest.onChange}
      onCommit={rest.onCommit}
      readOnly={rest.readOnly}
      context={rest.context}
      rowId={rest.rowId}
      ariaLabel={rest.ariaLabel}
    />
  )
```

`PluginFieldTypeMount` is a new component at `src/admin/plugin-host-ui/PluginFieldTypeMount.tsx`:

```tsx
import { useMemo } from 'react'
import { usePluginFieldTypeRegistry } from '@admin/plugin-host-hooks'
import type { CellEditorProps } from '@admin/pages/data/types'

interface Props extends CellEditorProps {
  field: Extract<DataField, { type: 'custom' }>
}

export function PluginFieldTypeMount(props: Props) {
  const registry = usePluginFieldTypeRegistry()
  const def = registry.get(props.field.fieldTypeId)
  if (!def) {
    // Plugin not loaded / uninstalled while a row still has cells of this type.
    return <PluginFieldTypeMissing fieldTypeId={props.field.fieldTypeId} />
  }
  const Component = props.context === 'grid' ? def.cell : def.detail
  return (
    <Component
      field={{ id: props.field.id, label: props.field.label,
               fieldTypeId: props.field.fieldTypeId, config: props.field.config }}
      value={props.value as unknown}
      onChange={props.onChange}
      onCommit={props.onCommit}
      readOnly={props.readOnly}
      rowId={props.rowId}
    />
  )
}
```

The exhaustive `_exhaustive: never` check at line 100 stays — the new variant is now in the union, so the check still narrows correctly. The `binding-compatibility-coverage.test.ts` gate is updated in the same change to skip `custom` (custom fields are NOT introspectable for the binding picker — see [§11](#11-deferred-questions)).

The `PluginFieldTypeMissing` fallback renders a small inline error: "This field needs the *Acme SEO Suite* plugin. Re-install to edit." — derived from the field id's plugin namespace.

---

## Lifecycle wiring

### activate

In `server/plugins/runtime.ts:activateInstalledServerPlugins`, after the existing schedule and route registration:

```ts
if (plugin.manifest.schemaExtensions && plugin.manifest.schemaExtensions.length > 0) {
  await applySchemaExtensions(db, plugin)
}
```

`applySchemaExtensions` (new in `server/plugins/schemaExtensions.ts`):

1. For each `{ table, fields[] }`:
   - Resolve `table` slug → `data_tables.id`. Refuse if the table doesn't exist (deferred error: log + skip, keep activation going).
   - For each `field`:
     - Compute the namespaced id: `${plugin.id}.${field.id}`.
     - For `type: 'custom'`, validate `fieldTypeId` against the plugin's own `fieldTypes[]` OR another plugin's registered field types.
     - Read current `fields_json`, find an existing field with the same id + `pluginId === plugin.id` (update-in-place) or no match (append).
     - Stamp `pluginId: plugin.id`, clear `hidden`, preserve any user-edited display order overrides.
   - Write back via `updateDataTable(db, tableId, { fields: nextFields })`.
2. Emit `content.entry.schemaUpdated` event on the hook bus (the A.2 plan's hook surface) so other plugins / admin UIs can react to the new field list.

Idempotent on re-activation — `pluginId + fieldId` is the upsert key.

### deactivate

The mirror of activate. Each plugin-owned field is patched with `hidden: true`. UI lookups (`CellDisplayRenderer`, `RowDetail`, the binding picker) filter `hidden: true` out; reads via the A.2 content API skip them. Data in `cells_json[fieldId]` is preserved untouched.

### uninstall

The destructive case. The host runs a SELECT counting non-null cells across `data_rows` for each plugin-owned field:

```sql
-- pseudocode; built dialect-naive via JSON path
select count(*) from data_rows where deleted_at is null
  and table_id = $1 and (cells_json -> $2) is not null
```

If `count > 0` for ANY field, the uninstall flow surfaces an explicit confirmation dialog in the admin: "Removing *Acme SEO Suite* will permanently delete data in 4 fields across 327 rows. Continue?" — confirmed → field removed from `fields_json` AND the cell key deleted from each affected row in one transaction.

For zero-data plugins (or zero-data fields), uninstall is silent — fields and cell keys are removed without prompting.

---

## Worked examples

### 9.1 SEO Suite — three built-in fields + one custom field type

Manifest excerpt:

```jsonc
{
  "id": "acme.seo-suite",
  "permissions": [
    "cms.content.read", "cms.content.write",
    "cms.schema.extend", "editor.fieldTypes.register"
  ],
  "contentAccess": [{ "table": "pages", "modes": ["read", "write"] }],
  "schemaExtensions": [{
    "table": "pages",
    "fields": [
      { "id": "metaTitle",       "type": "text",     "label": "Meta title",       "section": "SEO", "displayOrder": 100, "maxLength": 70 },
      { "id": "metaDescription", "type": "longText", "label": "Meta description", "section": "SEO", "displayOrder": 101, "maxLength": 160 },
      { "id": "ogImage",         "type": "media",    "label": "OG image",         "section": "SEO", "displayOrder": 102, "mediaKind": "image" },
      { "id": "keywords",        "type": "custom",   "fieldTypeId": "acme.seo-suite.seoKeywords",
                                 "label": "Keywords","section": "SEO", "displayOrder": 103 }
    ]
  }],
  "fieldTypes": [{ "id": "seoKeywords", "label": "SEO keywords",
                   "description": "Multi-tag input for OG / Twitter meta keywords." }],
  "entrypoints": { "editor": "editor/index.js", "server": "server/index.js" }
}
```

The editor entrypoint registers the chip-input field type:

```tsx
// editor/index.js (TypeScript source: editor/fieldTypes/seoKeywords.tsx)
import { Type } from '@sinclair/typebox'
import { Input, Stack } from '@pagebuilder/host-ui'
import { useState } from 'react'

export default {
  async activate(api) {
    api.editor.fieldTypes.register('acme.seo-suite.seoKeywords', {
      defaultValue: () => [],
      valueSchema: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 20 }),
      cell: ({ value, onChange, readOnly }) => {
        const tags = (value as string[]) ?? []
        return <span>{tags.length ? `${tags.length} keywords` : 'No keywords'}</span>
      },
      detail: ({ value, onChange, readOnly }) => {
        const [draft, setDraft] = useState('')
        const tags = (value as string[]) ?? []
        return (
          <Stack gap={8}>
            <div>
              {tags.map((t, i) => (
                <button key={i} onClick={() => onChange(tags.filter((_, j) => j !== i))}>
                  {t} ×
                </button>
              ))}
            </div>
            <Input value={draft} onChange={setDraft} onCommit={() => {
              if (!draft.trim()) return
              onChange([...tags, draft.trim()])
              setDraft('')
            }} placeholder="Add keyword + Enter" />
          </Stack>
        )
      },
    })
  },
}
```

The server entrypoint auto-fills `metaDescription` from the page body — reusing the A.2 content-access plan:

```ts
// server/index.ts
export default {
  activate(api) {
    api.cms.hooks.on('content.entry.updated', async ({ tableSlug, entryId, changedFieldIds, actor }) => {
      if (tableSlug !== 'pages') return
      if (actor.kind === 'plugin' && actor.pluginId === api.plugin.id) return
      if (!changedFieldIds.includes('body')) return

      const entry = await api.cms.content.table('pages').get(entryId)
      const metaKey = 'acme.seo-suite.metaDescription'
      if (!entry || entry.cells[metaKey]) return

      const body = await api.cms.content.tree(entryId, 'body').read()
      const firstParagraph = findFirstTextNode(body)
      if (!firstParagraph) return
      await api.cms.content.table('pages').update(entryId, {
        cells: { [metaKey]: firstParagraph.slice(0, 160) },
      })
    })
  },
}
```

Result: the operator edits SEO fields **inline on the page form** under a "SEO" section header. Today's sidecar `seo-entries` resource is deleted; the auto-fill logic is one event listener.

### 9.2 E-commerce — a `Product` table with a custom `money` field

A new top-level user-managed table (created via the A.2 `tables.create`) carrying `name`, `description`, plus a `price` field of custom type `acme.shop.money`:

```jsonc
{
  "id": "acme.shop",
  "permissions": [
    "cms.content.read", "cms.content.write", "cms.content.tables.manage",
    "cms.schema.extend", "editor.fieldTypes.register"
  ],
  "contentAccess": [{ "table": "products", "modes": ["read", "write"] }],
  "fieldTypes": [
    { "id": "money", "label": "Money", "description": "Amount + currency selector." }
  ]
}
```

`activate` in `server/index.ts` calls `api.cms.content.tables.create({ slug: 'products', ... fields: [...] })` once, then plugin-owned fields stamp themselves on activation. The custom `money` cell stores `{ amount: 4990, currency: 'USD' }` and the editor renders an amount input + currency dropdown — value validated by the plugin's TypeBox `valueSchema`.

### 9.3 Translator — per-locale variants on `posts`

```jsonc
{
  "id": "acme.translator",
  "permissions": ["cms.content.read", "cms.content.write",
                  "cms.schema.extend", "editor.fieldTypes.register"],
  "contentAccess": [{ "table": "posts", "modes": ["read", "write"] }],
  "fieldTypes": [{ "id": "translations", "label": "Translations",
                   "description": "Per-locale variants of the post body." }],
  "schemaExtensions": [{
    "table": "posts",
    "fields": [{ "id": "translations", "type": "custom",
                 "fieldTypeId": "acme.translator.translations",
                 "label": "Translations", "section": "Translation" }]
  }]
}
```

The custom field's `detail` component opens a tabbed dialog with one tab per configured locale and a TipTap editor in each tab. Value shape: `Record<LocaleCode, { title: string; bodyJson: TipTapDoc }>`. The plugin's `valueSchema` validates the locale codes against the plugin's settings.

---

## Rollout plan — one change set

1. **Schema additions (NO migration needed).** Extend `FieldCommonProps` in `src/core/data/schemas.ts` with `pluginId`, `hidden`, `section`, `displayOrder`. Add `CustomFieldSchema` to the `DataFieldSchema` union. Update `DATA_FIELD_TYPES` const tuple to include `'custom'`. `normalizeDataTableFields` continues to filter via TypeBox.
2. **Permissions.** Extend `PLUGIN_PERMISSION_VALUES`, `PLUGIN_CAPABILITIES`, `permissions` builder alias with the two new entries.
3. **Manifest schema.** Add `schemaExtensions` and `fieldTypes` to `parsePluginManifest` in `src/core/plugins/manifest.ts` with the [§3 validation rules](#validation-rules-in-parsepluginmanifest).
4. **Activate-time host upsert.** New `server/plugins/schemaExtensions.ts`. Invoke from `runtime.ts:activateInstalledServerPlugins`. Idempotent on re-activation.
5. **Deactivate / uninstall hooks.** Mirror functions for hidden-marking and (with operator-confirmation) destructive cell-key removal. Wire from the same lifecycle path that handles schedules / routes today.
6. **Cell editor switch.** Add the `case 'custom':` branch in `src/admin/pages/data/components/DataGrid/cells/CellEditorRenderer.tsx`. Add `PluginFieldTypeMount` + `PluginFieldTypeMissing` in `src/admin/plugin-host-ui/`.
7. **Field-type registry.** New `usePluginFieldTypeRegistry()` hook in `src/admin/plugin-host-hooks/`. Backed by a Zustand slice (or a plain `Map` exposed via React Context) that the plugin editor entrypoint's activate populates.
8. **Editor SDK.** Add `api.editor.fieldTypes` surface in `src/core/plugin-sdk/types/editorApi.ts`. Add the `PluginFieldTypeDefinition` type + builder helpers (`defineFieldType<TValue>(...)`) in `src/core/plugin-sdk/builders/`.
9. **Bundle externals.** `HOST_RUNTIME_EXTERNALS` in `src/core/plugin-sdk/cli/build.ts:69-77` already covers `react` / `@pagebuilder/host-ui` / `@pagebuilder/host-hooks` for editor entrypoints — no change.
10. **Manifest install consent UI.** Extend the install dialog to render `schemaExtensions` and `fieldTypes` sections from the [Permissions](#permissions) example.
11. **Content workspace form layout.** Update the content form to honor `section` (grouped header) and `displayOrder` (sort key). One small change in the form-rendering component; reading is already from the table's `fields[]`.
12. **Binding-picker filter.** Plugin-owned custom-type fields are excluded from the page-builder binding picker because their values are opaque to the host. `buildMetaFields` in `src/core/data/fields.ts:64-96` gets one new branch: `if (field.type === 'custom') continue` — mirrors the existing `pageTree` / `fieldSchema` exclusion.
13. **SEO Suite migration.** Replace the `seo-entries` plugin-private resource with the four schema-extension fields. Delete the sidecar storage code. Add the keyword chip-input field type. Update the README. The plugin's `permissions` array gains `cms.schema.extend` + `editor.fieldTypes.register`.
14. **Docs.** Update `docs/features/plugin-system.md` with the new permission entries + a cookbook section. Add cross-references from `docs/features/content-storage.md`.
15. **CLI.** Add `bun pb-plugin init --kind=content-extender` scaffold that pre-declares `cms.schema.extend` + a `schemaExtensions[]` entry on `pages`. Add `--kind=field-type` for plugins shipping a new field type.

One PR. `bun test && bun run build && bun run lint` must pass.

---

## Gate tests

| Test | Change |
|---|---|
| `plugin-sandbox-invariants.test.ts` | No new RPC targets — field-type registration happens entirely in the editor's main React tree. (The QuickJS sandbox is uninvolved for UI extensions; that's already how `editor.panels` works.) |
| `plugin-cms-content-surface.test.ts` (from A.2 plan) | Add case: write to a plugin-owned cell key via `api.cms.content.table(...).update(...)` succeeds when the cell key matches an active extension; value validated against the plugin's `valueSchema`. |
| `binding-compatibility-coverage.test.ts` | Update: exclude `custom` from the field types the binding-picker enumerates. The new exhaustive check remains tight. |
| New: `plugin-schema-extension-isolation.test.ts` | Architecture test: every plugin-owned field has `pluginId` set; no field id outside of `<pluginId>.<...>` namespace carries a `pluginId` stamp. AST scan of `data_tables.fields_json` post-activate. |
| New: `plugin-field-id-namespace.test.ts` | User-added field ids must NOT contain a dot. Plugin-owned ids must contain exactly one dot at the start. (Enforced by `parsePluginManifest` + the user field add path.) |
| New: `plugin-field-type-registry-parity.test.ts` | For every `fieldTypeId` referenced by an active plugin's `schemaExtensions[]`, the registry has a definition registered AND the manifest declares it in `fieldTypes[]` (or a peer plugin does + the dependency is declared). |
| New: `plugin-schema-uninstall-confirmation.test.ts` | Uninstalling a plugin with non-null cells in any owned field requires explicit operator confirmation; the host's uninstall handler does not silently delete row data. |

---

## Deferred questions

These do not block the change.

1. **Field-type values in published HTML.** Custom field-type values are opaque to the host. If a plugin wants its custom-field data to appear on published pages (e.g. SEO Suite's `metaTitle` in `<title>`), the plugin's `publish.html` filter handler reads the field from `cells_json` and rewrites the HTML. Future: a structured `publish.head` filter (mentioned in the original analysis as Gap B.3) lets plugins return `<meta>` tags directly without parsing HTML. Out of scope here; references B.3.
2. **Renaming plugin-owned fields.** Today the operator cannot rename plugin-owned fields — the field is locked, the label is plugin-supplied. If a plugin ships v2 with a renamed field, it's a delete + add for that field (data loss). v2 could add a `migrations[]` array on the manifest similar to schedules, allowing rename + value-transform on plugin upgrade. Deferred.
3. **Cross-plugin custom field-type sharing.** §3.6 allows it via `fieldTypeDependencies`. v1 keeps this simple: the dependent plugin declares the dependency; the install fails if the providing plugin isn't installed and active. No version range, no fallbacks. Future: semver matching like npm peer-dependencies.
4. **Validating cells against `valueSchema` server-side.** The plugin's `valueSchema` is a TypeBox shape that lives in the editor bundle. The server doesn't load editor bundles. v1: the server treats custom-cell writes as opaque JSON (no validation); the editor enforces `valueSchema` on the client. Malicious client posts garbage → garbage in `cells_json` → plugin's display code shows fallback. Future: a server-side TypeBox-only file inside the plugin entrypoints (`server/fieldTypes/<typeName>.ts`) the host can load in the QuickJS worker for validation.
5. **Custom field types in plugin-private resources.** Today plugin-private `cms.storage` resources accept only a narrow `text`/`longText`/`number`/`date`/`boolean` field set (`PluginResourceFieldType` in `src/core/plugin-sdk/types/resources.ts:5`). Should they support custom field types too? Probably — but the validator path is different. Deferred to the next iteration.
6. **Performance of cell-by-cell custom rendering in the Data grid.** With 1000 rows × 5 custom fields the grid mounts 5000 React components. The host's existing grid is already React-virtualised. If profiling shows a slowdown, the registry can grow a `bulkCell` shape that renders many cells at once. Defer until measured.
7. **Filterable custom fields.** §5 defines an optional `filter` component. If a plugin omits it, the field is non-filterable in the grid. Future: a JSON-path filter helper for plugins that store structured cells but want indexable substring filters.
8. **Display in the Data workspace grid for non-loaded plugins.** If a plugin is deactivated but cells still carry its data, the grid shows `<PluginFieldTypeMissing>` placeholders. Could fall back to a raw JSON preview. v1 keeps the missing state explicit so operators don't lose track of which plugin owns which cells.

---

## Related

- `docs/features/plugin-system.md` — gains the two new permissions + cookbook entries when this ships
- `docs/features/content-storage.md` — gains the field-extension story + `pluginId` ownership stamp
- `docs/reference/typebox-patterns.md` — the `valueSchema` pattern is the same TypeBox-at-the-boundary policy
- `docs/plans/2026-05-30-plugin-cms-content-access.md` — sibling plan; this plan presupposes its `api.cms.content.*` surface for plugin-owned field reads / writes
- `docs/plans/2026-05-30-plugin-binary-streaming-io.md` — unrelated but referenced; SEO Suite plugins doing structured-data fetching may want it
- `docs/plans/2026-05-30-plugin-queue-and-jobs.md` — unrelated but referenced; bulk-extract or bulk-translate workflows in field-extending plugins compose with it
- `CLAUDE.md` — the "Resources / Storage / Fields" tour gains a sibling paragraph for plugin-owned fields
- Source-of-truth files (existing, modified or referenced):
  - `src/core/data/schemas.ts` — `DataField` union, `FieldCommonProps`, `DataTableSchema`
  - `src/core/data/fields.ts` — `normalizeDataTableFields`, `buildMetaFields`, `buildPostTypeDefaultFields`
  - `src/core/plugins/manifest.ts` — manifest parser
  - `src/core/plugin-sdk/capabilities.ts` — permission catalog
  - `src/core/plugin-sdk/types/editorApi.ts` — `EditorPluginApi`
  - `src/core/plugin-sdk/cli/build.ts:69-77` — bundle externals already covering editor entrypoints
  - `src/admin/pages/data/components/DataGrid/cells/CellEditorRenderer.tsx` — the dispatch switch
  - `src/admin/pages/data/components/DataGrid/cells/` — 15 existing cell components for reference
  - `src/admin/plugin-host-ui/` + `src/admin/plugin-host-hooks/` — where `PluginFieldTypeMount` + `usePluginFieldTypeRegistry` land
  - `server/repositories/data/tables.ts` — table CRUD and the `system: true` protection
  - `server/plugins/runtime.ts:activateInstalledServerPlugins` — where the new schema-extension upsert is wired
  - `examples/plugins/seo-suite/` — migration target + canonical example
- Gate tests (existing, updated, or added):
  - `src/__tests__/architecture/binding-compatibility-coverage.test.ts` (existing — gates the exhaustive type list)
  - `src/__tests__/architecture/plugin-cms-content-surface.test.ts` (from A.2 — extended)
  - `plugin-schema-extension-isolation.test.ts` (new)
  - `plugin-field-id-namespace.test.ts` (new)
  - `plugin-field-type-registry-parity.test.ts` (new)
  - `plugin-schema-uninstall-confirmation.test.ts` (new)
