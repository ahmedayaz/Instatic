/**
 * Draft-site read/write endpoint.
 *
 *   GET /admin/api/cms/site — load the entire draft `SiteDocument` (gated
 *                              by `site.read`). Used by the editor to
 *                              hydrate the in-memory store on boot.
 *   PUT /admin/api/cms/site — replace the draft `SiteDocument` (gated by
 *                              `site.edit`). Validated through `validateSite`
 *                              so a malformed payload can never poison the
 *                              persistence layer.
 */
import type { DbClient } from '../../cms/db/client'
import { requireCapability } from '../../cms/authz'
import { loadDraftSite, saveDraftSite } from '../../cms/siteRepository'
import { validateSite, SiteValidationError } from '@core/persistence/validate'
import { badRequest, jsonResponse, methodNotAllowed, readJsonObject } from '../../http'

export async function handleSiteRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== '/admin/api/cms/site') return null

  const user = await requireCapability(req, db, req.method === 'GET' ? 'site.read' : 'site.edit')
  if (user instanceof Response) return user

  if (req.method === 'GET') {
    const site = await loadDraftSite(db)
    if (!site) return jsonResponse({ error: 'draft site not found' }, { status: 404 })
    return jsonResponse({ site })
  }

  if (req.method === 'PUT') {
    const body = await readJsonObject(req)
    try {
      const site = validateSite(body.site)
      await saveDraftSite(db, site, user.id)
      return jsonResponse({ ok: true })
    } catch (err) {
      if (err instanceof SiteValidationError) return badRequest(err.message)
      throw err
    }
  }

  return methodNotAllowed()
}
