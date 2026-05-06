import { describe, expect, it } from 'bun:test'
import { handleServerRequest } from '../../../server/router'
import type { DbClient, DbResult } from '../../../server/cms/db'

interface FakeDbCounts {
  site: number
  adminUsers: number
}

function makeFakeDb(counts: FakeDbCounts = { site: 0, adminUsers: 0 }): DbClient {
  const handle = async <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.toLowerCase()
    if (normalized.includes('count(*) as count from site')) {
      return { rows: [{ count: counts.site } as Row], rowCount: 1 }
    }
    if (normalized.includes('count(*) as count from admin_users')) {
      return { rows: [{ count: counts.adminUsers } as Row], rowCount: 1 }
    }
    // Catch-all: unknown queries (e.g. publishRepository.getPublishedPageBySlug) return empty
    return { rows: [], rowCount: 0 }
  }

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return handle as DbClient
}

describe('server router', () => {
  it('serves health checks', async () => {
    const res = await handleServerRequest(new Request('http://localhost/health'), { db: makeFakeDb() })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok' })
  })

  it('routes cms setup status', async () => {
    const res = await handleServerRequest(new Request('http://localhost/api/cms/setup/status'), { db: makeFakeDb() })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ needsSetup: true })
  })

  it('redirects unmatched public routes to /admin on a fresh install', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/'),
      { db: makeFakeDb({ site: 0, adminUsers: 0 }) },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin')
  })

  it('returns 404 for unknown routes once setup is complete', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/nope'),
      { db: makeFakeDb({ site: 1, adminUsers: 1 }) },
    )
    expect(res.status).toBe(404)
  })

  it('explains where the admin UI lives when /admin is hit on the cms port without a build', async () => {
    const res = await handleServerRequest(
      new Request('http://localhost/admin'),
      { db: makeFakeDb() },
    )
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('http://localhost:5173/admin')
  })
})
