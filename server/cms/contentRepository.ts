import { nanoid } from 'nanoid'
import type { DbClient } from './db/client'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { normalizeContentCollectionFields } from '@core/content/fields'
import type { ContentCollectionFields } from '@core/content/schemas'

type ContentEntryStatus = 'draft' | 'published' | 'unpublished'

interface ContentCollection {
  id: string
  name: string
  slug: string
  routeBase: string
  singularLabel: string
  pluralLabel: string
  fields: ContentCollectionFields
  createdAt: string
  updatedAt: string
}

interface ContentEntry {
  id: string
  collectionId: string
  title: string
  slug: string
  status: ContentEntryStatus
  bodyMarkdown: string
  featuredMediaId: string | null
  seoTitle: string
  seoDescription: string
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  deletedAt: string | null
}

export interface PublishedContentEntry {
  id: string
  entryId: string
  collectionId: string
  collectionSlug: string
  collectionRouteBase: string
  versionNumber: number
  title: string
  slug: string
  bodyMarkdown: string
  featuredMediaId: string | null
  featuredMediaPath: string | null
  seoTitle: string
  seoDescription: string
  publishedAt: string
  createdAt: string
}

interface ContentEntryVersion {
  id: string
  entryId: string
  versionNumber: number
  title: string
  slug: string
  bodyMarkdown: string
  featuredMediaId: string | null
  seoTitle: string
  seoDescription: string
  publishedAt: string
  createdAt: string
}

interface CreateContentCollectionInput {
  id?: string
  name: string
  slug: string
  routeBase?: string
  singularLabel: string
  pluralLabel: string
  fields?: ContentCollectionFields
}

interface UpdateContentCollectionInput {
  name?: string
  slug?: string
  routeBase?: string
  singularLabel?: string
  pluralLabel?: string
  fields?: ContentCollectionFields
}

interface CreateContentEntryInput {
  id?: string
  collectionId: string
  title: string
  slug: string
  bodyMarkdown?: string
  featuredMediaId?: string | null
  seoTitle?: string
  seoDescription?: string
}

interface SaveContentEntryDraftInput {
  title: string
  slug: string
  bodyMarkdown: string
  featuredMediaId: string | null
  seoTitle: string
  seoDescription: string
}

interface ContentCollectionRow {
  id: string
  name: string
  slug: string
  route_base: string
  singular_label: string
  plural_label: string
  fields_json?: unknown
  created_at: Date | string
  updated_at: Date | string
}

interface ContentEntryRow {
  id: string
  collection_id: string
  title: string
  slug: string
  status: ContentEntryStatus
  body_markdown: string
  featured_media_id: string | null
  seo_title: string
  seo_description: string
  created_at: Date | string
  updated_at: Date | string
  published_at: Date | string | null
  deleted_at: Date | string | null
}

interface ContentEntryVersionRow {
  id: string
  entry_id: string
  version_number: number
  title: string
  slug: string
  body_markdown: string
  featured_media_id: string | null
  seo_title: string
  seo_description: string
  published_at: Date | string
  created_at: Date | string
}

interface PublishedContentEntryRow extends ContentEntryVersionRow {
  collection_id: string
  collection_slug: string
  collection_route_base: string
  featured_media_path: string | null
}

interface PreviousPublishedRouteRow {
  previous_slug: string
  previous_route_base: string
}

interface ContentEntryRedirectRow {
  id: string
  from_route_base: string
  from_slug: string
  target_route_base: string
  target_slug: string
}

export interface ContentEntryRedirect {
  id: string
  fromPath: string
  targetPath: string
}

export type UpdateContentEntryCollectionResult =
  | { ok: true; entry: ContentEntry }
  | { ok: false; reason: 'entry_not_found' | 'collection_not_found' | 'slug_conflict' }

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toNullableIsoString(value: Date | string | null): string | null {
  return value ? toIsoString(value) : null
}

