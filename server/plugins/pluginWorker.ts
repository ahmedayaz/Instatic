/**
 * Plugin worker entry — runs INSIDE a Bun `Worker` spawned by
 * `pluginWorkerHost`. The worker's job:
 *
 *   1. Read the plugin's bundled server entrypoint from disk.
 *   2. Spawn a QuickJS-WASM context (see `quickjsHost.ts`) that runs the
 *      bundle in a kernel-independent, capability-isolated sandbox. The
 *      plugin code has NO ambient access to Bun/Node APIs — its only
 *      way to interact with the host is the in-VM `__hostCall(target, args)`
 *      function, which routes through the existing api-call protocol.
 *   3. Bridge between the host (postMessage / api-reply) and the VM
 *      (PluginVm interface from quickjsHost.ts).
 *
 * The Bun.Worker keeps its previous responsibilities — crash isolation and
 * keeping plugin CPU off the host's main event loop. The trust boundary
 * has moved inward to QuickJS.
 *
 * Communication (unchanged):
 *   - Inbound:  `MainToWorkerMessage` from `self.onmessage`.
 *   - Outbound: `WorkerToMainMessage` via `self.postMessage`.
 *
 * Correlation IDs:
 *   - For requests originating in main (`load-plugin`, `run-lifecycle`,
 *     `run-route`, …) the worker echoes the same `correlationId` in
 *     its `*-result` reply.
 *   - For api-calls originating in the VM (storage / hooks / settings)
 *     the worker generates a fresh nanoid and waits for `api-reply`.
 */

import { nanoid } from 'nanoid'
import { readFile } from 'node:fs/promises'
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
import { createPluginVm, type PluginVm } from './quickjsHost'

// ---------------------------------------------------------------------------
// Source shim — convert raw ESM `export function name(...)` declarations
// into a single IIFE that attaches the named hooks to
// `globalThis.__plugin_exports`. The QuickJS bridge expects this exact
// shape; the SDK build pipeline emits it natively, but plugin source can
// also be raw ESM (test fixtures, hand-authored single-file plugins).
//
// The transform is intentionally limited — it covers the public lifecycle
// patterns plugin authors actually use (`export function activate(api)`,
// `export const activate = ...`, `export default {...}`). Anything more
// elaborate (top-level `import` statements, dynamic require, side-effect
// modules) needs the SDK bundler.
// ---------------------------------------------------------------------------

function ensureIifeForm(source: string): string {
  // If the source already targets the bridge's globals, pass through.
  if (source.includes('__plugin_exports')) return source

  // Strip line/block comments only when computing the rewrite — we keep the
  // original characters for error messages. The rewriter uses anchored
  // regexes that match `export` at the start of a (possibly indented) line.
  const transformed = source
    .replace(
      /^([ \t]*)export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      '$1__plugin_exports.$3 = $2function $3',
    )
    .replace(
      /^([ \t]*)export\s+const\s+([A-Za-z_$][\w$]*)\s*=/gm,
      '$1__plugin_exports.$2 =',
    )
    .replace(
      /^([ \t]*)export\s+let\s+([A-Za-z_$][\w$]*)\s*=/gm,
      '$1__plugin_exports.$2 =',
    )
    .replace(
      /^([ \t]*)export\s+default\s+/gm,
      '$1__plugin_exports.default = ',
    )

  return `;(function () {\n  const __plugin_exports = (globalThis.__plugin_exports = {});\n${transformed}\n})();\n`
}

// ---------------------------------------------------------------------------
// Per-plugin in-worker registry — just the VM handle.
// ---------------------------------------------------------------------------

const vmsByPluginId = new Map<string, PluginVm>()

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
// Lifecycle handlers
// ---------------------------------------------------------------------------

