import { Type, Value, type Static } from '@core/utils/typeboxHelpers'
import type {
  InstalledPlugin,
  PluginAdminPage,
  PluginAdminPageRoute,
  PluginManifest,
  PluginPermission,
  PluginPageContent,
  PluginResource,
} from '@core/plugin-sdk'
import {
  isCompatiblePluginApiVersion,
  MIN_SUPPORTED_PLUGIN_API_VERSION,
  PLUGIN_API_VERSION,
  PLUGIN_PERMISSION_VALUES,
  permissionLabel as sdkPermissionLabel,
} from '@core/plugin-sdk'

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/
const PAGE_ID_PATTERN = /^[a-z][a-z0-9-]*$/
const SEMVERISH_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9a-zA-Z.-]+)?$/
const SAFE_ASSET_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/
// `assetBasePath` is server-controlled. The only legitimate shape is
// `/uploads/plugins/{pluginId}/{version}` (optionally trailing `/`),
// produced by `writePluginPackageFiles` on zip install. Any other shape
// — including `..` traversal, empty segments, or non-uploads paths —
// is rejected at the schema boundary so it can't reach the filesystem
// sinks (`loadServerPluginModule`, `removePluginAssets`).
const ASSET_BASE_PATH_PATTERN =
  /^\/uploads\/plugins\/[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/\d+\.\d+\.\d+(?:[-+][0-9a-zA-Z.-]+)?\/?$/
// Outbound network allowlist: lowercase hostname, optional leading `*.`
// wildcard. No paths, ports, query strings — just the host. This is the
// allowlist the host's `network.fetch` bridge checks against.
const NETWORK_HOST_PATTERN = /^(?:\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

const permissionSchema = Type.Union(
  PLUGIN_PERMISSION_VALUES.map((v) => Type.Literal(v)),
)

const pinSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  detail: Type.Optional(Type.String({ maxLength: 160 })),
  x: Type.Number({ minimum: 0, maximum: 100 }),
  y: Type.Number({ minimum: 0, maximum: 100 }),
})

// `pins` is optional in the schema so the union default can be handled
// explicitly in parsePluginManifest post-processing (TypeBox union defaults
// are not reliably applied within discriminated-union variants).
const contentSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('markdown'),
    heading: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    body: Type.String({ maxLength: 20_000 }),
  }),
  Type.Object({
    kind: Type.Literal('map'),
    heading: Type.String({ minLength: 1, maxLength: 120 }),
    body: Type.Optional(Type.String({ maxLength: 500 })),
    centerLabel: Type.Optional(Type.String({ maxLength: 80 })),
    pins: Type.Optional(Type.Array(pinSchema, { maxItems: 40 })),
  }),
  Type.Object({
    kind: Type.Literal('resource'),
    heading: Type.String({ minLength: 1, maxLength: 120 }),
    resource: Type.String({ pattern: PAGE_ID_PATTERN.source }),
  }),
  Type.Object({
    kind: Type.Literal('app'),
    heading: Type.String({ minLength: 1, maxLength: 120 }),
    entry: Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source }),
    assetPath: Type.Optional(Type.String()),
  }),
])

