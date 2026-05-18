/**
 * QuickJS-WASM host bridge — runs plugin code inside a WebAssembly-isolated
 * VM with no access to Bun / Node ambient APIs. The plugin can only call
 * back through the host-imported `__hostCall(target, args)` function, which
 * routes to the existing api-call dispatch in `pluginWorkerHost.ts`.
 *
 * Sandbox topology:
 *   ┌─ Bun host (main process)
 *   │  ┌─ Bun.Worker (crash isolation, CPU yield)
 *   │  │  ┌─ QuickJS-WASM context (security sandbox — THIS file)
 *   │  │  │  ┌─ Bootstrap (SDK facade + handler registries + minimal runtime)
 *   │  │  │  └─ Plugin source (IIFE → globalThis.__plugin_exports)
 *   │  │  └─ Host functions: __hostCall, __log
 *   │  └─ workerProtocol.ts wire format (unchanged)
 *   └─ pluginWorkerHost.ts api-call dispatch (unchanged)
 *
 * Concurrency model — sync QuickJS variant + deferred VM promises:
 *
 *   - The synchronous WASM variant of QuickJS is used (NOT the asyncified one).
 *     Asyncify's stack-unwinding interacts badly with Bun's microtask scheduler
 *     under load (manifests as `p->ref_count == 0` assertions on the second
 *     async eval). The sync variant is rock-stable.
 *   - `__hostCall` is registered as a *synchronous* VM function. When the
 *     plugin invokes it, the host creates a VM-side `Promise` via
 *     `ctx.newPromise()`, kicks off the real async work, and returns the
 *     Promise handle immediately. When the host work completes,
 *     `deferred.resolve(...)` lands the value into the VM and triggers any
 *     queued `.then` continuations.
 *   - The host drains the VM's microtask queue via
 *     `runtime.executePendingJobs()` after each settle and during eval polling.
 *
 * The SDK provided inside the VM:
 *   • `api.plugin.{id,version,permissions,log}`
 *   • `api.cms.routes.{get,post,patch,delete,getPublic}`
 *   • `api.cms.storage.collection(id).{list,create,update,delete}`
 *   • `api.cms.hooks.{on,filter,emit}`
 *   • `api.cms.loops.registerSource`
 *   • `api.cms.settings.{get,getAll,replace}`
 *
 * Denied inside the VM (verified by `scripts/spike-quickjs-host.ts`):
 *   • `Bun`, `process`, `require`, `import('node:*' | 'bun:*')`
 *   • `fetch`, `WebSocket`, `XMLHttpRequest` — to be re-introduced under
 *     `network.outbound` permission as a gated host function (separate step).
 *   • `eval` cannot escape — the VM has no references into the host's heap.
 */

