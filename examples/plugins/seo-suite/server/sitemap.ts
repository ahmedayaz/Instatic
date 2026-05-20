/**
 * SEO Suite — sitemap.xml + robots.txt public routes.
 *
 * Both routes are registered via `api.cms.routes.getPublic` so they are
 * reachable without authentication — search engines need them.
 *
 * Full mount paths (reverse-proxy these to the site root — see README.md):
 *   GET /admin/api/cms/plugins/pagebuilder.seo-suite/runtime/sitemap.xml
 *   GET /admin/api/cms/plugins/pagebuilder.seo-suite/runtime/robots.txt
 *
 * Route handlers return `{ __response: true, status, headers, body }` —
 * the plugin worker serialises this shape into a real Response with the
 * correct Content-Type (see server/plugins/pluginWorker.ts:serializeRouteResult).
 */
import type { ServerPluginApi } from '@pagebuilder/plugin-sdk'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

// ---------------------------------------------------------------------------
// TypeBox schema for a page-index row (resilient read from storage).
// ---------------------------------------------------------------------------

const PageIndexRowSchema = Type.Object({
  'page-id': Type.String(),
  slug: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  'last-seen-at': Type.Optional(Type.String()),
})

const SeoEntryRowSchema = Type.Object({
  'page-id': Type.String(),
  'no-index': Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape XML special characters for use in element content or attributes. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Return the date portion of an ISO string, or today's date as fallback. */
function toDateString(iso: string | undefined): string {
  if (!iso) return new Date().toISOString().slice(0, 10)
  const d = new Date(iso)
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10)
  return d.toISOString().slice(0, 10)
}

/** Coerce a stored boolean-or-string value to an actual boolean. */
function isTruthy(value: boolean | string | undefined): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value === 'true' || value === '1'
  return false
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSitemapRoutes(api: ServerPluginApi): void {
  // ── sitemap.xml ──────────────────────────────────────────────────────────
  api.cms.routes.getPublic('/sitemap.xml', async () => {
    try {
      const siteUrl = (api.cms.settings.get<string>('siteUrl') ?? '').replace(/\/$/, '')

      const [pageIndexRecords, seoEntryRecords] = await Promise.all([
        api.cms.storage.collection('page-index').list(),
        api.cms.storage.collection('seo-entries').list(),
      ])

      // Build a fast lookup for no-index flags by page-id.
      const noIndexByPageId = new Map<string, boolean>()
      for (const record of seoEntryRecords) {
        if (!Value.Check(SeoEntryRowSchema, record.data)) continue
        const entry = record.data as { 'page-id': string; 'no-index'?: boolean | string }
        noIndexByPageId.set(entry['page-id'], isTruthy(entry['no-index']))
      }

      const urlEntries: string[] = []

      for (const record of pageIndexRecords) {
        if (!Value.Check(PageIndexRowSchema, record.data)) continue
        const row = record.data as {
          'page-id': string
          slug?: string
          url?: string
          title?: string
          'last-seen-at'?: string
        }

        // Skip pages explicitly marked no-index.
        if (noIndexByPageId.get(row['page-id'])) continue

        // Build the canonical URL for this page.
        let loc = row.url ?? ''
        if (!loc && row.slug) {
          loc = `${siteUrl}/${row.slug.replace(/^\//, '')}`
        }
        if (!loc) continue

        const lastmod = toDateString(row['last-seen-at'])

        urlEntries.push(
          `  <url>\n` +
          `    <loc>${escapeXml(loc)}</loc>\n` +
          `    <lastmod>${escapeXml(lastmod)}</lastmod>\n` +
          `    <changefreq>weekly</changefreq>\n` +
          `    <priority>0.5</priority>\n` +
          `  </url>`,
        )
      }

      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urlEntries.join('\n') +
        (urlEntries.length > 0 ? '\n' : '') +
        `</urlset>`

      return {
        __response: true,
        status: 200,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
        body: xml,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      api.plugin.log('[seo-suite] sitemap.xml generation failed:', message)
      return {
        __response: true,
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'Sitemap generation failed.',
      }
    }
  })

  // ── robots.txt ───────────────────────────────────────────────────────────
  api.cms.routes.getPublic('/robots.txt', () => {
    try {
      const siteUrl = (api.cms.settings.get<string>('siteUrl') ?? '').replace(/\/$/, '')
      const operatorContent = api.cms.settings.get<string>('robotsTxt') ?? 'User-agent: *\nAllow: /'

      // Always append the Sitemap directive pointing at our route.
      const sitemapLine = siteUrl
        ? `Sitemap: ${siteUrl}/sitemap.xml`
        : `# Sitemap: <configure siteUrl in SEO Suite settings>`

      const body = `${operatorContent.trimEnd()}\n${sitemapLine}\n`

      return {
        __response: true,
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      api.plugin.log('[seo-suite] robots.txt generation failed:', message)
      return {
        __response: true,
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'robots.txt generation failed.',
      }
    }
  })
}
