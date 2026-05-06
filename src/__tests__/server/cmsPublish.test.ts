import { describe, expect, it } from 'bun:test'
import type { SiteDocument } from '@core/page-tree/schemas'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { DbResult } from '../../../server/cms/db'
import { saveDraftSite } from '../../../server/cms/siteRepository'
import {
  getDraftPublishStatus,
  getPublishedPageBySlug,
  publishDraftSite,
} from '../../../server/cms/publishRepository'
import { createFakeDb } from './dbTestFake'

function createPublishFakeDb() {
  const state = {
    site: null as Record<string, unknown> | null,
    pages: [] as Record<string, unknown>[],
    versions: [] as Record<string, unknown>[],
    runtimeAssets: [] as Record<string, unknown>[],
  }

  const db = createFakeDb(async (rawSql, params): Promise<DbResult> => {
    const sql = rawSql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (sql.startsWith('insert into site')) {
      state.site = {
        id: 'default',
        name: params[0],
        settings_json: params[1],
        created_at: new Date('2026-01-01').toISOString(),
        updated_at: new Date('2026-01-02').toISOString(),
      }
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('insert into pages')) {
      const patch = {
        id: params[0],
        title: params[1],
        slug: params[2],
        draft_document_json: params[3],
        sort_order: params[4],
      }
      const index = state.pages.findIndex((p) => p.id === patch.id)
      if (index >= 0) state.pages[index] = { ...state.pages[index], ...patch }
      else state.pages.push({ ...patch, status: 'draft', active_version_id: null })
      return { rows: [], rowCount: 1 }
    }
    if (sql === 'select id from pages') {
      return { rows: state.pages.map((p) => ({ id: p.id })), rowCount: state.pages.length }
    }
    if (sql.startsWith('delete from pages where id =')) {
      const id = params[0] as string
      state.pages = state.pages.filter((p) => p.id !== id)
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('select id, name, settings_json')) {
      return { rows: state.site ? [state.site] : [], rowCount: state.site ? 1 : 0 }
    }
    if (sql.startsWith('select id, title, slug, draft_document_json')) {
      return {
        rows: [...state.pages].sort((a, b) => Number(a.sort_order) - Number(b.sort_order)),
        rowCount: state.pages.length,
      }
    }
    if (sql.startsWith('select coalesce(max(version), 0)')) {
      const pageId = params[0]
      const pageVersions = state.versions.filter((v) => v.page_id === pageId)
      const nextVersion = Math.max(0, ...pageVersions.map((v) => Number(v.version))) + 1
      return { rows: [{ next_version: nextVersion }], rowCount: 1 }
    }
    if (sql.startsWith('insert into page_versions')) {
      state.versions.push({
        id: params[0],
        page_id: params[1],
        version: params[2],
        snapshot_json: params[3],
        published_by: params[4],
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('insert into published_runtime_assets')) {
      state.runtimeAssets.push({
        id: params[0],
        page_version_id: params[1],
        asset_path: params[2],
        public_path: params[3],
        content_type: params[4],
        content_bytes: params[5],
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('update pages set active_version_id')) {
      const page = state.pages.find((p) => p.id === params[1])
      if (page) {
        page.active_version_id = params[0]
        page.status = 'published'
      }
      return { rows: [], rowCount: page ? 1 : 0 }
    }
    if (sql.startsWith('select page_versions.snapshot_json')) {
      const page = state.pages.find((p) => p.slug === params[0] && p.status === 'published')
      const version = page
        ? state.versions.find((v) => v.id === page.active_version_id)
        : undefined
      return {
        rows: version ? [{ snapshot_json: version.snapshot_json }] : [],
        rowCount: version ? 1 : 0,
      }
    }
    if (sql.startsWith('select pages.id as page_id')) {
      const rows = state.pages
        .filter((page) => page.status === 'published' && page.active_version_id)
        .map((page) => {
          const version = state.versions.find((v) => v.id === page.active_version_id)
          return version
            ? {
                page_id: page.id,
                snapshot_json: version.snapshot_json,
                published_at: version.published_at ?? new Date('2026-01-03').toISOString(),
              }
            : null
        })
        .filter(Boolean)
      return { rows, rowCount: rows.length }
    }
    throw new Error(`Unhandled SQL: ${rawSql}`)
  })

  return { state, db }
}

function site(text: string): SiteDocument {
  return {
    id: 'project_1',
    name: 'Published Site',
    pages: [
      {
        id: 'page_home',
        title: 'Home',
        slug: 'index',
        rootNodeId: 'root',
        nodes: {
          root: {
            id: 'root',
            moduleId: 'base.body',
            props: {},
            breakpointOverrides: {},
            children: ['text_1'],
          },
          text_1: {
            id: 'text_1',
            moduleId: 'base.text',
            props: { text, tag: 'h1' },
            breakpointOverrides: {},
            children: [],
          },
        },
      },
    ],
    files: [],
    visualComponents: [],
    breakpoints: [
      { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
    ],
    settings: {
      colorTokens: {},
      shortcuts: {},
    },
    classes: {},
    createdAt: 1000,
    updatedAt: 2000,
  }
}

describe('CMS publishing', () => {
  it('publishes draft pages as immutable active snapshots', async () => {
    const { state, db } = createPublishFakeDb()
    await saveDraftSite(db, site('Published headline'))

    const result = await publishDraftSite(db, 'admin_1')
    const published = await getPublishedPageBySlug(db, 'index')

    expect(result).toMatchObject({ publishedPages: 1 })
    expect(state.versions).toHaveLength(1)
    expect(published?.site.pages[0].nodes.text_1.props.text).toBe('Published headline')
  })

  it('does not expose later draft changes until another publish occurs', async () => {
    const { db } = createPublishFakeDb()
    await saveDraftSite(db, site('Public version'))
    await publishDraftSite(db, 'admin_1')

    await saveDraftSite(db, site('Draft only'))
    const published = await getPublishedPageBySlug(db, 'index')

    expect(published?.site.pages[0].nodes.text_1.props.text).toBe('Public version')
  })

  it('reports that the current draft matches the active published snapshots after publishing', async () => {
    const { db } = createPublishFakeDb()
    await saveDraftSite(db, site('Public version'))
    await publishDraftSite(db, 'admin_1')

    const status = await getDraftPublishStatus(db)

    expect(status).toMatchObject({
      hasPublishedVersion: true,
      draftMatchesPublished: true,
      draftPages: 1,
      publishedPages: 1,
    })
    expect(status.lastPublishedAt).toBeTruthy()
  })

  it('reports that the current draft no longer matches after a later draft save', async () => {
    const { db } = createPublishFakeDb()
    await saveDraftSite(db, site('Public version'))
    await publishDraftSite(db, 'admin_1')
    await saveDraftSite(db, site('Draft only'))

    const status = await getDraftPublishStatus(db)

    expect(status).toMatchObject({
      hasPublishedVersion: true,
      draftMatchesPublished: false,
      draftPages: 1,
      publishedPages: 1,
    })
  })

  it('stores built runtime assets with the published page version', async () => {
    const { state, db } = createPublishFakeDb()
    const draft = site('Runtime page')
    draft.files = [
      {
        id: 'entry',
        path: 'src/scripts/entry.ts',
        type: 'script',
        content: `window.__publishedRuntime = 'ok'`,
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    draft.packageJson = { dependencies: {}, devDependencies: {} }
    draft.runtime = normalizeSiteRuntimeConfig({
      scripts: {
        entry: {
          placement: 'body-end',
          priority: 10,
        },
      },
    })
    await saveDraftSite(db, draft)

    await publishDraftSite(db, 'admin_1')
    const published = await getPublishedPageBySlug(db, 'index')

    expect(state.runtimeAssets.length).toBeGreaterThan(0)
    expect(String(state.runtimeAssets[0].public_path)).toContain('/_pb/assets/')
    expect(published?.runtimeAssets?.scripts).toHaveLength(1)
    expect(published?.runtimeAssets?.scripts[0].src).toBe(state.runtimeAssets[0].public_path)
  })
})
