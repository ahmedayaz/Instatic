/**
 * Plugin endpoints (gated by `plugins.manage`).
 *
 *   GET    /admin/api/cms/plugins                                   — list installed plugins + admin pages
 *   POST   /admin/api/cms/plugins                                   — install from a manifest JSON body
 *   POST   /admin/api/cms/plugins/inspect-package                   — read a plugin .zip without installing
 *   POST   /admin/api/cms/plugins/package                           — install from an uploaded .zip
 *   PATCH  /admin/api/cms/plugins/:id                               — enable / disable an installed plugin
 *   DELETE /admin/api/cms/plugins/:id                               — uninstall + delete on-disk assets
 *   GET    /admin/api/cms/plugins/:id/resources/:rid/records        — list records for a plugin resource
 *   POST   /admin/api/cms/plugins/:id/resources/:rid/records        — create a plugin record
 *   PATCH  /admin/api/cms/plugins/:id/resources/:rid/records/:rec   — update a plugin record
 *   DELETE /admin/api/cms/plugins/:id/resources/:rid/records/:rec   — delete a plugin record
 *   *      /admin/api/cms/plugins/:id/runtime/...                   — opaque runtime requests handled by
 *                                                                     the plugin's own server module
 *
 * The lifecycle hooks (`install`, `activate`, `deactivate`, `uninstall`) are
 * fired through `runPluginLifecycleHook`, which catches errors, parks the
 * plugin in `error` status, and lets the caller render a sensible response.
 *
 * `handlePluginsRoutes` is a thin dispatcher: it matches the URL pattern,
 * runs the `plugins.manage` capability check, and forwards to one of the
 * per-route handlers below. Each route handler owns its own method-routing
 * + body-parsing + repository calls.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import type { AuthUser } from '../../repositories/users'
import { createAuditEvent } from '../../repositories/audit'
import {
  createPluginRecord,
  deletePluginRecord,
  deletePlugin,
  getInstalledPlugin,
  installPlugin,
  listInstalledPlugins,
  listPluginRecords,
  setPluginLifecycleStatus,
  setPluginEnabled,
  updatePluginRecord,
} from '../../repositories/plugins'
import {
  collectEnabledAdminPages,
  findPluginResource,
  missingPluginPermissionGrants,
  parsePluginManifest,
  validatePluginRecordData,
} from '@core/plugins/manifest'
import type {
  InstalledPlugin,
  PluginLifecycleStatus,
  PluginManifest,
  PluginPermission,
  PluginResource,
  ServerPluginLifecycleHook,
} from '@core/plugin-sdk'
import { readPluginPackage } from '../../plugins/package'
import {
  activateInstalledServerPlugins,
  assertPluginPathWithin,
  handleServerPluginRuntimeRequest,
  loadServerPluginModule,
  runServerPluginLifecycleHook,
  serverPluginRuntime,
} from '../../plugins/runtime'
import { badRequest, jsonResponse, methodNotAllowed, readJsonObject } from '../../http'
import { requestAuditContext, type CmsHandlerOptions } from './shared'
import { nanoid } from 'nanoid'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pluginsPayload(db: DbClient) {
  const plugins = await listInstalledPlugins(db)
  return {
    plugins,
    adminPages: collectEnabledAdminPages(plugins),
  }
}

function readPermissionGrants(value: unknown): PluginPermission[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is PluginPermission => typeof item === 'string') as PluginPermission[]
}

function assertPluginPermissionGrants(
  manifest: PluginManifest,
  grantedPermissions: PluginPermission[],
): Response | null {
  const missing = missingPluginPermissionGrants(manifest, grantedPermissions)
  if (missing.length === 0) return null
  return badRequest(`Plugin install requires permission grants: ${missing.join(', ')}`)
}

function pluginManifestWithGrants(plugin: InstalledPlugin): PluginManifest {
  return {
    ...plugin.manifest,
    grantedPermissions: plugin.grantedPermissions,
  }
}

function lifecycleErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Plugin lifecycle hook failed'
}

async function runPluginLifecycleHook(
  db: DbClient,
  plugin: InstalledPlugin,
  options: CmsHandlerOptions,
  hook: ServerPluginLifecycleHook,
  successStatus: PluginLifecycleStatus,
): Promise<{ plugin: InstalledPlugin; ok: boolean }> {
  const manifest = pluginManifestWithGrants(plugin)

  try {
    const mod = await loadServerPluginModule(manifest, options.uploadsDir)
    if (!mod?.[hook]) {
      const updated = await setPluginLifecycleStatus(db, plugin.id, successStatus)
      return { plugin: updated ?? plugin, ok: true }
    }

    await runServerPluginLifecycleHook(manifest, mod, db, hook)
    const updated = await setPluginLifecycleStatus(db, plugin.id, successStatus)
    return { plugin: updated ?? plugin, ok: true }
  } catch (err) {
    if (hook === 'activate') {
      serverPluginRuntime.unregisterPlugin(plugin.id)
    }
    const updated = await setPluginLifecycleStatus(db, plugin.id, 'error', lifecycleErrorMessage(err))
    return { plugin: updated ?? plugin, ok: false }
  }
}

async function removePluginAssets(plugin: InstalledPlugin, uploadsDir?: string): Promise<void> {
  const assetBasePath = plugin.manifest.assetBasePath
  if (!uploadsDir || !assetBasePath?.startsWith('/uploads/plugins/')) return
  const relativeBasePath = assetBasePath.replace(/^\/uploads\/?/, '')
  const target = join(uploadsDir, relativeBasePath)
  // Defense-in-depth: a string-prefix match on `/uploads/plugins/` does not
  // block `..` traversal that the schema is supposed to reject — re-assert
  // containment after `path.join` normalises the segments so a corrupted
  // stored manifest (or a future schema regression) can't trigger an
  // arbitrary `rm -rf`.
  try {
    assertPluginPathWithin(uploadsDir, target)
  } catch (err) {
    console.error('[plugins] removePluginAssets refused to delete escaping path:', err)
    return
  }
  await rm(target, { recursive: true, force: true })
}

async function readPluginPackageForm(req: Request): Promise<{
  file: File | null
  grantedPermissions: PluginPermission[]
}> {
  const body = await req.formData()
  const file = body.get('file')
  const rawPermissions = body.get('grantedPermissions')
  let grantedPermissions: PluginPermission[] = []
  if (typeof rawPermissions === 'string') {
    try {
      // JSON.parse returns unknown — readPermissionGrants validates the shape
      // (must be array, items must be strings) before returning. Safe boundary.
      grantedPermissions = readPermissionGrants(JSON.parse(rawPermissions))
    } catch {
      grantedPermissions = []
    }
  }
  return {
    file: file instanceof File ? file : null,
    grantedPermissions,
  }
}

async function writePluginPackageFiles(
  uploadsDir: string,
  manifest: PluginManifest,
  files: Record<string, string>,
): Promise<PluginManifest> {
  const relativeBasePath = `plugins/${manifest.id}/${manifest.version}`
  const diskBasePath = join(uploadsDir, relativeBasePath)
  await rm(diskBasePath, { recursive: true, force: true })

  for (const [path, content] of Object.entries(files)) {
    if (path === 'plugin.json') continue
    const outputPath = join(diskBasePath, path)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, content, 'utf-8')
  }

  return {
    ...manifest,
    assetBasePath: `/uploads/${relativeBasePath}`,
  }
}

async function getEnabledPluginResource(
  db: DbClient,
  pluginId: string,
  resourceId: string,
): Promise<PluginResource | null> {
  const plugin = await getInstalledPlugin(db, pluginId)
  if (!plugin?.enabled) return null
  return findPluginResource(plugin.manifest, resourceId)
}

/**
 * Record a plugin lifecycle action in the audit log. All four mutation
 * endpoints (install / enable / disable / delete) emit the same envelope —
 * actor, action verb, and a `{ pluginId }` metadata payload — so this helper
 * exists purely to keep the route handlers tidy.
 */
