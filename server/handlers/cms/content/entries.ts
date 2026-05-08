/**
 * Content-entry endpoints.
 *
 *   GET    /admin/api/cms/content/authors                — list assignable authors
 *   GET    /admin/api/cms/content/entries/:id            — read a single entry
 *   PUT    /admin/api/cms/content/entries/:id            — save the draft
 *   DELETE /admin/api/cms/content/entries/:id            — soft delete
 *   POST   /admin/api/cms/content/entries/:id/publish    — publish
 *   PATCH  /admin/api/cms/content/entries/:id/status     — flip between draft/unpublished
 *   PATCH  /admin/api/cms/content/entries/:id/author     — reassign the author
 *   PATCH  /admin/api/cms/content/entries/:id/collection — move an entry to a new collection
 *
 * `handleContentEntryRoutes` is the dispatcher; one function below per URL
 * pattern owns its own method-routing, body-parsing, and audit emission.
 */
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import type { ContentEntry } from '@core/content/schemas'
import { createAuditEvent } from '../../../repositories/audit'
import {
  getContentEntry,
  listContentAuthorOptions,
  publishContentEntry,
  saveContentEntryDraft,
  softDeleteContentEntry,
  updateContentEntryAuthor,
  updateContentEntryCollection,
  updateContentEntryStatus,
} from '../../../repositories/content'
import { findUserById } from '../../../repositories/users'
import { slugFromTitle } from '@core/utils/slug'
import { badRequest, jsonResponse, methodNotAllowed } from '../../../http'
import { CMS_API_PREFIX, readValidatedBody, requestAuditContext } from '../shared'
import {
  EntryAuthorBodySchema,
  EntryCollectionBodySchema,
  EntryStatusBodySchema,
  EntryUpsertBodySchema,
  type EntryUpsertBody,
} from './schemas'
import {
  canEditContentEntry,
  canPublishContentEntry,
  canReadContentEntry,
  forbidden,
  requireContentAccess,
  requireContentAuthorManager,
  requireContentEditor,
  requireContentPublisher,
} from './access'

interface EntryDraft {
  title: string
  slug: string
  bodyMarkdown: string
  featuredMediaId: string | null
  seoTitle: string
  seoDescription: string
}

/**
 * Normalize an EntryUpsert payload into the strict shape both
 * `createContentEntry` and `saveContentEntryDraft` expect. Empty / missing
 * `title` falls back to "Untitled" so a draft always has a usable label;
 * `slug` derives from `title` when not supplied so entries are addressable
 * the moment they're saved.
 */
