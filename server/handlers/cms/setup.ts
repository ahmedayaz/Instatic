/**
 * First-run setup endpoints.
 *
 *   GET  /admin/api/cms/setup/status — does the install need setup?
 *   POST /admin/api/cms/setup        — create site + first owner + a
 *                                       starter homepage in one transaction.
 *
 * The setup POST is a one-shot bootstrap: it 409s if anyone has already
 * run setup, so the endpoint can stay public without becoming an account
 * creation backdoor.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../../cms/db/client'
import { hashPassword } from '../../cms/auth'
import { createSite, getSetupStatus } from '../../cms/repositories'
import { createUser } from '../../cms/usersRepository'
import { createAuditEvent } from '../../cms/auditRepository'
import { createNode } from '@core/page-tree/mutations'
import type { Page } from '@core/page-tree/schemas'
import { badRequest, jsonResponse, methodNotAllowed, readJsonObject } from '../../http'
import { CMS_API_PREFIX, readString, requestAuditContext } from './shared'

export async function handleSetupRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === `${CMS_API_PREFIX}/setup/status`) {
    if (req.method !== 'GET') return methodNotAllowed()
    return jsonResponse(await getSetupStatus(db))
  }

  if (url.pathname === `${CMS_API_PREFIX}/setup`) {
    if (req.method !== 'POST') return methodNotAllowed()
    const status = await getSetupStatus(db)
    if (!status.needsSetup) {
      return jsonResponse({ error: 'Setup already complete' }, { status: 409 })
    }

    const body = await readJsonObject(req)
    const siteName = readString(body, 'siteName')
    const email = readString(body, 'email').toLowerCase()
    const password = readString(body, 'password')

    if (!siteName) return badRequest('Missing siteName')
    if (!email.includes('@')) return badRequest('Invalid email')
    if (password.length < 12) return badRequest('Password must be at least 12 characters')

    return await db.transaction(async (tx) => {
      await createSite(tx, siteName, {})
      const owner = await createUser(tx, {
        id: nanoid(),
        email,
        displayName: email,
        passwordHash: await hashPassword(password),
        roleId: 'owner',
        allowOwnerRole: true,
      })
      await createAuditEvent(tx, {
        actorUserId: null,
        action: 'user.create',
        targetType: 'user',
        targetId: owner.id,
        metadata: { roleId: 'owner', source: 'setup' },
        ...requestAuditContext(req),
      })
      // Seed a starter homepage. SiteDocumentSchema requires pages.length >= 1
      // — a freshly-set-up site without any pages would fail validation the
      // moment the editor tried to load it.
      const rootNode = createNode('base.body')
      const homePage: Page = {
        id: nanoid(),
        title: 'Home',
        slug: 'index',
        rootNodeId: rootNode.id,
        nodes: { [rootNode.id]: rootNode },
      }
      await tx`
        insert into pages (
          id,
          title,
          slug,
          draft_document_json,
          sort_order,
          owner_user_id,
          created_by_user_id,
          updated_by_user_id
        )
        values (
          ${homePage.id},
          ${homePage.title},
          ${homePage.slug},
          ${homePage},
          ${0},
          ${owner.id},
          ${owner.id},
          ${owner.id}
        )
      `
      return jsonResponse({ ok: true }, { status: 201 })
    })
  }

  return null
}
