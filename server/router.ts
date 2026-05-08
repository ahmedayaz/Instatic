import { handleAgentRequest, handleAgentToolResult } from './handlers/agent'
import { handleCmsRequest } from './handlers/cms'
import type { DbClient } from './db/client'
import {
  getContentEntryRedirectByRoute,
  getPublishedContentEntryByRoute,
} from './repositories/content'
import { renderContentDocumentHtml } from './publish/contentRenderer'
import { getLatestPublishedSiteSnapshot, getPublishedPageBySlug } from './repositories/publish'
import { renderPublishedContentTemplate, renderPublishedSnapshot } from './publish/publicRenderer'
import { getSetupStatus } from './repositories/setup'
import { getPublishedRuntimeAsset } from './repositories/runtimeAsset'
import { handleLoopRequest, isLoopRuntimeAssetPath, serveLoopRuntimeAsset } from './handlers/cms/loop'
import { jsonResponse } from './http'
import { hardenUploadResponse, serveAdminApp, serveStaticFile } from './static'
import { registry } from '@core/module-engine/registry'
import type { CssBundleFile } from '@core/publisher/siteCssBundle'
import { buildSiteCssBundle } from './publish/siteCssBundle'

const VITE_DEV_URL = 'http://localhost:5173'

interface ServerRuntime {
  db: DbClient
  staticDir?: string
  uploadsDir?: string
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function publicSlugFromPath(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? 'index' : trimmed
}

function contentRouteFromPath(pathname: string): { collectionRouteBase: string; entrySlug: string } | null {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  return {
    collectionRouteBase: `/${parts.slice(0, -1).map((part) => decodeURIComponent(part)).join('/')}`,
    entrySlug: decodeURIComponent(parts[parts.length - 1]),
  }
}

// ---------------------------------------------------------------------------
// Per-route resolvers
//
// Each `tryServeXxx` returns a `Response` if it owns the request, or `null`
// if the path/method doesn't match — the dispatcher chains them together
// without per-call type juggling.
// ---------------------------------------------------------------------------

async function tryServeRuntimeAsset(req: Request, db: DbClient, pathname: string): Promise<Response | null> {
  if (req.method !== 'GET' || !pathname.startsWith('/_pb/assets/')) return null
  const runtimeAsset = await getPublishedRuntimeAsset(db, pathname)
  if (!runtimeAsset) return null
  const body = new ArrayBuffer(runtimeAsset.bytes.byteLength)
  new Uint8Array(body).set(runtimeAsset.bytes)
  return new Response(body, {
    headers: {
      'content-type': runtimeAsset.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

async function tryServeStaticAsset(
  req: Request,
  runtime: ServerRuntime,
  pathname: string,
): Promise<Response | null> {
  if (!runtime.staticDir || !pathname.startsWith('/assets/')) return null
  return await serveStaticFile(runtime.staticDir, pathname, req)
}

async function tryServeUpload(
  req: Request,
  runtime: ServerRuntime,
  pathname: string,
): Promise<Response | null> {
  if (!runtime.uploadsDir || !pathname.startsWith('/uploads/')) return null
  const upload = await serveStaticFile(runtime.uploadsDir, pathname.slice('/uploads'.length), req)
  if (!upload) return null
  // Defense-in-depth: even though the upload handler now writes only
  // server-chosen extensions, the static handler still derives Content-Type
  // from the on-disk extension. `hardenUploadResponse` adds the `nosniff`
  // and (for non-inert MIMEs) `attachment` headers so a stray non-allowlisted
  // file in the uploads dir can never be top-level navigated and rendered as
  // HTML on the admin origin. See `INERT_UPLOAD_MIMES` in `static.ts`.
  return hardenUploadResponse(upload)
}

async function tryServeAdminApp(
  req: Request,
  runtime: ServerRuntime,
  pathname: string,
): Promise<Response | null> {
  const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/')
  if (!isAdminPath) return null

  if (runtime.staticDir) {
    const adminApp = await serveAdminApp(runtime.staticDir, req)
    if (adminApp) return adminApp
  }
  // Admin SPA isn't served from this port (dev mode, or production missing a
  // build). Tell the developer where to actually find it.
  return adminUiNotBuiltResponse(pathname)
}

/**
 * Render the explicit page snapshot stored under `pages/<slug>` if one
 * exists for this URL. Returns `null` when the slug doesn't resolve to a
 * published page — the dispatcher then falls through to the content-entry
 * lookup.
 */
async function tryServePublishedPage(db: DbClient, url: URL): Promise<Response | null> {
  const snapshot = await getPublishedPageBySlug(db, publicSlugFromPath(url.pathname))
  if (!snapshot) return null
  return new Response(await renderPublishedSnapshot(snapshot, { db, url }), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

/**
 * Resolve a URL like `/posts/hello-world` against the content registry.
 * - If the entry exists at its current route, render it through the site
 *   template (or fall back to the standalone document renderer).
 * - Otherwise consult the redirect table and 301 to the entry's new home.
 *
 * Returns `null` for paths that don't carry at least a `/collection/slug`
 * shape; the dispatcher then continues to the setup-wizard redirect.
 */
async function tryServeContentRoute(db: DbClient, url: URL): Promise<Response | null> {
  const route = contentRouteFromPath(url.pathname)
  if (!route) return null

  const entry = await getPublishedContentEntryByRoute(db, route.collectionRouteBase, route.entrySlug)
  if (entry) {
    const siteSnapshot = await getLatestPublishedSiteSnapshot(db)
    const html = siteSnapshot
      ? await renderPublishedContentTemplate(siteSnapshot, entry, { db, url })
      : null
    return new Response(html ?? renderContentDocumentHtml(entry), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }

  const redirect = await getContentEntryRedirectByRoute(db, route.collectionRouteBase, route.entrySlug)
  if (redirect) {
    return new Response(null, {
      status: 301,
      headers: { location: `${redirect.targetPath}${url.search}` },
    })
  }

  return null
}

/**
 * On a fresh install with no admin user yet, bounce the visitor to /admin so
 * they land in the setup wizard instead of seeing a confusing 404. Returns
 * null when the install is already past setup.
 */
async function trySetupRedirect(db: DbClient): Promise<Response | null> {
  const setupStatus = await getSetupStatus(db)
  return setupStatus.needsSetup
    ? new Response(null, { status: 302, headers: { location: '/admin' } })
    : null
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleServerRequest(
  req: Request,
  runtime: ServerRuntime,
): Promise<Response> {
  const url = new URL(req.url)
  const { pathname } = url
  const { db } = runtime

  if (pathname === '/health') {
    return jsonResponse({ status: 'ok', ts: Date.now() })
  }

  // Delegated subsystems — each owns a URL prefix.
  if (pathname.startsWith('/admin/api/cms/')) {
    return handleCmsRequest(req, db, { uploadsDir: runtime.uploadsDir })
  }
  if (pathname === '/api/agent') {
    // `runtime.db` here, not the destructured `db`, satisfies the F-0008
    // architecture gate (agent-endpoint-auth.test.ts) which scans the
    // router source for the literal `handleAgentRequest(req, runtime.db)`
    // / `handleAgentToolResult(req, runtime.db)` calls. The gate exists
    // to ensure the DbClient flows into the handlers' auth checks.
    return handleAgentRequest(req, runtime.db)
  }
  if (pathname === '/api/agent/tool-result') {
    return handleAgentToolResult(req, runtime.db)
  }

  // Loop runtime — fixed CMS asset, served before per-site runtime
  // assets so the request never falls through to the per-site lookup.
  if (req.method === 'GET' && isLoopRuntimeAssetPath(pathname)) {
    return serveLoopRuntimeAsset()
  }
  if (pathname.startsWith('/_pb/loop/')) {
    return handleLoopRequest(req, url, { db })
  }

  const runtimeAsset = await tryServeRuntimeAsset(req, db, pathname)
  if (runtimeAsset) return runtimeAsset

  // Per-site CSS bundle — `reset-<hash>.css`, `framework-<hash>.css`,
  // `style-<hash>.css`. Filenames embed a content hash, so responses can use
  // `Cache-Control: immutable` for a year. Stale-hash requests 404 so the
  // browser falls back to refetching the HTML (which carries the new hash).
  //
  // The /_pb/css/ namespace is exclusive: any unknown path under it is a 404,
  // never falls through to the public-slug handler. That prevents an
  // unrelated path like `/_pb/css/anything.css` from accidentally rendering
  // the homepage (page-slug router doesn't know about CSS conventions).
  if (req.method === 'GET' && pathname.startsWith('/_pb/css/')) {
    return (await serveSiteCss(db, pathname)) ?? new Response('Not found', { status: 404 })
  }

  const staticAsset = await tryServeStaticAsset(req, runtime, pathname)
  if (staticAsset) return staticAsset

  const upload = await tryServeUpload(req, runtime, pathname)
  if (upload) return upload

  const adminApp = await tryServeAdminApp(req, runtime, pathname)
  if (adminApp) return adminApp

  if (req.method === 'GET') {
    const page = await tryServePublishedPage(db, url)
    if (page) return page

    const contentRoute = await tryServeContentRoute(db, url)
    if (contentRoute) return contentRoute

    const setupRedirect = await trySetupRedirect(db)
    if (setupRedirect) return setupRedirect
  }

  return jsonResponse({ error: 'Not found' }, { status: 404 })
}

// ---------------------------------------------------------------------------
// Helpers (long enough to live below the dispatcher for readability)
// ---------------------------------------------------------------------------

function adminUiNotBuiltResponse(pathname: string): Response {
  const targetUrl = `${VITE_DEV_URL}${pathname}`
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Admin UI not served on this port</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 32px; background: #000; color: #ededed; line-height: 1.5; }
  a { color: #fff; }
  code { background: #111; padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
<h1>Admin UI not served on this port</h1>
<p>This is the CMS API server (port 3001). In development, the admin UI is served by the Vite dev server.</p>
<p>Open <a href="${targetUrl}">${targetUrl}</a>.</p>
<p>If Vite isn't running yet, start it with <code>bun run dev</code> from the project root.</p>
</body>
</html>`
  return new Response(html, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

/**
 * Serve one of the three site CSS bundle files (reset / framework / style).
 *
 * The URL path is `/_pb/css/<bundle>-<hash>.css` where `<bundle>` is the
 * logical layer name and `<hash>` is the 12-hex SHA-256 prefix that
 * `buildSiteCssBundle` produces. We rebuild the bundle from the latest
 * published snapshot on every request, which is fine because:
 *
 *  - Bundles are tiny (kB) and the build is microseconds (deduped by moduleId).
 *  - Browsers / CDNs cache the response for a year (`immutable`), so this
 *    handler only fires for the FIRST visitor of a given hash.
 *  - When a hash changes (the site or its classes were edited), HTML pages
 *    re-render with the new `<link href>` referencing the new filename, and
 *    visitors fetch the new bundle exactly once.
 *
 * Stale hash → 404 so the browser falls back to refetching the HTML, which
 * carries the current hash. Returning the new content under the old name
 * would defeat `immutable` caching by serving different bytes for the same
 * URL across the cache lifetime.
 */
async function serveSiteCss(db: DbClient, pathname: string): Promise<Response | null> {
  const filename = pathname.slice('/_pb/css/'.length)
  const match = filename.match(/^(reset|framework|style)-([a-f0-9]{12})\.css$/)
  if (!match) return null

  const [, requestedBundle, requestedHash] = match
  const snapshot = await getLatestPublishedSiteSnapshot(db)
  if (!snapshot) return new Response('Not found', { status: 404 })

  const bundle = buildSiteCssBundle(snapshot.site, registry)
  const file: CssBundleFile = bundle[requestedBundle as 'reset' | 'framework' | 'style']
  if (file.hash !== requestedHash) {
    return new Response('Not found', { status: 404 })
  }

  return new Response(file.content, {
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${file.hash}"`,
    },
  })
}