import { getQuickJS, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from 'quickjs-emscripten'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PluginVmEnv {
  pluginId: string
  manifestVersion: string
  /** Permissions granted at install time — surfaced via api.plugin.permissions. */
  grantedPermissions: string[]
  /** Initial settings snapshot — read synchronously inside the VM via api.cms.settings.get. */
  settings: Record<string, string | number | boolean>
  /**
   * Dispatch a host-side api-call. The implementation MUST validate
   * permission + target on the host side (see `dispatchApiCall` in
   * `pluginWorkerHost.ts`). Return value is JSON-serializable.
   */
  hostCall: (target: string, args: unknown[]) => Promise<unknown>
  /**
   * Stream a log line back to the host. Equivalent to `api.plugin.log(...)`.
   * Kept separate from hostCall so the existing `log` worker→main event
   * stays a fire-and-forget message (no correlation id).
   */
  log: (args: unknown[]) => void
}

export interface PluginVm {
  readonly pluginId: string
  /** Names of lifecycle hooks the plugin actually exported. */
  readonly exportedHooks: ReadonlyArray<'install' | 'activate' | 'deactivate' | 'uninstall' | 'migrate'>
  runLifecycle: (hook: 'install' | 'activate' | 'deactivate' | 'uninstall') => Promise<void>
  runMigrate: (fromVersion: string) => Promise<void>
  runRoute: (routeKey: string, ctx: VmRouteContext) => Promise<unknown>
  runHookListener: (listenerId: string, payload: unknown) => Promise<void>
  runHookFilter: (filterId: string, value: unknown) => Promise<unknown>
  runLoopFetch: (sourceId: string, ctx: unknown) => Promise<{ items: unknown[]; totalItems: number }>
  runLoopPreview: (sourceId: string, ctx: unknown) => Promise<unknown[]>
  /** Update the VM's settings mirror so subsequent api.cms.settings.get() sees the new values. */
  updateSettings: (next: Record<string, string | number | boolean>) => Promise<void>
  dispose: () => void
}

export interface VmRouteContext {
  request: {
    url: string
    method: string
    headers: Record<string, string>
    body: string
  }
  body: Record<string, unknown>
  user: { id: string; email: string; capabilities: string[] } | null
}

// ---------------------------------------------------------------------------
// Singleton WASM module — one per worker, shared across plugin contexts.
// ---------------------------------------------------------------------------

let wasmModulePromise: Promise<QuickJSWASMModule> | null = null

function getWasmModule(): Promise<QuickJSWASMModule> {
  if (!wasmModulePromise) wasmModulePromise = getQuickJS()
  return wasmModulePromise
}

// ---------------------------------------------------------------------------
// JS↔VM marshalling
// ---------------------------------------------------------------------------

/**
 * Convert a JSON-serializable JS value into a fresh QuickJS handle. Caller
 * owns the returned handle and must dispose it (or transfer ownership to
 * the VM via `setProp` / function return).
 */
function jsToHandle(ctx: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === null || value === undefined) return ctx.undefined
  if (typeof value === 'string') return ctx.newString(value)
  if (typeof value === 'number') return ctx.newNumber(value)
  if (typeof value === 'boolean') return value ? ctx.true : ctx.false
  if (Array.isArray(value)) {
    const arr = ctx.newArray()
    value.forEach((item, idx) => {
      const itemHandle = jsToHandle(ctx, item)
      ctx.setProp(arr, idx, itemHandle)
      itemHandle.dispose()
    })
    return arr
  }
  if (typeof value === 'object') {
    const obj = ctx.newObject()
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childHandle = jsToHandle(ctx, v)
      ctx.setProp(obj, k, childHandle)
      childHandle.dispose()
    }
    return obj
  }
  // Functions / Symbols / BigInts aren't JSON-serializable across the boundary.
  return ctx.newString(String(value))
}

// ---------------------------------------------------------------------------
// Bootstrap source — evaluated inside the VM BEFORE the plugin code runs.
//
// Provides:
//   - `__plugin_handlers`        : maps storing route/listener/filter/loopSource handlers
//   - `__buildApi()`             : constructs the ServerPluginApi object plugins see
//   - `__runRoute / __runHookListener / __runHookFilter / __runLoopFetch / __runLoopPreview / __runLifecycle`
//   - `__plugin_meta` + `__plugin_settings`
//   - Minimal `console` polyfill routing to `__log`
//
// The plugin source runs AFTER this and attaches its lifecycle hooks to
// `globalThis.__plugin_exports`. Then the host evaluates `__runLifecycle(hook)`
// to dispatch.
// ---------------------------------------------------------------------------

