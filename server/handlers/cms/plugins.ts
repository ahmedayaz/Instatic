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
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DbClient } from '../../cms/db/client'
import { requireCapability } from '../../cms/authz'
import { createAuditEvent } from '../../cms/auditRepository'
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
} from '../../cms/pluginRepository'
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
import { readPluginPackage } from '../../cms/pluginPackage'
import {
  activateInstalledServerPlugins,
  handleServerPluginRuntimeRequest,
  loadServerPluginModule,
  runServerPluginLifecycleHook,
  serverPluginRuntime,
} from '../../cms/serverPluginRuntime'
import { badRequest, jsonResponse, methodNotAllowed, readJsonObject } from '../../http'
import { requestAuditContext, type CmsHandlerOptions } from './shared'
import { nanoid } from 'nanoid'

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
  await rm(join(uploadsDir, relativeBasePath), { recursive: true, force: true })
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

export async function handlePluginsRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === '/admin/api/cms/plugins') {
    const user = await requireCapability(req, db, 'plugins.manage')
    if (user instanceof Response) return user

    if (req.method === 'GET') {
      return jsonResponse(await pluginsPayload(db))
    }

    if (req.method === 'POST') {
      const body = await readJsonObject(req)
      try {
        const manifest = parsePluginManifest(body.manifest ?? body)
        const grantedPermissions = readPermissionGrants(body.grantedPermissions)
        const grantError = assertPluginPermissionGrants(manifest, grantedPermissions)
        if (grantError) return grantError
        const installed = await installPlugin(db, manifest, grantedPermissions)
        const plugin = await setPluginLifecycleStatus(db, installed.id, 'active') ?? installed
        await createAuditEvent(db, {
          actorUserId: user.id,
          action: 'plugin.install',
          targetType: 'plugin',
          targetId: plugin.id,
          metadata: { pluginId: plugin.id },
          ...requestAuditContext(req),
        })
        return jsonResponse({ plugin, ...await pluginsPayload(db) }, { status: 201 })
      } catch (err) {
        return badRequest(err instanceof Error ? err.message : 'Invalid plugin manifest')
      }
    }

    return methodNotAllowed()
  }

  if (url.pathname === '/admin/api/cms/plugins/inspect-package') {
    const user = await requireCapability(req, db, 'plugins.manage')
    if (user instanceof Response) return user
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

  if (url.pathname === '/admin/api/cms/plugins/package') {
    const user = await requireCapability(req, db, 'plugins.manage')
    if (user instanceof Response) return user
    if (req.method !== 'POST') return methodNotAllowed()
    if (!options.uploadsDir) return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })

    const { file, grantedPermissions } = await readPluginPackageForm(req)
    if (!file) return badRequest('Missing plugin package')

    try {
      const pluginPackage = await readPluginPackage(file)
      const grantError = assertPluginPermissionGrants(pluginPackage.manifest, grantedPermissions)
      if (grantError) return grantError
      const manifest = await writePluginPackageFiles(options.uploadsDir, pluginPackage.manifest, pluginPackage.files)
      const installed = await installPlugin(db, manifest, grantedPermissions)
      const installLifecycle = await runPluginLifecycleHook(db, installed, options, 'install', 'installed')
      if (!installLifecycle.ok) {
        return jsonResponse({ plugin: installLifecycle.plugin, ...await pluginsPayload(db) }, { status: 201 })
      }

      serverPluginRuntime.unregisterPlugin(installed.id)
      const activateLifecycle = await runPluginLifecycleHook(
        db,
        installLifecycle.plugin,
        options,
        'activate',
        'active',
      )
      await createAuditEvent(db, {
        actorUserId: user.id,
        action: 'plugin.install',
        targetType: 'plugin',
        targetId: activateLifecycle.plugin.id,
        metadata: { pluginId: activateLifecycle.plugin.id },
        ...requestAuditContext(req),
      })
      return jsonResponse({ plugin: activateLifecycle.plugin, ...await pluginsPayload(db) }, { status: 201 })
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'Invalid plugin package')
    }
  }

  const pluginItemMatch = url.pathname.match(/^\/admin\/api\/cms\/plugins\/([^/]+)$/)
  if (pluginItemMatch) {
    const user = await requireCapability(req, db, 'plugins.manage')
    if (user instanceof Response) return user

    const pluginId = decodeURIComponent(pluginItemMatch[1])

    if (req.method === 'PATCH') {
      const body = await readJsonObject(req)
      if (typeof body.enabled !== 'boolean') return badRequest('Plugin enabled must be a boolean')

      const current = await getInstalledPlugin(db, pluginId)
      if (!current) return jsonResponse({ error: 'Plugin not found' }, { status: 404 })

      if (!body.enabled) {
        const disabled = await setPluginEnabled(db, pluginId, false)
        if (!disabled) return jsonResponse({ error: 'Plugin not found' }, { status: 404 })
        serverPluginRuntime.unregisterPlugin(pluginId)
        const lifecycle = await runPluginLifecycleHook(db, disabled, options, 'deactivate', 'disabled')
        await activateInstalledServerPlugins(db, options.uploadsDir)
        await createAuditEvent(db, {
          actorUserId: user.id,
          action: 'plugin.disable',
          targetType: 'plugin',
          targetId: pluginId,
          metadata: { pluginId },
          ...requestAuditContext(req),
        })
        return jsonResponse({ plugin: lifecycle.plugin, ...await pluginsPayload(db) })
      }

      const enabled = await setPluginEnabled(db, pluginId, true)
      if (!enabled) return jsonResponse({ error: 'Plugin not found' }, { status: 404 })
      serverPluginRuntime.unregisterPlugin(pluginId)
      const lifecycle = await runPluginLifecycleHook(db, enabled, options, 'activate', 'active')
      await createAuditEvent(db, {
        actorUserId: user.id,
        action: 'plugin.enable',
        targetType: 'plugin',
        targetId: pluginId,
        metadata: { pluginId },
        ...requestAuditContext(req),
      })
      return jsonResponse({ plugin: lifecycle.plugin, ...await pluginsPayload(db) })
    }

    if (req.method === 'DELETE') {
      const current = await getInstalledPlugin(db, pluginId)
      if (!current) return jsonResponse({ error: 'Plugin not found' }, { status: 404 })
      const lifecycle = await runPluginLifecycleHook(db, current, options, 'uninstall', current.lifecycleStatus)
      if (!lifecycle.ok) {
        return badRequest(lifecycle.plugin.lastError ?? 'Plugin uninstall failed')
      }

      const deleted = await deletePlugin(db, pluginId)
      if (!deleted) return jsonResponse({ error: 'Plugin not found' }, { status: 404 })
      serverPluginRuntime.unregisterPlugin(pluginId)
      await removePluginAssets(current, options.uploadsDir)
      await activateInstalledServerPlugins(db, options.uploadsDir)
      await createAuditEvent(db, {
        actorUserId: user.id,
        action: 'plugin.delete',
        targetType: 'plugin',
        targetId: pluginId,
        metadata: { pluginId },
        ...requestAuditContext(req),
      })
      return jsonResponse({ ok: true })
    }

    return methodNotAllowed()
  }

  const pluginRecordsMatch = url.pathname.match(/^\/admin\/api\/cms\/plugins\/([^/]+)\/resources\/([^/]+)\/records$/)
  if (pluginRecordsMatch) {
    const user = await requireCapability(req, db, 'plugins.manage')
    if (user instanceof Response) return user

    const pluginId = decodeURIComponent(pluginRecordsMatch[1])
    const resourceId = decodeURIComponent(pluginRecordsMatch[2])
    const resource = await getEnabledPluginResource(db, pluginId, resourceId)
    if (!resource) return jsonResponse({ error: 'Plugin resource not found' }, { status: 404 })

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

  const pluginRuntimeMatch = url.pathname.match(/^\/admin\/api\/cms\/plugins\/([^/]+)\/runtime(?:\/.*)?$/)
  if (pluginRuntimeMatch) {
    return await handleServerPluginRuntimeRequest(req, db)
      ?? jsonResponse({ error: 'Plugin route not found' }, { status: 404 })
  }

  const pluginRecordItemMatch = url.pathname.match(/^\/admin\/api\/cms\/plugins\/([^/]+)\/resources\/([^/]+)\/records\/([^/]+)$/)
  if (pluginRecordItemMatch) {
    const user = await requireCapability(req, db, 'plugins.manage')
    if (user instanceof Response) return user

    const pluginId = decodeURIComponent(pluginRecordItemMatch[1])
    const resourceId = decodeURIComponent(pluginRecordItemMatch[2])
    const recordId = decodeURIComponent(pluginRecordItemMatch[3])
    const resource = await getEnabledPluginResource(db, pluginId, resourceId)
    if (!resource) return jsonResponse({ error: 'Plugin resource not found' }, { status: 404 })

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
        if (!record) return jsonResponse({ error: 'Plugin record not found' }, { status: 404 })
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
      if (!deleted) return jsonResponse({ error: 'Plugin record not found' }, { status: 404 })
      return jsonResponse({ ok: true })
    }

    return methodNotAllowed()
  }

  return null
}
