import { nanoid } from 'nanoid'
import type { SiteDocument } from '@core/page-tree/schemas'
import type { PublishedPageRuntimeAssets } from '@core/site-runtime'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { DbClient } from './db/client'
import { loadDraftSite } from './siteRepository'
import { buildSiteRuntimeScripts } from './runtime/bundleScripts'
import { ensureRuntimeDependencyCache } from './runtime/dependencyCache'
import { savePublishedRuntimeAssets } from './runtimeAssetRepository'

export interface PublishedPageSnapshot {
  cmsSnapshotVersion: 1
  pageId: string
  site: SiteDocument
  runtimeAssets?: PublishedPageRuntimeAssets
}

interface PublishResult {
  publishedPages: number
}

interface DraftPublishStatus {
  hasPublishedVersion: boolean
  draftMatchesPublished: boolean
  draftPages: number
  publishedPages: number
  lastPublishedAt?: string
}

interface ActivePublishedRow {
  page_id: string
  snapshot_json: PublishedPageSnapshot
  published_at: string | Date
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

function createSnapshot(
  site: SiteDocument,
  pageId: string,
  runtimeAssets?: PublishedPageRuntimeAssets,
): PublishedPageSnapshot {
  return {
    cmsSnapshotVersion: 1,
    pageId,
    site: structuredClone(site),
    ...(runtimeAssets && runtimeAssets.scripts.length > 0 ? { runtimeAssets } : {}),
  }
}

export async function getDraftPublishStatus(db: DbClient): Promise<DraftPublishStatus> {
  const site = await loadDraftSite(db)
  if (!site) {
    return {
      hasPublishedVersion: false,
      draftMatchesPublished: false,
      draftPages: 0,
      publishedPages: 0,
    }
  }

  const { rows: publishedRows } = await db<ActivePublishedRow>`
    select pages.id as page_id,
           page_versions.snapshot_json,
           page_versions.published_at
    from pages
    join page_versions on page_versions.id = pages.active_version_id
    where pages.status = 'published'
      and pages.active_version_id is not null
    order by pages.sort_order asc, pages.created_at asc
  `

  const draftSiteJson = canonicalJson(site)
  const draftPageIds = new Set(site.pages.map((page) => page.id))
  const draftMatchesPublished =
    publishedRows.length === site.pages.length &&
    publishedRows.every((row) =>
      draftPageIds.has(row.page_id) &&
      canonicalJson(row.snapshot_json.site) === draftSiteJson
    )
  const lastPublishedAt = publishedRows
    .map((row) => new Date(row.published_at).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0]

  return {
    hasPublishedVersion: publishedRows.length > 0,
    draftMatchesPublished,
    draftPages: site.pages.length,
    publishedPages: publishedRows.length,
    ...(lastPublishedAt ? { lastPublishedAt: new Date(lastPublishedAt).toISOString() } : {}),
  }
}

export async function publishDraftSite(
  db: DbClient,
  adminUserId: string,
): Promise<PublishResult> {
  return db.transaction(async (tx) => {
    const site = await loadDraftSite(tx)
    if (!site) throw new Error('draft site not found')

    const runtime = normalizeSiteRuntimeConfig(site.runtime)
    const dependencyCache = Object.keys(runtime.dependencyLock.packages).length > 0
      ? await ensureRuntimeDependencyCache(runtime.dependencyLock)
      : undefined

    for (const page of site.pages) {
      const { rows: versionRows } = await tx<{ next_version: number }>`
        select coalesce(max(version), 0) + 1 as next_version
        from page_versions
        where page_id = ${page.id}
      `
      const version = Number(versionRows[0]?.next_version ?? 1)
      const versionId = nanoid()
      const runtimeBuild = await buildSiteRuntimeScripts({
        site,
        page,
        target: 'publish',
        assetBasePath: `/_pb/assets/${versionId}/`,
        dependencyCache,
      })
      const runtimeErrors = runtimeBuild.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
      if (runtimeErrors.length > 0) {
        throw new Error(`runtime build failed: ${runtimeErrors.map((diagnostic) => diagnostic.message).join('; ')}`)
      }

      await tx`
        insert into page_versions (id, page_id, version, snapshot_json, published_by)
        values (
          ${versionId},
          ${page.id},
          ${version},
          ${createSnapshot(site, page.id, runtimeBuild.runtimeAssets)},
          ${adminUserId}
        )
      `
      await savePublishedRuntimeAssets(tx, versionId, runtimeBuild.files)
      await tx`
        update pages
        set active_version_id = ${versionId},
            status = 'published',
            updated_at = current_timestamp
        where id = ${page.id}
      `
    }

    return { publishedPages: site.pages.length }
  })
}

export async function getPublishedPageBySlug(
  db: DbClient,
  slug: string,
): Promise<PublishedPageSnapshot | null> {
  const { rows } = await db<{ snapshot_json: PublishedPageSnapshot }>`
    select page_versions.snapshot_json
    from pages
    join page_versions on page_versions.id = pages.active_version_id
    where pages.slug = ${slug}
      and pages.status = 'published'
    limit 1
  `
  return rows[0]?.snapshot_json ?? null
}

export async function getLatestPublishedSiteSnapshot(
  db: DbClient,
): Promise<PublishedPageSnapshot | null> {
  const { rows } = await db<{ snapshot_json: PublishedPageSnapshot }>`
    select page_versions.snapshot_json
    from pages
    join page_versions on page_versions.id = pages.active_version_id
    where pages.status = 'published'
      and pages.active_version_id is not null
    order by pages.sort_order asc, pages.created_at asc
    limit 1
  `
  return rows[0]?.snapshot_json ?? null
}
