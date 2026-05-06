# SQLite deployment

## When to use SQLite

The CMS supports SQLite as a first-class database engine alongside Postgres. SQLite is the right choice when:

- You're a contributor or solo developer running locally (`bun run dev` defaults to SQLite — no Docker required).
- You're deploying to a single VPS, Raspberry Pi, NAS, or other small instance and don't want to operate a separate Postgres process.
- You're hosting multi-tenant SaaS with strict per-tenant data isolation (one SQLite file per tenant).
- You want simple file-based backups (just copy the `.db` file).

Use Postgres when:

- You expect concurrent writers (multiple admin users editing simultaneously).
- You need horizontal scale-out or replication beyond Litestream.
- You already operate Postgres infrastructure.

## Single-writer trade-off

SQLite supports one concurrent writer at a time. For the CMS workload this is fine — admin actions are infrequent, page reads serve from generated static HTML, and the WAL mode pragma we set means readers don't block writers. If your site has dozens of simultaneous editors making changes, switch to Postgres.

## Local development

```sh
bun install
bun run dev
# Server starts on http://localhost:3001/admin with SQLite at .tmp/dev.db
```

No Docker, no postgres, no setup. The migrations run automatically on first boot.

## Production deployment

Use the `compose.sqlite.yml` override file:

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

This disables the postgres service and mounts a `data` volume at `/app/data` for the SQLite database. The `DATABASE_URL` env is set to `sqlite:/app/data/cms.db` automatically.

## Backup & durability with Litestream

[Litestream](https://litestream.io) replicates SQLite databases to S3, Backblaze, GCS, etc. in real time. Recommended for production SQLite deployments:

```yaml
# Add to compose.sqlite.yml
  litestream:
    image: litestream/litestream
    command: replicate
    volumes:
      - data:/app/data:ro
      - ./litestream.yml:/etc/litestream.yml
    depends_on:
      - app
```

With Litestream, your SQLite deployment has continuous off-site backup with second-level RPO.

## Migrating from SQLite to Postgres

If your traffic outgrows SQLite, migrate to Postgres:

1. Export data from SQLite with [`sqlite3 dump`](https://sqlite.org/cli.html) or a custom tool.
2. Stand up Postgres, run migrations against it (the CMS does this on first boot).
3. Import the data via psql.
4. Set `DATABASE_URL=postgres://...` and restart the CMS.

The migrations are dialect-translated but otherwise identical, so the schema shape matches. Field-by-field data import is the part you have to write yourself — there's no built-in migration tool yet (PRs welcome).

## Choosing between SQLite and Postgres

| Criterion | SQLite | Postgres |
|---|---|---|
| Setup complexity | Zero (file-based) | Docker or managed service |
| Concurrent writers | One at a time | Many |
| Backup | Copy file (or Litestream) | pg_dump / streaming replication |
| Horizontal scale | None (vertical only) | Read replicas, sharding |
| Operational overhead | Trivial | Moderate |
| CMS workload fit | Excellent for solo / small teams | Excellent for any scale |
