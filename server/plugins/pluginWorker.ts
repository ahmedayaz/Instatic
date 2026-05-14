/**
 * Plugin worker entry — runs INSIDE a Bun `Worker` spawned by
 * `pluginWorkerHost`. All plugin server modules are imported and
 * executed in this process so the host's main thread never holds a
 * file handle or import-graph dependency on plugin code.
 *
 * Communication:
 *   - Inbound: `MainToWorkerMessage` from `self.onmessage`.
 *   - Outbound: `WorkerToMainMessage` via `self.postMessage`.
 *
 * Correlation IDs:
 *   - For requests originating in main (`load-plugin`, `run-lifecycle`,
 *     `run-route`, …) the worker echoes the same `correlationId` in
 *     its `*-result` reply.
 *   - For api-calls originating in the worker (storage / hooks / settings)
 *     the worker generates a fresh nanoid and waits for `api-reply`.
 */

import { nanoid } from 'nanoid'
import { pathToFileURL } from 'node:url'
import type {
  PluginManifest,
  PluginRecord,
  ServerPluginApi,
  ServerPluginModule,
} from '@core/plugin-sdk'
import { assertPluginPermission } from '@core/plugin-sdk'
import type {
  ApiCall,
  ApiReply,
  LoadPluginRequest,
  MainToWorkerMessage,
  RunHookFilterRequest,
  RunHookListenerRequest,
  RunLifecycleRequest,
  RunLoopFetchRequest,
  RunLoopPreviewRequest,
  RunMigrateRequest,
  RunRouteRequest,
  SerializedResponse,
  UnloadPluginRequest,
  WorkerToMainMessage,
} from './workerProtocol'

// ---------------------------------------------------------------------------
// Per-plugin in-worker registry
// ---------------------------------------------------------------------------

interface LoadedPlugin {
  manifest: PluginManifest
  module: ServerPluginModule
  /** Settings snapshot — refreshed by the host on settings.changed. */
  settings: Record<string, string | number | boolean>
  /** Registered routes, keyed by `<METHOD>:<path>`. */
  routes: Map<string, RouteEntry>
  /** Registered hook listeners, keyed by listenerId. */
  listeners: Map<string, (payload: unknown) => unknown | Promise<unknown>>
  /** Registered hook filters, keyed by filterId. */
  filters: Map<string, (value: unknown, ctx: { pluginId: string }) => unknown | Promise<unknown>>
  /** Registered loop sources, keyed by sourceId. */
  loopSources: Map<string, LoopSource>
}

interface RouteEntry {
  capability: string | null
  handler: (ctx: PluginRouteContext) => unknown | Promise<unknown>
}

interface PluginRouteContext {
  req: Request
  body: Record<string, unknown>
  user: { id: string; email: string; capabilities: string[] } | null
}

interface LoopSource {
  id: string
  fetch: (ctx: unknown) => Promise<{ items: unknown[]; totalItems: number }>
  preview: (ctx: unknown) => unknown[]
}

const plugins = new Map<string, LoadedPlugin>()

// ---------------------------------------------------------------------------
// Outbound message helpers
// ---------------------------------------------------------------------------

function send(msg: WorkerToMainMessage): void {
  ;(self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg)
}

/**
 * Pending `api-call`s awaiting `api-reply` from the host. Cleared on
 * resolve/reject so a misbehaving host (or worker shutdown) doesn't
 * leak handlers.
 */
const pendingApiCalls = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (err: unknown) => void }
>()

function callHostApi(pluginId: string, target: ApiCall['target'], args: unknown[]): Promise<unknown> {
  const correlationId = nanoid()
  return new Promise<unknown>((resolve, reject) => {
    pendingApiCalls.set(correlationId, { resolve, reject })
    send({ kind: 'api-call', correlationId, pluginId, target, args })
  })
}

function handleApiReply(reply: ApiReply): void {
  const pending = pendingApiCalls.get(reply.correlationId)
  if (!pending) return
  pendingApiCalls.delete(reply.correlationId)
  if (reply.ok) pending.resolve(reply.value)
  else pending.reject(new Error(reply.error ?? 'plugin api call failed'))
}

