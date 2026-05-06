import { describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/cms/db'
import {
  createAdminUser,
  createSession,
  createSite,
  findAdminByEmail,
  getSetupStatus,
} from '../../../server/cms/repositories'

function makeFakeDb() {
  const site: Record<string, unknown>[] = []
  const admins: Record<string, unknown>[] = []
  const sessions: Record<string, unknown>[] = []

  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    // Reconstruct a parameterized SQL string for pattern matching.
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('count(*) as count from site')) {
      return { rows: [{ count: site.length } as Row], rowCount: 1 }
    }
    if (normalized.includes('count(*) as count from admin_users')) {
      return { rows: [{ count: admins.length } as Row], rowCount: 1 }
    }
    if (normalized.includes('insert into site')) {
      // values: [name, settings] — 'default' id is a literal in the SQL
      site.push({ id: 'default', name: values[0], settings_json: values[1] })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('insert into admin_users')) {
      // values: [id, email, passwordHash]
      admins.push({ id: values[0], email: values[1], password_hash: values[2] })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('select id, email, password_hash')) {
      // values: [email]
      return {
        rows: admins.filter((a) => a.email === values[0]) as Row[],
        rowCount: 1,
      }
    }
    if (normalized.includes('insert into sessions')) {
      // values: [idHash, adminUserId, expiresAt]
      sessions.push({ id_hash: values[0], admin_user_id: values[1], expires_at: values[2] })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return Object.assign(handle as DbClient, { site, admins, sessions })
}

describe('CMS repositories', () => {
  it('reports setup incomplete until site and admin exist', async () => {
    const db = makeFakeDb()
    expect(await getSetupStatus(db)).toEqual({ hasSite: false, hasAdmin: false, needsSetup: true })
    await createSite(db, 'Example Site', {})
    await createAdminUser(db, { id: 'admin_1', email: 'owner@example.com', passwordHash: 'hash' })
    expect(await getSetupStatus(db)).toEqual({ hasSite: true, hasAdmin: true, needsSetup: false })
  })

  it('creates and finds admins by normalized email', async () => {
    const db = makeFakeDb()
    await createAdminUser(db, { id: 'admin_1', email: 'Owner@Example.com', passwordHash: 'hash' })
    expect(await findAdminByEmail(db, 'owner@example.com')).toMatchObject({
      id: 'admin_1',
      email: 'owner@example.com',
      password_hash: 'hash',
    })
  })

  it('stores session token hashes only', async () => {
    const db = makeFakeDb()
    await createSession(db, { idHash: 'abc123', adminUserId: 'admin_1', expiresAt: new Date('2030-01-01') })
    expect(db.sessions[0]).toMatchObject({ id_hash: 'abc123', admin_user_id: 'admin_1' })
  })
})
