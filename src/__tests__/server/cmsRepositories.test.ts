import { describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/cms/db'
import {
  createAdminUser,
  createSession,
  createSite,
  findAdminByEmail,
  getSetupStatus,
} from '../../../server/cms/repositories'

class FakeDb implements DbClient {
  site: Record<string, unknown>[] = []
  admins: Record<string, unknown>[] = []
  sessions: Record<string, unknown>[] = []

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<DbResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.startsWith('select count(*)::int as count from site')) {
      return { rows: [{ count: this.site.length } as Row], rowCount: 1 }
    }
    if (normalized.startsWith('select count(*)::int as count from admin_users')) {
      return { rows: [{ count: this.admins.length } as Row], rowCount: 1 }
    }
    if (normalized.startsWith('insert into site')) {
      this.site.push({ id: 'default', name: params[0], settings_json: params[1] })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('insert into admin_users')) {
      this.admins.push({ id: params[0], email: params[1], password_hash: params[2] })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('select id, email, password_hash')) {
      return {
        rows: this.admins.filter((a) => a.email === params[0]) as Row[],
        rowCount: 1,
      }
    }
    if (normalized.startsWith('insert into sessions')) {
      this.sessions.push({ id_hash: params[0], admin_user_id: params[1], expires_at: params[2] })
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }
}

describe('CMS repositories', () => {
  it('reports setup incomplete until site and admin exist', async () => {
    const db = new FakeDb()
    expect(await getSetupStatus(db)).toEqual({ hasSite: false, hasAdmin: false, needsSetup: true })
    await createSite(db, 'Example Site', {})
    await createAdminUser(db, { id: 'admin_1', email: 'owner@example.com', passwordHash: 'hash' })
    expect(await getSetupStatus(db)).toEqual({ hasSite: true, hasAdmin: true, needsSetup: false })
  })

  it('creates and finds admins by normalized email', async () => {
    const db = new FakeDb()
    await createAdminUser(db, { id: 'admin_1', email: 'Owner@Example.com', passwordHash: 'hash' })
    expect(await findAdminByEmail(db, 'owner@example.com')).toMatchObject({
      id: 'admin_1',
      email: 'owner@example.com',
      password_hash: 'hash',
    })
  })

  it('stores session token hashes only', async () => {
    const db = new FakeDb()
    await createSession(db, { idHash: 'abc123', adminUserId: 'admin_1', expiresAt: new Date('2030-01-01') })
    expect(db.sessions[0]).toMatchObject({ id_hash: 'abc123', admin_user_id: 'admin_1' })
  })
})
