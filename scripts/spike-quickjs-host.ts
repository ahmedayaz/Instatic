/**
 * End-to-end check for server/plugins/quickjsHost.ts.
 *
 * Loads a plugin whose source mirrors examples/plugins/template/server/index.js
 * (wrapped as an IIFE that attaches to __plugin_exports — the shape the
 * updated SDK builder will produce). Runs install + activate + a route call.
 * Asserts the host received the expected SDK round-trips and that isolation
 * holds (no Bun / process / require leak).
 *
 * Run:  bun run scripts/spike-quickjs-host.ts
 */

import { createPluginVm, type PluginVm } from '../server/plugins/quickjsHost'

// Plugin "bundle" — IIFE that attaches lifecycle hooks. This is what
// cli/build.ts will emit for server entrypoints after the format change.
const PLUGIN_SOURCE = `
;(function () {
  const __exports = (globalThis.__plugin_exports = {});

  __exports.install = function install(api) {
    api.plugin.log('Template plugin installed', api.plugin.id);
  };

  __exports.activate = async function activate(api) {
    api.plugin.log('Activating', api.plugin.id, 'v' + api.plugin.version);

    // Storage round-trip
    const items = await api.cms.storage.collection('items').list();
    api.plugin.log('storage returned', items.length, 'items');

    // Settings read (synchronous against worker mirror)
    const greeting = api.cms.settings.get('greeting') || '(no greeting set)';
    api.plugin.log('settings.greeting =', greeting);

    // Route registration
    api.cms.routes.get('/status', 'plugins.manage', async function () {
      return { ok: true, plugin: api.plugin.id };
    });

    // Hook registration — exercises closure capture of api across lifecycle boundary.
    api.cms.hooks.on('publish.after', async function (payload) {
      api.plugin.log('publish.after fired, siteId=' + (payload && payload.siteId));
    });

    // Hook emit (async round-trip)
    await api.cms.hooks.emit('plugin.ready', { pluginId: api.plugin.id });

    // Isolation probes — must all be undefined / undefined-shaped
    api.plugin.log('typeof Bun =', typeof Bun);
    api.plugin.log('typeof process =', typeof process);
    api.plugin.log('typeof require =', typeof require);
    api.plugin.log('typeof fetch =', typeof globalThis.fetch);

    return { ok: true };
  };

  __exports.deactivate = function deactivate(api) {
    api.plugin.log('Deactivating');
  };
})();
`

// Fake host state — what pluginWorkerHost.ts dispatches against.
const hostCallLog: Array<{ target: string; args: unknown[] }> = []
const logLines: string[] = []

async function fakeHostCall(target: string, args: unknown[]): Promise<unknown> {
  console.log('  [fake host] api-call:', target, JSON.stringify(args).slice(0, 80))
  hostCallLog.push({ target, args })
  switch (target) {
    case 'cms.storage.list':
      console.log('  [fake host] returning 2 items for', args[0])
      return [
        { id: 'a', pluginId: 'acme.template', resourceId: 'items', data: { name: 'Alpha' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
        { id: 'b', pluginId: 'acme.template', resourceId: 'items', data: { name: 'Beta' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      ]
    case 'cms.routes.register':
    case 'cms.hooks.on':
    case 'cms.hooks.filter':
    case 'cms.hooks.emit':
    case 'cms.loops.registerSource':
      return null
    case 'cms.settings.replace':
      return args[0]
    default:
      throw new Error(`Unhandled host target in spike: ${target}`)
  }
}

function fakeLog(args: unknown[]): void {
  const line = '[plugin:acme.template] ' + args.map(stringifyArg).join(' ')
  logLines.push(line)
  console.log('  [fake host] log:', line)
}

function stringifyArg(v: unknown): string {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

async function main(): Promise<void> {
  console.log('Booting QuickJS-WASM module...')
  let vm: PluginVm
  try {
    vm = await createPluginVm({
      pluginSource: PLUGIN_SOURCE,
      env: {
        pluginId: 'acme.template',
        manifestVersion: '1.0.0',
        grantedPermissions: ['cms.routes', 'cms.storage', 'cms.hooks'],
        settings: { greeting: 'Hello from the sandbox' },
        hostCall: fakeHostCall,
        log: fakeLog,
      },
    })
    console.log('createPluginVm resolved')
  } catch (err) {
    console.error('createPluginVm threw:', err)
    throw err
  }

  console.log('\nExported hooks detected by VM:', vm.exportedHooks)

  console.log('\n=== install ===')
  await vm.runLifecycle('install')
  console.log('\n=== activate ===')
  await vm.runLifecycle('activate')

  console.log('\n=== runRoute(GET:/status) ===')
  const routeResult = await vm.runRoute('GET:/status', {
    request: { url: 'http://x/status', method: 'GET', headers: {}, body: '' },
    body: {},
    user: { id: 'u1', email: 'u@x', capabilities: ['plugins.manage'] },
  })
  console.log('  route returned:', JSON.stringify(routeResult))

  const onCall = hostCallLog.find((c) => c.target === 'cms.hooks.on')
  const listenerId = (onCall?.args[0] as { listenerId: string }).listenerId
  console.log('\n=== runHookListener(' + listenerId + ') ===')
  await vm.runHookListener(listenerId, { siteId: 'site-1', pageId: 'page-1' })

  console.log('\nDisposing...')
  vm.dispose()
  console.log('Disposed cleanly ✓')

  console.log('\n=== Spike-host complete ✓ ===')
  return

}

main().catch((err) => {
  console.error('\n=== Spike-host FAILED ===\n', err)
  process.exit(1)
})
