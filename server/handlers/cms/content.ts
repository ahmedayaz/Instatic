/**
 * Structured-content endpoints — collections + entries.
 *
 *   GET    /admin/api/cms/content/collections           — list collections (gated by `content.edit`)
 *   POST   /admin/api/cms/content/collections           — create a collection
 *   PATCH  /admin/api/cms/content/collections/:id       — partial update; rejects empty patches
 *   DELETE /admin/api/cms/content/collections/:id       — soft delete
 *
 *   GET    /admin/api/cms/content/collections/:id/entries — list entries in a collection
 *   POST   /admin/api/cms/content/collections/:id/entries — create a draft entry
 *
 *   GET    /admin/api/cms/content/entries/:id            — read a single entry
 *   PUT    /admin/api/cms/content/entries/:id            — save the draft
 *   DELETE /admin/api/cms/content/entries/:id            — soft delete
 *   POST   /admin/api/cms/content/entries/:id/publish    — publish (gated by `content.publish`)
 *   PATCH  /admin/api/cms/content/entries/:id/status     — flip between draft/unpublished
 *   PATCH  /admin/api/cms/content/entries/:id/collection — move an entry to a new collection
 */
import type { DbClient } from '../../cms/db/client'
import { requireCapability } from '../../cms/authz'
import {
  createContentCollection,
  createContentEntry,
  getContentEntry,
  listContentCollections,
  listContentEntries,
  publishContentEntry,
  saveContentEntryDraft,
  softDeleteContentCollection,
  softDeleteContentEntry,
  updateContentCollection,
  updateContentEntryCollection,
  updateContentEntryStatus,
} from '../../cms/contentRepository'
import { normalizeContentCollectionFields } from '@core/content/fields'
import { slugFromTitle } from '@core/utils/slug'
import { badRequest, jsonResponse, methodNotAllowed, readJsonObject } from '../../http'
import { readNullableString, readString } from './shared'

