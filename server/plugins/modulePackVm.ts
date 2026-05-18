/**
 * Plugin module pack sandbox — server-side.
 *
 * Plugins that declare `entrypoints.modules` ship a bundle whose default
 * export is an array of `PluginModuleDefinition` objects (or a function
 * returning one). Each definition has a `render(props, children) => { html, css }`
 * that the publisher invokes per canvas node during page generation.
 *
 * Before this module existed, the host loaded module packs via
 * `await import(dataUrl)` — running the bundle in-host with full Bun/Node
 * privileges. That was a complete RCE bypass: a malicious plugin could put
 * its payload in `entrypoints.modules` and skip the server-entrypoint
 * sandbox entirely. This file closes that hole by running the module pack
 * inside a QuickJS-WASM context exactly like server entrypoints.
 *
 * What runs inside the VM:
 *   - The pack's bundled JS (wrapped to attach to `globalThis.__module_pack`)
 *   - The pack's `render()` functions, invoked per node during publish
 *
 * What stays in the host:
 *   - Module metadata (id, name, schema, defaults, htmlTag, …) — copied out
 *     as JSON-serializable values at activation time
 *   - The host's `ModuleDefinition` wrapping (registry, error boundaries,
 *     React component factory for editor preview — already host-only)
 *
 * Performance note: render is called possibly hundreds of times per publish.
 * Each call is a sync QuickJS eval — sub-millisecond on typical hardware.
 * Publishes are background jobs; the cost is acceptable.
 */

import { getQuickJS, type QuickJSContext, type QuickJSWASMModule } from 'quickjs-emscripten'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Render output — must match `PluginRenderOutput` in the SDK. We restate it
 * here so this file stays free of the SDK dependency graph; mismatches would
 * be caught by the type system at the call site.
 */
export interface ModulePackRenderOutput {
  html: string
  css?: string
}

/**
 * Module metadata as it exits the VM. Mirrors `PluginModuleDefinition` minus
 * the function fields (`render`, `preview`) — those live inside the VM and
 * are invoked through `vm.render(...)` / `vm.preview(...)`.
 */
export interface SerializedModuleDefinition {
  id: string
  name: string
  description?: string
  category: string
  version: string
  defaults: Record<string, unknown>
  schema: Record<string, unknown>
  canHaveChildren?: boolean
  htmlTag?: string
  hasPreview: boolean
}

export interface ModulePackVm {
  readonly pluginId: string
  readonly modules: ReadonlyArray<SerializedModuleDefinition>
  render(moduleId: string, props: Record<string, unknown>, children: string[]): ModulePackRenderOutput
  preview(moduleId: string, props: Record<string, unknown>, children: string[]): ModulePackRenderOutput
  dispose(): void
}

// ---------------------------------------------------------------------------
// Singleton WASM module — shared with quickjsHost.ts's singleton via the
// quickjs-emscripten library's own module cache (`getQuickJS()` returns the
// shared instance). Each ModulePackVm gets its own context.
// ---------------------------------------------------------------------------

let wasmModulePromise: Promise<QuickJSWASMModule> | null = null

function getWasmModule(): Promise<QuickJSWASMModule> {
  if (!wasmModulePromise) wasmModulePromise = getQuickJS()
  return wasmModulePromise
}

// ---------------------------------------------------------------------------
// Source shim — convert raw ESM `export default [...]` (used by the SDK
// build pipeline) into a `globalThis.__module_pack = ...` assignment that
// the bootstrap can read. Matches the shim in `pluginWorker.ts`.
// ---------------------------------------------------------------------------

function ensureModulePackIifeForm(source: string): string {
  if (source.includes('__module_pack')) return source

  const transformed = source.replace(
    /^([ \t]*)export\s+default\s+/gm,
    '$1globalThis.__module_pack = ',
  )

  return `;(function () {\n${transformed}\n})();\n`
}

// ---------------------------------------------------------------------------
// Bootstrap source — initializes the pack and exposes invocation entries.
// ---------------------------------------------------------------------------

