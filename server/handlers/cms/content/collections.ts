/**
 * Content-collection endpoints.
 *
 *   GET    /admin/api/cms/content/collections           — list collections
 *   POST   /admin/api/cms/content/collections           — create a collection (`content.manage`)
 *   PATCH  /admin/api/cms/content/collections/:id       — partial update (`content.manage`)
 *   DELETE /admin/api/cms/content/collections/:id       — soft delete (`content.manage`)
 *
 *   GET    /admin/api/cms/content/collections/:id/entries — list entries
 *   POST   /admin/api/cms/content/collections/:id/entries — create draft entry
 *
 * The `/collections/:id/entries` POST lives here (instead of in `entries.ts`)
 * because the URL is rooted under `/collections/...` and the handler reuses
 * collection route; `entries.ts` owns every other entry-keyed URL.
 *
 * `handleContentCollectionRoutes` is the dispatcher; one function below per
 * URL pattern owns its own method-routing, body-parsing, and audit emission.
 */
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import type { ContentCollection } from '@core/content/schemas'
import { createAuditEvent } from '../../../repositories/audit'
import {
  createContentCollection,
  createContentEntry,
  listContentCollections,
  listContentEntries,
  softDeleteContentCollection,
  updateContentCollection,
} from '../../../repositories/content'
import { normalizeContentCollectionFields } from '@core/content/fields'
import { slugFromTitle } from '@core/utils/slug'
import { badRequest, jsonResponse, methodNotAllowed } from '../../../http'
import { CMS_API_PREFIX, readValidatedBody, requestAuditContext } from '../shared'
import {
  CollectionCreateBodySchema,
  CollectionPatchBodySchema,
  EntryUpsertBodySchema,
  type CollectionPatchBody,
} from './schemas'
import { entryDraftFromBody } from './entries'
import {
  canSeeAllContent,
  requireContentAccess,
  requireContentCreator,
  requireContentManager,
} from './access'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCollectionPatch(
  body: CollectionPatchBody,
  actorUserId: string,
): Parameters<typeof updateContentCollection>[2] | { error: string } {
  const update: Parameters<typeof updateContentCollection>[2] = {}

  if (body.name !== undefined) {
    if (!body.name.trim()) return { error: 'Collection name is required' }
    update.name = body.name.trim()
  }
  if (body.slug !== undefined) {
    const slug = slugFromTitle(body.slug.trim())
    if (!slug) return { error: 'Collection slug is required' }
    update.slug = slug
  }
  if (body.routeBase !== undefined) {
    if (!body.routeBase.trim()) return { error: 'Route base is required' }
    update.routeBase = body.routeBase.trim()
  }
  if (body.singularLabel !== undefined) {
    if (!body.singularLabel.trim()) return { error: 'Singular label is required' }
    update.singularLabel = body.singularLabel.trim()
  }
  if (body.pluralLabel !== undefined) {
    if (!body.pluralLabel.trim()) return { error: 'Plural label is required' }
    update.pluralLabel = body.pluralLabel.trim()
  }
  if (body.fields !== undefined) {
    update.fields = normalizeContentCollectionFields(body.fields)
  }

  if (Object.keys(update).length === 0) return { error: 'Collection update is required' }
  update.updatedByUserId = actorUserId
  return update
}

type CollectionAuditAction =
  | 'content.collection.create'
  | 'content.collection.update'
  | 'content.collection.delete'

async function recordCollectionAuditEvent(
  db: DbClient,
  user: AuthUser,
  req: Request,
  action: CollectionAuditAction,
  collection: ContentCollection,
): Promise<void> {
  await createAuditEvent(db, {
    actorUserId: user.id,
    action,
    targetType: 'content_collection',
    targetId: collection.id,
    metadata: { slug: collection.slug },
    ...requestAuditContext(req),
  })
}

// ---------------------------------------------------------------------------
// Per-route handlers
// ---------------------------------------------------------------------------

