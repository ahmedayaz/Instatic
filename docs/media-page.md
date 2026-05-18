# Media Page

A dedicated admin workspace for managing all media in the CMS — a HappyFiles-style file manager with folders, bulk operations, usage tracking, soft-delete, and an inspector. Built on the same canvas-style shell as the Site and Content workspaces, with floating draggable windows for the upload queue, asset inspector, and bulk-edit pane.

---

## Goals

1. **One first-class place to manage every file** — replace the dual-purpose `MediaExplorerPanel` (which today lives only as a docked panel inside the Content sidebar) with a real workspace.
2. **Beat HappyFiles on speed and clarity** — modal-free flows, keyboard navigation, real-time uploads, inspector that doesn't block browsing.
3. **Stay in the CMS architecture** — TypeBox schemas at every boundary, `media_assets`-style join tables, dual-dialect migrations (PG + SQLite), `media.manage` capability gating.
4. **Editor-quality UX** — reuse `AdminCanvasLayout`, the panel rail, `useDraggablePanel`, design tokens. No new layout primitives.

## Non-goals

- Image editing / cropping in-browser.
- Versioning history beyond "replace file" (binary swap keeps id and URL).
- CDN integration beyond the existing `/uploads/*` static handler.
- External cloud storage (S3 / R2) — local disk only, same as today.

---

## Architecture

### Route

`/admin/media` — registered in `src/admin/router.tsx`, gated by `media.manage`. Surfaced in `AdminSectionNavigation` between Content and Plugins.

`AdminWorkspace` (`src/admin/workspace.ts`) gains `'media'`. `canAccessWorkspace` and `workspacePath` get matching arms. `AdminCanvasLayout`'s `AdminCanvasWorkspace` extracts `'site' | 'content' | 'media'`.

### Layout

```
┌──────────────────────── Toolbar (z-60) ─────────────────────────────────┐
│ [Site] [Content] [Media▼] [Plugins] [Users] … [Upload] [Bulk ▾] [⚙][✦] │
├─────────┬──────────────────────────────────────┬────────────────────────┤
│ Rail    │  Canvas — files in current folder    │ Inspector (docked)     │
│ ┌──┐    │ ┌────┬────┬────┬────┬────┐           │ ┌────────────────────┐ │
│ │📁 │   │ │ ◻ │ ◻ │ ◻ │ ◻ │ ◻ │ … grid/list  │ │ Preview            │ │
│ │📁 │   │ └────┴────┴────┴────┴────┘           │ │ Filename ▢         │ │
│ │📁 │   │ FilterBar: type · folder · date · q  │ │ Alt text ▢         │ │
│ │🗑️ │   │                                      │ │ Folders ⊕          │ │
│ └──┘    │                                      │ │ Used on (3 pages)  │ │
│ Folders │                                      │ │ Copy URL · Replace │ │
│ tree    │                                      │ └────────────────────┘ │
└─────────┴──────────────────────────────────────┴────────────────────────┘

Floating draggable windows (overlays, z-50):
   ┌──────────────────────┐    ┌──────────────────────────────┐
   │ ⬆ Upload queue       │    │ 🔍 Asset Inspector (detached) │
   │ 5 of 12 — 42 MB/s    │    │ image.png — bag of metadata  │
   └──────────────────────┘    └──────────────────────────────┘

   ┌──────────────────────────────────────────────┐
   │ ✏ Bulk edit · 14 selected                    │
   │ Alt text [____] · Folder [Marketing ▾] · …   │
   └──────────────────────────────────────────────┘
```

### Module layout

```
src/admin/pages/media/
├── MediaPage.tsx                       — top-level component, wires AdminCanvasLayout
├── MediaPage.module.css
├── components/
│   ├── MediaSidebar/                   — folder tree + smart folders + trash
│   ├── MediaCanvas/                    — file grid/list with FilterBar
│   ├── MediaInspector/                 — docked asset details
│   ├── MediaToolbar/                   — toolbar right-slot actions (upload, bulk)
│   ├── floating/
│   │   ├── UploadQueueWindow/          — useDraggablePanel('mediaUploadQueue')
│   │   ├── DetachedInspector/          — useDraggablePanel('mediaInspector')
│   │   └── BulkEditWindow/             — useDraggablePanel('mediaBulkEdit')
│   └── dialogs/
│       ├── ReplaceFileDialog/
│       ├── FolderCreateDialog/
│       └── DeleteConfirmDialog/        — reuse ConfirmDeleteDialog
├── hooks/
│   ├── useMediaWorkspace.ts            — orchestrates server state (folders, assets, filters)
│   ├── useMediaSelection.ts            — selection set + keyboard ranges
│   ├── useUploadQueue.ts               — XHR / fetch upload pipeline + progress events
│   └── useMediaUsage.ts                — fetches per-asset usage list lazily
└── utils/
    ├── filters.ts                      — type/date/folder filter predicates
    └── thumbnails.ts                   — public URL → thumb URL helpers
```