export function entryDraftFromBody(body: EntryUpsertBody): EntryDraft {
  const title = body.title?.trim() || 'Untitled'
  return {
    title,
    slug: slugFromTitle(body.slug?.trim() || title),
    bodyMarkdown: body.bodyMarkdown ?? '',
    featuredMediaId: body.featuredMediaId ?? null,
    seoTitle: body.seoTitle ?? '',
    seoDescription: body.seoDescription ?? '',
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENTRY_NOT_FOUND_BODY = { error: 'Content entry not found' }

function entryNotFound(): Response {
  return jsonResponse(ENTRY_NOT_FOUND_BODY, { status: 404 })
}

type ContentEntryAuditAction =
  | 'content.entry.update'
  | 'content.entry.delete'
  | 'content.entry.status'
  | 'content.entry.move'
  | 'content.entry.publish'
  | 'content.author.assign'

/**
 * Audit-event envelope shared by every entry mutation: actor, action verb,
 * the entry's id as targetId, plus a small metadata payload (collectionId
 * + slug + caller-supplied extras). Caller passes the action verb and any
 * fields beyond the standard collectionId/slug.
 */
async function recordEntryAuditEvent(
  db: DbClient,
  user: AuthUser,
  req: Request,
  action: ContentEntryAuditAction,
  entry: ContentEntry,
  extraMetadata?: Record<string, unknown>,
): Promise<void> {
  await createAuditEvent(db, {
    actorUserId: user.id,
    action,
    targetType: 'content_entry',
    targetId: entry.id,
    metadata: {
      collectionId: entry.collectionId,
      slug: entry.slug,
      ...extraMetadata,
    },
    ...requestAuditContext(req),
  })
}

/**
 * Load an entry and run the caller's access check. Returns a Response on
 * 404 / forbidden so call sites can `if (entry instanceof Response) return entry`.
 */
async function loadEntryForAccess(
  db: DbClient,
  entryId: string,
  user: AuthUser,
  check: (user: AuthUser, entry: ContentEntry) => boolean,
): Promise<ContentEntry | Response> {
  const entry = await getContentEntry(db, entryId)
  if (!entry) return entryNotFound()
  if (!check(user, entry)) return forbidden()
  return entry
}

// ---------------------------------------------------------------------------
// Per-route handlers
// ---------------------------------------------------------------------------

async function handleListAuthors(req: Request, db: DbClient): Promise<Response> {
  const user = await requireContentAuthorManager(req, db)
  if (user instanceof Response) return user
  if (req.method !== 'GET') return methodNotAllowed()
  return jsonResponse({ authors: await listContentAuthorOptions(db) })
}

async function handleEntryItem(
  req: Request,
  db: DbClient,
  entryId: string,
): Promise<Response> {
  // GET reads (broader access); PUT and DELETE mutate (editor-only).
  const user =
    req.method === 'GET'
      ? await requireContentAccess(req, db)
      : await requireContentEditor(req, db)
  if (user instanceof Response) return user

  if (req.method === 'GET') {
    const entry = await loadEntryForAccess(db, entryId, user, canReadContentEntry)
    if (entry instanceof Response) return entry
    return jsonResponse({ entry })
  }

  if (req.method === 'PUT') {
    const currentEntry = await loadEntryForAccess(db, entryId, user, canEditContentEntry)
    if (currentEntry instanceof Response) return currentEntry

    const body = await readValidatedBody(req, EntryUpsertBodySchema)
    if (!body) return badRequest('Invalid entry payload')

    const entry = await saveContentEntryDraft(db, entryId, entryDraftFromBody(body), user.id)
    if (!entry) return entryNotFound()
    await recordEntryAuditEvent(db, user, req, 'content.entry.update', entry)
    return jsonResponse({ entry })
  }

  if (req.method === 'DELETE') {
    const currentEntry = await loadEntryForAccess(db, entryId, user, canEditContentEntry)
    if (currentEntry instanceof Response) return currentEntry

    const entry = await softDeleteContentEntry(db, entryId, user.id)
    if (!entry) return entryNotFound()
    await recordEntryAuditEvent(db, user, req, 'content.entry.delete', entry)
    return jsonResponse({ entry })
  }

  return methodNotAllowed()
}

async function handleEntryPublish(
  req: Request,
  db: DbClient,
  entryId: string,
): Promise<Response> {
  const user = await requireContentPublisher(req, db)
  if (user instanceof Response) return user
  if (req.method !== 'POST') return methodNotAllowed()

  const currentEntry = await loadEntryForAccess(db, entryId, user, canPublishContentEntry)
  if (currentEntry instanceof Response) return currentEntry

  const result = await publishContentEntry(db, entryId, user.id)
  await recordEntryAuditEvent(db, user, req, 'content.entry.publish', result.entry, {
    versionNumber: result.version.versionNumber,
  })
  return jsonResponse(result)
}

async function handleEntryStatus(
  req: Request,
  db: DbClient,
  entryId: string,
): Promise<Response> {
  const user = await requireContentEditor(req, db)
  if (user instanceof Response) return user
  if (req.method !== 'PATCH') return methodNotAllowed()

  const body = await readValidatedBody(req, EntryStatusBodySchema)
  if (!body) return badRequest('Status must be draft or unpublished')

  const currentEntry = await loadEntryForAccess(db, entryId, user, canEditContentEntry)
  if (currentEntry instanceof Response) return currentEntry

  const entry = await updateContentEntryStatus(db, entryId, body.status, user.id)
  if (!entry) return entryNotFound()
  await recordEntryAuditEvent(db, user, req, 'content.entry.status', entry, { status: body.status })
  return jsonResponse({ entry })
}

async function handleEntryAuthor(
  req: Request,
  db: DbClient,
  entryId: string,
): Promise<Response> {
  const user = await requireContentAuthorManager(req, db)
  if (user instanceof Response) return user
  if (req.method !== 'PATCH') return methodNotAllowed()

  const body = await readValidatedBody(req, EntryAuthorBodySchema)
  if (!body || !body.authorUserId.trim()) return badRequest('Author is required')

  const author = await findUserById(db, body.authorUserId)
  if (!author || author.status !== 'active') return badRequest('Author must be an active user')

  const currentEntry = await getContentEntry(db, entryId)
  if (!currentEntry) return entryNotFound()

  const entry = await updateContentEntryAuthor(db, entryId, body.authorUserId, user.id)
  if (!entry) return entryNotFound()

  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'content.author.assign',
    targetType: 'content_entry',
    targetId: entry.id,
    metadata: {
      previousAuthorUserId: currentEntry.authorUserId,
      authorUserId: body.authorUserId,
    },
    ...requestAuditContext(req),
  })
  return jsonResponse({ entry })
}

