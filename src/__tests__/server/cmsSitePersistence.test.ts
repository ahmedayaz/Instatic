import { describe, expect, it } from 'bun:test'
import type { SiteDocument } from '@core/page-tree/schemas'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { DbClient, DbResult } from '../../../server/cms/db'
import {
  loadDraftSite,
  saveDraftSite,
} from '../../../server/cms/siteRepository'

class SiteFakeDb implements DbClient {
  site: Record<string, unknown> | null = null
  pages: Record<string, unknown>[] = []

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<DbResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      return { rows: [], rowCount: 0 }
    }
    if (normalized.startsWith('insert into site')) {
      this.site = {
        id: 'default',
        name: params[0],
        settings_json: params[1],
        created_at: new Date('2026-01-01').toISOString(),
        updated_at: new Date('2026-01-02').toISOString(),
      }
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('insert into pages')) {
      const page = {
        id: params[0],
        title: params[1],
        slug: params[2],
        draft_document_json: params[3],
        sort_order: params[4],
        created_at: new Date('2026-01-01').toISOString(),
        updated_at: new Date('2026-01-02').toISOString(),
      }
      const index = this.pages.findIndex((p) => p.id === page.id)
      if (index >= 0) this.pages[index] = page
      else this.pages.push(page)
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('delete from pages where not')) {
      const ids = params[0] as string[]
      this.pages = this.pages.filter((p) => ids.includes(String(p.id)))
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('select id, name, settings_json')) {
      return { rows: this.site ? [this.site as Row] : [], rowCount: this.site ? 1 : 0 }
    }
    if (normalized.startsWith('select id, title, slug, draft_document_json')) {
      return {
        rows: [...this.pages].sort((a, b) => Number(a.sort_order) - Number(b.sort_order)) as Row[],
        rowCount: this.pages.length,
      }
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }
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
            moduleId: 'base.root',
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
    const db = new SiteFakeDb()
    await saveDraftSite(db, validSite())

    expect(db.site).toMatchObject({ name: 'Example Site' })
    expect(db.site?.settings_json).toMatchObject({
      cmsSiteSchemaVersion: 1,
      site: {
        id: 'project_1',
        settings: { metaTitle: 'Example' },
        classes: { class_1: { name: 'Hero' } },
      },
    })
    expect(db.pages).toHaveLength(1)
    expect(db.pages[0]).toMatchObject({
      id: 'page_home',
      title: 'Home',
      slug: 'index',
      sort_order: 0,
    })
  })

  it('loads a saved draft site without reading published versions', async () => {
    const db = new SiteFakeDb()
    await saveDraftSite(db, validSite())

    const loaded = await loadDraftSite(db)

    expect(loaded).toMatchObject({
      id: 'project_1',
      name: 'Example Site',
      settings: { metaTitle: 'Example' },
      classes: { class_1: { name: 'Hero' } },
      pages: [{ id: 'page_home', title: 'Home', slug: 'index' }],
    })
  })

  it('round-trips site runtime settings in the site shell', async () => {
    const db = new SiteFakeDb()
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
    const db = new SiteFakeDb()
    await saveDraftSite(db, validSite({
      pages: [
        validSite().pages[0],
        { ...validSite().pages[0], id: 'page_about', title: 'About', slug: 'about' },
      ],
    }))

    await saveDraftSite(db, validSite())

    expect(db.pages.map((p) => p.id)).toEqual(['page_home'])
  })
})
