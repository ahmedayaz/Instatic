# Deployment overview

This index maps every supported deployment target to the exact compose command and the docs you'll need. Pick a row, follow the linked guide.

## TL;DR — most self-hosters want this

```sh
docker compose -f compose.prod.yml -f compose.sqlite.yml up -d
```

That's the whole install. **No `.env` required** — SQLite mode disables the Postgres service entirely and every other variable has a sensible default. One container, SQLite on a named volume, public on `http://server-ip:3001`.

Until the public Docker image is published, swap `compose.sqlite.yml` for `-f compose.sqlite.yml -f compose.build.yml --build` to build the image from source — still no `.env` needed.

To put auto-provisioned HTTPS in front, set `DOMAIN` (and optionally `LETSENCRYPT_EMAIL`) in an `.env` file and add `-f compose.tls.yml` — see [tls-caddy.md](tls-caddy.md).

That's the recommended default for a single-VPS install. Read on if you need to know why, or you have advanced requirements (multi-author teams, horizontal scale, existing Postgres infrastructure).

## Pick your database engine

The CMS supports **SQLite** and **Postgres**. The choice is one env var (`DATABASE_URL`) and one compose override — there is **no other difference** in the code, the image, or the binary. Docker is purely packaging; both engines run with or without Docker.

### Default: SQLite

**Recommended for most users.** Use SQLite when:

- You're hosting a single site (hobby site, small business, blog, marketing site, docs site).
- You have one to a few admin authors who don't typically save simultaneously.
- You want the simplest possible operations: 1 container, file-based backup (`cp cms.db cms.db.bak`), no DB process to babysit.
- You want minimal RAM (~80 MB floor for the app container).

The CMS publishes static HTML, so visitor traffic does not touch the database. SQLite's single-writer constraint only affects admin concurrency, not site traffic — a SQLite-backed CMS happily serves millions of visitors.

### Advanced: Postgres

**Upgrade to Postgres when:**

- **Multiple admins edit the CMS at the same time.** SQLite serializes writes (one writer at a time, WAL still allows concurrent reads). If you have an editorial team of 3+ people saving pages simultaneously, you will hit contention.
- **You need to run more than one app container.** SQLite is file-locked, so horizontal scale of the app process means Postgres.
- **You already operate Postgres** and prefer to use it (managed RDS / Supabase / your own instance).
- **You want `pg_dump` / streaming replication** instead of file-copy or [Litestream](https://litestream.io).

Postgres adds a second container (~256 MB RAM floor for `postgres`) and ops surface (passwords, backups, version upgrades) in exchange for these properties.

## Self-host compose matrix

Every production stack starts with `compose.prod.yml`. Layered overrides switch the database engine and add a TLS-terminating reverse proxy.

| Stack command | Engine | Public surface | Containers | Docs |
|---|---|---|---|---|
| `docker compose -f compose.prod.yml -f compose.sqlite.yml up -d` ⭐ default | SQLite | `http://server:${HOST_PORT}` | `app` only | [sqlite-install.md](sqlite-install.md) |
| `docker compose -f compose.prod.yml -f compose.sqlite.yml -f compose.tls.yml up -d` ⭐ default + HTTPS | SQLite | `https://${DOMAIN}` | `app` + `caddy` | [sqlite-install.md](sqlite-install.md) + [tls-caddy.md](tls-caddy.md) |
| `docker compose -f compose.prod.yml up -d` | Postgres | `http://server:${HOST_PORT}` | `app` + `postgres` | [vps-compose.md](vps-compose.md) |
| `docker compose -f compose.prod.yml -f compose.tls.yml up -d` | Postgres | `https://${DOMAIN}` | `app` + `postgres` + `caddy` | [tls-caddy.md](tls-caddy.md) |

Build-from-source (when no published image exists yet): append `-f compose.build.yml --build` to any of the above and ensure `PAGE_BUILDER_IMAGE` resolves to a tag your local Docker daemon can produce.

### No-Docker installs

You don't need Docker at all if you'd rather run Bun directly on the host:

```sh
# SQLite (default)
DATABASE_URL=sqlite:./cms.db bun run server/index.ts

# Postgres (point at any Postgres you already operate)
DATABASE_URL=postgres://user:pw@host:5432/db bun run server/index.ts
```

Same code, same migrations, same image — just no container around it. Docker is only there to handle Bun + DB + reverse-proxy install on hosts where you don't want to manage runtimes.

## Per-mode trade-offs

| Criterion | SQLite (default) | Postgres (advanced) |
|---|---|---|
| Container count | 1 | 2 |
| RAM floor | ~80 MB (app) | ~80 MB (app) + ~256 MB (postgres) |
| Concurrent admin writers | One at a time (WAL allows concurrent reads) | Many |
| Horizontal scale (>1 app instance) | ❌ (file-locked) | ✅ |
| Backup tooling | File copy / [Litestream](https://litestream.io) | `pg_dump` / streaming replication |
| Setup complexity | Trivial | Low |
| Best for | Hobby sites, single-author / small teams | Multi-author editorial teams, anything needing horizontal scale |

## Other deployment targets

- **Just running locally?** → use `bun run dev`. SQLite, no Docker, no env file. See the project [README](../../README.md#local-development).

## File reference

| File | Role |
|---|---|
| `compose.prod.yml` | Production stack base (Postgres + app, ports + healthchecks + restart policies) |
| `compose.sqlite.yml` | Override that disables Postgres and points DATABASE_URL at a SQLite file |
| `compose.tls.yml` | Override that adds Caddy in front for HTTPS via Let's Encrypt |
| `compose.build.yml` | Override that builds the app image from source instead of pulling |
| `docker-compose.yml` | Local-dev Postgres (used by `bun run dev` Postgres mode) — not a prod file |
| `Dockerfile` | The production app image |
| `Caddyfile` | TLS reverse-proxy config consumed by `compose.tls.yml` |
| `.env.production.example` | Production env template — copy to `.env` and edit |

## Documentation

- [SQLite deployment](sqlite-install.md) — recommended default; when to use it, Litestream replication, when to upgrade
- [VPS Docker Compose (Postgres)](vps-compose.md) — step-by-step VPS install with Postgres
- [HTTPS via Caddy](tls-caddy.md) — auto-TLS layered on either DB mode
- [Production Docker image](docker-image.md) — building, tagging, running standalone
- [Backup and restore](backup-restore.md) — SQLite + Postgres, ad-hoc + Litestream
- [Release and image publishing workflow](release-workflow.md) — tag → GHCR → `docker pull`

## Image registry

- `PAGE_BUILDER_IMAGE` defaults to `ghcr.io/GITHUB_OWNER/IMAGE_NAME:latest` (placeholder).
- For a local build: `docker build -t page-builder-cms:local .` and set `PAGE_BUILDER_IMAGE=page-builder-cms:local` in `.env`.
- Once the public release lands, the placeholders get replaced with the real image name everywhere.
