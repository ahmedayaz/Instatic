/**
 * MeiliSearch backend implementation.
 *
 * Uses the MeiliSearch REST API directly — no npm client (sandbox constraint).
 * Auth header: `Authorization: Bearer <apiKey>`.
 *
 * Key endpoints used:
 *   POST /indexes                                 — create index
 *   PATCH /indexes/<uid>/settings                 — set searchable attributes
 *   POST /indexes/<uid>/documents                 — upsert batch
 *   DELETE /indexes/<uid>/documents/<id>          — delete one
 *   POST /indexes/<uid>/search                    — query
 *   DELETE /indexes/<uid>/documents               — clear all
 *   GET  /indexes/<uid>/stats                     — doc count + size
 *
 * All fetch responses from MeiliSearch enter the plugin through this file
 * and are validated with simple TypeScript narrowing before use — we don't
 * pull in TypeBox here because we're inside the sandbox and the types are
 * internal. Network errors throw naturally and bubble to the caller.
 */
import type { SearchBackend, SearchBackendOptions, SearchDoc, SearchHit, SearchResults, IndexStats } from './types'

// ---------------------------------------------------------------------------
// Internal narrowing helpers (no TypeBox — sandbox-internal only)
// ---------------------------------------------------------------------------

interface MeiliHit {
  id: string
  slug: string
  title: string
  excerpt: string
  [key: string]: unknown
}

interface MeiliSearchResponse {
  hits: MeiliHit[]
  estimatedTotalHits?: number
  totalHits?: number
  processingTimeMs: number
}

interface MeiliStatsResponse {
  numberOfDocuments: number
  rawDocumentDbSize?: number
  fieldDistribution?: Record<string, number>
}

function isMeiliSearchResponse(v: unknown): v is MeiliSearchResponse {
  if (typeof v !== 'object' || v === null) return false
  const obj = v as Record<string, unknown>
  return Array.isArray(obj.hits) && typeof obj.processingTimeMs === 'number'
}

function isMeiliStatsResponse(v: unknown): v is MeiliStatsResponse {
  if (typeof v !== 'object' || v === null) return false
  return typeof (v as Record<string, unknown>).numberOfDocuments === 'number'
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createMeiliSearchBackend(opts: SearchBackendOptions): SearchBackend {
  const { endpoint, adminApiKey, searchApiKey, indexName, searchableFields, excerptLength } = opts
  const base = endpoint.replace(/\/$/, '')
  const indexUrl = `${base}/indexes/${encodeURIComponent(indexName)}`

  function adminHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${adminApiKey}`,
      'Content-Type': 'application/json',
    }
  }

  function searchHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${searchApiKey}`,
      'Content-Type': 'application/json',
    }
  }

  async function ensureIndex(): Promise<void> {
    // Create index if it doesn't exist (MeiliSearch is idempotent on creation).
    const createRes = await fetch(`${base}/indexes`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ uid: indexName, primaryKey: 'id' }),
      signal: AbortSignal.timeout(10_000),
    })
    // 201 = created, 200 = already exists, 202 = accepted (task queued)
    // 400 with code 'index_already_exists' is also fine.
    if (!createRes.ok) {
      const body = await createRes.json() as Record<string, unknown>
      const code = String(body.code ?? '')
      if (code !== 'index_already_exists') {
        throw new Error(`MeiliSearch: failed to create index "${indexName}": ${body.message ?? createRes.status}`)
      }
    }

    // Update searchable attributes.
    const settingsRes = await fetch(`${indexUrl}/settings/searchable-attributes`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify(searchableFields),
      signal: AbortSignal.timeout(10_000),
    })
    if (!settingsRes.ok) {
      const body = await settingsRes.json() as Record<string, unknown>
      throw new Error(`MeiliSearch: failed to update searchable attributes: ${body.message ?? settingsRes.status}`)
    }
  }

  async function upsertDocuments(docs: SearchDoc[]): Promise<void> {
    if (docs.length === 0) return
    const res = await fetch(`${indexUrl}/documents`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(docs),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const body = await res.json() as Record<string, unknown>
      throw new Error(`MeiliSearch: upsert failed: ${body.message ?? res.status}`)
    }
  }

  async function deleteDocument(id: string): Promise<void> {
    const res = await fetch(`${indexUrl}/documents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: adminHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    // 404 = already gone → treat as success.
    if (!res.ok && res.status !== 404) {
      const body = await res.json() as Record<string, unknown>
      throw new Error(`MeiliSearch: delete failed: ${body.message ?? res.status}`)
    }
  }

  async function search(
    query: string,
    { page, perPage }: { page: number; perPage: number },
  ): Promise<SearchResults> {
    const started = Date.now()
    const offset = (page - 1) * perPage
    const res = await fetch(`${indexUrl}/search`, {
      method: 'POST',
      headers: searchHeaders(),
      body: JSON.stringify({
        q: query,
        limit: perPage,
        offset,
        attributesToRetrieve: ['id', 'slug', 'title', 'excerpt'],
        attributesToHighlight: [],
        attributesToCrop: ['excerpt'],
        cropLength: Math.ceil(excerptLength / 5), // word-count estimate
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.json() as Record<string, unknown>
      throw new Error(`MeiliSearch: search failed: ${body.message ?? res.status}`)
    }
    const body = await res.json()
    if (!isMeiliSearchResponse(body)) {
      throw new Error('MeiliSearch: unexpected search response shape')
    }

    const total = body.totalHits ?? body.estimatedTotalHits ?? body.hits.length
    const hits: SearchHit[] = body.hits.map((h) => ({
      id: String(h.id),
      slug: String(h.slug ?? ''),
      title: String(h.title ?? ''),
      excerpt: String(h.excerpt ?? '').slice(0, excerptLength),
    }))

    return {
      hits,
      total,
      tookMs: Date.now() - started,
    }
  }

  async function clearIndex(): Promise<void> {
    const res = await fetch(`${indexUrl}/documents`, {
      method: 'DELETE',
      headers: adminHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok && res.status !== 404) {
      const body = await res.json() as Record<string, unknown>
      throw new Error(`MeiliSearch: clear index failed: ${body.message ?? res.status}`)
    }
  }

  async function getStats(): Promise<IndexStats> {
    const res = await fetch(`${indexUrl}/stats`, {
      method: 'GET',
      headers: adminHeaders(),
      signal: AbortSignal.timeout(10_000),
    })

    let docCount = 0
    let sizeBytes: number | null = null

    if (res.ok) {
      const body = await res.json()
      if (isMeiliStatsResponse(body)) {
        docCount = body.numberOfDocuments
        sizeBytes = typeof body.rawDocumentDbSize === 'number' ? body.rawDocumentDbSize : null
      }
    } else if (res.status !== 404) {
      const body = await res.json() as Record<string, unknown>
      throw new Error(`MeiliSearch: stats failed: ${body.message ?? res.status}`)
    }

    // Extract hostname for display.
    let endpointHost = endpoint
    try {
      endpointHost = new URL(endpoint).host
    } catch (_err) {
      // keep raw string
    }

    return {
      docCount,
      sizeBytes,
      lastSyncedAt: null, // tracked separately via storage
      backend: 'meilisearch',
      endpointHost,
    }
  }

  return {
    ensureIndex,
    upsertDocuments,
    deleteDocument,
    search,
    clearIndex,
    getStats,
  }
}
