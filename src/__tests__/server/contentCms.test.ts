import { describe, expect, it } from 'bun:test'
import type { DbResult } from '../../../server/cms/db'
import { migrations } from '../../../server/cms/db/migrations-pg'
import {
  createContentCollection,
  getContentEntryRedirectByRoute,
  createContentEntry,
  getPublishedContentEntryByRoute,
  listContentCollections,
  publishContentEntry,
  saveContentEntryDraft,
  updateContentCollection,
  updateContentEntryCollection,
} from '../../../server/cms/contentRepository'
import { renderContentDocumentHtml } from '../../../server/cms/contentRenderer'
import { handleServerRequest } from '../../../server/router'
import { createFakeDb } from './dbTestFake'

type QueryHandler = (sql: string, params: unknown[]) => DbResult | undefined

function makeContentFakeDb(handlers: QueryHandler[]) {
  return createFakeDb(async (rawSql, params): Promise<DbResult> => {
    const sql = rawSql.replace(/\s+/g, ' ').trim().toLowerCase()
    for (const handler of handlers) {
      const result = handler(sql, params)
      if (result) return result
    }
    throw new Error(`Unhandled SQL: ${rawSql}`)
  })
}

function rowDate(value: string) {
  return new Date(value)
}

const productCollectionFields = {
  builtIn: {
    body: true,
    featuredMedia: false,
    seo: false,
  },
  custom: [],
}

describe('content CMS migrations', () => {
  it('creates content tables and seeds the default Posts collection', () => {
    const sql = migrations.map((migration) => migration.sql).join('\n')

    expect(sql).toContain('create table if not exists content_collections')
    expect(sql).toContain('create table if not exists content_entries')
    expect(sql).toContain('create table if not exists content_entry_versions')
    expect(sql).toContain('active_version_id')
    expect(sql).toContain('create table if not exists content_entry_redirects')
    expect(sql).toContain("values ('posts', 'Posts', 'posts', '/posts', 'Post', 'Posts')")
  })
})

