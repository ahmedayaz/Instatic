/**
 * Editor-side runtime endpoints — dependency resolution and live preview.
 *
 *   POST /admin/api/cms/runtime/dependencies/resolve — resolve a
 *        `package.json`-shaped payload into a `dependencyLock` object
 *        (gated by `runtime.manage`). Used when the editor wants to
 *        re-pin a site's npm dependencies.
 *
 *   POST /admin/api/cms/runtime/preview — build a single-page preview
 *        document (HTML + assets + diagnostics) for a given draft site
 *        (gated by `site.edit`). Used by the visual builder's preview
 *        iframe.
 *
 * Both endpoints accept the draft site in the request body rather than
 * loading the persisted draft — preview must reflect unsaved edits.
 */
import type { DbClient } from '../../cms/db/client'
import { requireCapability } from '../../cms/authz'
import { resolveSiteDependencyLock } from '../../cms/runtime/dependencyResolver'
import { ensureRuntimeDependencyCache } from '../../cms/runtime/dependencyCache'
import { buildRuntimePreviewDocument } from '../../cms/runtime/previewRuntime'
import { validateSite, SiteValidationError } from '@core/persistence/validate'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import type { SitePackageJson } from '@core/site-dependencies/manifest'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { registry } from '@core/module-engine/registry'
import { badRequest, jsonResponse, methodNotAllowed, readJsonObject } from '../../http'
import { readObject, readString } from './shared'

function runtimeDependencyMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const dependencies: Record<string, string> = {}
  for (const [rawName, rawVersion] of Object.entries(raw as Record<string, unknown>)) {
    const name = rawName.trim()
    const version = typeof rawVersion === 'string' ? rawVersion.trim() : ''
    if (!name || !version || !isSafePackageName(name)) continue
    dependencies[name] = version
  }
  return dependencies
}

function runtimeRequestPackageJson(raw: unknown): SitePackageJson {
  const manifest = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  return {
    dependencies: runtimeDependencyMap(manifest.dependencies),
    devDependencies: runtimeDependencyMap(manifest.devDependencies),
  }
}

export async function handleRuntimeRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === '/admin/api/cms/runtime/dependencies/resolve') {
    const user = await requireCapability(req, db, 'runtime.manage')
    if (user instanceof Response) return user
    if (req.method !== 'POST') return methodNotAllowed()

    const body = await readJsonObject(req)
    try {
      const packageJson = runtimeRequestPackageJson(body.packageJson)
      const dependencyLock = await resolveSiteDependencyLock(packageJson)
      return jsonResponse({ dependencyLock })
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'Runtime dependency resolution failed')
    }
  }

  if (url.pathname === '/admin/api/cms/runtime/preview') {
    const user = await requireCapability(req, db, 'site.edit')
    if (user instanceof Response) return user
    if (req.method !== 'POST') return methodNotAllowed()

    const body = await readJsonObject(req)
    const pageId = readString(body, 'pageId')
    const breakpointId = readString(body, 'breakpointId') || undefined
    const templateContext = readObject<TemplateRenderDataContext>(body, 'templateContext')
    if (!pageId) return badRequest('Missing pageId')

    try {
      const site = validateSite(body.site)
      const page = site.pages.find((candidate) => candidate.id === pageId)
      if (!page) return jsonResponse({ error: 'Page not found' }, { status: 404 })

      const runtime = normalizeSiteRuntimeConfig(site.runtime)
      const dependencyCache = Object.keys(runtime.dependencyLock.packages).length > 0
        ? await ensureRuntimeDependencyCache(runtime.dependencyLock)
        : undefined
      const preview = await buildRuntimePreviewDocument({
        site,
        page,
        registry,
        assetBasePath: '/_pb/preview/runtime/',
        dependencyCache,
        breakpointId,
        templateContext,
        db,
      })

      return jsonResponse({
        html: preview.html,
        assets: preview.files.map((file) => ({
          path: file.path,
          publicPath: file.publicPath,
          content: file.content,
          contentType: file.contentType,
        })),
        runtimeAssets: preview.runtimeAssets,
        diagnostics: preview.diagnostics,
      })
    } catch (err) {
      if (err instanceof SiteValidationError) return badRequest(err.message)
      return badRequest(err instanceof Error ? err.message : 'Runtime preview build failed')
    }
  }

  return null
}
