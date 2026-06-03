import { describe, expect, it } from 'bun:test'
import {
  collectEnabledAdminPages,
  parsePluginManifest,
  pluginAdminPageRoute,
  validatePluginRecordData,
} from '@core/plugins/manifest'

describe('plugin manifest validation', () => {
  it('accepts a declarative admin-page plugin manifest', () => {
    const manifest = parsePluginManifest({
      id: 'local.map',
      name: 'Map Studio',
      version: '1.0.0',
      apiVersion: 1,
      description: 'Adds a map workspace to the admin.',
      adminPages: [
        {
          id: 'overview',
          title: 'Map',
          navLabel: 'Map',
          icon: 'map',
          content: {
            kind: 'map',
            heading: 'Store Map',
            body: 'Track important locations.',
            centerLabel: 'Prague',
            pins: [
              { label: 'HQ', detail: 'Main office', x: 42, y: 55 },
            ],
          },
        },
      ],
    })

    expect(manifest.id).toBe('local.map')
    expect(manifest.adminPages[0].route).toBe('/admin/plugins/local.map/overview')
    expect(pluginAdminPageRoute('local.map', 'overview')).toBe('/admin/plugins/local.map/overview')
  })

  it('accepts backend resources and resource-backed admin pages', () => {
    const manifest = parsePluginManifest({
      id: 'acme.books',
      name: 'Books',
      version: '1.0.0',
      apiVersion: 1,
      description: 'Adds a backend-backed books database.',
      permissions: ['cms.storage'],
      resources: [
        {
          id: 'books',
          title: 'Books',
          singularLabel: 'Book',
          pluralLabel: 'Books',
          fields: [
            { id: 'title', label: 'Title', type: 'text', required: true },
            { id: 'author', label: 'Author', type: 'text' },
            { id: 'notes', label: 'Notes', type: 'longtext' },
          ],
        },
      ],
      adminPages: [
        {
          id: 'books',
          title: 'Books',
          navLabel: 'Books',
          content: {
            kind: 'resource',
            heading: 'Books',
            resource: 'books',
          },
        },
      ],
    })

    expect(manifest.resources[0].fields[0]).toMatchObject({
      id: 'title',
      label: 'Title',
      type: 'text',
      required: true,
    })
    expect(manifest.adminPages[0].content).toMatchObject({
      kind: 'resource',
      resource: 'books',
    })
  })

  it('preserves networkAllowedHosts on the parsed manifest', () => {
    // Regression: the parser previously dropped this field on the way out,
    // so even plugins that declared an allowlist saw every gated fetch
    // rejected at the host with "host not in allowlist" — making
    // `network.outbound` effectively unusable. The host's gated-fetch
    // check (server/plugins/pluginWorkerHost.ts:performGatedFetch) reads
    // this list straight off the parsed manifest.
    const manifest = parsePluginManifest({
      id: 'acme.fetch',
      name: 'Fetch demo',
      version: '1.0.0',
      apiVersion: 1,
      permissions: ['network.outbound'],
      networkAllowedHosts: ['example.com', 'api.github.com', '*.github.com'],
    })
    expect(manifest.networkAllowedHosts).toEqual([
      'example.com',
      'api.github.com',
      '*.github.com',
    ])
  })

  // Defense-in-depth for ISS-011 / ISS-005: an allowlist should never name a
  // raw internal target. The load-bearing SSRF block is in performGatedFetch,
  // but the manifest parser fails closed on IP literals and localhost so the
  // operator gets a clear signal at install time.
  it('rejects IP-literal entries in networkAllowedHosts', () => {
    for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '*.192.168.0.1']) {
      expect(() =>
        parsePluginManifest({
          id: 'acme.fetch',
          name: 'Fetch demo',
          version: '1.0.0',
          apiVersion: 1,
          permissions: ['network.outbound'],
          networkAllowedHosts: [host],
        }),
      ).toThrow(/IP literal/i)
    }
  })

  it('rejects localhost in networkAllowedHosts', () => {
    for (const host of ['localhost', 'api.localhost']) {
      expect(() =>
        parsePluginManifest({
          id: 'acme.fetch',
          name: 'Fetch demo',
          version: '1.0.0',
          apiVersion: 1,
          permissions: ['network.outbound'],
          networkAllowedHosts: [host],
        }),
      ).toThrow(/localhost/i)
    }
  })

  it('accepts packaged JavaScript app admin pages', () => {
    const manifest = parsePluginManifest({
      id: 'acme.insights',
      name: 'Insights Dashboard',
      version: '1.0.0',
      apiVersion: 1,
      resources: [
        {
          id: 'metrics',
          title: 'Metrics',
          fields: [
            { id: 'label', label: 'Label', type: 'text', required: true },
            { id: 'value', label: 'Value', type: 'number', required: true },
          ],
        },
      ],
      adminPages: [
        {
          id: 'dashboard',
          title: 'Dashboard',
          navLabel: 'Insights',
          content: {
            kind: 'app',
            heading: 'Insights Dashboard',
            entry: 'admin/dashboard.js',
          },
        },
      ],
    })

    expect(manifest.adminPages[0].content).toMatchObject({
      kind: 'app',
      entry: 'admin/dashboard.js',
    })
  })

  it('rejects unsafe JavaScript app entry paths', () => {
    expect(() =>
      parsePluginManifest({
        id: 'acme.badapp',
        name: 'Bad App',
        version: '1.0.0',
        apiVersion: 1,
        adminPages: [{
          id: 'dashboard',
          title: 'Dashboard',
          content: { kind: 'app', heading: 'Dashboard', entry: '../secrets.js' },
        }],
      }),
    ).toThrow('Invalid plugin manifest')
  })

  it('accepts a server-shaped assetBasePath that matches the plugin id and version', () => {
    const manifest = parsePluginManifest({
      id: 'acme.workflow',
      name: 'Workflow',
      version: '1.2.3',
      apiVersion: 1,
      assetBasePath: '/uploads/plugins/acme.workflow/1.2.3',
      entrypoints: { server: 'server/index.js' },
    })
    expect(manifest.assetBasePath).toBe('/uploads/plugins/acme.workflow/1.2.3')
  })

  it('rejects assetBasePath containing path traversal segments', () => {
    expect(() =>
      parsePluginManifest({
        id: 'atk.evil',
        name: 'evil',
        version: '1.0.0',
        apiVersion: 1,
        assetBasePath: '/uploads/plugins/../../etc',
        entrypoints: { server: 'pwn.js' },
      }),
    ).toThrow('Invalid plugin manifest')
  })

  it('rejects assetBasePath outside /uploads/plugins/', () => {
    expect(() =>
      parsePluginManifest({
        id: 'atk.evil',
        name: 'evil',
        version: '1.0.0',
        apiVersion: 1,
        assetBasePath: '/etc',
      }),
    ).toThrow('Invalid plugin manifest')

    expect(() =>
      parsePluginManifest({
        id: 'atk.evil',
        name: 'evil',
        version: '1.0.0',
        apiVersion: 1,
        assetBasePath: '/uploads/anywhere/atk.evil/1.0.0',
      }),
    ).toThrow('Invalid plugin manifest')
  })

  it('rejects assetBasePath that does not match the manifest id+version', () => {
    expect(() =>
      parsePluginManifest({
        id: 'atk.evil',
        name: 'evil',
        version: '1.0.0',
        apiVersion: 1,
        // Schema-level pattern accepts this shape, but the post-parse
        // cross-check rejects it because it points at someone else's plugin.
        assetBasePath: '/uploads/plugins/legit.workflow/2.0.0',
      }),
    ).toThrow('assetBasePath must equal "/uploads/plugins/atk.evil/1.0.0"')
  })

  it('rejects unsafe plugin IDs and page IDs', () => {
    expect(() =>
      parsePluginManifest({
        id: 'local/map',
        name: 'Bad',
        version: '1.0.0',
        apiVersion: 1,
        adminPages: [],
      }),
    ).toThrow('Invalid plugin manifest')

    expect(() =>
      parsePluginManifest({
        id: 'local.good',
        name: 'Bad Page',
        version: '1.0.0',
        apiVersion: 1,
        adminPages: [{ id: '../bad', title: 'Bad', content: { kind: 'markdown', body: 'Nope' } }],
      }),
    ).toThrow('Invalid plugin manifest')
  })

  it('collects admin pages only from enabled plugins', () => {
    const enabled = parsePluginManifest({
      id: 'local.enabled',
      name: 'Enabled',
      version: '1.0.0',
      apiVersion: 1,
      adminPages: [{ id: 'dashboard', title: 'Enabled', content: { kind: 'markdown', body: 'Visible' } }],
    })
    const disabled = parsePluginManifest({
      id: 'local.disabled',
      name: 'Disabled',
      version: '1.0.0',
      apiVersion: 1,
      adminPages: [{ id: 'dashboard', title: 'Disabled', content: { kind: 'markdown', body: 'Hidden' } }],
    })

    expect(
      collectEnabledAdminPages([
        { manifest: enabled, enabled: true, grantedPermissions: ['admin.navigation'] },
        { manifest: disabled, enabled: false, grantedPermissions: ['admin.navigation'] },
      ]).map((page) => page.pluginId),
    ).toEqual(['local.enabled'])
  })

  it('does not collect admin pages from plugins with lifecycle errors', () => {
    const manifest = parsePluginManifest({
      id: 'local.error',
      name: 'Broken',
      version: '1.0.0',
      apiVersion: 1,
      adminPages: [{ id: 'dashboard', title: 'Broken', content: { kind: 'markdown', body: 'Hidden' } }],
    })

    expect(
      collectEnabledAdminPages([
        { manifest, enabled: true, lifecycleStatus: 'error', grantedPermissions: ['admin.navigation'] },
      ]),
    ).toEqual([])
  })

  it('does not collect admin pages when admin.navigation is not granted', () => {
    const manifest = parsePluginManifest({
      id: 'local.silent',
      name: 'Silent',
      version: '1.0.0',
      apiVersion: 1,
      adminPages: [{ id: 'dashboard', title: 'Silent', content: { kind: 'markdown', body: 'Hidden' } }],
    })

    expect(
      collectEnabledAdminPages([
        { manifest, enabled: true, grantedPermissions: [] },
      ]),
    ).toEqual([])
  })

  it('validates plugin record input against a declared resource schema', () => {
    const manifest = parsePluginManifest({
      id: 'acme.books',
      name: 'Books',
      version: '1.0.0',
      apiVersion: 1,
      resources: [
        {
          id: 'books',
          title: 'Books',
          fields: [
            { id: 'title', label: 'Title', type: 'text', required: true },
            { id: 'pages', label: 'Pages', type: 'number' },
            { id: 'featured', label: 'Featured', type: 'boolean' },
          ],
        },
      ],
      adminPages: [],
    })

    const data = validatePluginRecordData(manifest.resources[0], {
      title: 'Invisible Cities',
      pages: 165,
      featured: true,
      ignored: 'not stored',
    })

    expect(data).toEqual({
      title: 'Invisible Cities',
      pages: 165,
      featured: true,
    })
    expect(() => validatePluginRecordData(manifest.resources[0], { pages: 'many' }))
      .toThrow('Missing required field "Title"')
  })
})