const BOOTSTRAP_SOURCE = `
'use strict';

// ------- minimal runtime stubs -------
const __consoleProxy = (level) => function () {
  const parts = [];
  for (let i = 0; i < arguments.length; i++) {
    const a = arguments[i];
    if (a instanceof Error) parts.push(a.stack || a.message);
    else if (typeof a === 'string') parts.push(a);
    else {
      try { parts.push(JSON.stringify(a)); }
      catch (_) { parts.push(String(a)); }
    }
  }
  __log(level, parts.join(' '));
};
globalThis.console = {
  log: __consoleProxy('info'),
  info: __consoleProxy('info'),
  warn: __consoleProxy('warn'),
  error: __consoleProxy('error'),
  debug: __consoleProxy('info'),
  trace: __consoleProxy('info'),
};

// ------- gated fetch -------
// Plugins with the 'network.outbound' permission AND a matching entry in
// the manifest's networkAllowedHosts can issue outbound HTTP. The host
// enforces both checks (kernel-of-correctness); this shim provides a
// Response-like façade so plugin code can use the familiar fetch API.
globalThis.fetch = async function fetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
  const opts = init && typeof init === 'object' ? init : {};
  const serialized = {
    method: typeof opts.method === 'string' ? opts.method : 'GET',
    headers: opts.headers && typeof opts.headers === 'object' ? opts.headers : {},
    body: typeof opts.body === 'string' ? opts.body : (opts.body == null ? undefined : String(opts.body)),
  };
  // hostCall returns { status, ok, headers, body } — see performGatedFetch.
  const result = await __hostCall('network.fetch', [url, serialized]);
  return {
    status: result.status,
    ok: result.ok,
    headers: {
      get: function (name) { return result.headers[String(name).toLowerCase()] || null; },
      has: function (name) { return Object.prototype.hasOwnProperty.call(result.headers, String(name).toLowerCase()); },
      forEach: function (cb) { for (const k of Object.keys(result.headers)) cb(result.headers[k], k); },
    },
    text: async function () { return result.body; },
    json: async function () { return JSON.parse(result.body); },
    arrayBuffer: async function () {
      const buf = new Uint8Array(result.body.length);
      for (let i = 0; i < result.body.length; i++) buf[i] = result.body.charCodeAt(i) & 0xff;
      return buf.buffer;
    },
  };
};

// ------- handler registries (live inside the VM, host has metadata) -------
globalThis.__plugin_handlers = {
  routes: {},
  listeners: {},
  filters: {},
  loopSources: {},
};

// ------- the api object plugins receive -------
globalThis.__buildApi = function buildApi() {
  const meta = globalThis.__plugin_meta;

  function assertPermission(perm) {
    // Sync defense-in-depth check INSIDE the VM. The host-side dispatcher
    // also enforces permissions (kernel-of-correctness), but the host check
    // surfaces as a rejected Promise — plugin code that doesn't await
    // would otherwise silently succeed. Throwing synchronously here matches
    // the pre-sandbox 'assertPluginPermission' behavior plugin authors
    // already rely on.
    if (meta.permissions.indexOf(perm) < 0) {
      throw new Error('Plugin "' + meta.id + '" requires permission "' + perm + '"');
    }
  }

  function call(target, args) {
    return __hostCall(target, args);
  }

  function normalizePath(p) {
    const t = String(p).trim();
    if (!t || t === '/') return '/';
    return '/' + t.replace(/^\\/+|\\/+$/g, '');
  }

  function makeRoute(method) {
    return function (path, capability, handler) {
      assertPermission('cms.routes');
      if (typeof handler !== 'function') throw new TypeError('Route handler must be a function');
      const routeKey = method + ':' + normalizePath(path);
      globalThis.__plugin_handlers.routes[routeKey] = handler;
      return call('cms.routes.register', [{ method: method, path: normalizePath(path), capability: capability, routeKey: routeKey }]);
    };
  }
  function registerPublic(method) {
    return function (path, handler) {
      assertPermission('cms.routes');
      if (typeof handler !== 'function') throw new TypeError('Route handler must be a function');
      const routeKey = method + ':' + normalizePath(path);
      globalThis.__plugin_handlers.routes[routeKey] = handler;
      return call('cms.routes.register', [{ method: method, path: normalizePath(path), capability: null, routeKey: routeKey }]);
    };
  }

  function on(event, listener) {
    assertPermission('cms.hooks');
    if (typeof listener !== 'function') throw new TypeError('Hook listener must be a function');
    const listenerId = __nextId('listener');
    globalThis.__plugin_handlers.listeners[listenerId] = listener;
    return call('cms.hooks.on', [{ event: String(event), listenerId: listenerId }]);
  }
  function filter(name, handler) {
    assertPermission('cms.hooks');
    if (typeof handler !== 'function') throw new TypeError('Hook filter must be a function');
    const filterId = __nextId('filter');
    globalThis.__plugin_handlers.filters[filterId] = handler;
    return call('cms.hooks.filter', [{ name: String(name), filterId: filterId }]);
  }
  function emit(event, payload) {
    assertPermission('cms.hooks');
    return call('cms.hooks.emit', [{ event: String(event), payload: payload === undefined ? null : payload }]);
  }

  function registerSource(source) {
    assertPermission('loops.register');
    if (!source || typeof source !== 'object') throw new TypeError('Loop source must be an object');
    if (typeof source.fetch !== 'function') throw new TypeError('Loop source.fetch must be a function');
    const sourceId = String(source.id);
    globalThis.__plugin_handlers.loopSources[sourceId] = {
      fetch: source.fetch,
      preview: typeof source.preview === 'function' ? source.preview : function () { return []; },
    };
    const descriptor = {
      id: sourceId,
      label: source.label,
      description: source.description,
      filterSchema: source.filterSchema || {},
      orderByOptions: source.orderByOptions || [],
      fields: source.fields || [],
    };
    return call('cms.loops.registerSource', [descriptor]);
  }

  function collection(resourceId) {
    assertPermission('cms.storage');
    return {
      list: function () { return call('cms.storage.list', [String(resourceId)]); },
      create: function (data) { return call('cms.storage.create', [String(resourceId), data]); },
      update: function (recordId, data) { return call('cms.storage.update', [String(resourceId), String(recordId), data]); },
      delete: function (recordId) { return call('cms.storage.delete', [String(resourceId), String(recordId)]); },
    };
  }

  const settingsApi = {
    get: function (key) { return globalThis.__plugin_settings[key]; },
    getAll: function () { return Object.assign({}, globalThis.__plugin_settings); },
    replace: async function (next) {
      const updated = await call('cms.settings.replace', [next]);
      for (const k of Object.keys(globalThis.__plugin_settings)) delete globalThis.__plugin_settings[k];
      if (updated && typeof updated === 'object') Object.assign(globalThis.__plugin_settings, updated);
    },
  };

  return {
    plugin: {
      id: meta.id,
      version: meta.version,
      permissions: meta.permissions.slice(),
      log: function () {
        const parts = [];
        for (let i = 0; i < arguments.length; i++) {
          const a = arguments[i];
          if (typeof a === 'string') parts.push(a);
          else {
            try { parts.push(JSON.stringify(a)); }
            catch (_) { parts.push(String(a)); }
          }
        }
        __log('info', parts.join(' '));
      },
    },
    cms: {
      routes: {
        get: makeRoute('GET'),
        post: makeRoute('POST'),
        patch: makeRoute('PATCH'),
        delete: makeRoute('DELETE'),
        getPublic: registerPublic('GET'),
      },
      storage: { collection: collection },
      hooks: { on: on, filter: filter, emit: emit },
      loops: { registerSource: registerSource },
      settings: settingsApi,
    },
  };
};

let __idCounter = 0;
function __nextId(prefix) { __idCounter += 1; return prefix + '_' + __idCounter + '_' + Date.now().toString(36); }

// ------- runners — host calls these to dispatch into plugin code -------

globalThis.__runLifecycle = async function runLifecycle(hook) {
  const fn = globalThis.__plugin_exports && globalThis.__plugin_exports[hook];
  if (typeof fn !== 'function') return;
  await fn(globalThis.__buildApi());
};

globalThis.__runMigrate = async function runMigrate(fromVersion) {
  const fn = globalThis.__plugin_exports && globalThis.__plugin_exports.migrate;
  if (typeof fn !== 'function') return;
  await fn({ fromVersion: fromVersion }, globalThis.__buildApi());
};

globalThis.__runRoute = async function runRoute(routeKey, ctxJson) {
  const handler = globalThis.__plugin_handlers.routes[routeKey];
  if (!handler) throw new Error('Route handler not registered: ' + routeKey);
  const ctx = JSON.parse(ctxJson);
  const req = {
    url: ctx.request.url,
    method: ctx.request.method,
    headers: ctx.request.headers,
    json: async function () { return JSON.parse(ctx.request.body || '{}'); },
    text: async function () { return ctx.request.body; },
  };
  const result = await handler({ req: req, body: ctx.body, user: ctx.user });
  return JSON.stringify(result === undefined ? { ok: true } : result);
};

globalThis.__runHookListener = async function runHookListener(listenerId, payloadJson) {
  const fn = globalThis.__plugin_handlers.listeners[listenerId];
  if (!fn) return;
  await fn(JSON.parse(payloadJson));
};

globalThis.__runHookFilter = async function runHookFilter(filterId, valueJson) {
  const fn = globalThis.__plugin_handlers.filters[filterId];
  if (!fn) return valueJson;
  const value = JSON.parse(valueJson);
  const next = await fn(value, { pluginId: globalThis.__plugin_meta.id });
  return JSON.stringify(next === undefined ? value : next);
};

globalThis.__runLoopFetch = async function runLoopFetch(sourceId, ctxJson) {
  const source = globalThis.__plugin_handlers.loopSources[sourceId];
  if (!source) throw new Error('Loop source not registered: ' + sourceId);
  const result = await source.fetch(JSON.parse(ctxJson));
  return JSON.stringify(result);
};

globalThis.__runLoopPreview = function runLoopPreview(sourceId, ctxJson) {
  const source = globalThis.__plugin_handlers.loopSources[sourceId];
  if (!source) throw new Error('Loop source not registered: ' + sourceId);
  return JSON.stringify(source.preview(JSON.parse(ctxJson)));
};

globalThis.__updateSettings = function updateSettings(nextJson) {
  const next = JSON.parse(nextJson);
  for (const k of Object.keys(globalThis.__plugin_settings)) delete globalThis.__plugin_settings[k];
  Object.assign(globalThis.__plugin_settings, next);
};

globalThis.__detectExportedHooks = function detectExportedHooks() {
  const known = ['install', 'activate', 'deactivate', 'uninstall', 'migrate'];
  const exp = globalThis.__plugin_exports || {};
  const out = [];
  for (const name of known) {
    if (typeof exp[name] === 'function') out.push(name);
  }
  return JSON.stringify(out);
};
`

