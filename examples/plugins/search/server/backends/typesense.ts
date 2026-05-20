/**
 * Typesense backend implementation.
 *
 * Uses the Typesense REST API directly — no npm client (sandbox constraint).
 * Auth header: `X-TYPESENSE-API-KEY: <apiKey>`.
 *
 * Key endpoints used:
 *   POST /collections                                   — create collection
 *   POST /collections/<name>/documents/import           — batch upsert (JSONL)
 *   DELETE /collections/<name>/documents/<id>           — delete one
 *   GET /collections/<name>/documents/search?...        — query
 *   DELETE /collections/<name>/documents                — clear all (filter = *)
 *   GET /collections/<name>                             — stats (num_documents)
 *
 * Typesense uses JSONL (one JSON object per line) for batch imports.
 * Single-document operations use regular JSON.
 */
import type { SearchBackend, SearchBackendOptions, SearchDoc, SearchHit, SearchResults, IndexStats } from './types'

// ---------------------------------------------------------------------------
// Internal narrowing helpers
// ---------------------------------------------------------------------------

interface TypesenseHit {
  document: {
    id: string
    slug?: string
    title?: string
    excerpt?: string
    [key: string]: unknown
  }
}

interface TypesenseSearchResponse {
  hits?: TypesenseHit[]
  found: number
  search_time_ms: number
}

interface TypesenseCollectionInfo {
  name: string
  num_documents: number
  [key: string]: unknown
}

function isTypesenseSearchResponse(v: unknown): v is TypesenseSearchResponse {
  if (typeof v !== 'object' || v === null) return false
  const obj = v as Record<string, unknown>
  return typeof obj.found === 'number' && typeof obj.search_time_ms === 'number'
}