async function handleLoadPlugin(msg: LoadPluginRequest): Promise<void> {
  try {
    // Tear down any prior VM for the same plugin id (re-load on upgrade).
    const existing = vmsByPluginId.get(msg.pluginId)
    if (existing) {
      existing.dispose()
      vmsByPluginId.delete(msg.pluginId)
    }

    // The host passes an absolute path; we read the bundle as text and
    // hand it to the QuickJS bridge. The worker (not the VM) is what does
    // the file read — fs access stays outside the security boundary.
    const rawSource = await readFile(msg.entryFileUrl, 'utf-8')
    const pluginSource = ensureIifeForm(rawSource)

    const vm = await createPluginVm({
      pluginSource,
      env: {
        pluginId: msg.pluginId,
        manifestVersion: msg.manifest.version,
        grantedPermissions: msg.manifest.grantedPermissions ?? [],
        settings: { ...msg.settings },
        hostCall: (target, args) =>
          callHostApi(msg.pluginId, target as ApiCall['target'], args),
        log: (args) => {
          send({ kind: 'log', pluginId: msg.pluginId, args })
        },
      },
    })

    vmsByPluginId.set(msg.pluginId, vm)
    send({
      kind: 'load-plugin-result',
      correlationId: msg.correlationId,
      ok: true,
      hooks: vm.exportedHooks as LoadPluginResultHooks,
    })
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
  const vm = vmsByPluginId.get(msg.pluginId)
  if (vm) {
    vm.dispose()
    vmsByPluginId.delete(msg.pluginId)
  }
  send({ kind: 'unload-plugin-result', correlationId: msg.correlationId, ok: true })
}

async function handleRunLifecycle(msg: RunLifecycleRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({
      kind: 'lifecycle-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Plugin "${msg.pluginId}" not loaded in worker`,
    })
    return
  }
  if (!vm.exportedHooks.includes(msg.hook)) {
    // No-op — the plugin didn't export this hook, identical to the
    // pre-QuickJS behavior of skipping when `module[hook]` was undefined.
    send({ kind: 'lifecycle-result', correlationId: msg.correlationId, ok: true })
    return
  }
  try {
    await vm.runLifecycle(msg.hook)
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
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({
      kind: 'lifecycle-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Plugin "${msg.pluginId}" not loaded in worker`,
    })
    return
  }
  if (!vm.exportedHooks.includes('migrate')) {
    send({ kind: 'lifecycle-result', correlationId: msg.correlationId, ok: true })
    return
  }
  try {
    await vm.runMigrate(msg.fromVersion)
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
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({ kind: 'route-result', correlationId: msg.correlationId, ok: false, error: 'Plugin not loaded' })
    return
  }
  try {
    const result = await vm.runRoute(msg.routeKey, {
      request: msg.request,
      body: msg.body,
      user: msg.user,
    })
    const response = serializeRouteResult(result)
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

/**
 * Convert a plugin-returned route result into the serialized response shape
 * the host expects. The VM returns plain JSON values (the bootstrap's
 * `__runRoute` JSON-stringifies the handler result), so we don't have an
 * actual `Response` to inspect here — the VM can't construct host
 * `Response` instances. Plugins that need custom status/headers can
 * return `{ __response: true, status, headers, body }` and we materialize it.
 */
function serializeRouteResult(value: unknown): SerializedResponse {
  if (
    value &&
    typeof value === 'object' &&
    (value as { __response?: boolean }).__response === true
  ) {
    const r = value as { status?: number; headers?: Record<string, string>; body?: string }
    return {
      kind: 'response',
      status: typeof r.status === 'number' ? r.status : 200,
      headers: r.headers ?? {},
      body: typeof r.body === 'string' ? r.body : '',
    }
  }
  return { kind: 'json', value: value === undefined ? { ok: true } : value }
}

async function handleRunHookListener(msg: RunHookListenerRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({ kind: 'hook-listener-result', correlationId: msg.correlationId, ok: true })
    return
  }
  try {
    await vm.runHookListener(msg.listenerId, msg.payload)
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
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({ kind: 'hook-filter-result', correlationId: msg.correlationId, ok: true, value: msg.value })
    return
  }
  try {
    const next = await vm.runHookFilter(msg.filterId, msg.value)
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
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({
      kind: 'loop-fetch-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Plugin "${msg.pluginId}" not loaded in worker`,
    })
    return
  }
  try {
    const value = await vm.runLoopFetch(msg.sourceId, msg.ctx)
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

async function handleRunLoopPreview(msg: RunLoopPreviewRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) {
    send({
      kind: 'loop-preview-result',
      correlationId: msg.correlationId,
      ok: false,
      error: `Plugin "${msg.pluginId}" not loaded in worker`,
    })
    return
  }
  try {
    const value = await vm.runLoopPreview(msg.sourceId, msg.ctx)
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
// Settings sync — `settings.changed` lands here from the host and updates
// the VM's local mirror so subsequent `api.cms.settings.get(...)` calls
// see the new values synchronously.
// ---------------------------------------------------------------------------

async function maybeApplySettingsChange(reply: ApiReply): Promise<void> {
  // Currently the worker doesn't receive a dedicated settings.changed message;
  // when a plugin's own `settings.replace()` call lands, the host's reply
  // carries the cleaned values, and the VM's facade applies them locally.
  // Kept as a stub for future host-pushed settings updates.
  void reply
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
      void handleRunLoopPreview(msg)
      return
    case 'api-reply':
      void maybeApplySettingsChange(msg)
      handleApiReply(msg)
      return
  }
}
