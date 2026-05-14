import { describe, expect, it } from 'bun:test'
import type { SiteDocument } from '@core/page-tree/schemas'
import { SiteValidationError } from '@core/persistence/validate'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { DbResult } from '../../../server/db'
import {
  loadDraftSite,
  saveDraftSite,
} from '../../../server/repositories/site'
import { createFakeDb } from './dbTestFake'

function createSiteFakeDb() {
  const state = {
    site: null as Record<string, unknown> | null,
    pages: [] as Record<string, unknown>[],
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
      const page = {
        id: params[0],
        title: params[1],
        slug: params[2],
        draft_document_json: params[3],
        sort_order: params[4],
        owner_user_id: params[5],
        created_by_user_id: params[6],
        updated_by_user_id: params[7],
        created_at: new Date('2026-01-01').toISOString(),
        updated_at: new Date('2026-01-02').toISOString(),
      }
      const index = state.pages.findIndex((p) => p.id === page.id)
      if (index >= 0) state.pages[index] = page
      else state.pages.push(page)
      return { rows: [], rowCount: 1 }
    }
    if (sql.trim().toLowerCase() === 'select id from pages') {
      return { rows: state.pages.map((p) => ({ id: p.id })), rowCount: state.pages.length }
    }
    if (sql.toLowerCase().startsWith('delete from pages where id =')) {
      state.pages = state.pages.filter((p) => String(p.id) !== String(params[0]))
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('select id, name, settings_json')) {
      return {
        rows: state.site ? [state.site] : [],
        rowCount: state.site ? 1 : 0,
      }
    }
    if (sql.startsWith('select id, title, slug, draft_document_json')) {
      return {
        rows: [...state.pages].sort((a, b) => Number(a.sort_order) - Number(b.sort_order)),
        rowCount: state.pages.length,
      }
    }
    throw new Error(`Unhandled SQL: ${rawSql}`)
  })

  return { state, db }
}

function validSite(overrides: Partial<SiteDocument> = {}): SiteDocument {
  return {
    id: 'project_1',
    name: 'Example Site',
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
            children: [],
            classIds: [],
          },
        },
      },
    ],
    files: [],
    visualComponents: [],
    packageJson: {
      dependencies: {},
      devDependencies: {},
    },
    runtime: normalizeSiteRuntimeConfig(undefined),
    breakpoints: [
      { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
    ],
    settings: {
      metaTitle: 'Example',
      colorTokens: { '--color-primary': '#111111' },
      shortcuts: {},
    },
    classes: {
      class_1: {
        id: 'class_1',
        name: 'Hero',
        styles: { color: 'red' },
        breakpointStyles: {},
        createdAt: 1,
        updatedAt: 2,
      },
    },
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

describe('CMS draft site persistence', () => {
  it('saves the single-site site shell and page draft rows', async () => {
    const { state, db } = createSiteFakeDb()
    await saveDraftSite(db, validSite(), 'user_1')

    expect(state.site).toMatchObject({ name: 'Example Site' })
    expect(state.site?.settings_json).toMatchObject({
      cmsSiteSchemaVersion: 1,
      site: {
        id: 'project_1',
        settings: { metaTitle: 'Example' },
        classes: { class_1: { name: 'Hero' } },
      },
    })
    expect(state.pages).toHaveLength(1)
    expect(state.pages[0]).toMatchObject({
      id: 'page_home',
      title: 'Home',
      slug: 'index',
      sort_order: 0,
      owner_user_id: 'user_1',
      created_by_user_id: 'user_1',
      updated_by_user_id: 'user_1',
    })
  })

  it('loads a saved draft site without reading published versions', async () => {
    const { db } = createSiteFakeDb()
    await saveDraftSite(db, validSite(), 'user_1')

    const loaded = await loadDraftSite(db)

    expect(loaded).toMatchObject({
      id: 'project_1',
      name: 'Example Site',
      settings: { metaTitle: 'Example' },
      classes: { class_1: { name: 'Hero' } },
      pages: [{
        id: 'page_home',
        title: 'Home',
        slug: 'index',
        ownerUserId: 'user_1',
        createdByUserId: 'user_1',
        updatedByUserId: 'user_1',
      }],
    })
  })

  it('validates the reconstructed draft site before returning it', async () => {
    const { state, db } = createSiteFakeDb()
    await saveDraftSite(db, validSite(), 'user_1')

    state.pages[0]!.draft_document_json = {
      ...state.pages[0]!.draft_document_json as SiteDocument['pages'][number],
      rootNodeId: 'missing-root',
      nodes: {},
    }

    await expect(loadDraftSite(db)).rejects.toThrow(SiteValidationError)
  })

  it('round-trips site runtime settings in the site shell', async () => {
    const { db } = createSiteFakeDb()
    await saveDraftSite(db, validSite({
      runtime: normalizeSiteRuntimeConfig({
        scripts: {
          script_1: {
            placement: 'head',
            priority: 10,
          },
        },
      }),
    }))

    const loaded = await loadDraftSite(db)

    expect(loaded?.runtime?.scripts.script_1).toMatchObject({
      placement: 'head',
      priority: 10,
    })
  })

  it('removes page rows that no longer exist in the draft site', async () => {
    const { state, db } = createSiteFakeDb()
    await saveDraftSite(db, validSite({
      pages: [
        validSite().pages[0],
        { ...validSite().pages[0], id: 'page_about', title: 'About', slug: 'about' },
      ],
    }))

    await saveDraftSite(db, validSite())

    expect(state.pages.map((p) => p.id)).toEqual(['page_home'])
  })
})
