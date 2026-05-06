import type { DbClient } from './client'

export interface Migration {
  id: string
  sql: string
}

/**
 * Apply any pending migrations to the database. Creates the schema_migrations
 * tracking table if it doesn't already exist, then runs each migration that
 * hasn't been recorded yet — inside a transaction so a partial failure leaves
 * the database unchanged.
 *
 * The schema_migrations table uses portable SQL (TEXT + current_timestamp) so
 * this function works identically against both the Postgres and SQLite adapters.
 */
export async function runMigrations(db: DbClient, migrations: Migration[]): Promise<void> {
  await db.unsafe(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at text not null default current_timestamp
    )
  `)

  for (const migration of migrations) {
    const { rows } = await db<{ id: string }>`
      select id from schema_migrations where id = ${migration.id}
    `
    if (rows.length > 0) continue

    await db.transaction(async (tx) => {
      // migration.sql is a multi-statement DDL/DML string — unsafe() is
      // required because tagged templates cannot accept a runtime string value,
      // and multi-statement batches are not supported by the parameterised path.
      await tx.unsafe(migration.sql)
      await tx`insert into schema_migrations (id) values (${migration.id})`
    })
  }
}