function isTypesenseCollectionInfo(v: unknown): v is TypesenseCollectionInfo {
  if (typeof v !== 'object' || v === null) return false
  const obj = v as Record<string, unknown>
  return typeof obj.name === 'string' && typeof obj.num_documents === 'number'
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createTypesenseBackend(opts: SearchBackendOptions): SearchBackend {
  const { endpoint, adminApiKey, searchApiKey, indexName, searchableFields, excerptLength } = opts
  const base = endpoint.replace(/\/$/, '')
  const collectionUrl = `${base}/collections/${encodeURIComponent(indexName)}`

  function adminHeaders(): Record<string, string> {
    return {
      'X-TYPESENSE-API-KEY': adminApiKey,
      'Content-Type': 'application/json',
    }
  }

  function searchHeaders(): Record<string, string> {
    return {
      'X-TYPESENSE-API-KEY': searchApiKey,
      'Content-Type': 'application/json',
    }
  }

  async function ensureIndex(): Promise<void> {
    // Check if collection already exists.
    const checkRes = await fetch(collectionUrl, {
      method: 'GET',
      headers: adminHeaders(),
      signal: AbortSignal.timeout(10_000),
    })

    if (checkRes.ok) {
      // Collection exists — update it (schema evolution not needed for v1).
      return
    }

    if (checkRes.status !== 404) {
      const body = await checkRes.json() as Record<string, unknown>
      throw new Error(`Typesense: could not check collection: ${body.message ?? checkRes.status}`)
    }

    // Create the collection with the declared fields.
    const fields = [
      { name: 'id', type: 'string' },
      { name: 'slug', type: 'string', index: false },
      { name: 'title', type: 'string' },
      { name: 'headings', type: 'string', optional: true },
      { name: 'content', type: 'string', optional: true },
      { name: 'excerpt', type: 'string', optional: true },
      { name: 'indexedAt', type: 'string', index: false, optional: true },
    ]

    const schema = {
      name: indexName,
      fields,
      // Use the declared searchable fields to order the ranking priority.
      // Typesense auto-detects the rest.
    }

    const createRes = await fetch(`${base}/collections`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(schema),
      signal: AbortSignal.timeout(10_000),
    })

    if (!createRes.ok) {
      const body = await createRes.json() as Record<string, unknown>
      // Concurrent activate calls on the same instance could race.
      if (String(body.message ?? '').includes('already exists')) return
      throw new Error(`Typesense: failed to create collection "${indexName}": ${body.message ?? createRes.status}`)
    }
  }

  async function upsertDocuments(docs: SearchDoc[]): Promise<void> {
    if (docs.length === 0) return
    // Typesense batch import expects JSONL with action=upsert.
    const jsonl = docs.map((d) => JSON.stringify(d)).join('\n')
    const res = await fetch(`${collectionUrl}/documents/import?action=upsert`, {
      method: 'POST',
      headers: {
        'X-TYPESENSE-API-KEY': adminApiKey,
        'Content-Type': 'text/plain',
      },
      body: jsonl,
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Typesense: import failed (${res.status}): ${text.slice(0, 200)}`)
    }
    // Response is JSONL — each line is the result for one doc.
    // We don't parse line-by-line errors for simplicity in v1.
  }

  async function deleteDocument(id: string): Promise<void> {
    const res = await fetch(`${collectionUrl}/documents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: adminHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok && res.status !== 404) {
      const body = await res.json() as Record<string, unknown>
      throw new Error(`Typesense: delete failed: ${body.message ?? res.status}`)
    }
  }

  async function search(
    query: string,
    { page, perPage }: { page: number; perPage: number },
  ): Promise<SearchResults> {
    const started = Date.now()
    const queryFields = searchableFields.join(',')
    const params = new URLSearchParams({
      q: query,
      query_by: queryFields || 'title,headings,content',
      per_page: String(perPage),
      page: String(page),
      include_fields: 'id,slug,title,excerpt',
      highlight_fields: 'none',
    })

    const res = await fetch(`${collectionUrl}/documents/search?${params.toString()}`, {
      method: 'GET',
      headers: searchHeaders(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.json() as Record<string, unknown>
      throw new Error(`Typesense: search failed: ${body.message ?? res.status}`)
    }

    const body = await res.json()
    if (!isTypesenseSearchResponse(body)) {
      throw new Error('Typesense: unexpected search response shape')
    }

    const hits: SearchHit[] = (body.hits ?? []).map((h) => ({
      id: String(h.document.id ?? ''),
      slug: String(h.document.slug ?? ''),
      title: String(h.document.title ?? ''),
      excerpt: String(h.document.excerpt ?? '').slice(0, excerptLength),
    }))

    return {
      hits,
      total: body.found,
      tookMs: Date.now() - started,
    }
  }

  async function clearIndex(): Promise<void> {
    // Typesense supports a bulk-delete by filter; "match_all" is "*".
    const res = await fetch(`${collectionUrl}/documents?filter_by=id:!=__none__`, {
      method: 'DELETE',
      headers: adminHeaders(),
      signal: AbortSignal.timeout(30_000),
    })
    // 404 means collection doesn't exist yet — that's fine.
    if (!res.ok && res.status !== 404) {
      const body = await res.json() as Record<string, unknown>
      throw new Error(`Typesense: clear failed: ${body.message ?? res.status}`)
    }
  }

  async function getStats(): Promise<IndexStats> {
    const res = await fetch(collectionUrl, {
      method: 'GET',
      headers: adminHeaders(),
      signal: AbortSignal.timeout(10_000),
    })

    let docCount = 0

    if (res.ok) {
      const body = await res.json()
      if (isTypesenseCollectionInfo(body)) {
        docCount = body.num_documents
      }
    } else if (res.status !== 404) {
      const body = await res.json() as Record<string, unknown>
      throw new Error(`Typesense: stats failed: ${body.message ?? res.status}`)
    }

    let endpointHost = endpoint
    try {
      endpointHost = new URL(endpoint).host
    } catch (_err) {
      // keep raw string
    }

    return {
      docCount,
      sizeBytes: null, // Typesense doesn't expose size in collection stats
      lastSyncedAt: null,
      backend: 'typesense',
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
