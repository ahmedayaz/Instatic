import type { SiteDocument, Page } from '@core/page-tree/schemas'
import {
  DEFAULT_BREAKPOINTS,
  DEFAULT_SITE_SETTINGS,
} from '@core/page-tree/schemas'
import { validateSite } from '@core/persistence/validate'
import { normalizeSitePackageJson } from '@core/site-dependencies/manifest'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { DbClient } from '../db/client'
import type { SiteRow } from '../types'

const CMS_SITE_SCHEMA_VERSION = 1

type SiteShell = Omit<SiteDocument, 'name' | 'pages'>

interface StoredSiteShell {
  cmsSiteSchemaVersion: 1
  site: SiteShell
}

interface PageDraftRow {
  id: string
  title: string
  slug: string
  draft_document_json: Page
  sort_order: number
  owner_user_id: string | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
}

function siteShell(site: SiteDocument): StoredSiteShell {
  return {
    cmsSiteSchemaVersion: CMS_SITE_SCHEMA_VERSION,
    site: {
      id: site.id,
      files: site.files,
      visualComponents: site.visualComponents,
      packageJson: site.packageJson,
      runtime: site.runtime,
      breakpoints: site.breakpoints,
      settings: site.settings,
      classes: site.classes,
      createdAt: site.createdAt,
      updatedAt: site.updatedAt,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readStoredShell(row: SiteRow): SiteShell {
  const settings = row.settings_json
  const site = isRecord(settings.site) ? settings.site : {}
  return {
    id: typeof site.id === 'string' ? site.id : 'default',
    files: Array.isArray(site.files) ? site.files as SiteDocument['files'] : [],
    visualComponents: Array.isArray(site.visualComponents)
      ? site.visualComponents as SiteDocument['visualComponents']
      : [],
    packageJson: normalizeSitePackageJson(site.packageJson),
    runtime: normalizeSiteRuntimeConfig(site.runtime),
    breakpoints: Array.isArray(site.breakpoints)
      ? site.breakpoints as SiteDocument['breakpoints']
      : DEFAULT_BREAKPOINTS,
    settings: isRecord(site.settings)
      ? site.settings as unknown as SiteDocument['settings']
      : DEFAULT_SITE_SETTINGS,
    classes: isRecord(site.classes) ? site.classes as SiteDocument['classes'] : {},
    createdAt: typeof site.createdAt === 'number' ? site.createdAt : Date.parse(String(row.created_at)),
    updatedAt: typeof site.updatedAt === 'number' ? site.updatedAt : Date.parse(String(row.updated_at)),
  }
}

function withPageOwnership(
  page: Page,
  ownership: {
    ownerUserId: string | null
    createdByUserId: string | null
    updatedByUserId: string | null
  },
): Page {
  return {
    ...page,
    ownerUserId: ownership.ownerUserId,
    createdByUserId: ownership.createdByUserId,
    updatedByUserId: ownership.updatedByUserId,
  }
}

export async function saveDraftSite(db: DbClient, site: SiteDocument, actorUserId: string | null = null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx`
      insert into site (id, name, settings_json)
      values ('default', ${site.name}, ${siteShell(site)})
      on conflict (id) do update
        set name = excluded.name,
            settings_json = excluded.settings_json,
            updated_at = current_timestamp
    `

    for (let index = 0; index < site.pages.length; index++) {
      const page = site.pages[index]
      const ownerUserId = page.ownerUserId ?? actorUserId
      const createdByUserId = page.createdByUserId ?? actorUserId
      const updatedByUserId = actorUserId ?? page.updatedByUserId ?? null
      const pageDocument = withPageOwnership(page, {
        ownerUserId,
        createdByUserId,
        updatedByUserId,
      })
      await tx`
        insert into pages (
          id,
          title,
          slug,
          draft_document_json,
          sort_order,
          owner_user_id,
          created_by_user_id,
          updated_by_user_id
        )
        values (
          ${page.id},
          ${page.title},
          ${page.slug},
          ${pageDocument},
          ${index},
          ${ownerUserId},
          ${createdByUserId},
          ${updatedByUserId}
        )
        on conflict (id) do update
          set title = excluded.title,
              slug = excluded.slug,
              draft_document_json = excluded.draft_document_json,
              sort_order = excluded.sort_order,
              owner_user_id = coalesce(pages.owner_user_id, excluded.owner_user_id),
              created_by_user_id = coalesce(pages.created_by_user_id, excluded.created_by_user_id),
              updated_by_user_id = excluded.updated_by_user_id,
              updated_at = current_timestamp
      `
    }

    const nextPageIds = new Set(site.pages.map((page) => page.id))
    const { rows: existingPageRows } = await tx<{ id: string }>`select id from pages`
    for (const { id } of existingPageRows) {
      if (!nextPageIds.has(id)) {
        await tx`delete from pages where id = ${id}`
      }
    }
  })
}

export async function loadDraftSite(db: DbClient): Promise<SiteDocument | null> {
  const { rows: siteRows } = await db<SiteRow>`
    select id, name, settings_json, created_at, updated_at
    from site
    where id = 'default'
    limit 1
  `
  const site = siteRows[0]
  if (!site) return null

  const { rows: pageRows } = await db<PageDraftRow>`
    select id, title, slug, draft_document_json, sort_order,
           owner_user_id, created_by_user_id, updated_by_user_id
    from pages
    order by sort_order asc, created_at asc
  `
  const shell = readStoredShell(site)
  return validateSite({
    ...shell,
    name: site.name,
    pages: pageRows.map((row) =>
      withPageOwnership(row.draft_document_json, {
        ownerUserId: row.owner_user_id,
        createdByUserId: row.created_by_user_id,
        updatedByUserId: row.updated_by_user_id,
      })
    ),
  })
}