`@admin/pages/site/panels/MediaExplorerPanel/` is removed once the new page lands — the Content workspace will point its rail's "media" tab at the new full page (open in same tab or via a side-drawer that mounts a slim `MediaPicker` view sharing the same hooks). **No backward-compat shim.**

### State

A single Zustand-free, hook-driven state container — `useMediaWorkspace` (returns `{ folders, assets, selection, filter, upload, ... }`). The site editor's store doesn't grow new slices; the Media page is self-contained.

### Persistence

- `useEditorLayoutPersistence` already handles floating panel positions through `panelLayoutStorage.ts`. We extend `FloatingPanelId` with `'mediaInspector' | 'mediaUploadQueue' | 'mediaBulkEdit'` and the rest is free.
- View mode (grid / list / large thumbs), sort, and last-opened folder are stored in `localStorage` under `pb-media-page-v1`.
- Open floating windows survive reload via the same layout store (`open: boolean`).

---

## Data model

All names use the `*_json` suffix convention for JSON columns. Both `migrations-pg.ts` and `migrations-sqlite.ts` get parity entries — gated by `migration-parity.test.ts`.

### Extend `media_assets`

| Column            | Type (PG)        | Type (SQLite) | Notes                                                         |
|-------------------|------------------|---------------|---------------------------------------------------------------|
| `alt_text`        | `text`           | `text`        | Default `''`. Required for accessibility, exposed in inspector. |
| `caption`         | `text`           | `text`        | Optional.                                                     |
| `title`           | `text`           | `text`        | Optional, falls back to filename.                             |
| `tags_json`       | `jsonb`          | `text`        | `string[]`. Stored sorted, lowercase.                         |
| `width`           | `integer`        | `integer`     | Nullable, populated on upload from image metadata.            |
| `height`          | `integer`        | `integer`     | Nullable.                                                     |
| `duration_ms`     | `integer`        | `integer`     | Nullable, for video/audio.                                    |
| `dominant_color`  | `text`           | `text`        | Nullable, `#rrggbb`. Computed server-side on upload.          |
| `deleted_at`      | `timestamptz`    | `text`        | Nullable. Non-null = in Trash.                                |
| `replaced_at`     | `timestamptz`    | `text`        | Nullable. Set when binary is swapped via "Replace file".      |

### New table `media_folders`

```sql
create table if not exists media_folders (
  id text primary key,
  parent_id text references media_folders(id) on delete cascade,
  name text not null,
  slug text not null,
  sort_order integer not null default 0,
  created_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (parent_id, slug)
);
```

Slug is auto-generated from name; `parent_id` null = root folder. Uniqueness scoped per parent so users can have two "Logos" folders under different roots.

### New table `media_asset_folders` (many-to-many)

```sql
create table if not exists media_asset_folders (
  asset_id text not null references media_assets(id) on delete cascade,
  folder_id text not null references media_folders(id) on delete cascade,
  primary key (asset_id, folder_id)
);
create index if not exists media_asset_folders_folder_idx
  on media_asset_folders (folder_id);
```

Assets with no folder rows are surfaced as **Uncategorized**.

### New table `media_smart_folders`

```sql
create table if not exists media_smart_folders (
  id text primary key,
  name text not null,
  query_json jsonb not null,      -- text on SQLite
  created_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now()
);
```

`query_json` is a TypeBox-validated filter object — `{ types: ['image'], missingAlt: true, olderThanDays: 90, … }`. Smart folders run as queries at list time, not as materialized lists.

### New table `media_usage_refs`

Maintained by a publish-time hook. Lets the inspector show "Used on N pages" without scanning every page tree on each load.

```sql
create table if not exists media_usage_refs (
  asset_id text not null references media_assets(id) on delete cascade,
  ref_kind text not null,          -- 'page' | 'content-entry' | 'user-avatar' | 'plugin'
  ref_id text not null,
  ref_path text,                   -- e.g. node id, where in the doc
  computed_at timestamptz not null default now(),
  primary key (asset_id, ref_kind, ref_id, coalesce(ref_path, ''))
);
create index if not exists media_usage_refs_asset_idx
  on media_usage_refs (asset_id);
```

Refs are recomputed when:
- A page is published or saved.
- A content entry is saved.
- A user avatar is set.
- The user clicks "Rescan usage" in the inspector (manual refresh).

---

## Server endpoints

All gated by `media.manage` unless noted. New endpoints live in new files alongside the existing `media.ts` handler.

### Assets (extend `server/handlers/cms/media.ts`)