async function recordPluginAuditEvent(
  db: DbClient,
  user: AuthUser,
  req: Request,
  action: 'plugin.install' | 'plugin.enable' | 'plugin.disable' | 'plugin.delete',
  pluginId: string,
): Promise<void> {
  await createAuditEvent(db, {
    actorUserId: user.id,
    action,
    targetType: 'plugin',
    targetId: pluginId,
    metadata: { pluginId },
    ...requestAuditContext(req),
  })
}

const PLUGIN_NOT_FOUND = jsonResponse({ error: 'Plugin not found' }, { status: 404 })
const PLUGIN_RECORD_NOT_FOUND = jsonResponse({ error: 'Plugin record not found' }, { status: 404 })
const PLUGIN_RESOURCE_NOT_FOUND = jsonResponse({ error: 'Plugin resource not found' }, { status: 404 })

// ---------------------------------------------------------------------------
// Per-route handlers — one function per URL pattern
// ---------------------------------------------------------------------------

async function handlePluginsCollection(
  req: Request,
  db: DbClient,
  user: AuthUser,
): Promise<Response> {
  if (req.method === 'GET') {
    return jsonResponse(await pluginsPayload(db))
  }

  if (req.method === 'POST') {
    const body = await readJsonObject(req)
    try {
      // JSON-installed plugins have no on-disk package — only the zip-install
      // path writes files and assigns `assetBasePath`. Drop any caller-supplied
      // value before validating so a malicious manifest cannot point the
      // filesystem sinks at attacker-chosen paths.
      const rawManifest = body.manifest ?? body
      const sanitizedInput = rawManifest && typeof rawManifest === 'object' && !Array.isArray(rawManifest)
        ? { ...(rawManifest as Record<string, unknown>), assetBasePath: undefined }
        : rawManifest
      const manifest = parsePluginManifest(sanitizedInput)
      const grantedPermissions = readPermissionGrants(body.grantedPermissions)
      const grantError = assertPluginPermissionGrants(manifest, grantedPermissions)
      if (grantError) return grantError
      const installed = await installPlugin(db, manifest, grantedPermissions)
      const plugin = await setPluginLifecycleStatus(db, installed.id, 'active') ?? installed
      await recordPluginAuditEvent(db, user, req, 'plugin.install', plugin.id)
      return jsonResponse({ plugin, ...await pluginsPayload(db) }, { status: 201 })
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'Invalid plugin manifest')
    }
  }

  return methodNotAllowed()
}

