import type { DbClient } from './db'
import type { AdminUserRow } from './types'

export interface SetupStatus {
  hasSite: boolean
  hasAdmin: boolean
  needsSetup: boolean
}

export async function getSetupStatus(db: DbClient): Promise<SetupStatus> {
  const [site, admin] = await Promise.all([
    db.query<{ count: number }>('select count(*)::int as count from site'),
    db.query<{ count: number }>('select count(*)::int as count from admin_users'),
  ])
  const hasSite = Number(site.rows[0]?.count ?? 0) > 0
  const hasAdmin = Number(admin.rows[0]?.count ?? 0) > 0
  return { hasSite, hasAdmin, needsSetup: !hasSite || !hasAdmin }
}

export async function createSite(
  db: DbClient,
  name: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into site (id, name, settings_json)
     values ('default', $1, $2)
     on conflict (id) do update
       set name = excluded.name,
           settings_json = excluded.settings_json,
           updated_at = now()`,
    [name, settings],
  )
}

export async function createAdminUser(
  db: DbClient,
  input: { id: string; email: string; passwordHash: string },
): Promise<void> {
  await db.query(
    'insert into admin_users (id, email, password_hash) values ($1, $2, $3)',
    [input.id, input.email.trim().toLowerCase(), input.passwordHash],
  )
}

export async function findAdminByEmail(
  db: DbClient,
  email: string,
): Promise<AdminUserRow | null> {
  const result = await db.query<AdminUserRow>(
    `select id, email, password_hash, created_at
     from admin_users
     where email = $1
     limit 1`,
    [email.trim().toLowerCase()],
  )
  return result.rows[0] ?? null
}

export async function createSession(
  db: DbClient,
  input: { idHash: string; adminUserId: string; expiresAt: Date },
): Promise<void> {
  await db.query(
    'insert into sessions (id_hash, admin_user_id, expires_at) values ($1, $2, $3)',
    [input.idHash, input.adminUserId, input.expiresAt],
  )
}
