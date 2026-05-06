import { describe, expect, it } from 'bun:test'
import { handleCmsRequest } from '../../../server/cms/handlers'
import type { DbClient, DbResult } from '../../../server/cms/db'
import { SESSION_COOKIE_NAME } from '../../../server/cms/auth'
import { loginRateLimit } from '../../../server/cms/rateLimit'

function makeFakeDb() {
  const site: Record<string, unknown>[] = []
  const admins: Record<string, unknown>[] = []
  const sessions: Record<string, unknown>[] = []
  const pages: Record<string, unknown>[] = []

  const handle = async <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    // Reconstruct a parameterized SQL string for pattern matching.
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    // getSetupStatus — no values
    if (normalized.includes('count(*) as count from site')) {
      return { rows: [{ count: site.length } as Row], rowCount: 1 }
    }
    if (normalized.includes('count(*) as count from admin_users')) {
      return { rows: [{ count: admins.length } as Row], rowCount: 1 }
    }
    // createSite (repositories.ts) — values[0]=name, values[1]=settings
    // saveDraftSite (siteRepository.ts) — values[0]=name, values[1]=siteShell (via transaction)
    if (normalized.includes('insert into site')) {
      const row = { id: 'default', name: values[0], settings_json: values[1] }
      const index = site.findIndex((s) => s.id === 'default')
      if (index >= 0) site[index] = row
      else site.push(row)
      return { rows: [], rowCount: 1 }
    }
    // createAdminUser — values[0]=id, values[1]=email, values[2]=passwordHash
    if (normalized.includes('insert into admin_users')) {
      admins.push({
        id: values[0],
        email: values[1],
        password_hash: values[2],
        created_at: new Date().toISOString(),
      })
      return { rows: [], rowCount: 1 }
    }
    // saveDraftSite pages (siteRepository.ts, via transaction) — values[0..4]=id, title, slug, page, index
    if (normalized.includes('insert into pages')) {
      const page = {
        id: values[0],
        title: values[1],
        slug: values[2],
        draft_document_json: values[3],
        sort_order: values[4],
      }
      const index = pages.findIndex((p) => p.id === page.id)
      if (index >= 0) pages[index] = page
      else pages.push(page)
      return { rows: [], rowCount: 1 }
    }
    // saveDraftSite: select existing page IDs for stale-page diffing
    if (normalized.trim() === 'select id from pages') {
      return { rows: pages.map((p) => ({ id: p.id })) as Row[], rowCount: pages.length }
    }
    // saveDraftSite: delete a single stale page — values[0]=pageId
    if (normalized.includes('delete from pages where id =')) {
      const index = pages.findIndex((p) => String(p.id) === String(values[0]))
      if (index >= 0) pages.splice(index, 1)
      return { rows: [], rowCount: 1 }
    }
    // findAdminByEmail — values[0]=email
    if (normalized.includes('select id, email, password_hash')) {
      return { rows: admins.filter((a) => a.email === values[0]) as Row[], rowCount: 1 }
    }
    // createSession — values[0]=idHash, values[1]=adminUserId, values[2]=expiresAt
    if (normalized.includes('insert into sessions')) {
      sessions.push({ id_hash: values[0], admin_user_id: values[1], expires_at: values[2] })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return Object.assign(handle as DbClient, { site, admins, sessions, pages })
}

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>
}