// ---------------------------------------------------------------------------
// VM construction
// ---------------------------------------------------------------------------

/**
 * Create a fresh QuickJS context for a plugin, evaluate the bootstrap, wire
 * in host functions, evaluate the plugin source bundle, and return a
 * `PluginVm` with strongly-typed entry points. Caller MUST `dispose()` when
 * the plugin is unloaded.
 *
 * Plugin source MUST be an IIFE that attaches its lifecycle hooks to
 * `globalThis.__plugin_exports`. The SDK build pipeline produces this shape
 * for server bundles — see `src/core/plugin-sdk/cli/build.ts`.
 */
export async function createPluginVm(args: {
  pluginSource: string
  env: PluginVmEnv
}): Promise<PluginVm> {
  const wasm = await getWasmModule()
  const ctx = wasm.newContext()
  /**
   * Host function handles MUST be kept alive for the lifetime of the
   * context — QuickJS's emscripten binding holds them via a HostRefMap and
   * disposing the JS-side handle early invalidates the in-VM callable.
   * They get released alongside the context in `dispose()` below.
   */
  const hostFunctionHandles: QuickJSHandle[] = []

  try {
    // 1. Wire __hostCall as a SYNCHRONOUS VM function. The host returns a
    //    VM-side Promise immediately and resolves it later from JS-land.
    //    `runtime.executePendingJobs()` drives any queued plugin-side .then
    //    continuations after the resolve lands.
    const hostCallHandle = ctx.newFunction('__hostCall', (targetHandle, argsHandle) => {
      const target = ctx.getString(targetHandle)
      const dumpedArgs = ctx.dump(argsHandle) as unknown
      const argsArray = Array.isArray(dumpedArgs) ? dumpedArgs : []

      const deferred = ctx.newPromise()
      args.env.hostCall(target, argsArray).then(
        (value) => {
          if (!deferred.alive) return
          const valueHandle = jsToHandle(ctx, value)
          deferred.resolve(valueHandle)
          if (valueHandle !== ctx.undefined && valueHandle !== ctx.null && valueHandle !== ctx.true && valueHandle !== ctx.false) {
            valueHandle.dispose()
          }
          // Drain plugin-side microtasks queued by the resolve.
          ctx.runtime.executePendingJobs()
        },
        (err) => {
          if (!deferred.alive) return
          const message = err instanceof Error ? err.message : String(err)
          const errHandle = ctx.newError(message)
          deferred.reject(errHandle)
          errHandle.dispose()
          ctx.runtime.executePendingJobs()
        },
      )
      return deferred.handle
    })
    ctx.setProp(ctx.global, '__hostCall', hostCallHandle)
    hostFunctionHandles.push(hostCallHandle)

    // 2. Wire __log — fire-and-forget log channel.
    const logHandle = ctx.newFunction('__log', (levelHandle, messageHandle) => {
      const level = ctx.getString(levelHandle)
      const message = ctx.getString(messageHandle)
      args.env.log([`[${level}]`, message])
    })
    ctx.setProp(ctx.global, '__log', logHandle)
    hostFunctionHandles.push(logHandle)

    // 3. Wire meta + settings as VM globals.
    const metaHandle = jsToHandle(ctx, {
      id: args.env.pluginId,
      version: args.env.manifestVersion,
      permissions: args.env.grantedPermissions,
    })
    ctx.setProp(ctx.global, '__plugin_meta', metaHandle)
    metaHandle.dispose()

    const settingsHandle = jsToHandle(ctx, { ...args.env.settings })
    ctx.setProp(ctx.global, '__plugin_settings', settingsHandle)
    settingsHandle.dispose()

    // 4. Evaluate the bootstrap and plugin bundle.
    ctx.unwrapResult(ctx.evalCode(BOOTSTRAP_SOURCE, 'pagebuilder-bootstrap.js')).dispose()
    ctx.unwrapResult(ctx.evalCode(args.pluginSource, `plugin:${args.env.pluginId}`)).dispose()

    // 5. Detect which lifecycle hooks the plugin exported.
    const exportedHooks = await evalJson<Array<'install' | 'activate' | 'deactivate' | 'uninstall' | 'migrate'>>(
      ctx,
      `__detectExportedHooks()`,
    )

    const pluginId = args.env.pluginId

    return {
      pluginId,
      exportedHooks,

      async runLifecycle(hook) {
        await evalVoid(ctx, `__runLifecycle(${JSON.stringify(hook)})`)
      },

      async runMigrate(fromVersion) {
        await evalVoid(ctx, `__runMigrate(${JSON.stringify(fromVersion)})`)
      },

      async runRoute(routeKey, routeCtx) {
        const ctxJson = JSON.stringify(routeCtx)
        const json = await evalString(ctx, `__runRoute(${JSON.stringify(routeKey)}, ${JSON.stringify(ctxJson)})`)
        return JSON.parse(json) as unknown
      },

      async runHookListener(listenerId, payload) {
        const payloadJson = JSON.stringify(payload ?? null)
        await evalVoid(ctx, `__runHookListener(${JSON.stringify(listenerId)}, ${JSON.stringify(payloadJson)})`)
      },

      async runHookFilter(filterId, value) {
        const valueJson = JSON.stringify(value ?? null)
        const resultJson = await evalString(
          ctx,
          `__runHookFilter(${JSON.stringify(filterId)}, ${JSON.stringify(valueJson)})`,
        )
        return JSON.parse(resultJson) as unknown
      },

      async runLoopFetch(sourceId, loopCtx) {
        const ctxJson = JSON.stringify(loopCtx ?? null)
        const json = await evalString(ctx, `__runLoopFetch(${JSON.stringify(sourceId)}, ${JSON.stringify(ctxJson)})`)
        const parsed = JSON.parse(json) as { items?: unknown[]; totalItems?: number }
        return {
          items: Array.isArray(parsed.items) ? parsed.items : [],
          totalItems: typeof parsed.totalItems === 'number' ? parsed.totalItems : 0,
        }
      },

      async runLoopPreview(sourceId, loopCtx) {
        const ctxJson = JSON.stringify(loopCtx ?? null)
        const json = await evalString(ctx, `__runLoopPreview(${JSON.stringify(sourceId)}, ${JSON.stringify(ctxJson)})`)
        const parsed = JSON.parse(json) as unknown
        return Array.isArray(parsed) ? parsed : []
      },

      async updateSettings(next) {
        const json = JSON.stringify(next)
        await evalVoid(ctx, `__updateSettings(${JSON.stringify(json)})`)
      },

      dispose() {
        for (const h of hostFunctionHandles) {
          try { if (h.alive) h.dispose() } catch {/* already disposed */}
        }
        try { ctx.dispose() } catch {/* already disposed */}
      },
    }
  } catch (err) {
    for (const h of hostFunctionHandles) {
      try { if (h.alive) h.dispose() } catch {/* ignore */}
    }
    try { ctx.dispose() } catch {/* ignore */}
    throw err
  }
}