const resourceFieldSchema = Type.Object({
  id: Type.String({ pattern: PAGE_ID_PATTERN.source }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  type: Type.Union([
    Type.Literal('text'),
    Type.Literal('longtext'),
    Type.Literal('number'),
    Type.Literal('date'),
    Type.Literal('boolean'),
  ]),
  required: Type.Optional(Type.Boolean()),
})

const resourceSchema = Type.Object({
  id: Type.String({ pattern: PAGE_ID_PATTERN.source }),
  title: Type.String({ minLength: 1, maxLength: 80 }),
  singularLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  pluralLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  fields: Type.Array(resourceFieldSchema, { minItems: 1, maxItems: 50 }),
})

const adminPageSchema = Type.Object({
  id: Type.String({ pattern: PAGE_ID_PATTERN.source }),
  title: Type.String({ minLength: 1, maxLength: 80 }),
  navLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
  icon: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
  route: Type.Optional(Type.String()),
  content: contentSchema,
})

// `settings` schema — a discriminated union over the supported types so the
// host can render the right control without a second parse step.
const SETTING_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/
const settingTypeSchema = Type.Union([
  Type.Literal('text'),
  Type.Literal('textarea'),
  Type.Literal('number'),
  Type.Literal('toggle'),
  Type.Literal('select'),
  Type.Literal('color'),
  Type.Literal('url'),
  Type.Literal('password'),
])
const settingDefinitionSchema = Type.Object({
  id: Type.String({ pattern: SETTING_ID_PATTERN.source }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  type: settingTypeSchema,
  description: Type.Optional(Type.String({ maxLength: 500 })),
  required: Type.Optional(Type.Boolean()),
  secret: Type.Optional(Type.Boolean()),
  default: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
  options: Type.Optional(Type.Array(Type.Object({
    label: Type.String({ minLength: 1, maxLength: 80 }),
    value: Type.String({ minLength: 1, maxLength: 80 }),
  }))),
  placeholder: Type.Optional(Type.String({ maxLength: 120 })),
  rows: Type.Optional(Type.Number()),
  min: Type.Optional(Type.Number()),
  max: Type.Optional(Type.Number()),
  step: Type.Optional(Type.Number()),
  unit: Type.Optional(Type.String({ maxLength: 16 })),
  format: Type.Optional(Type.Union([Type.Literal('hex'), Type.Literal('rgba')])),
})

// Marketplace metadata — author, license, URLs, keywords, visual icon.
// Validated at the manifest boundary so a malicious zip can't inject
// arbitrary HTML or filesystem-traversing icon paths.
const URL_PATTERN = /^https?:\/\/[^\s<>"'`]+$/
const EMAIL_PATTERN = /^[^\s<>"'`@]+@[^\s<>"'`@]+\.[^\s<>"'`@]+$/
const SPDX_PATTERN = /^[A-Za-z0-9.+-]{1,40}$/
const KEYWORD_PATTERN = /^[A-Za-z0-9_-]{1,30}$/
const ICON_PATH_PATTERN = /^[a-zA-Z0-9._-]+\.(png|svg|webp|jpg|jpeg)$/

const authorSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  email: Type.Optional(Type.String({ pattern: EMAIL_PATTERN.source, maxLength: 240 })),
  url: Type.Optional(Type.String({ pattern: URL_PATTERN.source, maxLength: 500 })),
})

const manifestSchema = Type.Object({
  id: Type.String({ pattern: PLUGIN_ID_PATTERN.source }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  version: Type.String({ pattern: SEMVERISH_PATTERN.source }),
  // Schema accepts any positive integer; the parser narrows to the
  // host-supported range via `isCompatiblePluginApiVersion`. Rejecting at
  // a literal would force every old plugin offline the day a host bumps
  // PLUGIN_API_VERSION, even when the host explicitly wants to keep
  // serving older plugins via MIN_SUPPORTED_PLUGIN_API_VERSION.
  apiVersion: Type.Integer({ minimum: 1 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  author: Type.Optional(authorSchema),
  license: Type.Optional(Type.String({ pattern: SPDX_PATTERN.source })),
  homepage: Type.Optional(Type.String({ pattern: URL_PATTERN.source, maxLength: 500 })),
  repository: Type.Optional(Type.String({ pattern: URL_PATTERN.source, maxLength: 500 })),
  keywords: Type.Optional(Type.Array(Type.String({ pattern: KEYWORD_PATTERN.source }), { maxItems: 20 })),
  icon: Type.Optional(Type.String({ pattern: ICON_PATH_PATTERN.source, maxLength: 80 })),
  permissions: Type.Array(permissionSchema, { default: [] }),
  grantedPermissions: Type.Optional(Type.Array(permissionSchema)),
  // Per-host allowlist for outbound HTTP. Plain hostnames (`api.example.com`)
  // match exactly; the leading `*.` wildcard matches one subdomain segment.
  // Hostnames are normalized (lowercased, trimmed) at manifest parse time.
  networkAllowedHosts: Type.Optional(Type.Array(
    Type.String({ pattern: NETWORK_HOST_PATTERN.source, maxLength: 253 }),
    { maxItems: 50 },
  )),
  entrypoints: Type.Optional(Type.Object({
    server: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    editor: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    admin: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    modules: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
    frontend: Type.Optional(Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source })),
  })),
  assetBasePath: Type.Optional(Type.String({ pattern: ASSET_BASE_PATH_PATTERN.source })),
  resources: Type.Array(resourceSchema, { maxItems: 20, default: [] }),
  adminPages: Type.Array(adminPageSchema, { maxItems: 20, default: [] }),
  pack: Type.Optional(Type.Object({
    path: Type.String({ pattern: SAFE_ASSET_PATH_PATTERN.source }),
  })),
  settings: Type.Optional(Type.Array(settingDefinitionSchema, { maxItems: 50 })),
})

type ManifestRaw = Static<typeof manifestSchema>

export function pluginAdminPageRoute(pluginId: string, pageId: string): string {
  return `/admin/plugins/${pluginId}/${pageId}`
}

export function parsePluginManifest(input: unknown): PluginManifest {
  let data: ManifestRaw
  try {
    data = Value.Parse(manifestSchema, input) as ManifestRaw
  } catch {
    const errors = [...Value.Errors(manifestSchema, input)]
    throw new Error(`Invalid plugin manifest: ${errors[0]?.message ?? 'manifest is malformed'}`)
  }

  // SDK compatibility — reject manifests targeting a host API version this
  // build can't honour. Done after schema validation so the error message
  // can reference the parsed value rather than `unknown`.
  if (!isCompatiblePluginApiVersion(data.apiVersion)) {
    throw new Error(
      `Plugin "${data.id}" targets apiVersion ${data.apiVersion}, but this host ` +
        `supports apiVersion ${MIN_SUPPORTED_PLUGIN_API_VERSION}–${PLUGIN_API_VERSION}. ` +
        `Update the plugin (or the host) to a compatible version.`,
    )
  }

  // The schema permits any `/uploads/plugins/{id}/{version}` shape, but the
  // path must reference *this* plugin's own id+version — anything else would
  // let one plugin manifest target another plugin's files at the filesystem
  // sinks (`loadServerPluginModule`, `removePluginAssets`).
  if (data.assetBasePath) {
    const expected = `/uploads/plugins/${data.id}/${data.version}`
    const normalized = data.assetBasePath.replace(/\/+$/, '')
    if (normalized !== expected) {
      throw new Error(
        `Invalid plugin manifest: assetBasePath must equal "${expected}"`,
      )
    }
  }

  const duplicateResources = new Set<string>()
  const resources: PluginResource[] = data.resources.map((resource) => {
    if (duplicateResources.has(resource.id)) {
      throw new Error(`Invalid plugin manifest: duplicate resource "${resource.id}"`)
    }
    duplicateResources.add(resource.id)

    const duplicateFields = new Set<string>()
    for (const field of resource.fields) {
      if (duplicateFields.has(field.id)) {
        throw new Error(`Invalid plugin manifest: duplicate field "${field.id}"`)
      }
      duplicateFields.add(field.id)
    }

    return resource as PluginResource
  })

  const duplicatePages = new Set<string>()
  const adminPages: PluginAdminPage[] = data.adminPages.map((page) => {
    if (duplicatePages.has(page.id)) {
      throw new Error(`Invalid plugin manifest: duplicate admin page "${page.id}"`)
    }
    duplicatePages.add(page.id)
    if (page.content.kind === 'resource' && !duplicateResources.has(page.content.resource)) {
      throw new Error(`Invalid plugin manifest: resource page "${page.id}" references unknown resource "${page.content.resource}"`)
    }

    // Normalise the content: apply the pins default for map pages explicitly,
    // since TypeBox union defaults are not reliably applied within union variants.
    const content: PluginPageContent = page.content.kind === 'map'
      ? { ...page.content, pins: page.content.pins ?? [] }
      : page.content as PluginPageContent

    return {
      id: page.id,
      title: page.title,
      navLabel: page.navLabel,
      icon: page.icon,
      route: pluginAdminPageRoute(data.id, page.id),
      content,
    }
  })

  // Settings — duplicate id check.
  if (data.settings && data.settings.length > 0) {
    const seen = new Set<string>()
    for (const s of data.settings) {
      if (seen.has(s.id)) {
        throw new Error(`Invalid plugin manifest: duplicate setting "${s.id}"`)
      }
      seen.add(s.id)
      if (s.type === 'select' && (!s.options || s.options.length === 0)) {
        throw new Error(`Invalid plugin manifest: setting "${s.id}" of type "select" must declare options`)
      }
    }
  }

  return {
    id: data.id,
    name: data.name,
    version: data.version,
    apiVersion: data.apiVersion,
    description: data.description,
    permissions: data.permissions as PluginPermission[],
    grantedPermissions: data.grantedPermissions as PluginPermission[] | undefined,
    entrypoints: data.entrypoints,
    assetBasePath: data.assetBasePath,
    resources,
    adminPages,
    pack: data.pack,
    settings: data.settings as PluginManifest['settings'],
    author: data.author,
    license: data.license,
    homepage: data.homepage,
    repository: data.repository,
    keywords: data.keywords ? [...data.keywords] : undefined,
    icon: data.icon,
  }
}

export function missingPluginPermissionGrants(
  manifest: Pick<PluginManifest, 'permissions'>,
  grantedPermissions: PluginPermission[],
): PluginPermission[] {
  const granted = new Set(grantedPermissions)
  return manifest.permissions.filter((permission) => !granted.has(permission))
}

export function permissionLabel(permission: PluginPermission): string {
  return sdkPermissionLabel(permission)
}

export function findPluginResource(
  manifest: Pick<PluginManifest, 'resources'>,
  resourceId: string,
): PluginResource | null {
  return manifest.resources.find((resource) => resource.id === resourceId) ?? null
}

export function validatePluginRecordData(
  resource: PluginResource,
  input: unknown,
  options: { partial?: boolean } = {},
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Plugin record data must be an object')
  }

  const raw = input as Record<string, unknown>
  const data: Record<string, unknown> = {}

  for (const field of resource.fields) {
    const value = raw[field.id]
    const missing = value === undefined || value === null || value === ''

    if (missing) {
      if (field.required && !options.partial) {
        throw new Error(`Missing required field "${field.label}"`)
      }
      continue
    }

    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Field "${field.label}" must be a number`)
      }
      data[field.id] = value
      continue
    }

    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new Error(`Field "${field.label}" must be a boolean`)
      }
      data[field.id] = value
      continue
    }

    if (typeof value !== 'string') {
      throw new Error(`Field "${field.label}" must be text`)
    }
    data[field.id] = value.trim()
  }

  return data
}

