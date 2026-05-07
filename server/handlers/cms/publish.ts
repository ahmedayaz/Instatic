/**
 * Site publish endpoints.
 *
 *   POST /admin/api/cms/publish         — push the current draft as a new
 *                                          published snapshot (gated by
 *                                          `pages.publish`). Records an
 *                                          audit event with the page count.
 *   GET  /admin/api/cms/publish/status  — return the freshness of the
 *                                          current draft vs. the latest
 *                                          published snapshot (gated by
 *                                          `site.read`).
 */
import type { DbClient } from '../../cms/db/client'
import { requireCapability } from '../../cms/authz'
import { createAuditEvent } from '../../cms/auditRepository'
import { getDraftPublishStatus, publishDraftSite } from '../../cms/publishRepository'
import { jsonResponse, methodNotAllowed } from '../../http'
import { requestAuditContext } from './shared'

export async function handlePublishRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === '/admin/api/cms/publish') {
    const user = await requireCapability(req, db, 'pages.publish')
    if (user instanceof Response) return user
    if (req.method !== 'POST') return methodNotAllowed()

    const result = await publishDraftSite(db, user.id)
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'publish',
      targetType: 'site',
      targetId: 'default',
      metadata: { publishedPages: result.publishedPages },
      ...requestAuditContext(req),
    })
    return jsonResponse(result)
  }

  if (url.pathname === '/admin/api/cms/publish/status') {
    const user = await requireCapability(req, db, 'site.read')
    if (user instanceof Response) return user
    if (req.method !== 'GET') return methodNotAllowed()

    return jsonResponse(await getDraftPublishStatus(db))
  }

  return null
}