// ---------------------------------------------------------------------------
// Build a `ServerPluginApi` for a given loaded plugin
// ---------------------------------------------------------------------------

function makeApi(loaded: LoadedPlugin): ServerPluginApi {
  const manifest = loaded.manifest

  function register(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    capability: string,
    handler: (ctx: PluginRouteContext) => unknown | Promise<unknown>,
  ) {
    assertPluginPermission(manifest, 'cms.routes')
    const routeKey = `${method}:${normalizeRoutePath(path)}`
    loaded.routes.set(routeKey, { capability, handler })
    void callHostApi(manifest.id, 'cms.routes.register', [
      { method, path: normalizeRoutePath(path), capability, routeKey },
    ])
  }

  function registerPublic(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    handler: (ctx: PluginRouteContext) => unknown | Promise<unknown>,
  ) {
    assertPluginPermission(manifest, 'cms.routes')
    const routeKey = `${method}:${normalizeRoutePath(path)}`
    loaded.routes.set(routeKey, { capability: null, handler })
    void callHostApi(manifest.id, 'cms.routes.register', [
      { method, path: normalizeRoutePath(path), capability: null, routeKey },
    ])
  }

  return {
    plugin: {
      id: manifest.id,
      version: manifest.version,
      permissions: manifest.grantedPermissions ?? [],
      log: (...args) => {
        send({ kind: 'log', pluginId: manifest.id, args })
      },
    },
    cms: {
      routes: {
        get: (path, capability, handler) => register('GET', path, capability, handler as never),
        post: (path, capability, handler) => register('POST', path, capability, handler as never),
        patch: (path, capability, handler) => register('PATCH', path, capability, handler as never),
        delete: (path, capability, handler) => register('DELETE', path, capability, handler as never),
        getPublic: (path, handler) => registerPublic('GET', path, handler as never),
      },
      storage: {
        collection(resourceId) {
          assertPluginPermission(manifest, 'cms.storage')
          return {
            list: async () =>
              (await callHostApi(manifest.id, 'cms.storage.list', [resourceId])) as PluginRecord[],
            create: async (data) =>
              (await callHostApi(manifest.id, 'cms.storage.create', [resourceId, data])) as PluginRecord,
            update: async (recordId, data) =>
              (await callHostApi(manifest.id, 'cms.storage.update', [resourceId, recordId, data])) as PluginRecord | null,
            delete: async (recordId) =>
              (await callHostApi(manifest.id, 'cms.storage.delete', [resourceId, recordId])) as boolean,
          }
        },
      },
      hooks: {
        on(event, listener) {
          assertPluginPermission(manifest, 'cms.hooks')
          const listenerId = nanoid()
          loaded.listeners.set(listenerId, listener as (payload: unknown) => unknown | Promise<unknown>)
          void callHostApi(manifest.id, 'cms.hooks.on', [{ event: event as string, listenerId }])
        },
        filter(name, handler) {
          assertPluginPermission(manifest, 'cms.hooks')
          const filterId = nanoid()
          loaded.filters.set(filterId, handler as (v: unknown, ctx: { pluginId: string }) => unknown | Promise<unknown>)
          void callHostApi(manifest.id, 'cms.hooks.filter', [{ name: name as string, filterId }])
        },
        async emit(event, payload) {
          assertPluginPermission(manifest, 'cms.hooks')
          await callHostApi(manifest.id, 'cms.hooks.emit', [{ event: event as string, payload }])
        },
      },
      loops: {
        registerSource(source) {
          assertPluginPermission(manifest, 'loops.register')
          loaded.loopSources.set(source.id, source as LoopSource)
          // Strip non-serializable fields before sending — fetch / preview
          // stay in the worker; the host only needs the descriptor metadata.
          const { fetch: _fetch, preview: _preview, ...descriptor } = source as Record<string, unknown> & LoopSource
          void callHostApi(manifest.id, 'cms.loops.registerSource', [descriptor])
        },
      },
      settings: {
        get<T extends string | number | boolean = string>(key: string): T | undefined {
          return loaded.settings[key] as T | undefined
        },
        getAll() {
          return { ...loaded.settings }
        },
        async replace(next) {
          const updated = (await callHostApi(manifest.id, 'cms.settings.replace', [next])) as Record<
            string,
            string | number | boolean
          >
          // Host replies with the cleaned values; mirror them locally so
          // subsequent get() calls in the same hook see the new state.
          for (const key of Object.keys(loaded.settings)) delete loaded.settings[key]
          Object.assign(loaded.settings, updated)
        },
      },
    },
  }
}

function normalizeRoutePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') return '/'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

// ---------------------------------------------------------------------------
// Inbound message handlers
// ---------------------------------------------------------------------------

async function handleLoadPlugin(msg: LoadPluginRequest): Promise<void> {
  try {
    // Cache-bust the import URL so re-loads (after upgrade) pick up the
    // new file even though the module path is the same.
    const url = `${pathToFileURL(msg.entryFileUrl).href}?v=${Date.now()}`
    const mod = (await import(url)) as ServerPluginModule
    plugins.set(msg.pluginId, {
      manifest: msg.manifest,
      module: mod,
      settings: { ...msg.settings },
      routes: new Map(),
      listeners: new Map(),
      filters: new Map(),
      loopSources: new Map(),
    })
    const hooks: LoadPluginResultHooks = []
    for (const hook of ['install', 'activate', 'deactivate', 'uninstall', 'migrate'] as const) {
      if (typeof mod[hook] === 'function') hooks.push(hook)
    }
    send({ kind: 'load-plugin-result', correlationId: msg.correlationId, ok: true, hooks })
  } catch (err) {
    send({
      kind: 'load-plugin-result',
      correlationId: msg.correlationId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

type LoadPluginResultHooks = NonNullable<
  Extract<WorkerToMainMessage, { kind: 'load-plugin-result' }>['hooks']
>

function handleUnloadPlugin(msg: UnloadPluginRequest): void {
  plugins.delete(msg.pluginId)
  send({ kind: 'unload-plugin-result', correlationId: msg.correlationId, ok: true })
}

async function handleRunLifecycle(msg: RunLifecycleRequest): Promise<void> {
  const loaded = plugins.get(msg.pluginId)
  if (!loaded) {
    send({
      kind: 'lifecycle-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Plugin "${msg.pluginId}" not loaded in worker`,
    })
    return
  }
  const handler = loaded.module[msg.hook]
  if (!handler) {
    send({ kind: 'lifecycle-result', correlationId: msg.correlationId, ok: true })
    return
  }
  try {
    await handler(makeApi(loaded))
    send({ kind: 'lifecycle-result', correlationId: msg.correlationId, ok: true })
  } catch (err) {
    send({
      kind: 'lifecycle-result',
      correlationId: msg.correlationId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function handleRunMigrate(msg: RunMigrateRequest): Promise<void> {
  const loaded = plugins.get(msg.pluginId)
  if (!loaded) {
    send({
      kind: 'lifecycle-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Plugin "${msg.pluginId}" not loaded in worker`,
    })
    return
  }
  const handler = loaded.module.migrate
  if (!handler) {
    send({ kind: 'lifecycle-result', correlationId: msg.correlationId, ok: true })
    return
  }
  try {
    await handler({ fromVersion: msg.fromVersion }, makeApi(loaded))
    send({ kind: 'lifecycle-result', correlationId: msg.correlationId, ok: true })
  } catch (err) {
    send({
      kind: 'lifecycle-result',
      correlationId: msg.correlationId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function handleRunRoute(msg: RunRouteRequest): Promise<void> {
  const loaded = plugins.get(msg.pluginId)
  if (!loaded) {
    send({ kind: 'route-result', correlationId: msg.correlationId, ok: false, error: 'Plugin not loaded' })
    return
  }
  const entry = loaded.routes.get(msg.routeKey)
  if (!entry) {
    send({ kind: 'route-result', correlationId: msg.correlationId, ok: false, error: 'Route not registered' })
    return
  }

  // Reconstruct a Request-shaped object the plugin can use. We don't try to
  // build a full Bun Request — plugins consume a small subset (url, method,
  // headers, json()). Provide that subset.
  const headers = new Headers(msg.request.headers)
  const fakeRequest = {
    url: msg.request.url,
    method: msg.request.method,
    headers,
    async json() { return JSON.parse(msg.request.body || '{}') },
    async text() { return msg.request.body },
  } as unknown as Request

  try {
    const result = await entry.handler({
      req: fakeRequest,
      body: msg.body,
      user: msg.user,
    })
    const response = await serializeRouteResult(result)
    send({ kind: 'route-result', correlationId: msg.correlationId, ok: true, response })
  } catch (err) {
    send({
      kind: 'route-result',
      correlationId: msg.correlationId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function serializeRouteResult(value: unknown): Promise<SerializedResponse> {
  if (value instanceof Response) {
    const body = await value.text()
    const headers: Record<string, string> = {}
    value.headers.forEach((v, k) => { headers[k] = v })
    return { kind: 'response', status: value.status, headers, body }
  }
  return { kind: 'json', value: value === undefined ? { ok: true } : value }
}

async function handleRunHookListener(msg: RunHookListenerRequest): Promise<void> {
  const loaded = plugins.get(msg.pluginId)
  const listener = loaded?.listeners.get(msg.listenerId)
  if (!listener) {
    send({ kind: 'hook-listener-result', correlationId: msg.correlationId, ok: true })
    return
  }
  try {
    await listener(msg.payload)
    send({ kind: 'hook-listener-result', correlationId: msg.correlationId, ok: true })
  } catch (err) {
    send({
      kind: 'hook-listener-result',
      correlationId: msg.correlationId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function handleRunHookFilter(msg: RunHookFilterRequest): Promise<void> {
  const loaded = plugins.get(msg.pluginId)
  const handler = loaded?.filters.get(msg.filterId)
  if (!handler) {
    send({ kind: 'hook-filter-result', correlationId: msg.correlationId, ok: true, value: msg.value })
    return
  }
  try {
    const next = await handler(msg.value, { pluginId: msg.pluginId })
    send({ kind: 'hook-filter-result', correlationId: msg.correlationId, ok: true, value: next })
  } catch (err) {
    send({
      kind: 'hook-filter-result',
      correlationId: msg.correlationId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function handleRunLoopFetch(msg: RunLoopFetchRequest): Promise<void> {
  const loaded = plugins.get(msg.pluginId)
  const source = loaded?.loopSources.get(msg.sourceId)
  if (!source) {
    send({
      kind: 'loop-fetch-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Loop source "${msg.sourceId}" not registered`,
    })
    return
  }
  try {
    const value = await source.fetch(msg.ctx)
    send({ kind: 'loop-fetch-result', correlationId: msg.correlationId, ok: true, value })
  } catch (err) {
    send({
      kind: 'loop-fetch-result',
      correlationId: msg.correlationId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function handleRunLoopPreview(msg: RunLoopPreviewRequest): void {
  const loaded = plugins.get(msg.pluginId)
  const source = loaded?.loopSources.get(msg.sourceId)
  if (!source) {
    send({
      kind: 'loop-preview-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Loop source "${msg.sourceId}" not registered`,
    })
    return
  }
  try {
    const value = source.preview(msg.ctx)
    send({ kind: 'loop-preview-result', correlationId: msg.correlationId, ok: true, value })
  } catch (err) {
    send({
      kind: 'loop-preview-result',
      correlationId: msg.correlationId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

;(self as unknown as { onmessage: (e: MessageEvent) => void }).onmessage = (event: MessageEvent) => {
  const msg = event.data as MainToWorkerMessage
  switch (msg.kind) {
    case 'load-plugin':
      void handleLoadPlugin(msg)
      return
    case 'unload-plugin':
      handleUnloadPlugin(msg)
      return
    case 'run-lifecycle':
      void handleRunLifecycle(msg)
      return
    case 'run-migrate':
      void handleRunMigrate(msg)
      return
    case 'run-route':
      void handleRunRoute(msg)
      return
    case 'run-hook-listener':
      void handleRunHookListener(msg)
      return
    case 'run-hook-filter':
      void handleRunHookFilter(msg)
      return
    case 'run-loop-fetch':
      void handleRunLoopFetch(msg)
      return
    case 'run-loop-preview':
      handleRunLoopPreview(msg)
      return
    case 'api-reply':
      handleApiReply(msg)
      return
  }
}