async function handleInspectPackage(req: Request): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed()

  const { file } = await readPluginPackageForm(req)
  if (!file) return badRequest('Missing plugin package')
  try {
    const pluginPackage = await readPluginPackage(file)
    return jsonResponse({ manifest: pluginPackage.manifest })
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'Invalid plugin package')
  }
}

async function handlePackageInstall(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
  user: AuthUser,
): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed()
  if (!options.uploadsDir) {
    return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
  }

  const { file, grantedPermissions } = await readPluginPackageForm(req)
  if (!file) return badRequest('Missing plugin package')

  try {
    const pluginPackage = await readPluginPackage(file)
    const grantError = assertPluginPermissionGrants(pluginPackage.manifest, grantedPermissions)
    if (grantError) return grantError
    const manifest = await writePluginPackageFiles(
      options.uploadsDir,
      pluginPackage.manifest,
      pluginPackage.files,
    )
    const installed = await installPlugin(db, manifest, grantedPermissions)
    const installLifecycle = await runPluginLifecycleHook(db, installed, options, 'install', 'installed')
    if (!installLifecycle.ok) {
      return jsonResponse(
        { plugin: installLifecycle.plugin, ...await pluginsPayload(db) },
        { status: 201 },
      )
    }

    serverPluginRuntime.unregisterPlugin(installed.id)
    const activateLifecycle = await runPluginLifecycleHook(
      db,
      installLifecycle.plugin,
      options,
      'activate',
      'active',
    )
    await recordPluginAuditEvent(db, user, req, 'plugin.install', activateLifecycle.plugin.id)
    return jsonResponse(
      { plugin: activateLifecycle.plugin, ...await pluginsPayload(db) },
      { status: 201 },
    )
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'Invalid plugin package')
  }
}