const BOOTSTRAP_SOURCE = `
'use strict';

// Minimal console (just routes to throw — module render() must not need logs).
// Plugins that do need diagnostics should use api.plugin.log via the server
// entrypoint, not console inside a render.
globalThis.console = {
  log: function () {}, info: function () {}, warn: function () {},
  error: function () {}, debug: function () {}, trace: function () {},
};

/**
 * Resolve the pack's default export to a flat array of module definitions.
 * The pack can default-export either an array or a function that returns
 * one (the latter pattern lets the pack author parameterize by pluginId).
 */
globalThis.__initPack = function initPack(pluginId) {
  const entry = globalThis.__module_pack;
  const value = typeof entry === 'function' ? entry({ pluginId: pluginId }) : entry;
  if (!Array.isArray(value)) {
    throw new Error('Plugin "' + pluginId + '" module pack default export must be an array (or a function returning one)');
  }
  // Keyed by id so the host can call render(id, ...) without re-scanning.
  const byId = {};
  for (const def of value) {
    if (!def || typeof def !== 'object' || typeof def.id !== 'string') {
      throw new Error('Plugin "' + pluginId + '" module pack contains a non-object entry');
    }
    byId[def.id] = def;
  }
  globalThis.__modules = byId;
  // Return a SERIALIZED snapshot — metadata only, no functions.
  return value.map(function (def) {
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      category: def.category,
      version: def.version,
      defaults: def.defaults || {},
      schema: def.schema || {},
      canHaveChildren: !!def.canHaveChildren,
      htmlTag: typeof def.htmlTag === 'string' ? def.htmlTag : undefined,
      hasPreview: typeof def.preview === 'function',
    };
  });
};

globalThis.__renderModule = function renderModule(moduleId, propsJson, childrenJson) {
  const def = globalThis.__modules && globalThis.__modules[moduleId];
  if (!def) throw new Error('Module not found: ' + moduleId);
  if (typeof def.render !== 'function') {
    throw new Error('Module "' + moduleId + '" has no render() function');
  }
  const props = JSON.parse(propsJson);
  const children = JSON.parse(childrenJson);
  const out = def.render(props, children);
  return JSON.stringify({
    html: typeof out === 'object' && out && typeof out.html === 'string' ? out.html : '',
    css: typeof out === 'object' && out && typeof out.css === 'string' ? out.css : undefined,
  });
};

globalThis.__previewModule = function previewModule(moduleId, propsJson, childrenJson) {
  const def = globalThis.__modules && globalThis.__modules[moduleId];
  if (!def) throw new Error('Module not found: ' + moduleId);
  // Fall back to render() when preview is not provided — matches the SDK contract.
  const fn = typeof def.preview === 'function' ? def.preview : def.render;
  if (typeof fn !== 'function') {
    throw new Error('Module "' + moduleId + '" has no render() or preview() function');
  }
  const props = JSON.parse(propsJson);
  const children = JSON.parse(childrenJson);
  const out = fn(props, children);
  return JSON.stringify({
    html: typeof out === 'object' && out && typeof out.html === 'string' ? out.html : '',
    css: typeof out === 'object' && out && typeof out.css === 'string' ? out.css : undefined,
  });
};
`

// ---------------------------------------------------------------------------
// VM construction
// ---------------------------------------------------------------------------

/**
 * Build a sandboxed module pack VM from the pack's bundled source.
 *
 * Throws if the pack's bootstrap or default-export resolution fails — the
 * caller (lifecycle handler) should mark the plugin's `lifecycleStatus` as
 * `error` and surface the message.
 */
export async function createModulePackVm(args: {
  pluginId: string
  packSource: string
}): Promise<ModulePackVm> {
  const wasm = await getWasmModule()
  const ctx = wasm.newContext()

  try {
    // Evaluate the pack — IIFE wrap maps `export default ...` to a
    // `globalThis.__module_pack = ...` assignment.
    const wrappedSource = ensureModulePackIifeForm(args.packSource)
    ctx.unwrapResult(ctx.evalCode(wrappedSource, `module-pack:${args.pluginId}`)).dispose()

    // Then the bootstrap (defines __initPack, __renderModule, __previewModule).
    ctx.unwrapResult(ctx.evalCode(BOOTSTRAP_SOURCE, 'modulepack-bootstrap.js')).dispose()

    // Initialize the pack — pulls metadata out, builds the id-keyed lookup.
    const modulesJson = evalString(
      ctx,
      `JSON.stringify(__initPack(${JSON.stringify(args.pluginId)}))`,
    )
    const modules = JSON.parse(modulesJson) as SerializedModuleDefinition[]

    const pluginId = args.pluginId

    return {
      pluginId,
      modules,

      render(moduleId, props, children) {
        const propsJson = JSON.stringify(props)
        const childrenJson = JSON.stringify(children)
        const code = `__renderModule(${JSON.stringify(moduleId)}, ${JSON.stringify(propsJson)}, ${JSON.stringify(childrenJson)})`
        const result = evalString(ctx, code)
        return JSON.parse(result) as ModulePackRenderOutput
      },

      preview(moduleId, props, children) {
        const propsJson = JSON.stringify(props)
        const childrenJson = JSON.stringify(children)
        const code = `__previewModule(${JSON.stringify(moduleId)}, ${JSON.stringify(propsJson)}, ${JSON.stringify(childrenJson)})`
        const result = evalString(ctx, code)
        return JSON.parse(result) as ModulePackRenderOutput
      },

      dispose() {
        try { ctx.dispose() } catch {/* already disposed */}
      },
    }
  } catch (err) {
    try { ctx.dispose() } catch {/* ignore */}
    throw err
  }
}

// ---------------------------------------------------------------------------
// Sync eval helper — module pack code is fully synchronous (no host calls,
// no Promises). One-shot evalCode + getString is enough.
// ---------------------------------------------------------------------------

function evalString(ctx: QuickJSContext, code: string): string {
  const result = ctx.evalCode(code, 'modulepack-eval.js')
  const handle = ctx.unwrapResult(result)
  try {
    return ctx.getString(handle)
  } finally {
    handle.dispose()
  }
}
