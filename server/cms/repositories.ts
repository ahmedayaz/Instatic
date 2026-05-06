import type { DbClient } from './db/client'
import type { AdminUserRow } from './types'

interface SetupStatus {
  hasSite: boolean
  hasAdmin: boolean
  needsSetup: boolean
}

export async function getSetupStatus(db: DbClient): Promise<SetupStatus> {
  const [site, admin] = await Promise.all([
    db<{ count: number }>`select count(*) as count from site`,
    db<{ count: number }>`select count(*) as count from admin_users`,
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
  await db`
    insert into site (id, name, settings_json)
    values ('default', ${name}, ${settings})
    on conflict (id) do update
      set name = excluded.name,
          settings_json = excluded.settings_json,
          updated_at = current_timestamp
  `
}

export async function createAdminUser(
  db: DbClient,
  input: { id: string; email: string; passwordHash: string },
): Promise<void> {
  await db`
    insert into admin_users (id, email, password_hash)
    values (${input.id}, ${input.email.trim().toLowerCase()}, ${input.passwordHash})
  `
}

export async function findAdminByEmail(
  db: DbClient,
  email: string,
): Promise<AdminUserRow | null> {
  const { rows } = await db<AdminUserRow>`
    select id, email, password_hash, created_at
    from admin_users
    where email = ${email.trim().toLowerCase()}
    limit 1
  `
  return rows[0] ?? null
}

export async function createSession(
  db: DbClient,
  input: { idHash: string; adminUserId: string; expiresAt: Date },
): Promise<void> {
  await db`
    insert into sessions (id_hash, admin_user_id, expires_at)
    values (${input.idHash}, ${input.adminUserId}, ${input.expiresAt})
  `
}

export async function findAdminBySessionHash(
  db: DbClient,
  idHash: string,
): Promise<AdminUserRow | null> {
  const { rows } = await db<AdminUserRow>`
    select admin_users.id,
           admin_users.email,
           admin_users.password_hash,
           admin_users.created_at
    from sessions
    join admin_users on admin_users.id = sessions.admin_user_id
    where sessions.id_hash = ${idHash}
      and sessions.expires_at > current_timestamp
    limit 1
  `
  return rows[0] ?? null
}

export async function deleteSessionByHash(db: DbClient, idHash: string): Promise<void> {
  await db`delete from sessions where id_hash = ${idHash}`
}
