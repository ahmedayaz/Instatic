/**
 * Search plugin — server entrypoint.
 *
 * Runs entirely inside the QuickJS-WASM sandbox. No Node/Bun access.
 *
 * Lifecycle:
 *   activate   — pick backend, ensure index, register routes + hooks
 *   deactivate — no-op (backend connections are stateless HTTP)
 *   uninstall  — clear query log storage
 *
 * Routes registered:
 *   GET  /search          (public)          — full-text search, rate-limited
 *   GET  /admin-search    (plugins.manage)  — same search but authenticated (for admin UI)
 *   GET  /status          (plugins.manage)  — index stats + backend info
 *   POST /clear           (plugins.manage)  — delete all documents from the index
 *   GET  /analytics       (plugins.manage)  — top queries / top no-results
 *
 * Hooks:
 *   publish.before → store pending { pageId, siteId } so publish.html has context
 *   publish.html   → extract + upsert the rendered page HTML into the search index
 *   publish.after  → clean up pending state
 *
 * Indexing design:
 *   The `publish.html` filter is the ONLY hook that gives us both:
 *     • the full rendered HTML (to extract title/headings/content), AND
 *     • a synchronous execution context (the filter runs inline during publish).
 *   The `publish.before` hook stores the current pageId in a Map so the filter
 *   can look it up. The QuickJS VM is single-threaded and the host serialises
 *   hook/filter calls through the worker, so no interleaving is possible.
 *
 *   "Reindex all" from the admin UI is NOT supported programmatically — the
 *   plugin has no API to enumerate all published pages. To rebuild the full
 *   index, the operator should use the site editor's "Publish All" action,
 *   which fires the publish pipeline (and therefore this filter) for each page.
 */
import type { ServerPluginApi, ServerPluginModule } from '@pagebuilder/plugin-sdk'
import { createMeiliSearchBackend } from './backends/meilisearch'
import { createTypesenseBackend } from './backends/typesense'
import { extractSearchDoc } from './extract'
import { createRateLimiter } from './rateLimit'
import { buildSearchRouteHandler } from './searchRoute'
import { getAnalyticsSnapshot } from './analytics'
import type { SearchBackend, SearchBackendOptions } from './backends/types'

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

function readBackendOptions(api: ServerPluginApi): SearchBackendOptions | null {
  const endpoint = api.cms.settings.get<string>('endpoint') ?? ''
  const adminApiKey = api.cms.settings.get<string>('adminApiKey') ?? ''
  const searchApiKey = api.cms.settings.get<string>('searchApiKey') ?? ''
  const indexName = api.cms.settings.get<string>('indexName') ?? 'pagebuilder'
  const searchableFieldsRaw = api.cms.settings.get<string>('searchableFields') ?? 'title\nheadings\ncontent'
  const excerptLength = Number(api.cms.settings.get<number>('excerptLength') ?? 200)

  if (!endpoint || !adminApiKey) {
    api.plugin.log('Search plugin: endpoint and adminApiKey must be configured in Settings.')
    return null
  }

  const searchableFields = searchableFieldsRaw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    endpoint,
    adminApiKey,
    searchApiKey: searchApiKey || adminApiKey,
    indexName,
    searchableFields,
    excerptLength,
  }
}

function pickBackend(api: ServerPluginApi, opts: SearchBackendOptions): SearchBackend {
  const backend = api.cms.settings.get<string>('backend') ?? 'meilisearch'
  return backend === 'typesense'
    ? createTypesenseBackend(opts)
    : createMeiliSearchBackend(opts)
}

