# Plugin SDK Lifecycle

A Page Builder plugin is a zip archive containing a `plugin.json` manifest and one or more JavaScript entrypoints. The server entrypoint runs inside a **QuickJS-WASM sandbox** — it has no access to Node, Bun, the host file system, environment variables, or the network. Everything it can do flows through the SDK described below.

Related references:

- [Plugin authoring guide](authoring.md)
- [Plugin permissions](permissions.md)
- [Plugin sandbox](sandbox.md)
- [Loop sources](loop-sources.md)
- `examples/plugins/template`

## Server entrypoint

Set `entrypoints.server` in `plugin.json` to a package-relative JavaScript module path:

```json
{
  "id": "acme.workflow",
  "version": "1.0.0",
  "permissions": ["cms.routes", "cms.storage"],
  "entrypoints": {
    "server": "server/index.js"
  }
}
```

The server module exports any of these lifecycle hooks:

```js
export function install(api)    {}  // first time the package is installed
export function activate(api)   {}  // every time the plugin enters `active`
export function deactivate(api) {}  // when the plugin is disabled
export function uninstall(api)  {}  // before the package is removed
export function migrate(ctx, api) {} // between old.deactivate and new.activate on upgrade
```

Hooks can be synchronous or async. The host calls them in this order:

- **Fresh install:** `install` → `activate`
- **Disable:** `deactivate`
- **Enable (after disable):** `activate`
- **Upgrade to a new version:** old `deactivate` → new `migrate({ fromVersion }, api)` → new `activate`
- **Uninstall:** `deactivate` (if active) → `uninstall`

If any hook throws, the host rolls back to the previous lifecycle state and marks the plugin as `error` with the thrown message in `lastError`.

## The `api` object

Every hook receives the same shape:

```js
// Plugin metadata
api.plugin.id           // string — namespaced, e.g. "acme.workflow"
api.plugin.version      // string — manifest version
api.plugin.permissions  // string[] — granted permissions
api.plugin.log(...)     // routes to the host's [plugin:<id>] log prefix

// HTTP routes — requires `cms.routes`
api.cms.routes.get('/status', 'plugins.manage', handler)
api.cms.routes.post('/action', 'plugins.manage', handler)
api.cms.routes.patch('/item', 'plugins.manage', handler)
api.cms.routes.delete('/item', 'plugins.manage', handler)
api.cms.routes.getPublic('/health', handler)  // skips auth

// Plugin-owned records — requires `cms.storage`
const items = api.cms.storage.collection('items')
await items.list()
await items.create({ title: 'Draft', status: 'pending' })
await items.update(recordId, { status: 'approved' })
await items.delete(recordId)

// CMS events — requires `cms.hooks`
api.cms.hooks.on('publish.after', async (event) => { /* ... */ })
api.cms.hooks.filter('publish.html', async (html) => html + '<!-- plugin -->')
await api.cms.hooks.emit('my.plugin.signal', { /* ... */ })

// Loop entity sources — requires `loops.register`
api.cms.loops.registerSource({ id: 'acme.workflow.items', /* ... */ })

// Settings — declared in manifest's `settings` field
api.cms.settings.get('apiKey')          // read current value
api.cms.settings.getAll()                // snapshot of all settings
await api.cms.settings.replace({ apiKey: 'new-value' })

// Outbound HTTP — requires `network.outbound` + manifest's `networkAllowedHosts`
const res = await fetch('https://api.example.com/data')
const data = await res.json()
```

Route handlers are mounted under `/admin/api/cms/plugins/:pluginId/runtime/*` and (except for `getPublic`) run behind the admin session check + the declared capability. Handlers receive `{ req, body, user }`. The user object is `null` for public routes.

Each method enforces the matching permission **synchronously inside the sandbox** before the call is issued. Forgetting to declare a permission produces a clear error during `activate`, not a silent failure.

## Lifecycle state

Installed plugins persist `lifecycleStatus` and `lastError`:

| Status | Meaning |
|---|---|
| `installed` | Package stored, `install` hook succeeded, `activate` has not completed. |
| `active` | Plugin is enabled and `activate` succeeded. |
| `disabled` | Plugin is disabled (and `deactivate` succeeded, if exported). |
| `error` | A lifecycle hook threw, or the worker crashed past its budget. `lastError` carries the message. |

Plugins with lifecycle errors stay installed for diagnostics, but their admin pages are not collected into navigation until activation succeeds again.

## Crash recovery

Each plugin runs in its own Bun.Worker. If the worker crashes (uncaught error inside a hook or a runaway loop), the host:

1. Logs the crash and records it as a `plugin_crash_events` row.
2. Terminates the worker. Sibling plugins are unaffected.
3. Auto-respawns the plugin's worker and re-runs `activate`.

If the same plugin crashes more than `CRASH_THRESHOLD` times within `CRASH_WINDOW_MS` (3 crashes / 5 minutes), the host stops auto-respawning and parks the plugin in `error`. The site owner restarts it manually from the Plugins admin page once the cause is fixed.
