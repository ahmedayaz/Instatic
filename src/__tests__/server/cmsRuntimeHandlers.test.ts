import { describe, expect, it } from 'bun:test'
import { SESSION_COOKIE_NAME } from '../../../server/cms/auth'
import type { DbClient, DbResult } from '../../../server/cms/db'
import { handleCmsRequest } from '../../../server/cms/handlers'
import type { SiteDocument } from '@core/page-tree/schemas'

class RuntimeHandlerFakeDb implements DbClient {
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): Promise<DbResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.startsWith('select admin_users.id')) {
      return {
        rows: [{
          id: 'admin_1',
          email: 'owner@example.com',
          password_hash: 'hash',
          created_at: new Date('2026-01-01').toISOString(),
        } as Row],
        rowCount: 1,
      }
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }
}

function runtimeRequest(url: string, body: unknown): Request {
  return {
    method: 'POST',
    url,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === 'cookie') return `${SESSION_COOKIE_NAME}=session-token`
        if (name.toLowerCase() === 'content-type') return 'application/json'
        return null
      },
    },
    json: async () => body,
  } as unknown as Request
}

function site(): SiteDocument {
  return {
    id: 'site_1',
    name: 'Runtime Preview',
    pages: [
      {
        id: 'page_1',
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
    packageJson: { dependencies: {}, devDependencies: {} },
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: {
      colorTokens: {},
      shortcuts: {},
    },
    classes: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('CMS runtime handlers', () => {
  it('resolves an empty runtime dependency manifest', async () => {
    const res = await handleCmsRequest(runtimeRequest(
      'http://localhost/api/cms/runtime/dependencies/resolve',
      { packageJson: { dependencies: {}, devDependencies: {} } },
    ), new RuntimeHandlerFakeDb())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      dependencyLock: { version: 1, packages: {} },
    })
  })

  it('builds a runtime preview document for a provided site and page', async () => {
    const res = await handleCmsRequest(runtimeRequest(
      'http://localhost/api/cms/runtime/preview',
      { site: site(), pageId: 'page_1' },
    ), new RuntimeHandlerFakeDb())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      html: expect.stringContaining('<!DOCTYPE html>'),
      assets: [],
      runtimeAssets: { scripts: [] },
      diagnostics: [],
    })
  })
})
