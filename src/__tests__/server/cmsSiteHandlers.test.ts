import { describe, expect, it } from 'bun:test'
import type { SiteDocument } from '@core/page-tree/schemas'
import { SESSION_COOKIE_NAME, hashSessionToken } from '../../../server/cms/auth'
import type { DbClient, DbResult } from '../../../server/cms/db'
import { handleCmsRequest } from '../../../server/cms/handlers'

class SiteHandlerFakeDb implements DbClient {
  site: Record<string, unknown> | null = null
  admins: Record<string, unknown>[] = [
    {
      id: 'admin_1',
      email: 'owner@example.com',
      password_hash: 'hash',
      created_at: new Date('2026-01-01').toISOString(),
    },
  ]
  sessions: Record<string, unknown>[] = []
  pages: Record<string, unknown>[] = []

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<DbResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      return { rows: [], rowCount: 0 }
    }
    if (normalized.startsWith('select admin_users.id, admin_users.email')) {
      const session = this.sessions.find((s) => String(s.id_hash) === String(params[0]))
      if (!session) return { rows: [], rowCount: 0 }
      const admin = this.admins.find((a) => a.id === session.admin_user_id)
      return { rows: admin ? [admin as Row] : [], rowCount: admin ? 1 : 0 }
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

function site(): SiteDocument {
  return {
    id: 'project_1',
    name: 'CMS Site',
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

async function createCookie(db: SiteHandlerFakeDb): Promise<string> {
  const token = 'valid-session-token'
  db.sessions.push({
    id_hash: await hashSessionToken(token),
    admin_user_id: 'admin_1',
    expires_at: new Date('2030-01-01').toISOString(),
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

function cmsRequest(
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Request {
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    url,
    method: init.method ?? 'GET',
    headers: {
      get(name: string) {
        return headers.get(name.toLowerCase()) ?? null
      },
    },
    async json() {
      return init.body ? JSON.parse(init.body) : {}
    },
  } as Request
}

describe('cms site handlers', () => {
  it('requires an admin session for draft site reads', async () => {
    const db = new SiteHandlerFakeDb()
    const res = await handleCmsRequest(cmsRequest('http://localhost/api/cms/site'), db)

    expect(res.status).toBe(401)
  })

  it('saves and loads the draft site for an authenticated admin', async () => {
    const db = new SiteHandlerFakeDb()
    const cookie = await createCookie(db)

    const save = await handleCmsRequest(cmsRequest('http://localhost/api/cms/site', {
      method: 'PUT',
      body: JSON.stringify({ site: site() }),
      headers: {
        'content-type': 'application/json',
        cookie,
      },
    }), db)
    expect(save.status).toBe(200)

    const load = await handleCmsRequest(cmsRequest('http://localhost/api/cms/site', {
      headers: { cookie },
    }), db)
    expect(load.status).toBe(200)
    expect(await load.json()).toMatchObject({
      site: {
        id: 'project_1',
        name: 'CMS Site',
        pages: [{ id: 'page_home', slug: 'index' }],
      },
    })
  })
})
