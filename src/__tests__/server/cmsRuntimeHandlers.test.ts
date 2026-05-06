import { describe, expect, it } from 'bun:test'
import { SESSION_COOKIE_NAME } from '../../../server/cms/auth'
import type { DbClient, DbResult } from '../../../server/cms/db'
import { handleCmsRequest } from '../../../server/cms/handlers'
import type { SiteDocument } from '@core/page-tree/schemas'

function makeFakeDb(): DbClient {
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    // findAdminBySessionHash — return a hardcoded admin regardless of session hash
    if (normalized.includes('select admin_users.id')) {
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

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return handle as DbClient
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
            moduleId: 'base.body',
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
    ), makeFakeDb())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      dependencyLock: { version: 1, packages: {} },
    })
  })

  it('builds a runtime preview document for a provided site and page', async () => {
    const res = await handleCmsRequest(runtimeRequest(
      'http://localhost/api/cms/runtime/preview',
      { site: site(), pageId: 'page_1' },
    ), makeFakeDb())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      html: expect.stringContaining('<!DOCTYPE html>'),
      assets: [],
      runtimeAssets: { scripts: [] },
      diagnostics: [],
    })
  })
})