function parseExcludePaths(api: ServerPluginApi): string[] {
  const raw = api.cms.settings.get<string>('excludePaths') ?? ''
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function isExcluded(slug: string, excludePaths: string[]): boolean {
  return excludePaths.some((p) => slug.startsWith(p))
}

/**
 * Derive a stable document id from a page slug.
 * We strip the leading slash and replace remaining slashes with underscores
 * so the id satisfies both MeiliSearch's primary-key rules and Typesense's
 * id requirements (no slashes, alphanumeric + underscore).
 */
function slugToDocId(slug: string): string {
  return slug.replace(/^\//, '').replace(/\//g, '_') || 'root'
}

/**
 * Derive a URL path slug from the CMS pageId.
 * pageId might be "about" or "/about" or a UUID — we normalise to "/about".
 */
function pageIdToSlug(pageId: string): string {
  return pageId.startsWith('/') ? pageId : `/${pageId}`
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const mod: ServerPluginModule = {
  install(api: ServerPluginApi) {
    api.plugin.log('Search plugin installed — configure endpoint + API keys in Settings.')
  },

  async activate(api: ServerPluginApi) {
    api.plugin.log('Search plugin activating')

    const opts = readBackendOptions(api)
    const limiter = createRateLimiter({ maxPerMinute: 60 })

    // The backend may be unconfigured (missing endpoint/key) — we still
    // register routes so the admin can call /status and see the error state.
    let backend: SearchBackend | null = null

    if (opts) {
      try {
        backend = pickBackend(api, opts)
        await backend.ensureIndex()
        api.plugin.log('Search plugin: index ready')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        api.plugin.log('Search plugin: ensureIndex failed:', message)
        backend = null
      }
    }

    // ── Public search route ──────────────────────────────────────────────
    if (backend) {
      const searchHandler = buildSearchRouteHandler({ backend, limiter, api })
      api.cms.routes.getPublic('/search', searchHandler)
    } else {
      api.cms.routes.getPublic('/search', async () => {
        return new Response(
          JSON.stringify({ error: 'Search is not configured. Set endpoint and API keys in plugin Settings.' }),
          { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
        )
      })
    }

    // ── Admin: authenticated search (for the admin Documents tab) ─────────
    // The public /search route is not reachable through usePluginRoutes() because
    // that helper points at the plugin's runtime base URL. We register a parallel
    // authenticated route so the admin UI can search the index without the CORS /
    // path mismatch. No rate-limit on authenticated requests.
    api.cms.routes.get('/admin-search', 'plugins.manage', async (ctx) => {
      if (!backend) {
        return new Response(
          JSON.stringify({ error: 'Backend not configured.' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        )
      }
      const url = new URL(ctx.req.url)
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
      const perPage = Math.max(1, Math.min(50, parseInt(url.searchParams.get('per-page') ?? '20', 10) || 20))
      if (!q) {
        return { results: [], total: 0, took_ms: 0, query: '' }
      }
      try {
        const liveOpts = readBackendOptions(api)
        const liveBackend = liveOpts ? pickBackend(api, liveOpts) : backend
        const results = await liveBackend.search(q, { page: 1, perPage })
        return {
          results: results.hits,
          total: results.total,
          took_ms: results.tookMs,
          query: q,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return new Response(
          JSON.stringify({ error: message }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        )
      }
    })

    // ── Admin: status ────────────────────────────────────────────────────
    api.cms.routes.get('/status', 'plugins.manage', async () => {
      if (!backend) {
        const currentOpts = readBackendOptions(api)
        return {
          ok: false,
          configured: false,
          message: currentOpts === null
            ? 'endpoint and adminApiKey must be set in plugin Settings.'
            : 'Backend failed to initialise — check plugin logs.',
        }
      }
      try {
        const liveOpts = readBackendOptions(api)
        const liveBackend = liveOpts ? pickBackend(api, liveOpts) : backend
        const stats = await liveBackend.getStats()
        return { ok: true, configured: true, stats }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, configured: true, message }
      }
    })

    // ── Admin: analytics ─────────────────────────────────────────────────
    api.cms.routes.get('/analytics', 'plugins.manage', async () => {
      const enableLogging = api.cms.settings.get<boolean>('enableQueryLogging') ?? true
      if (!enableLogging) {
        return { ok: true, loggingDisabled: true, topQueries: [], topNoResults: [] }
      }
      const snapshot = await getAnalyticsSnapshot(api)
      return { ok: true, ...snapshot }
    })

    // ── Admin: clear index ───────────────────────────────────────────────
    api.cms.routes.post('/clear', 'plugins.manage', async () => {
      if (!backend) {
        return { ok: false, message: 'Backend not configured.' }
      }
      try {
        const liveOpts = readBackendOptions(api)
        const liveBackend = liveOpts ? pickBackend(api, liveOpts) : backend
        await liveBackend.clearIndex()
        return { ok: true, message: 'Index cleared.' }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, message }
      }
    })

    // ── Per-publish indexing ─────────────────────────────────────────────
    //
    // Indexing uses two cooperating hooks:
    //
    //  1. publish.before  — stores the current page's id/slug in a Map so the
    //                       publish.html filter has context. The QuickJS VM is
    //                       single-threaded; the host serialises all hook/filter
    //                       calls through the worker queue, so there is no risk
    //                       of interleaving across concurrent publish requests.
    //
    //  2. publish.html    — fires with the FULL rendered HTML synchronously
    //                       during the publish pipeline. This is the only point
    //                       where we have both the page content AND execution
    //                       context to index it. We extract title/headings/
    //                       content and upsert the document — then return the
    //                       HTML unchanged (we are a pass-through filter).
    //
    //  3. publish.after   — cleanup only: remove the pending entry.

    // Map<siteId, { slug: string }> — set by publish.before, consumed by publish.html.
    const pendingPublish = new Map<string, { slug: string }>()

    api.cms.hooks.on('publish.before', async (evt) => {
      if (!evt.pageId) return
      const slug = pageIdToSlug(evt.pageId)
      pendingPublish.set(evt.siteId, { slug })
    })

    api.cms.hooks.filter('publish.html', async (html, _ctx) => {
      // Must ALWAYS return html — we are a pass-through filter.
      if (!backend || typeof html !== 'string') return html

      // Find the pending entry. If not set (publish.before didn't fire for
      // this request), skip indexing rather than guessing.
      // Look for any pending entry — in single-publish mode there is one.
      // If multiple sites published simultaneously, pick the first available
      // (this is safe because the VM is single-threaded: only one publish
      // pipeline can be active at a time).
      const entries = Array.from(pendingPublish.entries())
      if (entries.length === 0) return html
      const [siteId, { slug }] = entries[0]

      const excludePaths = parseExcludePaths(api)
      if (isExcluded(slug, excludePaths)) {
        api.plugin.log(`Search plugin: skipping excluded slug "${slug}"`)
        return html
      }

      const excerptLength = Number(api.cms.settings.get<number>('excerptLength') ?? 200)
      const docId = slugToDocId(slug)
      const doc = extractSearchDoc(html, { id: docId, slug }, excerptLength)

      try {
        const liveOpts = readBackendOptions(api)
        const liveBackend = liveOpts ? pickBackend(api, liveOpts) : backend
        await liveBackend.upsertDocuments([doc])
        api.plugin.log(`Search plugin: indexed "${slug}" (${docId})`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        api.plugin.log('Search plugin: upsert failed:', message)
      }

      // Clean up so the next publish starts fresh.
      pendingPublish.delete(siteId)

      return html
    })

    api.cms.hooks.on('publish.after', async (evt) => {
      // Clean up any leftover pending entry (e.g. if publish.html filter
      // didn't run due to an upstream error).
      if (evt.siteId) pendingPublish.delete(evt.siteId)
    })

    api.plugin.log('Search plugin activated.')
  },

  deactivate(api: ServerPluginApi) {
    api.plugin.log('Search plugin deactivated.')
  },

  async uninstall(api: ServerPluginApi) {
    const queries = api.cms.storage.collection('queries')
    const all = await queries.list()
    await Promise.all(all.map((r) => queries.delete(r.id)))
    api.plugin.log(`Search plugin uninstalled, removed ${all.length} query log entries.`)
  },
}

export default mod
