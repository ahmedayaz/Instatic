import { isSafePackageName } from '../site-dependencies/packageNames'
import type { Page } from '../page-tree/schemas'
import type { SiteFile } from '../files/schemas'
import type {
  LockedSiteDependency,
  SiteDependencyLock,
  SiteRuntimeConfig,
  SiteRuntimeTarget,
  SiteScriptRuntimeConfig,
  SiteScriptScope,
} from './schemas'

/**
 * Input shape for `collectRuntimeScripts`. Lives here (next to the function)
 * rather than in `./types` so the type module stays free of `page-tree` imports
 * and the runtime/page-tree type cycle is broken.
 */
export interface CollectRuntimeScriptsInput {
  files: SiteFile[]
  runtime: SiteRuntimeConfig
  page: Page
  target: SiteRuntimeTarget
}

export const DEFAULT_SITE_DEPENDENCY_LOCK: SiteDependencyLock = {
  version: 1,
  packages: {},
  updatedAt: 0,
}

export const DEFAULT_SCRIPT_RUNTIME_CONFIG: SiteScriptRuntimeConfig = {
  enabled: true,
  runInCanvas: true,
  placement: 'body-end',
  timing: 'dom-ready',
  scope: { type: 'all-pages' },
  priority: 100,
}

export const DEFAULT_SITE_RUNTIME: SiteRuntimeConfig = {
  dependencyLock: DEFAULT_SITE_DEPENDENCY_LOCK,
  scripts: {},
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeScriptScope(raw: unknown): SiteScriptScope {
  if (!isRecord(raw)) return DEFAULT_SCRIPT_RUNTIME_CONFIG.scope
  if (raw.type === 'pages') return { type: 'pages', pageIds: stringArray(raw.pageIds) }
  if (raw.type === 'templates') return { type: 'templates', templatePageIds: stringArray(raw.templatePageIds) }
  return DEFAULT_SCRIPT_RUNTIME_CONFIG.scope
}

export function normalizeScriptRuntimeConfig(raw: unknown): SiteScriptRuntimeConfig {
  if (!isRecord(raw)) return { ...DEFAULT_SCRIPT_RUNTIME_CONFIG }

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SCRIPT_RUNTIME_CONFIG.enabled,
    runInCanvas: typeof raw.runInCanvas === 'boolean' ? raw.runInCanvas : DEFAULT_SCRIPT_RUNTIME_CONFIG.runInCanvas,
    placement: raw.placement === 'head' || raw.placement === 'body-end'
      ? raw.placement
      : DEFAULT_SCRIPT_RUNTIME_CONFIG.placement,
    timing: raw.timing === 'immediate' || raw.timing === 'dom-ready' || raw.timing === 'idle'
      ? raw.timing
      : DEFAULT_SCRIPT_RUNTIME_CONFIG.timing,
    scope: normalizeScriptScope(raw.scope),
    priority: finiteNumberOr(raw.priority, DEFAULT_SCRIPT_RUNTIME_CONFIG.priority),
  }
}

function normalizeLockedDependency(rawKey: string, raw: unknown): LockedSiteDependency | null {
  const key = rawKey.trim()
  if (!key || !isSafePackageName(key) || !isRecord(raw)) return null

  const requested = typeof raw.requested === 'string' && raw.requested.trim()
    ? raw.requested.trim()
    : ''
  const version = typeof raw.version === 'string' && raw.version.trim()
    ? raw.version.trim()
    : ''
  if (!requested || !version) return null

  return {
    name: key,
    requested,
    version,
    ...(typeof raw.integrity === 'string' && raw.integrity.trim() ? { integrity: raw.integrity.trim() } : {}),
    ...(typeof raw.tarballUrl === 'string' && raw.tarballUrl.trim() ? { tarballUrl: raw.tarballUrl.trim() } : {}),
    resolvedAt: finiteNumberOr(raw.resolvedAt, 0),
  }
}

function normalizeDependencyLock(raw: unknown): SiteDependencyLock {
  if (!isRecord(raw)) return { ...DEFAULT_SITE_DEPENDENCY_LOCK, packages: {} }

  const packages: Record<string, LockedSiteDependency> = {}
  if (isRecord(raw.packages)) {
    for (const [name, value] of Object.entries(raw.packages)) {
      const dependency = normalizeLockedDependency(name, value)
      if (dependency) packages[dependency.name] = dependency
    }
  }

  return {
    version: 1,
    packages,
    updatedAt: finiteNumberOr(raw.updatedAt, 0),
  }
}

export function normalizeSiteRuntimeConfig(raw: unknown): SiteRuntimeConfig {
  if (!isRecord(raw)) return { dependencyLock: { ...DEFAULT_SITE_DEPENDENCY_LOCK, packages: {} }, scripts: {} }

  const scripts: Record<string, SiteScriptRuntimeConfig> = {}
  if (isRecord(raw.scripts)) {
    for (const [fileId, value] of Object.entries(raw.scripts)) {
      if (fileId.trim()) scripts[fileId] = normalizeScriptRuntimeConfig(value)
    }
  }

  return {
    dependencyLock: normalizeDependencyLock(raw.dependencyLock),
    scripts,
  }
}

export function cloneSiteRuntimeConfig(runtime: SiteRuntimeConfig = DEFAULT_SITE_RUNTIME): SiteRuntimeConfig {
  return normalizeSiteRuntimeConfig(runtime)
}

export function scriptAppliesToPage(
  config: Pick<SiteScriptRuntimeConfig, 'scope'>,
  page: { id: string; template?: unknown },
): boolean {
  if (config.scope.type === 'all-pages') return true
  if (config.scope.type === 'pages') return config.scope.pageIds.includes(page.id)
  return Boolean(page.template) && config.scope.templatePageIds.includes(page.id)
}

export function collectRuntimeScripts({
  files,
  runtime,
  page,
  target,
}: CollectRuntimeScriptsInput) {
  return files
    .filter((file) => file.type === 'script')
    .map((file) => ({
      file,
      config: runtime.scripts[file.id] ?? { ...DEFAULT_SCRIPT_RUNTIME_CONFIG },
    }))
    .filter(({ config }) => config.enabled)
    .filter(({ config }) => target !== 'canvas' || config.runInCanvas)
    .filter(({ config }) => scriptAppliesToPage(config, page))
    .sort((a, b) => {
      const priority = a.config.priority - b.config.priority
      return priority || a.file.path.localeCompare(b.file.path)
    })
}