| Method | Path                                       | Body / Query                          | Returns                       |
|--------|--------------------------------------------|---------------------------------------|-------------------------------|
| GET    | `/admin/api/cms/media`                     | `?folder=&type=&q=&tag=&sort=&page=&pageSize=&trash=true` | `{ assets, total, page }`     |
| POST   | `/admin/api/cms/media`                     | multipart `file=`, optional `folderId=` | `{ asset }`                 |
| PATCH  | `/admin/api/cms/media/:id`                 | `{ filename?, alt_text?, caption?, title?, tags? }` | `{ asset }` |
| DELETE | `/admin/api/cms/media/:id`                 | —                                     | `{ ok: true }` (soft delete)  |
| POST   | `/admin/api/cms/media/:id/restore`         | —                                     | `{ asset }`                   |
| DELETE | `/admin/api/cms/media/:id?purge=true`      | —                                     | `{ ok: true }` (hard delete)  |
| POST   | `/admin/api/cms/media/:id/replace`         | multipart `file=`                     | `{ asset }` (id + URL unchanged) |
| POST   | `/admin/api/cms/media/:id/folders`         | `{ add?: string[], remove?: string[] }` | `{ asset }`                 |
| POST   | `/admin/api/cms/media/bulk`                | `{ ids: string[], op: 'delete' \| 'restore' \| 'move' \| 'tag', payload?: … }` | `{ updated, errors }` |
| GET    | `/admin/api/cms/media/:id/usage`           | —                                     | `{ refs: MediaUsageRef[] }`   |
| POST   | `/admin/api/cms/media/usage/rescan`        | `{ ids?: string[] }`                  | `{ scanned, found }`          |

### Folders (`server/handlers/cms/mediaFolders.ts`)

| Method | Path                                       | Body                                  | Returns           |
|--------|--------------------------------------------|---------------------------------------|-------------------|
| GET    | `/admin/api/cms/media/folders`             | —                                     | `{ folders }` (flat list — client builds tree) |
| POST   | `/admin/api/cms/media/folders`             | `{ name, parentId? }`                 | `{ folder }`      |
| PATCH  | `/admin/api/cms/media/folders/:id`         | `{ name?, parentId?, sortOrder? }`    | `{ folder }`      |
| DELETE | `/admin/api/cms/media/folders/:id`         | —                                     | `{ ok: true }` (assets unassigned, not deleted) |

### Smart folders (`server/handlers/cms/mediaSmartFolders.ts`)

| Method | Path                                                | Body                       |
|--------|-----------------------------------------------------|----------------------------|
| GET    | `/admin/api/cms/media/smart-folders`                | —                          |
| POST   | `/admin/api/cms/media/smart-folders`                | `{ name, query }`          |
| PATCH  | `/admin/api/cms/media/smart-folders/:id`            | `{ name?, query? }`        |
| DELETE | `/admin/api/cms/media/smart-folders/:id`            | —                          |

### Built-in smart folders (no DB row required)

The list endpoint always merges in:

- **All files** — no filter.
- **Recent uploads** — created within the last 7 days.
- **Unused** — zero entries in `media_usage_refs`.
- **Missing alt text** — images with empty `alt_text`.
- **Trash** — `deleted_at is not null`.

---

## Repositories

`server/repositories/media.ts` is extended (not duplicated) with:

- `listMediaAssets(db, filter)` — paginated, filter-aware.
- `softDeleteMediaAsset(db, id)` / `restoreMediaAsset(db, id)` / `purgeMediaAsset(db, id)`.
- `replaceMediaAssetBinary(db, id, newStoragePath, newSizeBytes, newMime)` — keeps `public_path` and `id` stable.
- `updateMediaAssetMetadata(db, id, patch)` — alt text, caption, title, tags.
- `assignAssetToFolders(db, assetId, { add, remove })`.
- `bulkOperation(db, ids, op, payload)` — wraps a transaction.

`server/repositories/mediaFolders.ts` — new repo.
`server/repositories/mediaUsage.ts` — new repo. Publish-time scanner lives in `server/publish/mediaUsageScan.ts` and is called from the existing publish pipeline.

---

## Client persistence module

`src/core/persistence/cmsMedia.ts` (already exists, lean) is extended with matching client functions: `listMediaFolders`, `createMediaFolder`, `updateMediaAssetMetadata`, `bulkUpdateMediaAssets`, `replaceMediaAssetFile`, `listMediaAssetUsage`, etc. All responses go through TypeBox schemas in `src/core/persistence/responseSchemas.ts`.

---

## UI specifics

### Folder tree (left sidebar)