describe('content CMS repository', () => {
  it('lists default collections with frontend field names', async () => {
    const db = makeContentFakeDb([
      (sql) => {
        if (!sql.startsWith('select id, name, slug, route_base')) return undefined
        return {
          rows: [{
            id: 'posts',
            name: 'Posts',
            slug: 'posts',
            route_base: '/posts',
            singular_label: 'Post',
            plural_label: 'Posts',
            created_at: rowDate('2026-05-01T10:00:00Z'),
            updated_at: rowDate('2026-05-01T10:00:00Z'),
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(listContentCollections(db)).resolves.toEqual([{
      id: 'posts',
      name: 'Posts',
      slug: 'posts',
      routeBase: '/posts',
      singularLabel: 'Post',
      pluralLabel: 'Posts',
      fields: {
        builtIn: {
          body: true,
          featuredMedia: true,
          seo: true,
        },
        custom: [],
      },
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:00:00.000Z',
    }])
  })

  it('creates collections with persisted field settings', async () => {
    const db = makeContentFakeDb([
      (sql, params) => {
        if (!sql.startsWith('insert into content_collections')) return undefined
        expect(params).toEqual([
          'products',
          'Products',
          'products',
          '/products',
          'Product',
          'Products',
          productCollectionFields,
        ])
        return {
          rows: [{
            id: 'products',
            name: 'Products',
            slug: 'products',
            route_base: '/products',
            singular_label: 'Product',
            plural_label: 'Products',
            fields_json: productCollectionFields,
            created_at: rowDate('2026-05-01T10:00:00Z'),
            updated_at: rowDate('2026-05-01T10:00:00Z'),
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(createContentCollection(db, {
      id: 'products',
      name: 'Products',
      slug: 'products',
      routeBase: '/products',
      singularLabel: 'Product',
      pluralLabel: 'Products',
      fields: productCollectionFields,
    })).resolves.toMatchObject({
      id: 'products',
      fields: productCollectionFields,
    })
  })

  it('updates collection identity, route, labels, and field settings', async () => {
    const nextFields = {
      builtIn: {
        body: false,
        featuredMedia: true,
        seo: false,
      },
      custom: [],
    }
    const db = makeContentFakeDb([
      (sql, params) => {
        if (!sql.startsWith('update content_collections')) return undefined
        // Template order: SET name=$1, slug=$2, route_base=$3, singular_label=$4,
        //                     plural_label=$5, fields_json=$6  WHERE id=$7
        expect(params).toEqual([
          'Catalog',
          'catalog',
          '/catalog',
          'Product',
          'Products',
          nextFields,
          'products',
        ])
        return {
          rows: [{
            id: 'products',
            name: 'Catalog',
            slug: 'catalog',
            route_base: '/catalog',
            singular_label: 'Product',
            plural_label: 'Products',
            fields_json: nextFields,
            created_at: rowDate('2026-05-01T10:00:00Z'),
            updated_at: rowDate('2026-05-01T10:05:00Z'),
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(updateContentCollection(db, 'products', {
      name: 'Catalog',
      slug: 'catalog',
      routeBase: '/catalog',
      singularLabel: 'Product',
      pluralLabel: 'Products',
      fields: nextFields,
    })).resolves.toMatchObject({
      id: 'products',
      name: 'Catalog',
      slug: 'catalog',
      routeBase: '/catalog',
      fields: nextFields,
    })
  })

  it('moves an entry to another collection when its slug is available there', async () => {
    const db = makeContentFakeDb([
      (sql, params) => {
        if (sql.startsWith('select id, collection_id, title, slug')) {
          expect(params).toEqual(['entry_1'])
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Hello',
              slug: 'hello',
              status: 'draft',
              body_markdown: '# Hello',
              featured_media_id: null,
              seo_title: '',
              seo_description: '',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:01:00Z'),
              published_at: null,
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('select id from content_collections')) {
          expect(params).toEqual(['products'])
          return { rows: [{ id: 'products' }], rowCount: 1 }
        }
        if (sql.startsWith('select id from content_entries')) {
          // Template order: WHERE collection_id=$1 AND slug=$2 AND id <> $3
          expect(params).toEqual(['products', 'hello', 'entry_1'])
          return { rows: [], rowCount: 0 }
        }
        if (sql.startsWith('update content_entries set collection_id')) {
          // Template order: SET collection_id=$1  WHERE id=$2
          expect(params).toEqual(['products', 'entry_1'])
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'products',
              title: 'Hello',
              slug: 'hello',
              status: 'draft',
              body_markdown: '# Hello',
              featured_media_id: null,
              seo_title: '',
              seo_description: '',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:02:00Z'),
              published_at: null,
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        return undefined
      },
    ])

    await expect(updateContentEntryCollection(db, 'entry_1', 'products')).resolves.toEqual({
      ok: true,
      entry: {
        id: 'entry_1',
        collectionId: 'products',
        title: 'Hello',
        slug: 'hello',
        status: 'draft',
        bodyMarkdown: '# Hello',
        featuredMediaId: null,
        seoTitle: '',
        seoDescription: '',
        createdAt: '2026-05-01T10:00:00.000Z',
        updatedAt: '2026-05-01T10:02:00.000Z',
        publishedAt: null,
        deletedAt: null,
      },
    })
  })

  it('creates drafts, saves body markdown, and publishes a snapshot', async () => {
    const calls: string[] = []
    const db = makeContentFakeDb([
      (sql, params) => {
        calls.push(sql)
        if (sql.startsWith('insert into content_entries')) {
          expect(params).toEqual([
            'entry_1',
            'posts',
            'Hello',
            'hello',
            'draft',
            '',
            null,
            '',
            '',
          ])
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Hello',
              slug: 'hello',
              status: 'draft',
              body_markdown: '',
              featured_media_id: null,
              seo_title: '',
              seo_description: '',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:00:00Z'),
              published_at: null,
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        // publishContentEntry: UPDATE ... SET active_version_id=$1 WHERE id=$2
        if (sql.startsWith('update content_entries set status =')) {
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Hello',
              slug: 'hello',
              status: 'published',
              body_markdown: '# Hello',
              featured_media_id: null,
              seo_title: 'SEO Hello',
              seo_description: 'SEO Description',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:02:00Z'),
              published_at: rowDate('2026-05-01T10:02:00Z'),
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        // saveContentEntryDraft: UPDATE ... SET title=$1, slug=$2, ... WHERE id=$7
        if (sql.startsWith('update content_entries')) {
          expect(params).toEqual([
            'Hello',
            'hello',
            '# Hello',
            null,
            'SEO Hello',
            'SEO Description',
            'entry_1',
          ])
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Hello',
              slug: 'hello',
              status: 'draft',
              body_markdown: '# Hello',
              featured_media_id: null,
              seo_title: 'SEO Hello',
              seo_description: 'SEO Description',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:01:00Z'),
              published_at: null,
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('select content_entry_versions.slug as previous_slug')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.startsWith('select coalesce(max(version_number), 0) + 1')) {
          return { rows: [{ next_version: 1 }], rowCount: 1 }
        }
        if (sql.startsWith('select id, collection_id, title, slug')) {
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Hello',
              slug: 'hello',
              status: 'draft',
              body_markdown: '# Hello',
              featured_media_id: null,
              seo_title: 'SEO Hello',
              seo_description: 'SEO Description',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:01:00Z'),
              published_at: null,
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('insert into content_entry_versions')) {
          expect(params.slice(1)).toEqual([
            'entry_1',
            1,
            'Hello',
            'hello',
            '# Hello',
            null,
            'SEO Hello',
            'SEO Description',
          ])
          return { rows: [], rowCount: 1 }
        }
        return undefined
      },
    ])

    await createContentEntry(db, {
      id: 'entry_1',
      collectionId: 'posts',
      title: 'Hello',
      slug: 'hello',
    })
    await saveContentEntryDraft(db, 'entry_1', {
      title: 'Hello',
      slug: 'hello',
      bodyMarkdown: '# Hello',
      featuredMediaId: null,
      seoTitle: 'SEO Hello',
      seoDescription: 'SEO Description',
    })
    const result = await publishContentEntry(db, 'entry_1', 'admin_1')

    expect(result.version.versionNumber).toBe(1)
    expect(result.entry.status).toBe('published')
    // Verify the insert SQL was emitted with all 9 params
    expect(calls.some((sql) => sql.startsWith('insert into content_entry_versions'))).toBe(true)
    // Template order: SET active_version_id=$1 (versionId) WHERE id=$2 (entryId)
    expect(calls.some((sql) => sql.includes('active_version_id = $1'))).toBe(true)
  })

  it('records a redirect from the previous published slug when publishing a changed slug', async () => {
    const calls: string[] = []
    const db = makeContentFakeDb([
      (sql, params) => {
        calls.push(sql)
        if (sql.startsWith('select id, collection_id, title, slug')) {
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Post',
              slug: 'post',
              status: 'published',
              body_markdown: '# Post',
              featured_media_id: null,
              seo_title: '',
              seo_description: '',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:03:00Z'),
              published_at: rowDate('2026-05-01T10:02:00Z'),
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('select content_entry_versions.slug as previous_slug')) {
          return {
            rows: [{
              previous_slug: 'untitled',
              previous_route_base: '/posts',
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('select coalesce(max(version_number), 0) + 1')) {
          return { rows: [{ next_version: 2 }], rowCount: 1 }
        }
        if (sql.startsWith('insert into content_entry_versions')) {
          expect(params.slice(1)).toEqual([
            'entry_1',
            2,
            'Post',
            'post',
            '# Post',
            null,
            '',
            '',
          ])
          return { rows: [], rowCount: 1 }
        }
        if (sql.startsWith('update content_entries set status =')) {
          // Template order: SET active_version_id=$1 (versionId) WHERE id=$2 (entryId)
          expect(typeof params[0]).toBe('string')  // versionId (nanoid)
          expect(params[1]).toBe('entry_1')
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Post',
              slug: 'post',
              status: 'published',
              body_markdown: '# Post',
              featured_media_id: null,
              seo_title: '',
              seo_description: '',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:04:00Z'),
              published_at: rowDate('2026-05-01T10:04:00Z'),
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('insert into content_entry_redirects')) {
          expect(params.slice(1)).toEqual(['posts', '/posts', 'untitled', 'entry_1'])
          return { rows: [], rowCount: 1 }
        }
        return undefined
      },
    ])

    const result = await publishContentEntry(db, 'entry_1', 'admin_1')

    expect(result.version.versionNumber).toBe(2)
    expect(result.entry.slug).toBe('post')
    expect(calls.some((sql) => sql.startsWith('insert into content_entry_redirects'))).toBe(true)
  })

  it('resolves the active published version by collection route and entry slug', async () => {
    const db = makeContentFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select content_entry_versions.id')) return undefined
        expect(sql).toContain('content_entry_versions.id = content_entries.active_version_id')
        expect(params).toEqual(['/posts', 'hello'])
        return {
          rows: [{
            id: 'version_1',
            entry_id: 'entry_1',
            collection_id: 'posts',
            collection_slug: 'posts',
            collection_route_base: '/posts',
            version_number: 2,
            title: 'Published Hello',
            slug: 'hello',
            body_markdown: 'Published body',
            featured_media_id: null,
            seo_title: 'SEO',
            seo_description: 'Description',
            published_at: rowDate('2026-05-01T10:02:00Z'),
            created_at: rowDate('2026-05-01T10:02:00Z'),
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(getPublishedContentEntryByRoute(db, 'posts', 'hello')).resolves.toMatchObject({
      id: 'version_1',
      collectionSlug: 'posts',
      collectionRouteBase: '/posts',
      title: 'Published Hello',
      bodyMarkdown: 'Published body',
    })
  })

  it('does not resolve old published slugs after a newer version becomes active', async () => {
    const db = makeContentFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select content_entry_versions.id')) return undefined
        expect(sql).toContain('content_entry_versions.id = content_entries.active_version_id')
        expect(params).toEqual(['/posts', 'untitled'])
        return { rows: [], rowCount: 0 }
      },
    ])

    await expect(getPublishedContentEntryByRoute(db, '/posts', 'untitled')).resolves.toBeNull()
  })

  it('resolves old published slugs as redirects to the active published slug', async () => {
    const db = makeContentFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select content_entry_redirects.id')) return undefined
        expect(sql).toContain('content_entry_versions.id = target_entries.active_version_id')
        expect(params).toEqual(['/posts', 'untitled'])
        return {
          rows: [{
            id: 'redirect_1',
            from_route_base: '/posts',
            from_slug: 'untitled',
            target_route_base: '/posts',
            target_slug: 'post',
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(getContentEntryRedirectByRoute(db, '/posts', 'untitled')).resolves.toEqual({
      id: 'redirect_1',
      fromPath: '/posts/untitled',
      targetPath: '/posts/post',
    })
  })
})

describe('content CMS rendering', () => {
  it('renders markdown content as safe public HTML', () => {
    const html = renderContentDocumentHtml({
      title: 'Hello <script>alert(1)</script>',
      bodyMarkdown: [
        '# Heading',
        '',
        'Paragraph with [link](https://example.com).',
        '',
        '![Alt image](/uploads/image.png)',
        '',
        '@[video](/uploads/movie.mp4)',
      ].join('\n'),
      seoTitle: 'SEO Hello',
      seoDescription: 'Description',
      featuredMediaPath: null,
    })

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<title>SEO Hello</title>')
    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('<a href="https://example.com"')
    expect(html).toContain('<img src="/uploads/image.png" alt="Alt image"')
    expect(html).toContain('<video controls src="/uploads/movie.mp4"')
    expect(html).not.toContain('<script>')
  })
})

describe('content CMS public routes', () => {
  it('renders published custom collection entries without a page template', async () => {
    const db = makeContentFakeDb([
      (sql) => {
        if (sql.startsWith('select page_versions.snapshot_json')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.startsWith('select content_entry_versions.id')) {
          return {
            rows: [{
              id: 'version_1',
              entry_id: 'entry_1',
              collection_id: 'products',
              collection_slug: 'products',
              collection_route_base: '/products',
              version_number: 1,
              title: 'Some product',
              slug: 'some-product',
              body_markdown: 'A product body.',
              featured_media_id: null,
              featured_media_path: null,
              seo_title: '',
              seo_description: '',
              published_at: rowDate('2026-05-01T10:00:00Z'),
              created_at: rowDate('2026-05-01T10:00:00Z'),
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('select content_entry_redirects.id')) {
          return { rows: [], rowCount: 0 }
        }
        return undefined
      },
    ])

    const res = await handleServerRequest(new Request('http://localhost/products/some-product'), { db })
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('<h1>Some product</h1>')
    expect(html).toContain('<p>A product body.</p>')
  })
})