/**
 * PATCH `enabled` on a single plugin. The shape is symmetric — both branches
 * flip the enabled flag, run the matching lifecycle hook, re-bind the runtime
 * registry, and emit one audit event — only the verbs and statuses differ.
 */
async function setPluginEnabledFromRequest(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
  user: AuthUser,
  pluginId: string,
  enabled: boolean,
): Promise<Response> {
  const updated = await setPluginEnabled(db, pluginId, enabled)
  if (!updated) return PLUGIN_NOT_FOUND

  serverPluginRuntime.unregisterPlugin(pluginId)
  const lifecycle = await runPluginLifecycleHook(
    db,
    updated,
    options,
    enabled ? 'activate' : 'deactivate',
    enabled ? 'active' : 'disabled',
  )

  // Disabling a plugin frees its registry slot but leaves the rest of the
  // installed surface registered — re-activate the others so they pick up
  // their hooks again.
  if (!enabled) {
    await activateInstalledServerPlugins(db, options.uploadsDir)
  }

  await recordPluginAuditEvent(
    db,
    user,
    req,
    enabled ? 'plugin.enable' : 'plugin.disable',
    pluginId,
  )
  return jsonResponse({ plugin: lifecycle.plugin, ...await pluginsPayload(db) })
}

async function handlePluginItem(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
  user: AuthUser,
  pluginId: string,
): Promise<Response> {
  if (req.method === 'PATCH') {
    const body = await readJsonObject(req)
    if (typeof body.enabled !== 'boolean') return badRequest('Plugin enabled must be a boolean')

    const current = await getInstalledPlugin(db, pluginId)
    if (!current) return PLUGIN_NOT_FOUND

    return setPluginEnabledFromRequest(req, db, options, user, pluginId, body.enabled)
  }

  if (req.method === 'DELETE') {
    const current = await getInstalledPlugin(db, pluginId)
    if (!current) return PLUGIN_NOT_FOUND

    const lifecycle = await runPluginLifecycleHook(db, current, options, 'uninstall', current.lifecycleStatus)
    if (!lifecycle.ok) {
      return badRequest(lifecycle.plugin.lastError ?? 'Plugin uninstall failed')
    }

    const deleted = await deletePlugin(db, pluginId)
    if (!deleted) return PLUGIN_NOT_FOUND
    serverPluginRuntime.unregisterPlugin(pluginId)
    await removePluginAssets(current, options.uploadsDir)
    await activateInstalledServerPlugins(db, options.uploadsDir)
    await recordPluginAuditEvent(db, user, req, 'plugin.delete', pluginId)
    return jsonResponse({ ok: true })
  }

  return methodNotAllowed()
}

async function handlePluginRecordsCollection(
  req: Request,
  db: DbClient,
  pluginId: string,
  resourceId: string,
): Promise<Response> {
  const resource = await getEnabledPluginResource(db, pluginId, resourceId)
  if (!resource) return PLUGIN_RESOURCE_NOT_FOUND

  if (req.method === 'GET') {
    return jsonResponse({
      resource,
      records: await listPluginRecords(db, pluginId, resourceId),
    })
  }

  if (req.method === 'POST') {
    const body = await readJsonObject(req)
    try {
      const data = validatePluginRecordData(resource, body.data ?? body)
      const record = await createPluginRecord(db, {
        id: nanoid(),
        pluginId,
        resourceId,
        data,
      })
      return jsonResponse({ record }, { status: 201 })
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'Invalid plugin record data')
    }
  }

  return methodNotAllowed()
}