async function handleEntryCollection(
  req: Request,
  db: DbClient,
  entryId: string,
): Promise<Response> {
  const user = await requireContentEditor(req, db)
  if (user instanceof Response) return user
  if (req.method !== 'PATCH') return methodNotAllowed()

  const body = await readValidatedBody(req, EntryCollectionBodySchema)
  if (!body || !body.collectionId.trim()) return badRequest('Collection is required')

  const currentEntry = await loadEntryForAccess(db, entryId, user, canEditContentEntry)
  if (currentEntry instanceof Response) return currentEntry

  const result = await updateContentEntryCollection(db, entryId, body.collectionId, user.id)
  if (result.ok) {
    await recordEntryAuditEvent(db, user, req, 'content.entry.move', result.entry)
    return jsonResponse({ entry: result.entry })
  }
  if (result.reason === 'slug_conflict') {
    return jsonResponse(
      { error: 'An entry with this slug already exists in the target collection' },
      { status: 409 },
    )
  }
  if (result.reason === 'collection_not_found') {
    return jsonResponse({ error: 'Collection not found' }, { status: 404 })
  }
  return entryNotFound()
}

// ---------------------------------------------------------------------------
// Route patterns
// ---------------------------------------------------------------------------

const ENTRY_PUBLISH_PATTERN = /^\/admin\/api\/cms\/content\/entries\/([^/]+)\/publish$/
const ENTRY_STATUS_PATTERN = /^\/admin\/api\/cms\/content\/entries\/([^/]+)\/status$/
const ENTRY_AUTHOR_PATTERN = /^\/admin\/api\/cms\/content\/entries\/([^/]+)\/author$/
const ENTRY_COLLECTION_PATTERN = /^\/admin\/api\/cms\/content\/entries\/([^/]+)\/collection$/
const ENTRY_ITEM_PATTERN = /^\/admin\/api\/cms\/content\/entries\/([^/]+)$/

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleContentEntryRoutes(
  req: Request,
  db: DbClient,
): Promise<Response | null> {
  const { pathname } = new URL(req.url)

  if (pathname === `${CMS_API_PREFIX}/content/authors`) {
    return handleListAuthors(req, db)
  }

  // Sub-routes (`/publish`, `/status`, `/author`, `/collection`) must match
  // before the bare `/entries/:id` pattern, otherwise the latter swallows
  // them (the regex `[^/]+` would match e.g. `abc/publish`).
  const publishMatch = pathname.match(ENTRY_PUBLISH_PATTERN)
  if (publishMatch) {
    return handleEntryPublish(req, db, decodeURIComponent(publishMatch[1]))
  }

  const statusMatch = pathname.match(ENTRY_STATUS_PATTERN)
  if (statusMatch) {
    return handleEntryStatus(req, db, decodeURIComponent(statusMatch[1]))
  }

  const authorMatch = pathname.match(ENTRY_AUTHOR_PATTERN)
  if (authorMatch) {
    return handleEntryAuthor(req, db, decodeURIComponent(authorMatch[1]))
  }

  const collectionMatch = pathname.match(ENTRY_COLLECTION_PATTERN)
  if (collectionMatch) {
    return handleEntryCollection(req, db, decodeURIComponent(collectionMatch[1]))
  }

  const itemMatch = pathname.match(ENTRY_ITEM_PATTERN)
  if (itemMatch) {
    return handleEntryItem(req, db, decodeURIComponent(itemMatch[1]))
  }

  return null
}
