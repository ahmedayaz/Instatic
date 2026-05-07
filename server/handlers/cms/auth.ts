/**
 * Authentication endpoints — login, logout, and "who am I".
 *
 *   POST /admin/api/cms/login  — exchange (email, password) for a session
 *                                 cookie, after rate-limit + constant-time
 *                                 password verification.
 *   POST /admin/api/cms/logout — revoke the current session row + clear
 *                                 the cookie.
 *   GET  /admin/api/cms/me     — return the authenticated user, role, and
 *                                 capabilities (used by the admin shell).
 */
import type { DbClient } from '../../cms/db/client'
import {
  createSessionToken,
  hashSessionToken,
  sessionExpiry,
  verifyPassword,
} from '../../cms/auth'
import { createSession, revokeSessionByHash } from '../../cms/sessionsRepository'
import { findUserByEmail, markUserLoggedIn, toPublicUser } from '../../cms/usersRepository'
import { requireAuthenticatedUser, getSessionHash } from '../../cms/authz'
import { createAuditEvent } from '../../cms/auditRepository'
import { loginRateLimit } from '../../cms/rateLimit'
import { clientIp } from '../../cms/security'
import { jsonResponse, methodNotAllowed, readJsonObject, setCookieHeader } from '../../http'
import { CMS_API_PREFIX, readString, requestAuditContext } from './shared'
import { clearSessionCookie, getDummyPasswordHash, sessionCookie } from './session'

export async function handleAuthRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === `${CMS_API_PREFIX}/login`) {
    if (req.method !== 'POST') return methodNotAllowed()
    const body = await readJsonObject(req)
    const email = readString(body, 'email').toLowerCase()
    const password = readString(body, 'password')

    // Rate limit per (client-ip, email) tuple. The bucket is consumed BEFORE
    // any DB lookup or password verification — an attacker who triggers the
    // 429 cannot make us burn argon2id CPU cycles.
    const rateLimitKey = `${clientIp(req) ?? 'unknown'}|${email}`
    const decision = loginRateLimit.consume(rateLimitKey)
    if (!decision.ok) {
      return jsonResponse(
        { error: 'Too many login attempts. Try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil(decision.retryAfterMs / 1000)) },
        },
      )
    }

    // Constant-time path: ALWAYS run argon2id verify, even when the email
    // doesn't match a user. Without this, "user not found" returns in ~5ms
    // while "user found, wrong password" takes ~100ms — a timing oracle for
    // email enumeration. We verify against a fixed dummy hash on the no-user
    // branch; the result is always false, but the latency profile is the
    // same as the real branch.
    const user = await findUserByEmail(db, email)
    const verifiedHash = user?.passwordHash ?? (await getDummyPasswordHash())
    const passwordOk = await verifyPassword(password, verifiedHash)

    if (!user || user.status !== 'active' || !passwordOk) {
      await createAuditEvent(db, {
        actorUserId: user?.id ?? null,
        action: 'login.failure',
        targetType: 'user',
        targetId: user?.id ?? null,
        metadata: { email },
        ...requestAuditContext(req),
      })
      return jsonResponse({ error: 'Invalid email or password' }, { status: 401 })
    }

    // Successful login → release this user's bucket so a forgotten password
    // followed by a correct attempt doesn't continue eating into the quota.
    loginRateLimit.reset(rateLimitKey)

    const token = createSessionToken()
    const expiresAt = sessionExpiry()
    await createSession(db, {
      idHash: await hashSessionToken(token),
      userId: user.id,
      expiresAt,
      ...requestAuditContext(req),
    })
    await markUserLoggedIn(db, user.id)
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'login.success',
      targetType: 'user',
      targetId: user.id,
      metadata: {},
      ...requestAuditContext(req),
    })

    return setCookieHeader(jsonResponse({ ok: true }), sessionCookie(req, token, expiresAt))
  }

  if (url.pathname === `${CMS_API_PREFIX}/logout`) {
    if (req.method !== 'POST') return methodNotAllowed()
    const user = await requireAuthenticatedUser(req, db)
    const idHash = await getSessionHash(req)
    if (idHash) await revokeSessionByHash(db, idHash)
    if (!(user instanceof Response)) {
      await createAuditEvent(db, {
        actorUserId: user.id,
        action: 'logout',
        targetType: 'user',
        targetId: user.id,
        metadata: {},
        ...requestAuditContext(req),
      })
    }
    return setCookieHeader(jsonResponse({ ok: true }), clearSessionCookie(req))
  }

  if (url.pathname === `${CMS_API_PREFIX}/me`) {
    if (req.method !== 'GET') return methodNotAllowed()
    const user = await requireAuthenticatedUser(req, db)
    if (user instanceof Response) return user
    return jsonResponse({ user: toPublicUser(user), role: user.role, capabilities: user.capabilities })
  }

  return null
}