// ---------------------------------------------------------------------------
// Eval helpers — drive a VM expression to a fully-resolved value.
//
// Polling pattern (no asyncify):
//   1. evalCode runs the synchronous portion of the expression
//   2. If the result is a Promise (e.g. from `async function` call),
//      we poll its state via getPromiseState
//   3. Between polls: executePendingJobs() advances VM microtasks
//   4. If no jobs ran and the Promise is still pending, yield to the host
//      event loop so __hostCall's host-side .then can fire deferred.resolve
//   5. Once fulfilled/rejected, return the value or throw the error
// ---------------------------------------------------------------------------

async function evalResolved<T>(
  ctx: QuickJSContext,
  code: string,
  read: (handle: QuickJSHandle) => T,
): Promise<T> {
  const evalResult = ctx.evalCode(code, 'pagebuilder-eval.js')
  const evalHandle = ctx.unwrapResult(evalResult)

  // Drain any microtasks scheduled by the eval's synchronous portion.
  drainJobs(ctx)

  // Probe Promise state. For non-promises, `getPromiseState` returns a
  // fulfilled state with `notAPromise: true` and `value` set to the
  // original handle (no new ownership transfer).
  const initialState = ctx.getPromiseState(evalHandle)
  if (initialState.type === 'fulfilled' && initialState.notAPromise) {
    try {
      return read(evalHandle)
    } finally {
      evalHandle.dispose()
    }
  }

  // It IS a Promise — pump VM jobs + host event loop until it settles.
  const MAX_BATCHES = 10_000
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const state = ctx.getPromiseState(evalHandle)
    if (state.type === 'fulfilled') {
      const valueHandle = state.value
      evalHandle.dispose()
      try {
        return read(valueHandle)
      } finally {
        valueHandle.dispose()
      }
    }
    if (state.type === 'rejected') {
      const errorHandle = state.error
      const errorValue = ctx.dump(errorHandle) as { message?: string; stack?: string } | string | undefined
      evalHandle.dispose()
      // Surface the plugin's own error message verbatim — the host's
      // logging (`[plugin:<id>]`) provides the context, so a "Plugin VM
      // threw: " prefix would just be redundant noise.
      const message = typeof errorValue === 'object' && errorValue && errorValue.message
        ? errorValue.message
        : typeof errorValue === 'string'
          ? errorValue
          : 'VM promise rejected with unknown error'
      throw new Error(message)
    }
    // Still pending. Drain VM microtasks, then yield to host event loop
    // so any pending __hostCall host-side resolution can fire.
    const ranJobs = drainJobs(ctx)
    if (ranJobs === 0) {
      await new Promise<void>((res) => setTimeout(res, 0))
    }
  }
  evalHandle.dispose()
  throw new Error(`VM promise did not settle within ${MAX_BATCHES} batches`)
}

/**
 * Drain QuickJS's pending-job queue. The result is a `DisposableResult` —
 * either success (`.value` is the count of jobs that ran) or failure
 * (`.value` is the error handle). We treat any error as 0 jobs ran and
 * just dispose the error; uncaught microtask errors inside the VM usually
 * mean a plugin bug that the calling eval's reject path will surface
 * cleanly.
 */
function drainJobs(ctx: QuickJSContext): number {
  const result = ctx.runtime.executePendingJobs()
  if ('error' in result && result.error) {
    try { result.error.dispose() } catch { /* ignore */ }
    return 0
  }
  if ('value' in result && typeof result.value === 'number') {
    return result.value
  }
  return 0
}

function evalVoid(ctx: QuickJSContext, code: string): Promise<void> {
  return evalResolved(ctx, code, () => undefined)
}

function evalString(ctx: QuickJSContext, code: string): Promise<string> {
  return evalResolved(ctx, code, (h) => ctx.getString(h))
}

async function evalJson<T>(ctx: QuickJSContext, code: string): Promise<T> {
  const raw = await evalString(ctx, `JSON.stringify((${code}))`)
  return JSON.parse(raw) as T
}
