import type {
  InstalledPlugin,
  PluginLifecycleStatus,
  PluginManifest,
  PluginPermission,
  PluginRecord,
} from '@core/plugin-sdk'
import { parsePluginManifest } from '@core/plugins/manifest'
import type { DbClient } from './db/client'

interface InstalledPluginRow {
  id: string
  name: string
  version: string
  enabled: boolean
  lifecycle_status?: string | null
  last_error?: string | null
  granted_permissions_json?: unknown
  manifest_json: unknown
  installed_at: Date | string
  updated_at: Date | string
}

interface PluginRecordRow {
  id: string
  plugin_id: string
  resource_id: string
  data_json: unknown
  created_at: Date | string
  updated_at: Date | string
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

// Returns unknown by design — every caller validates downstream via
// parsePluginManifest (Zod) or readPermissionGrants. Safe boundary.
function readManifestJson(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

function writeJson(value: unknown): string {
  return JSON.stringify(value)
}

function mapInstalledPlugin(row: InstalledPluginRow): InstalledPlugin {
  const manifest = parsePluginManifest(readManifestJson(row.manifest_json))
  const grantedPermissions = readManifestJson(row.granted_permissions_json)
  const lifecycleStatus = readLifecycleStatus(row.lifecycle_status, Boolean(row.enabled))
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    enabled: Boolean(row.enabled),
    lifecycleStatus,
    lastError: row.last_error ?? null,
    grantedPermissions: Array.isArray(grantedPermissions)
      ? grantedPermissions as PluginPermission[]
      : manifest.grantedPermissions ?? [],
    manifest,
    installedAt: toIsoString(row.installed_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

function readLifecycleStatus(value: unknown, enabled: boolean): PluginLifecycleStatus {
  if (
    value === 'installed' ||
    value === 'active' ||
    value === 'disabled' ||
    value === 'error'
  ) {
    return value
  }
  return enabled ? 'active' : 'disabled'
}

function mapPluginRecord(row: PluginRecordRow): PluginRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    resourceId: row.resource_id,
    data: readManifestJson(row.data_json) as Record<string, unknown>,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  }
}

export async function listInstalledPlugins(db: DbClient): Promise<InstalledPlugin[]> {
  const { rows } = await db<InstalledPluginRow>`
    select id, name, version, enabled, lifecycle_status, last_error,
           granted_permissions_json, manifest_json, installed_at, updated_at
    from installed_plugins
    order by installed_at desc
  `
  return rows.map(mapInstalledPlugin)
}

export async function getInstalledPlugin(db: DbClient, id: string): Promise<InstalledPlugin | null> {
  const { rows } = await db<InstalledPluginRow>`
    select id, name, version, enabled, lifecycle_status, last_error,
           granted_permissions_json, manifest_json, installed_at, updated_at
    from installed_plugins
    where id = ${id}
  `
  return rows[0] ? mapInstalledPlugin(rows[0]) : null
}

export async function installPlugin(
  db: DbClient,
  manifest: PluginManifest,
  grantedPermissions: PluginPermission[] = manifest.grantedPermissions ?? [],
): Promise<InstalledPlugin> {
  const manifestToStore = { ...manifest, grantedPermissions }
  const { rows } = await db<InstalledPluginRow>`
    insert into installed_plugins (id, name, version, manifest_json, granted_permissions_json, enabled, lifecycle_status, last_error)
    values (${manifest.id}, ${manifest.name}, ${manifest.version}, ${writeJson(manifestToStore)}, ${writeJson(grantedPermissions)}, true, 'installed', null)
    on conflict (id) do update
      set name = excluded.name,
          version = excluded.version,
          manifest_json = excluded.manifest_json,
          granted_permissions_json = excluded.granted_permissions_json,
          enabled = true,
          lifecycle_status = 'installed',
          last_error = null,
          updated_at = current_timestamp
    returning id, name, version, enabled, lifecycle_status, last_error,
              granted_permissions_json, manifest_json, installed_at, updated_at
  `
  return mapInstalledPlugin(rows[0])
}

export async function setPluginEnabled(
  db: DbClient,
  id: string,
  enabled: boolean,
): Promise<InstalledPlugin | null> {
  const { rows } = await db<InstalledPluginRow>`
    update installed_plugins set enabled = ${enabled}, updated_at = current_timestamp
    where id = ${id}
    returning id, name, version, enabled, lifecycle_status, last_error,
              granted_permissions_json, manifest_json, installed_at, updated_at
  `
  return rows[0] ? mapInstalledPlugin(rows[0]) : null
}

export async function setPluginLifecycleStatus(
  db: DbClient,
  id: string,
  lifecycleStatus: PluginLifecycleStatus,
  lastError: string | null = null,
): Promise<InstalledPlugin | null> {
  const { rows } = await db<InstalledPluginRow>`
    update installed_plugins set lifecycle_status = ${lifecycleStatus}, last_error = ${lastError}, updated_at = current_timestamp
    where id = ${id}
    returning id, name, version, enabled, lifecycle_status, last_error,
              granted_permissions_json, manifest_json, installed_at, updated_at
  `
  return rows[0] ? mapInstalledPlugin(rows[0]) : null
}

export async function deletePlugin(db: DbClient, id: string): Promise<boolean> {
  const { rowCount } = await db`delete from installed_plugins where id = ${id}`
  return rowCount > 0
}

export async function listPluginRecords(
  db: DbClient,
  pluginId: string,
  resourceId: string,
): Promise<PluginRecord[]> {
  const { rows } = await db<PluginRecordRow>`
    select id, plugin_id, resource_id, data_json, created_at, updated_at
    from plugin_records
    where plugin_id = ${pluginId} and resource_id = ${resourceId}
    order by created_at desc
  `
  return rows.map(mapPluginRecord)
}

export async function createPluginRecord(
  db: DbClient,
  input: {
    id: string
    pluginId: string
    resourceId: string
    data: Record<string, unknown>
  },
): Promise<PluginRecord> {
  const { rows } = await db<PluginRecordRow>`
    insert into plugin_records (id, plugin_id, resource_id, data_json)
    values (${input.id}, ${input.pluginId}, ${input.resourceId}, ${writeJson(input.data)})
    returning id, plugin_id, resource_id, data_json, created_at, updated_at
  `
  return mapPluginRecord(rows[0])
}

export async function updatePluginRecord(
  db: DbClient,
  input: {
    id: string
    pluginId: string
    resourceId: string
    data: Record<string, unknown>
  },
): Promise<PluginRecord | null> {
  const { rows } = await db<PluginRecordRow>`
    update plugin_records set data_json = ${writeJson(input.data)}, updated_at = current_timestamp
    where id = ${input.id} and plugin_id = ${input.pluginId} and resource_id = ${input.resourceId}
    returning id, plugin_id, resource_id, data_json, created_at, updated_at
  `
  return rows[0] ? mapPluginRecord(rows[0]) : null
}

export async function deletePluginRecord(
  db: DbClient,
  input: { id: string; pluginId: string; resourceId: string },
): Promise<boolean> {
  const { rowCount } = await db`
    delete from plugin_records
    where id = ${input.id} and plugin_id = ${input.pluginId} and resource_id = ${input.resourceId}
  `
  return rowCount > 0
}