async function handlePluginRecordItem(
  req: Request,
  db: DbClient,
  pluginId: string,
  resourceId: string,
  recordId: string,
): Promise<Response> {
  const resource = await getEnabledPluginResource(db, pluginId, resourceId)
  if (!resource) return PLUGIN_RESOURCE_NOT_FOUND

  if (req.method === 'PATCH') {
    const body = await readJsonObject(req)
    try {
      const data = validatePluginRecordData(resource, body.data ?? body)
      const record = await updatePluginRecord(db, {
        id: recordId,
        pluginId,
        resourceId,
        data,
      })
      if (!record) return PLUGIN_RECORD_NOT_FOUND
      return jsonResponse({ record })
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'Invalid plugin record data')
    }
  }

  if (req.method === 'DELETE') {
    const deleted = await deletePluginRecord(db, {
      id: recordId,
      pluginId,
      resourceId,
    })
    if (!deleted) return PLUGIN_RECORD_NOT_FOUND
    return jsonResponse({ ok: true })
  }

  return methodNotAllowed()
}

// ---------------------------------------------------------------------------
// Route patterns
// ---------------------------------------------------------------------------

const PLUGIN_ITEM_PATTERN = /^\/admin\/api\/cms\/plugins\/([^/]+)$/
const PLUGIN_RECORDS_PATTERN = /^\/admin\/api\/cms\/plugins\/([^/]+)\/resources\/([^/]+)\/records$/
const PLUGIN_RECORD_ITEM_PATTERN = /^\/admin\/api\/cms\/plugins\/([^/]+)\/resources\/([^/]+)\/records\/([^/]+)$/
const PLUGIN_RUNTIME_PATTERN = /^\/admin\/api\/cms\/plugins\/([^/]+)\/runtime(?:\/.*)?$/

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handlePluginsRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
): Promise<Response | null> {
  const url = new URL(req.url)
  const { pathname } = url

  // Plugin runtime is a pass-through to the plugin's own server module — its
  // capability gating lives inside `handleServerPluginRuntimeRequest` because
  // the module decides which routes are public vs. authenticated.
  if (PLUGIN_RUNTIME_PATTERN.test(pathname)) {
    return (
      (await handleServerPluginRuntimeRequest(req, db)) ??
      jsonResponse({ error: 'Plugin route not found' }, { status: 404 })
    )
  }

  // Every CMS-side plugin route requires `plugins.manage`.
  if (!isPluginAdminPath(pathname)) return null
  const user = await requireCapability(req, db, 'plugins.manage')
  if (user instanceof Response) return user

  if (pathname === '/admin/api/cms/plugins') {
    return handlePluginsCollection(req, db, user)
  }

  if (pathname === '/admin/api/cms/plugins/inspect-package') {
    return handleInspectPackage(req)
  }

  if (pathname === '/admin/api/cms/plugins/package') {
    return handlePackageInstall(req, db, options, user)
  }

  const recordItemMatch = pathname.match(PLUGIN_RECORD_ITEM_PATTERN)
  if (recordItemMatch) {
    return handlePluginRecordItem(
      req,
      db,
      decodeURIComponent(recordItemMatch[1]),
      decodeURIComponent(recordItemMatch[2]),
      decodeURIComponent(recordItemMatch[3]),
    )
  }

  const recordsMatch = pathname.match(PLUGIN_RECORDS_PATTERN)
  if (recordsMatch) {
    return handlePluginRecordsCollection(
      req,
      db,
      decodeURIComponent(recordsMatch[1]),
      decodeURIComponent(recordsMatch[2]),
    )
  }

  const itemMatch = pathname.match(PLUGIN_ITEM_PATTERN)
  if (itemMatch) {
    return handlePluginItem(req, db, options, user, decodeURIComponent(itemMatch[1]))
  }

  return null
}

/**
 * Quick check that `pathname` is one of the plugin admin routes — the
 * runtime route is handled separately above. Centralising the prefix keeps
 * the dispatcher's auth gate from running on unrelated CMS paths.
 */
function isPluginAdminPath(pathname: string): boolean {
  if (pathname === '/admin/api/cms/plugins') return true
  if (pathname === '/admin/api/cms/plugins/inspect-package') return true
  if (pathname === '/admin/api/cms/plugins/package') return true
  return pathname.startsWith('/admin/api/cms/plugins/')
}