export async function handleContentRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === '/admin/api/cms/content/collections') {
    const user = await requireCapability(req, db, 'content.edit')
    if (user instanceof Response) return user

    if (req.method === 'GET') {
      return jsonResponse({ collections: await listContentCollections(db) })
    }

    if (req.method === 'POST') {
      const body = await readJsonObject(req)
      const name = readString(body, 'name')
      if (!name) return badRequest('Collection name is required')

      const singularLabel = readString(body, 'singularLabel') || name.replace(/s$/i, '') || name
      const pluralLabel = readString(body, 'pluralLabel') || name
      const slug = slugFromTitle(readString(body, 'slug') || pluralLabel)
      const routeBase = readString(body, 'routeBase') || slug
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
      return jsonResponse({ collection }, { status: 201 })
    }

    return methodNotAllowed()
  }

  const collectionItemMatch = url.pathname.match(/^\/admin\/api\/cms\/content\/collections\/([^/]+)$/)
  if (collectionItemMatch) {
    const user = await requireCapability(req, db, 'content.edit')
    if (user instanceof Response) return user

    const collectionId = decodeURIComponent(collectionItemMatch[1])
    if (req.method === 'PATCH') {
      const body = await readJsonObject(req)
      const update: Parameters<typeof updateContentCollection>[2] = {}

      if ('name' in body) {
        const name = readString(body, 'name')
        if (!name) return badRequest('Collection name is required')
        update.name = name
      }
      if ('slug' in body) {
        const slug = slugFromTitle(readString(body, 'slug'))
        if (!slug) return badRequest('Collection slug is required')
        update.slug = slug
      }
      if ('routeBase' in body) {
        const routeBase = readString(body, 'routeBase')
        if (!routeBase) return badRequest('Route base is required')
        update.routeBase = routeBase
      }
      if ('singularLabel' in body) {
        const singularLabel = readString(body, 'singularLabel')
        if (!singularLabel) return badRequest('Singular label is required')
        update.singularLabel = singularLabel
      }
      if ('pluralLabel' in body) {
        const pluralLabel = readString(body, 'pluralLabel')
        if (!pluralLabel) return badRequest('Plural label is required')
        update.pluralLabel = pluralLabel
      }
      if ('fields' in body) {
        update.fields = normalizeContentCollectionFields(body.fields)
      }
      if (Object.keys(update).length === 0) return badRequest('Collection update is required')
      update.updatedByUserId = user.id

      const collection = await updateContentCollection(db, collectionId, update)
      if (!collection) return jsonResponse({ error: 'Collection not found' }, { status: 404 })
      return jsonResponse({ collection })
    }

    if (req.method === 'DELETE') {
      const collection = await softDeleteContentCollection(db, collectionId, user.id)
      if (!collection) return jsonResponse({ error: 'Collection cannot be deleted' }, { status: 409 })
      return jsonResponse({ collection })
    }

    return methodNotAllowed()
  }

  const collectionEntriesMatch = url.pathname.match(/^\/admin\/api\/cms\/content\/collections\/([^/]+)\/entries$/)
  if (collectionEntriesMatch) {
    const user = await requireCapability(req, db, 'content.edit')
    if (user instanceof Response) return user

    const collectionId = decodeURIComponent(collectionEntriesMatch[1])
    if (req.method === 'GET') {
      return jsonResponse({ entries: await listContentEntries(db, collectionId) })
    }

    if (req.method === 'POST') {
      const body = await readJsonObject(req)
      const title = readString(body, 'title') || 'Untitled'
      const entry = await createContentEntry(db, {
        collectionId,
        title,
        slug: slugFromTitle(readString(body, 'slug') || title),
        bodyMarkdown: readString(body, 'bodyMarkdown'),
        featuredMediaId: readNullableString(body, 'featuredMediaId'),
        seoTitle: readString(body, 'seoTitle'),
        seoDescription: readString(body, 'seoDescription'),
      }, user.id)
      return jsonResponse({ entry }, { status: 201 })
    }

    return methodNotAllowed()
  }

  const contentEntryMatch = url.pathname.match(/^\/admin\/api\/cms\/content\/entries\/([^/]+)$/)
  if (contentEntryMatch) {
    const user = await requireCapability(req, db, 'content.edit')
    if (user instanceof Response) return user

    const entryId = decodeURIComponent(contentEntryMatch[1])
    if (req.method === 'GET') {
      const entry = await getContentEntry(db, entryId)
      if (!entry) return jsonResponse({ error: 'Content entry not found' }, { status: 404 })
      return jsonResponse({ entry })
    }

    if (req.method === 'PUT') {
      const body = await readJsonObject(req)
      const title = readString(body, 'title') || 'Untitled'
      const entry = await saveContentEntryDraft(db, entryId, {
        title,
        slug: slugFromTitle(readString(body, 'slug') || title),
        bodyMarkdown: readString(body, 'bodyMarkdown'),
        featuredMediaId: readNullableString(body, 'featuredMediaId'),
        seoTitle: readString(body, 'seoTitle'),
        seoDescription: readString(body, 'seoDescription'),
      }, user.id)
      if (!entry) return jsonResponse({ error: 'Content entry not found' }, { status: 404 })
      return jsonResponse({ entry })
    }

    if (req.method === 'DELETE') {
      const entry = await softDeleteContentEntry(db, entryId, user.id)
      if (!entry) return jsonResponse({ error: 'Content entry not found' }, { status: 404 })
      return jsonResponse({ entry })
    }

    return methodNotAllowed()
  }

  const publishContentEntryMatch = url.pathname.match(/^\/admin\/api\/cms\/content\/entries\/([^/]+)\/publish$/)
  if (publishContentEntryMatch) {
    const user = await requireCapability(req, db, 'content.publish')
    if (user instanceof Response) return user
    if (req.method !== 'POST') return methodNotAllowed()

    const entryId = decodeURIComponent(publishContentEntryMatch[1])
    return jsonResponse(await publishContentEntry(db, entryId, user.id))
  }

  const contentEntryStatusMatch = url.pathname.match(/^\/admin\/api\/cms\/content\/entries\/([^/]+)\/status$/)
  if (contentEntryStatusMatch) {
    const user = await requireCapability(req, db, 'content.edit')
    if (user instanceof Response) return user
    if (req.method !== 'PATCH') return methodNotAllowed()

    const body = await readJsonObject(req)
    const status = readString(body, 'status')
    if (status !== 'draft' && status !== 'unpublished') {
      return badRequest('Status must be draft or unpublished')
    }

    const entryId = decodeURIComponent(contentEntryStatusMatch[1])
    const entry = await updateContentEntryStatus(db, entryId, status, user.id)
    if (!entry) return jsonResponse({ error: 'Content entry not found' }, { status: 404 })
    return jsonResponse({ entry })
  }

  const contentEntryCollectionMatch = url.pathname.match(/^\/admin\/api\/cms\/content\/entries\/([^/]+)\/collection$/)
  if (contentEntryCollectionMatch) {
    const user = await requireCapability(req, db, 'content.edit')
    if (user instanceof Response) return user
    if (req.method !== 'PATCH') return methodNotAllowed()

    const body = await readJsonObject(req)
    const collectionId = readString(body, 'collectionId')
    if (!collectionId) return badRequest('Collection is required')

    const entryId = decodeURIComponent(contentEntryCollectionMatch[1])
    const result = await updateContentEntryCollection(db, entryId, collectionId, user.id)
    if (result.ok) return jsonResponse({ entry: result.entry })
    if (result.reason === 'slug_conflict') {
      return jsonResponse({ error: 'An entry with this slug already exists in the target collection' }, { status: 409 })
    }
    if (result.reason === 'collection_not_found') {
      return jsonResponse({ error: 'Collection not found' }, { status: 404 })
    }
    return jsonResponse({ error: 'Content entry not found' }, { status: 404 })
  }

  return null
}