describe('CMS handlers', () => {
  it('reports setup status', async () => {
    const db = makeFakeDb()
    const res = await handleCmsRequest(new Request('http://localhost/api/cms/setup/status'), db)
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ hasSite: false, hasAdmin: false, needsSetup: true })
  })

  it('creates the first site, admin account, and a starter homepage', async () => {
    const db = makeFakeDb()
    const res = await handleCmsRequest(new Request('http://localhost/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({ ok: true })
    expect(db.site).toHaveLength(1)
    expect(db.admins).toHaveLength(1)
    // A starter homepage MUST be seeded — SiteDocumentSchema requires
    // pages.length >= 1, otherwise the editor errors on first load.
    expect(db.pages).toHaveLength(1)
    expect(db.pages[0]).toMatchObject({ title: 'Home', slug: 'index', sort_order: 0 })
    const doc = db.pages[0].draft_document_json as { rootNodeId: string; nodes: Record<string, { moduleId: string }> }
    expect(doc.nodes[doc.rootNodeId].moduleId).toBe('base.body')
  })

  it('refuses setup after an admin exists', async () => {
    const db = makeFakeDb()
    db.site.push({ id: 'default', name: 'Existing' })
    db.admins.push({ id: 'admin_1', email: 'owner@example.com', password_hash: 'hash' })
    const res = await handleCmsRequest(new Request('http://localhost/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'new@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    expect(res.status).toBe(409)
  })

  it('logs in and sets an HttpOnly session cookie', async () => {
    const db = makeFakeDb()
    await handleCmsRequest(new Request('http://localhost/api/cms/setup', {
      method: 'POST',
      body: JSON.stringify({ siteName: 'Example', email: 'owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    const res = await handleCmsRequest(new Request('http://localhost/api/cms/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'owner@example.com', password: 'long-enough-password' }),
      headers: { 'content-type': 'application/json' },
    }), db)
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    // Plain HTTP request → cookie must NOT carry the Secure flag, otherwise
    // browsers reject it.
    expect(cookie).not.toContain('Secure')
    expect(db.sessions).toHaveLength(1)
  })

  // ─── Secure cookie flag ─────────────────────────────────────────────────
  // The CMS terminates TLS at Caddy (compose.tls.yml) which sets
  // X-Forwarded-Proto: https on the upstream request. The handler must detect
  // this and append `Secure` to the session cookie so it is never transmitted
  // over plain HTTP. We also verify the inverse — direct HTTP requests must
  // NOT get a Secure cookie (which browsers would reject).
  describe('session cookie Secure flag', () => {
    async function loginThen(headers: HeadersInit): Promise<string> {
      const db = makeFakeDb()
      await handleCmsRequest(new Request('http://localhost/api/cms/setup', {
        method: 'POST',
        body: JSON.stringify({ siteName: 'Example', email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      const res = await handleCmsRequest(new Request('http://localhost/api/cms/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json', ...headers },
      }), db)
      expect(res.status).toBe(200)
      return res.headers.get('set-cookie') ?? ''
    }

    it('sets Secure when the request carries X-Forwarded-Proto: https', async () => {
      const cookie = await loginThen({ 'x-forwarded-proto': 'https' })
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
    })

    it('does NOT set Secure when X-Forwarded-Proto: http (i.e., plain HTTP via proxy)', async () => {
      const cookie = await loginThen({ 'x-forwarded-proto': 'http' })
      expect(cookie).not.toContain('Secure')
    })

    it('does NOT set Secure when no forwarding header is present and the request is HTTP', async () => {
      const cookie = await loginThen({})
      expect(cookie).not.toContain('Secure')
    })

    it('logout cookie also gets Secure when behind HTTPS proxy (so the browser accepts the deletion)', async () => {
      const db = makeFakeDb()
      await handleCmsRequest(new Request('http://localhost/api/cms/setup', {
        method: 'POST',
        body: JSON.stringify({ siteName: 'Example', email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      const loginRes = await handleCmsRequest(new Request('http://localhost/api/cms/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'o@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      }), db)
      const sessionCookie = (loginRes.headers.get('set-cookie') ?? '')
        .split(';')[0] // just `pb_admin_session=<token>`

      const logoutRes = await handleCmsRequest(new Request('http://localhost/api/cms/logout', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-proto': 'https',
          cookie: sessionCookie,
        },
      }), db)
      expect(logoutRes.status).toBe(200)
      const cookie = logoutRes.headers.get('set-cookie') ?? ''
      expect(cookie).toContain('Max-Age=0')
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('HttpOnly')
    })
  })

  // ─── Login rate limiting + constant-time + origin check ────────────────
  describe('login security', () => {
    /**
     * Make a login attempt with a unique XFF so the rate limit bucket key
     * doesn't bleed across tests.
     *
     * `Origin` is set on the constructed Headers post-hoc because happy-dom
     * (loaded via the test setup) strictly follows the Fetch spec's
     * "forbidden request headers" rule: passing `origin` in the Request
     * constructor's `headers` init silently drops it. In production, Bun.serve
     * receives the raw HTTP Origin header from the wire — no such filtering
     * applies. Mutating headers after Request construction works in both
     * environments, so we use that path here.
     */
    function loginRequest(email: string, password: string, xff: string, origin?: string): Request {
      const req = new Request('http://localhost/api/cms/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': xff,
        },
      })
      if (origin) req.headers.set('origin', origin)
      return req
    }

    async function makeDbWithAdmin() {
      const db = makeFakeDb()
      await handleCmsRequest(new Request('http://localhost/api/cms/setup', {
        method: 'POST',
        body: JSON.stringify({ siteName: 'X', email: 'owner@example.com', password: 'long-enough-password' }),
        headers: { 'content-type': 'application/json' },
      }), db)
      return db
    }

    it('rate-limits to 5 attempts per (IP, email), then returns 429 with Retry-After', async () => {
      // Use a unique IP+email so the singleton bucket starts fresh.
      const xff = '203.0.113.10'
      const email = 'rate-limit-test@example.com'
      loginRateLimit.reset(`${xff}|${email}`)

      const db = await makeDbWithAdmin()

      for (let i = 0; i < 5; i++) {
        const res = await handleCmsRequest(
          loginRequest(email, 'wrong-password', xff),
          db,
        )
        expect(res.status).toBe(401)
      }

      const blocked = await handleCmsRequest(
        loginRequest(email, 'wrong-password', xff),
        db,
      )
      expect(blocked.status).toBe(429)
      expect(blocked.headers.get('retry-after')).toBeTruthy()
      const body = await blocked.json() as { error: string }
      expect(body.error).toMatch(/too many/i)

      // Cleanup so the bucket doesn't leak into other tests.
      loginRateLimit.reset(`${xff}|${email}`)
    })

    it('clears the bucket on successful login (forgotten password recovery flow)', async () => {
      const xff = '203.0.113.20'
      const email = 'owner@example.com'
      loginRateLimit.reset(`${xff}|${email}`)

      const db = await makeDbWithAdmin()

      // Three failed attempts.
      for (let i = 0; i < 3; i++) {
        const res = await handleCmsRequest(
          loginRequest(email, 'wrong-password', xff),
          db,
        )
        expect(res.status).toBe(401)
      }

      // Successful login resets the quota.
      const ok = await handleCmsRequest(
        loginRequest(email, 'long-enough-password', xff),
        db,
      )
      expect(ok.status).toBe(200)

      // Now another 5 wrong attempts must still be allowed (counter was reset).
      for (let i = 0; i < 5; i++) {
        const res = await handleCmsRequest(
          loginRequest(email, 'wrong-password', xff),
          db,
        )
        expect(res.status).toBe(401)
      }

      loginRateLimit.reset(`${xff}|${email}`)
    })

    it('returns 401 (not 404) for an unknown email — same response shape as wrong-password', async () => {
      const xff = '203.0.113.30'
      const unknownEmail = 'does-not-exist@example.com'
      loginRateLimit.reset(`${xff}|${unknownEmail}`)
      loginRateLimit.reset(`${xff}|owner@example.com`)

      const db = await makeDbWithAdmin()

      // Unknown email (constant-time path runs argon2id verify against a dummy hash).
      const res = await handleCmsRequest(
        loginRequest(unknownEmail, 'long-enough-password', xff),
        db,
      )
      expect(res.status).toBe(401)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('Invalid email or password')

      // Wrong password for an existing email should produce the EXACT same
      // response shape — no enumeration via different error messages.
      const res2 = await handleCmsRequest(
        loginRequest('owner@example.com', 'wrong-password', xff),
        db,
      )
      expect(res2.status).toBe(401)
      const body2 = await res2.json() as { error: string }
      expect(body2.error).toBe('Invalid email or password')

      loginRateLimit.reset(`${xff}|${unknownEmail}`)
      loginRateLimit.reset(`${xff}|owner@example.com`)
    })

    it('rejects state-changing requests with a foreign Origin (CSRF defense)', async () => {
      const db = await makeDbWithAdmin()
      const probe = loginRequest('owner@example.com', 'long-enough-password', '203.0.113.99', 'https://evil.example.com')
      // Sanity-assert that the test fixture builds the request we expect.
      expect(probe.headers.get('origin')).toBe('https://evil.example.com')
      expect(probe.method).toBe('POST')
      const res = await handleCmsRequest(probe, db)
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toMatch(/origin/i)
    })

    it('accepts state-changing requests with no Origin (curl, server-to-server)', async () => {
      const db = await makeDbWithAdmin()
      // No `origin` header — must be allowed (covers curl/CLI/server-to-server).
      loginRateLimit.reset('203.0.113.40|owner@example.com')
      const res = await handleCmsRequest(
        loginRequest('owner@example.com', 'long-enough-password', '203.0.113.40'),
        db,
      )
      expect(res.status).toBe(200)
      loginRateLimit.reset('203.0.113.40|owner@example.com')
    })
  })
})
