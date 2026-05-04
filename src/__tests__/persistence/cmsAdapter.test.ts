import { describe, expect, it } from 'bun:test'
import type { SiteDocument } from '@core/page-tree/schemas'
import { CmsAdapter } from '@core/persistence/cms'

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

describe('CmsAdapter', () => {
  it('loads the single-site draft site from the CMS API', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const adapter = new CmsAdapter(async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ site: site() }), { status: 200 })
    })

    const loaded = await adapter.loadSite('ignored-in-single-site-mode')

    expect(loaded?.id).toBe('project_1')
    expect(calls[0]).toMatchObject({
      input: '/api/cms/site',
      init: { method: 'GET', credentials: 'include' },
    })
  })

  it('saves the draft site to the CMS API', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const adapter = new CmsAdapter(async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    await adapter.saveSite(site())

    expect(calls[0].input).toBe('/api/cms/site')
    expect(calls[0].init).toMatchObject({
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    })
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      site: { id: 'project_1', name: 'CMS Site' },
    })
  })

  it('returns undefined when no draft site exists yet', async () => {
    const adapter = new CmsAdapter(async () =>
      new Response(JSON.stringify({ error: 'draft site not found' }), { status: 404 }))

    await expect(adapter.loadSite('default')).resolves.toBeUndefined()
  })

  it('surfaces CMS save error messages from the API response body', async () => {
    const adapter = new CmsAdapter(async () =>
      new Response(JSON.stringify({ error: 'Duplicate page slug "/about"' }), { status: 400 }))

    await expect(adapter.saveSite(site())).rejects.toThrow('Duplicate page slug "/about"')
  })
})