export function collectEnabledAdminPages(
  plugins: Array<
    Pick<InstalledPlugin, 'enabled' | 'manifest' | 'grantedPermissions'>
    & Partial<Pick<InstalledPlugin, 'lifecycleStatus' | 'settings' | 'updatedAt'>>
  >,
): PluginAdminPageRoute[] {
  return plugins
    .filter((plugin) => plugin.enabled && plugin.lifecycleStatus !== 'error')
    // `admin.navigation` is the gate for adding pages to the CMS sidebar — a
    // plugin that didn't request the grant has no business mounting nav
    // entries even if its manifest declared `adminPages` items.
    .filter((plugin) => plugin.grantedPermissions?.includes('admin.navigation'))
    .flatMap((plugin) =>
      plugin.manifest.adminPages.map((page) => {
        const content: PluginPageContent = page.content.kind === 'app'
          ? {
              ...page.content,
              assetPath: page.content.assetPath ?? plugin.manifest.assetBasePath,
            }
          : page.content

        return {
          pluginId: plugin.manifest.id,
          pluginName: plugin.manifest.name,
          pluginVersion: plugin.manifest.version,
          pluginUpdatedAt: plugin.updatedAt ?? '',
          ...page,
          content,
          // The host parser always populates `route` via `pluginAdminPageRoute`;
          // we re-narrow to a guaranteed string here for the runtime route type.
          route: page.route ?? pluginAdminPageRoute(plugin.manifest.id, page.id),
          pluginSettings: plugin.settings ?? {},
          pluginSettingsSchema: plugin.manifest.settings,
        }
      }),
    )
}