async function handleCollectionsCollection(req: Request, db: DbClient): Promise<Response> {
  const user = req.method === 'GET'
    ? await requireContentAccess(req, db)
    : await requireContentManager(req, db)
  if (user instanceof Response) return user

  if (req.method === 'GET') {
    return jsonResponse({ collections: await listContentCollections(db) })
  }

  if (req.method === 'POST') {
    const body = await readValidatedBody(req, CollectionCreateBodySchema)
    if (!body) return badRequest('Invalid collection payload')

    const name = body.name.trim()
    if (!name) return badRequest('Collection name is required')

    const singularLabel = body.singularLabel?.trim() || name.replace(/s$/i, '') || name
    const pluralLabel = body.pluralLabel?.trim() || name
    const slug = slugFromTitle(body.slug?.trim() || pluralLabel)
    const routeBase = body.routeBase?.trim() || slug

    const collection = await createContentCollection(db, {
      name,
      slug,
      routeBase,
      singularLabel,
      pluralLabel,
      fields: normalizeContentCollectionFields(body.fields),
      createdByUserId: user.id,
      updatedByUserId: user.id,
    })
    await recordCollectionAuditEvent(db, user, req, 'content.collection.create', collection)
    return jsonResponse({ collection }, { status: 201 })
  }

  return methodNotAllowed()
}

async function handleCollectionItem(
  req: Request,
  db: DbClient,
  collectionId: string,
): Promise<Response> {
  const user = await requireContentManager(req, db)
  if (user instanceof Response) return user

  if (req.method === 'PATCH') {
    const body = await readValidatedBody(req, CollectionPatchBodySchema)
    if (!body) return badRequest('Invalid collection payload')

    const update = buildCollectionPatch(body, user.id)
    if ('error' in update) return badRequest(update.error)

    const collection = await updateContentCollection(db, collectionId, update)
    if (!collection) return jsonResponse({ error: 'Collection not found' }, { status: 404 })
    await recordCollectionAuditEvent(db, user, req, 'content.collection.update', collection)
    return jsonResponse({ collection })
  }

  if (req.method === 'DELETE') {
    const collection = await softDeleteContentCollection(db, collectionId, user.id)
    if (!collection) return jsonResponse({ error: 'Collection cannot be deleted' }, { status: 409 })
    await recordCollectionAuditEvent(db, user, req, 'content.collection.delete', collection)
    return jsonResponse({ collection })
  }

  return methodNotAllowed()
}

async function handleCollectionEntries(
  req: Request,
  db: DbClient,
  collectionId: string,
): Promise<Response> {
  const user = req.method === 'POST'
    ? await requireContentCreator(req, db)
    : await requireContentAccess(req, db)
  if (user instanceof Response) return user

  if (req.method === 'GET') {
    const visibility = canSeeAllContent(user) ? {} : { ownerUserId: user.id }
    return jsonResponse({ entries: await listContentEntries(db, collectionId, visibility) })
  }

  if (req.method === 'POST') {
    const body = await readValidatedBody(req, EntryUpsertBodySchema)
    if (!body) return badRequest('Invalid entry payload')

    const draft = entryDraftFromBody(body)
    const entry = await createContentEntry(db, { collectionId, ...draft }, user.id)
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'content.entry.create',
      targetType: 'content_entry',
      targetId: entry.id,
      metadata: { collectionId, slug: entry.slug },
      ...requestAuditContext(req),
    })
    return jsonResponse({ entry }, { status: 201 })
  }

  return methodNotAllowed()
}

// ---------------------------------------------------------------------------
// Route patterns
// ---------------------------------------------------------------------------

const COLLECTION_ITEM_PATTERN = /^\/admin\/api\/cms\/content\/collections\/([^/]+)$/
const COLLECTION_ENTRIES_PATTERN = /^\/admin\/api\/cms\/content\/collections\/([^/]+)\/entries$/

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleContentCollectionRoutes(
  req: Request,
  db: DbClient,
): Promise<Response | null> {
  const { pathname } = new URL(req.url)

  if (pathname === `${CMS_API_PREFIX}/content/collections`) {
    return handleCollectionsCollection(req, db)
  }

  // `/entries` sub-route must match before the bare `/collections/:id` so the
  // latter doesn't swallow `:id/entries` (regex `[^/]+` matches the whole tail).
  const entriesMatch = pathname.match(COLLECTION_ENTRIES_PATTERN)
  if (entriesMatch) {
    return handleCollectionEntries(req, db, decodeURIComponent(entriesMatch[1]))
  }

  const itemMatch = pathname.match(COLLECTION_ITEM_PATTERN)
  if (itemMatch) {
    return handleCollectionItem(req, db, decodeURIComponent(itemMatch[1]))
  }

  return null
}
