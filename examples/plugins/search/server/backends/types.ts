/**
 * Search backend abstraction — shared types and interface.
 *
 * Both MeiliSearch and Typesense adapters implement `SearchBackend`.
 * The server entrypoint picks the right one based on the `backend` setting.
 *
 * All types are expressed as plain TypeScript interfaces (no TypeBox here —
 * these are internal to the sandbox and not validated at a network boundary).
 * TypeBox validation happens at the route handler level where HTTP responses
 * from the external APIs enter the plugin's trust boundary.
 */

// ---------------------------------------------------------------------------
// Document shape stored in the search index
// ---------------------------------------------------------------------------

export interface SearchDoc {
  /** Stable unique id — derived from the page slug or page ID. */
  id: string
  /** Page slug / URL path, e.g. "/blog/my-post". */
  slug: string
  /** Document title extracted from <title> or <h1>. */
  title: string
  /** Space-joined heading text (h1-h4). */
  headings: string
  /** Plain-text body content (script/style stripped). */
  content: string
  /** Short snippet used in search result cards. */
  excerpt: string
  /** ISO timestamp of when this doc was indexed. */
  indexedAt: string
}

// ---------------------------------------------------------------------------
// Search query result
// ---------------------------------------------------------------------------

export interface SearchHit {
  id: string
  slug: string
  title: string
  excerpt: string
}

export interface SearchResults {
  hits: SearchHit[]
  total: number
  tookMs: number
}

// ---------------------------------------------------------------------------
// Index stats
// ---------------------------------------------------------------------------

export interface IndexStats {
  /** Number of documents currently in the index. */
  docCount: number
  /** Approximate index size in bytes, or null when the backend doesn't report it. */
  sizeBytes: number | null
  /** ISO timestamp of the last successful index operation, or null. */
  lastSyncedAt: string | null
  /** Which backend is in use ('meilisearch' | 'typesense'). */
  backend: string
  /** Hostname extracted from the configured endpoint. */
  endpointHost: string
}

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

export interface SearchBackendOptions {
  endpoint: string
  adminApiKey: string
  searchApiKey: string
  indexName: string
  searchableFields: string[]
  excerptLength: number
}

export interface SearchBackend {
  /**
   * Ensure the index / collection exists with the correct settings.
   * Safe to call on every activate.
   */
  ensureIndex(): Promise<void>

  /**
   * Insert or update documents. Idempotent on `id`.
   * Batching is the caller's responsibility.
   */
  upsertDocuments(docs: SearchDoc[]): Promise<void>

  /**
   * Remove a single document by its id.
   * Silently succeeds when the document doesn't exist.
   */
  deleteDocument(id: string): Promise<void>

  /**
   * Execute a full-text search query.
   */
  search(
    query: string,
    opts: { page: number; perPage: number },
  ): Promise<SearchResults>

  /**
   * Delete all documents from the index (does NOT remove the index itself).
   */
  clearIndex(): Promise<void>

  /**
   * Return lightweight index statistics for the admin dashboard.
   */
  getStats(): Promise<IndexStats>
}