- Reuses the existing `Tree` primitive from `src/editor/ui/Tree/` for keyboard nav / drag-to-reorder consistency.
- Drag a file from the canvas → tree row = assign to that folder (with `Alt` to set as primary / replace existing folder assignments).
- Drag a folder onto another folder = reparent.
- Inline rename, context menu (rename · new subfolder · delete).
- Smart folders rendered below regular folders in a separate group.

### Canvas

- Grid (default), list, large thumbs. Stored in `localStorage`.
- `FilterBar` for type (`all / image / video / audio / document / other`), date, tag, search.
- Sort: newest / oldest / largest / smallest / a–z / z–a.
- Keyboard: arrows traverse, `Shift+arrow` range-select, `Cmd/Ctrl+A` select all, `R` rename, `Del` trash, `M` move, `Enter` open inspector.
- Drag a file out of the canvas → onto folder tree / onto another browser tab (HTML5 drag for download).
- Thumbnails: existing `public_path` for images; for videos we use `<video preload="metadata">` as today; for docs we render a type icon.

### Inspector (docked + detachable)

- Preview at the top (image / video player / icon).
- Editable fields: filename, alt text, caption, title, tags.
- Read-only: MIME, size, dimensions, dominant color swatch, uploader, created date, replaced date.
- Folder chip list with `⊕` to add to more folders.
- **Replace file** — opens dialog, accepts a new file with same-or-different MIME, swaps binary, bumps `replaced_at`.
- **Usage list** — lazy-loaded; expands into a list of pages / entries / avatars that reference this asset, each a link to that resource.
- **Copy URL**, **Open in new tab**, **Download**.
- **Detach** button → closes docked inspector and opens `DetachedInspector` floating window for this asset.

### Floating windows (`useDraggablePanel`)

1. **Upload queue** — `mediaUploadQueue`. Persists across folder switches and even page navigations (mounted in the layout). Shows per-file progress, retry on failure, "Open in folder" link when done.
2. **Detached Asset Inspector** — `mediaInspector`. Multiple instances *not* supported in v1; opening a second asset reuses the same window (Cmd/Ctrl+click could open a new one in a future iteration). Identical content to the docked inspector.
3. **Bulk Edit** — `mediaBulkEdit`. Shown when `selection.size >= 2`. Lets the user batch-edit alt text (only if all selected are images), tags (add/remove), folders (add/remove), or delete. Closes on commit.

All three are gated by `media.manage` (since the whole page is). All three persist position + open state in `panelLayoutStorage`.

### Toolbar right-slot

- **Upload** primary button (also accepts drop anywhere on the page).
- **Bulk ▾** dropdown — visible when selection non-empty: Move to folder · Add tag · Trash · Restore (if in Trash) · Replace (single-select only).
- **View** group — grid / list / large.

---

## Publish-time usage indexing

Hooks into existing flow:

- `server/publish/index.ts` (or wherever a page is rendered to disk) gets a post-publish step that walks the page tree, collects every `prop.src` / `prop.videoUrl` / etc. that points at `/uploads/...`, resolves to `asset.id`, and replaces the asset's `media_usage_refs(ref_kind='page', ref_id=pageId)` rows transactionally.
- Content entry save triggers the same for `ref_kind='content-entry'`.
- Avatar update triggers `ref_kind='user-avatar'`.

Plugins can opt in by calling a yet-to-define SDK method `recordMediaUsage(refKind, refId, assetIds)` — out of scope for v1 of the Media page, but planned.

---

## Capability + access

- Existing `media.manage` capability remains the single gate.
- `AdminWorkspace = 'media'` is added; `canAccessWorkspace` checks `media.manage`; `firstAccessibleWorkspace` order extended to `[site, content, media, plugins, users]`.
- Plugin pages can link to `/admin/media` like any other workspace.

---

## Migration plan

One migration ID per change, parity across both dialects. IDs follow the existing numeric convention.

```
NNN_media_assets_metadata        — alt_text, caption, title, tags_json, width, height,
                                   duration_ms, dominant_color,
                                   deleted_at, replaced_at
NNN_media_folders                — create media_folders + media_asset_folders + indices
NNN_media_smart_folders          — create media_smart_folders
NNN_media_usage_refs             — create media_usage_refs + index
```

No data migration needed — existing assets get default empty metadata and live in "Uncategorized" until the user organizes them.

---

## Tests

- **Architecture gates**: extend `db-json-column-naming.test.ts` (already enforces `*_json`), `migration-parity.test.ts`, `no-router-in-editor.test.ts` (the new page is in `src/admin/`, not `src/editor/`, so it's fine to use the admin router).
- **Unit**: folder slug uniqueness, smart-folder query parsing, usage scanner.
- **Integration**: upload → list → tag → bulk-move → soft-delete → restore.
- **UI smoke**: render `MediaPage` with mock workspace, ensure grid + inspector + folder tree mount.