function mapCollection(row: ContentCollectionRow): ContentCollection {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    routeBase: row.route_base ? normalizeRouteBase(row.route_base) : normalizeRouteBase(row.slug),
    singularLabel: row.singular_label,
    pluralLabel: row.plural_label,
    fields: normalizeContentCollectionFields(row.fields_json),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

function mapEntry(row: ContentEntryRow): ContentEntry {
  return {
    id: row.id,
    collectionId: row.collection_id,
    title: row.title,
    slug: row.slug,
    status: row.status,
    bodyMarkdown: row.body_markdown,
    featuredMediaId: row.featured_media_id,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    publishedAt: toNullableIsoString(row.published_at),
    deletedAt: toNullableIsoString(row.deleted_at),
  }
}

function mapVersion(row: ContentEntryVersionRow): ContentEntryVersion {
  return {
    id: row.id,
    entryId: row.entry_id,
    versionNumber: Number(row.version_number),
    title: row.title,
    slug: row.slug,
    bodyMarkdown: row.body_markdown,
    featuredMediaId: row.featured_media_id,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    publishedAt: toIsoString(row.published_at),
    createdAt: toIsoString(row.created_at),
  }
}

function mapPublishedEntry(row: PublishedContentEntryRow): PublishedContentEntry {
  return {
    ...mapVersion(row),
    collectionId: row.collection_id,
    collectionSlug: row.collection_slug,
    collectionRouteBase: row.collection_route_base
      ? normalizeRouteBase(row.collection_route_base)
      : normalizeRouteBase(row.collection_slug),
    featuredMediaPath: row.featured_media_path,
  }
}

function publicContentPath(routeBase: string, slug: string): string {
  const normalizedBase = normalizeRouteBase(routeBase)
  return `${normalizedBase === '/' ? '' : normalizedBase}/${slug}`
}

function mapRedirect(row: ContentEntryRedirectRow): ContentEntryRedirect | null {
  const fromPath = publicContentPath(row.from_route_base, row.from_slug)
  const targetPath = publicContentPath(row.target_route_base, row.target_slug)
  if (fromPath === targetPath) return null
  return {
    id: row.id,
    fromPath,
    targetPath,
  }
}

export async function listContentCollections(db: DbClient): Promise<ContentCollection[]> {
  const { rows } = await db<ContentCollectionRow>`
    select id, name, slug, route_base, singular_label, plural_label, fields_json, created_at, updated_at
    from content_collections
    where deleted_at is null
    order by created_at asc
  `
  return rows.map(mapCollection)
}

export async function createContentCollection(
  db: DbClient,
  input: CreateContentCollectionInput,
): Promise<ContentCollection> {
  const fields = normalizeContentCollectionFields(input.fields)
  const { rows } = await db<ContentCollectionRow>`
    insert into content_collections (id, name, slug, route_base, singular_label, plural_label, fields_json)
    values (
      ${input.id ?? nanoid()},
      ${input.name},
      ${input.slug},
      ${normalizeRouteBase(input.routeBase ?? input.slug)},
      ${input.singularLabel},
      ${input.pluralLabel},
      ${fields}
    )
    returning id, name, slug, route_base, singular_label, plural_label, fields_json, created_at, updated_at
  `
  return mapCollection(rows[0])
}

export async function updateContentCollection(
  db: DbClient,
  collectionId: string,
  input: UpdateContentCollectionInput,
): Promise<ContentCollection | null> {
  const fields = input.fields === undefined ? null : normalizeContentCollectionFields(input.fields)
  const routeBase = input.routeBase === undefined ? null : normalizeRouteBase(input.routeBase)
  const { rows } = await db<ContentCollectionRow>`
    update content_collections
    set name = coalesce(${input.name ?? null}, name),
        slug = coalesce(${input.slug ?? null}, slug),
        route_base = coalesce(${routeBase}, route_base),
        singular_label = coalesce(${input.singularLabel ?? null}, singular_label),
        plural_label = coalesce(${input.pluralLabel ?? null}, plural_label),
        fields_json = coalesce(${fields}, fields_json),
        updated_at = current_timestamp
    where id = ${collectionId}
      and deleted_at is null
    returning id, name, slug, route_base, singular_label, plural_label, fields_json, created_at, updated_at
  `
  return rows[0] ? mapCollection(rows[0]) : null
}

export async function softDeleteContentCollection(
  db: DbClient,
  collectionId: string,
): Promise<ContentCollection | null> {
  if (collectionId === 'posts') return null

  const { rows: countRows } = await db<{ count: number }>`
    select count(*) as count
    from content_entries
    where collection_id = ${collectionId}
      and deleted_at is null
  `
  if (Number(countRows[0]?.count ?? 0) > 0) return null

  const { rows } = await db<ContentCollectionRow>`
    update content_collections
    set deleted_at = current_timestamp, updated_at = current_timestamp
    where id = ${collectionId}
      and deleted_at is null
    returning id, name, slug, route_base, singular_label, plural_label, fields_json, created_at, updated_at
  `
  return rows[0] ? mapCollection(rows[0]) : null
}

export async function listContentEntries(
  db: DbClient,
  collectionId: string,
): Promise<ContentEntry[]> {
  const { rows } = await db<ContentEntryRow>`
    select id, collection_id, title, slug, status, body_markdown, featured_media_id,
           seo_title, seo_description, created_at, updated_at, published_at, deleted_at
    from content_entries
    where collection_id = ${collectionId}
      and deleted_at is null
    order by updated_at desc, created_at desc
  `
  return rows.map(mapEntry)
}

export async function getContentEntry(
  db: DbClient,
  entryId: string,
): Promise<ContentEntry | null> {
  const { rows } = await db<ContentEntryRow>`
    select id, collection_id, title, slug, status, body_markdown, featured_media_id,
           seo_title, seo_description, created_at, updated_at, published_at, deleted_at
    from content_entries
    where id = ${entryId}
      and deleted_at is null
    limit 1
  `
  return rows[0] ? mapEntry(rows[0]) : null
}

export async function createContentEntry(
  db: DbClient,
  input: CreateContentEntryInput,
): Promise<ContentEntry> {
  const { rows } = await db<ContentEntryRow>`
    insert into content_entries (id, collection_id, title, slug, status, body_markdown, featured_media_id, seo_title, seo_description)
    values (
      ${input.id ?? nanoid()},
      ${input.collectionId},
      ${input.title},
      ${input.slug},
      ${'draft'},
      ${input.bodyMarkdown ?? ''},
      ${input.featuredMediaId ?? null},
      ${input.seoTitle ?? ''},
      ${input.seoDescription ?? ''}
    )
    returning id, collection_id, title, slug, status, body_markdown, featured_media_id,
              seo_title, seo_description, created_at, updated_at, published_at, deleted_at
  `
  return mapEntry(rows[0])
}

export async function saveContentEntryDraft(
  db: DbClient,
  entryId: string,
  input: SaveContentEntryDraftInput,
): Promise<ContentEntry | null> {
  const { rows } = await db<ContentEntryRow>`
    update content_entries
    set title = ${input.title},
        slug = ${input.slug},
        body_markdown = ${input.bodyMarkdown},
        featured_media_id = ${input.featuredMediaId},
        seo_title = ${input.seoTitle},
        seo_description = ${input.seoDescription},
        updated_at = current_timestamp
    where id = ${entryId}
      and deleted_at is null
    returning id, collection_id, title, slug, status, body_markdown, featured_media_id,
              seo_title, seo_description, created_at, updated_at, published_at, deleted_at
  `
  return rows[0] ? mapEntry(rows[0]) : null
}

export async function softDeleteContentEntry(
  db: DbClient,
  entryId: string,
): Promise<ContentEntry | null> {
  const { rows } = await db<ContentEntryRow>`
    update content_entries
    set deleted_at = current_timestamp, updated_at = current_timestamp
    where id = ${entryId}
      and deleted_at is null
    returning id, collection_id, title, slug, status, body_markdown, featured_media_id,
              seo_title, seo_description, created_at, updated_at, published_at, deleted_at
  `
  return rows[0] ? mapEntry(rows[0]) : null
}

export async function updateContentEntryCollection(
  db: DbClient,
  entryId: string,
  collectionId: string,
): Promise<UpdateContentEntryCollectionResult> {
  const entry = await getContentEntry(db, entryId)
  if (!entry) return { ok: false, reason: 'entry_not_found' }
  if (entry.collectionId === collectionId) return { ok: true, entry }

  const { rows: collectionRows } = await db<{ id: string }>`
    select id from content_collections
    where id = ${collectionId}
      and deleted_at is null
    limit 1
  `
  if (!collectionRows[0]) return { ok: false, reason: 'collection_not_found' }

  const { rows: conflictRows } = await db<{ id: string }>`
    select id from content_entries
    where collection_id = ${collectionId}
      and slug = ${entry.slug}
      and id <> ${entryId}
      and deleted_at is null
    limit 1
  `
  if (conflictRows[0]) return { ok: false, reason: 'slug_conflict' }

  const { rows } = await db<ContentEntryRow>`
    update content_entries
    set collection_id = ${collectionId},
        updated_at = current_timestamp
    where id = ${entryId}
      and deleted_at is null
    returning id, collection_id, title, slug, status, body_markdown, featured_media_id,
              seo_title, seo_description, created_at, updated_at, published_at, deleted_at
  `
  if (!rows[0]) return { ok: false, reason: 'entry_not_found' }
  return { ok: true, entry: mapEntry(rows[0]) }
}

export async function updateContentEntryStatus(
  db: DbClient,
  entryId: string,
  status: Exclude<ContentEntryStatus, 'published'>,
): Promise<ContentEntry | null> {
  const { rows } = await db<ContentEntryRow>`
    update content_entries
    set status = ${status},
        published_at = null,
        updated_at = current_timestamp
    where id = ${entryId}
      and deleted_at is null
    returning id, collection_id, title, slug, status, body_markdown, featured_media_id,
              seo_title, seo_description, created_at, updated_at, published_at, deleted_at
  `
  return rows[0] ? mapEntry(rows[0]) : null
}

export async function publishContentEntry(
  db: DbClient,
  entryId: string,
  _adminUserId: string,
): Promise<{ entry: ContentEntry; version: ContentEntryVersion }> {
  return db.transaction(async (tx) => {
    const entry = await getContentEntry(tx, entryId)
    if (!entry) throw new Error('content entry not found')

    const { rows: previousRouteRows } = await tx<PreviousPublishedRouteRow>`
      select content_entry_versions.slug as previous_slug,
             coalesce(nullif(content_collections.route_base, ''), '/' || content_collections.slug) as previous_route_base
      from content_entries
      join content_collections on content_collections.id = content_entries.collection_id
      join content_entry_versions on content_entry_versions.id = content_entries.active_version_id
      where content_entries.id = ${entryId}
        and content_entries.deleted_at is null
        and content_collections.deleted_at is null
      limit 1
    `

    const { rows: versionRows } = await tx<{ next_version: number }>`
      select coalesce(max(version_number), 0) + 1 as next_version
      from content_entry_versions
      where entry_id = ${entryId}
    `
    const versionNumber = Number(versionRows[0]?.next_version ?? 1)
    const versionId = nanoid()

    await tx`
      insert into content_entry_versions
        (id, entry_id, version_number, title, slug, body_markdown, featured_media_id, seo_title, seo_description)
      values (
        ${versionId},
        ${entry.id},
        ${versionNumber},
        ${entry.title},
        ${entry.slug},
        ${entry.bodyMarkdown},
        ${entry.featuredMediaId},
        ${entry.seoTitle},
        ${entry.seoDescription}
      )
    `

    const { rows: updateRows } = await tx<ContentEntryRow>`
      update content_entries
      set status = 'published',
          active_version_id = ${versionId},
          published_at = current_timestamp,
          updated_at = current_timestamp
      where id = ${entry.id}
        and deleted_at is null
      returning id, collection_id, title, slug, status, body_markdown, featured_media_id,
                seo_title, seo_description, created_at, updated_at, published_at, deleted_at
    `

    const previousRoute = previousRouteRows[0]
    if (
      previousRoute?.previous_slug &&
      publicContentPath(previousRoute.previous_route_base, previousRoute.previous_slug) !==
        publicContentPath(previousRoute.previous_route_base, entry.slug)
    ) {
      await tx`
        insert into content_entry_redirects (id, collection_id, from_route_base, from_slug, target_entry_id)
        values (
          ${nanoid()},
          ${entry.collectionId},
          ${normalizeRouteBase(previousRoute.previous_route_base)},
          ${previousRoute.previous_slug},
          ${entry.id}
        )
        on conflict (from_route_base, from_slug) do update
          set collection_id = excluded.collection_id,
              target_entry_id = excluded.target_entry_id
      `
    }

    const updatedRow = updateRows[0]
    return {
      entry: mapEntry(updatedRow),
      version: {
        id: versionId,
        entryId: entry.id,
        versionNumber,
        title: entry.title,
        slug: entry.slug,
        bodyMarkdown: entry.bodyMarkdown,
        featuredMediaId: entry.featuredMediaId,
        seoTitle: entry.seoTitle,
        seoDescription: entry.seoDescription,
        publishedAt: updatedRow?.published_at
          ? toIsoString(updatedRow.published_at)
          : new Date().toISOString(),
        createdAt: updatedRow?.published_at
          ? toIsoString(updatedRow.published_at)
          : new Date().toISOString(),
      },
    }
  })
}

export async function getPublishedContentEntryByRoute(
  db: DbClient,
  collectionRouteBase: string,
  entrySlug: string,
): Promise<PublishedContentEntry | null> {
  const { rows } = await db<PublishedContentEntryRow>`
    select content_entry_versions.id,
           content_entry_versions.entry_id,
           content_entries.collection_id,
           content_collections.slug as collection_slug,
           content_collections.route_base as collection_route_base,
           content_entry_versions.version_number,
           content_entry_versions.title,
           content_entry_versions.slug,
           content_entry_versions.body_markdown,
           content_entry_versions.featured_media_id,
           media_assets.public_path as featured_media_path,
           content_entry_versions.seo_title,
           content_entry_versions.seo_description,
           content_entry_versions.published_at,
           content_entry_versions.created_at
    from content_entries
    join content_collections on content_collections.id = content_entries.collection_id
    join content_entry_versions on content_entry_versions.id = content_entries.active_version_id
    left join media_assets on media_assets.id = content_entry_versions.featured_media_id
    where coalesce(nullif(content_collections.route_base, ''), '/' || content_collections.slug) = ${normalizeRouteBase(collectionRouteBase)}
      and content_entry_versions.slug = ${entrySlug}
      and content_entries.status = 'published'
      and content_entries.deleted_at is null
      and content_collections.deleted_at is null
    limit 1
  `
  return rows[0] ? mapPublishedEntry(rows[0]) : null
}

export async function getContentEntryRedirectByRoute(
  db: DbClient,
  collectionRouteBase: string,
  entrySlug: string,
): Promise<ContentEntryRedirect | null> {
  const { rows } = await db<ContentEntryRedirectRow>`
    select content_entry_redirects.id,
           content_entry_redirects.from_route_base,
           content_entry_redirects.from_slug,
           coalesce(nullif(target_collections.route_base, ''), '/' || target_collections.slug) as target_route_base,
           content_entry_versions.slug as target_slug
    from content_entry_redirects
    join content_entries target_entries on target_entries.id = content_entry_redirects.target_entry_id
    join content_collections target_collections on target_collections.id = target_entries.collection_id
    join content_entry_versions on content_entry_versions.id = target_entries.active_version_id
    where content_entry_redirects.from_route_base = ${normalizeRouteBase(collectionRouteBase)}
      and content_entry_redirects.from_slug = ${entrySlug}
      and target_entries.status = 'published'
      and target_entries.deleted_at is null
      and target_collections.deleted_at is null
    limit 1
  `
  return rows[0] ? mapRedirect(rows[0]) : null
}
