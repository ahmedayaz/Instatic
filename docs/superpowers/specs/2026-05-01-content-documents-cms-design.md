# Content Documents CMS Design

Date: 2026-05-01

## Purpose

Add the first real CMS content area to the self-hosted single-site CMS. The current editor remains the visual page builder for the site. The new Content section manages article-like content documents such as posts and future custom collections.

The goal is to complete an end-to-end content workflow: create content, edit it in a rich UI, save drafts, publish snapshots, and render published entries on public URLs.

## Decisions

- Admin is split into two primary sections: Site and Content.
- Site keeps the current page builder.
- Content uses the same admin chrome and design language, but it is a separate editing surface.
- Content entries are document-like, not mini page-builder pages.
- Markdown is the storage format for body content.
- The authoring UI is rich only. Users should not edit raw Markdown source in v1.
- Markdown shortcuts should autoformat while typing, for example `## Heading` becomes a heading visually.
- Content v1 supports collections, entries, drafts, publishing, and simple public rendering.
- Custom fields, dynamic template binding, roles, and collaborative editing are out of scope for this milestone.

## Routes

Admin routes:

- `/admin/site` mounts the existing page builder.
- `/admin/content` mounts the new content area.
- `/admin` redirects to `/admin/site`.

Public routes:

- `/posts/:slug` serves published entries from the default Posts collection.
- `/:collectionSlug/:slug` serves published entries from custom collections.
- Draft-only or unpublished entries return 404.
- Public rendering reads published snapshots only, never live drafts.

## Admin Architecture

Introduce a shared admin shell that can host both major sections.

Site section:

- Keeps the current editor layout, page-builder canvas, panels, toolbar, media library integration, save flow, and publish flow.

Content section:

- Reuses the visual language of the current editor.
- Does not reuse page-builder internals such as pan, zoom, arbitrary positioning, node trees, or selection overlays.
- Uses a focused document surface centered in the workspace.
- Uses fixed 100% scale with vertical scrolling only.

Content layout areas:

- Left rail: top-level admin section navigation, initially Site and Content, with Media and Settings possible later.
- Content sidebar: collections and entries.
- Center surface: rich document editor for title and body.
- Top document toolbar: insert heading, text, image, video, save, preview, publish.
- Right settings panel: slug, status, featured media, SEO title, SEO description, timestamps.

## Data Model

Add `content_collections`:

- `id`
- `name`
- `slug`
- `singular_label`
- `plural_label`
- `created_at`
- `updated_at`
- `deleted_at`

Add `content_entries`:

- `id`
- `collection_id`
- `title`
- `slug`
- `status`
- `body_markdown`
- `featured_media_id`
- `seo_title`
- `seo_description`
- `created_at`
- `updated_at`
- `published_at`
- `deleted_at`

Add `content_entry_versions`:

- `id`
- `entry_id`
- `version_number`
- `title`
- `slug`
- `body_markdown`
- `featured_media_id`
- `seo_title`
- `seo_description`
- `published_at`
- `created_at`

The migration should initialize a default Posts collection. Existing installations should get this collection automatically.

## Publishing Model

Draft saves update `content_entries`.

Publishing writes a snapshot to `content_entry_versions` and updates the entry publish metadata. Public routes use the latest published version.

This mirrors the current page-builder principle: draft changes are private until publish, and published output is stable across restarts.

## Editor Behavior

The editor presents a rich document surface while storing Markdown internally.

Required v1 behavior:

- Title field at the top.
- Rich body editor below the title.
- Markdown shortcuts autoformat in place.
- Toolbar can insert heading and text.
- Toolbar can open the existing media picker for images and videos.
- Inserted images and videos appear as rich previews in the document.
- Saved body content is serialized to Markdown.
- Preview uses the same Markdown rendering path as public output.
- Manual save and autosave update the draft.
- Publish writes the published snapshot.

The first implementation should choose a rich editor that supports Markdown serialization. A raw CodeMirror Markdown editor is not sufficient for the authoring surface, though it can remain useful elsewhere in the app.

## API Surface

Collections:

- List collections.
- Create collection.
- Update collection metadata.
- Delete collection by soft-deleting it.
- The default Posts collection cannot be deleted in v1.
- Collections with non-deleted entries cannot be deleted in v1.

Entries:

- List entries by collection.
- Create entry.
- Get entry.
- Save draft.
- Delete entry by setting `deleted_at`.
- Publish entry.

Rendering:

- Resolve public entry route.
- Load latest published version.
- Render title, featured media, body, and basic SEO metadata.

Media:

- Reuse the existing media library.
- Filter media picker results by image or video depending on insertion action.

## Non-Goals

This milestone does not include:

- Custom fields or schema builder.
- Dynamic data binding inside page templates.
- Visual template builder for collection detail pages.
- Team roles and permissions.
- Real-time collaborative editing.
- Raw Markdown source toggle.
- Page-builder modules inside content entries.

## Validation

Automated coverage should verify:

- Migration creates the default Posts collection.
- Collections can be created and listed.
- Entries can be created and saved as drafts.
- Publishing creates a version snapshot.
- Public routes serve published versions.
- Public routes do not serve draft-only entries.
- Public routes return 404 for unpublished entries.
- Public routes return 404 for soft-deleted entries.
- Saved and published content persists after server restart.
- `/admin/site` and `/admin/content` both load.

Manual validation should verify:

1. Open `/admin/content`.
2. Create a post.
3. Type rich content with Markdown shortcuts.
4. Insert image or video from the media library.
5. Save the draft.
6. Confirm the public URL is 404 before publish.
7. Publish the entry.
8. Confirm the public URL renders the entry.
9. Restart the dev server.
10. Confirm the entry and public URL still work.

## Implementation Order

1. Add database migrations and server-side content repositories.
2. Add content API handlers.
3. Add public content route rendering.
4. Add admin routing and shared shell split for Site and Content.
5. Add Content sidebar for collections and entries.
6. Add rich Markdown-backed editor.
7. Add media insertion.
8. Add draft save, publish, preview, and validation tests.
