/**
 * Session cookie helpers and constant-time login dummy hash.
 *
 * Two concerns colocated because both are about the login/session boundary:
 *
 *  - `sessionCookie` / `clearSessionCookie` build the `Set-Cookie` headers
 *    used by the auth handlers. They detect HTTPS via `X-Forwarded-Proto`
 *    (so the `Secure` flag is set when behind a reverse proxy) and fall
 *    back to the request URL otherwise.
 *
 *  - `getDummyPasswordHash` returns a fixed argon2id hash, computed once
 *    per process. The login handler verifies against it on the
 *    "no such user" branch so latency stays constant and an attacker
 *    can't enumerate emails by timing.
 */
import { SESSION_COOKIE_NAME, hashPassword } from '../../cms/auth'

/**
 * True when the inbound request was made over HTTPS.
 *
 * Trusts `X-Forwarded-Proto` from a reverse proxy (e.g. Caddy in
 * compose.tls.yml) and falls back to the request URL's protocol when no
 * proxy is involved.
 *
 * Spoofing X-Forwarded-Proto from a direct (non-proxied) HTTP client doesn't
 * gain the attacker anything: it would cause the server to set `Secure`,
 * which makes browsers refuse to send the cookie over HTTP. So the worst
 * case is the attacker locks themselves out, not a privilege escalation.
 */
function requestIsHttps(req: Request): boolean {
  const forwardedProto = req.headers.get('x-forwarded-proto')
  if (forwardedProto) return forwardedProto.toLowerCase() === 'https'
  return req.url.startsWith('https://')
}

function sessionCookieAttributes(secure: boolean): string {
  // HttpOnly  — JS in the browser cannot read the cookie (XSS mitigation)
  // SameSite=Lax — cross-origin POST/PUT/DELETE don't carry the cookie (CSRF)
  // Secure    — browser only sends the cookie over HTTPS (set when applicable)
  const base = 'Path=/admin; HttpOnly; SameSite=Lax'
  return secure ? `${base}; Secure` : base
}

export function sessionCookie(req: Request, token: string, expires: Date): string {
  const attrs = sessionCookieAttributes(requestIsHttps(req))
  return `${SESSION_COOKIE_NAME}=${token}; ${attrs}; Expires=${expires.toUTCString()}`
}

export function clearSessionCookie(req: Request): string {
  const attrs = sessionCookieAttributes(requestIsHttps(req))
  return `${SESSION_COOKIE_NAME}=; ${attrs}; Max-Age=0`
}

/**
 * A fixed argon2id hash, computed once per process. Used by the login handler
 * as the verification target when the supplied email doesn't match any admin
 * user — keeping the response time constant prevents an attacker from
 * learning which emails belong to admins via timing analysis.
 *
 * The hashed plaintext is deliberately not a real password and never grants
 * access; verifyPassword against this hash returns false for every input.
 *
 * Eagerly kicked off at module load so the very first unknown-email login
 * doesn't pay the one-time hashing cost (~50ms) and stand out as slower
 * than the steady-state.
 */
const dummyPasswordHashCache: Promise<string> = hashPassword('not-a-real-account-placeholder')

export function getDummyPasswordHash(): Promise<string> {
  return dummyPasswordHashCache
}
