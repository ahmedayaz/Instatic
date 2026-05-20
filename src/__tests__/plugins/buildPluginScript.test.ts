/**
 * End-to-end test for the SDK CLI's `build` pipeline.
 *
 * Builds the UI Kit plugin from its TypeScript source, then verifies:
 *   - the emitted plugin.json is parseable by the host manifest validator
 *   - the bundled `modules/index.js` default-exports an array of
 *     `PluginModuleDefinition` shapes the host can register
 *   - the emitted `pack/site.json` is parseable by the host pack validator
 *   - the resulting zip is well-formed (round-trips through the host's
 *     `readPluginPackage`)
 *
 * Slow-ish test (a real Bun.build runs); kept in its own file so the rest
 * of the plugin tests stay fast.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlugin } from '@core/plugin-sdk/cli/build'
import { parsePluginManifest } from '@core/plugins/manifest'
import { readPluginPackage } from '../../../server/plugins/package'
import { parsePluginPack } from '../../../server/plugins/pack'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const pluginDir = join(repoRoot, 'examples', 'plugins', 'ui-kit')

describe('scripts/build-plugin.ts', () => {
  let result: Awaited<ReturnType<typeof buildPlugin>>

  it('builds the UI Kit plugin from TypeScript source', async () => {
    result = await buildPlugin(pluginDir)
    expect(result.pluginId).toBe('acme.ui-kit')
  })

  it('emits a plugin.json the host parses cleanly', async () => {
    const json = JSON.parse(await readFile(join(result.outputDir, 'plugin.json'), 'utf-8'))
    const manifest = parsePluginManifest(json)
    expect(manifest.id).toBe('acme.ui-kit')
    expect(manifest.entrypoints?.modules).toBe('modules/index.js')
    expect(manifest.pack?.path).toBe('pack/site.json')
  })

  it('emits a pack/site.json the host parses cleanly', async () => {
    const json = JSON.parse(await readFile(join(result.outputDir, 'pack', 'site.json'), 'utf-8'))
    const pack = parsePluginPack('acme.ui-kit', json)
    expect(pack.classes.length).toBeGreaterThanOrEqual(8)
    expect(pack.visualComponents.length).toBeGreaterThanOrEqual(3)
    expect(pack.pages.length).toBeGreaterThanOrEqual(1)
  })

  it('emits a modules/index.js whose default export is the array of host-shaped modules', async () => {
    const moduleUrl = `file://${join(result.outputDir, 'modules', 'index.js')}`
    const mod = await import(moduleUrl) as {
      default: Array<{ id: string; render: (props: Record<string, unknown>, children: string[]) => { html: string } }>
    }
    expect(Array.isArray(mod.default)).toBe(true)
    expect(mod.default.length).toBe(5)
    for (const m of mod.default) {
      expect(typeof m.id).toBe('string')
      expect(m.id.startsWith('acme.ui-kit.')).toBe(true)
      expect(typeof m.render).toBe('function')
    }
    // First module should have the UI Kit category shape.
    const callout = mod.default.find((m) => m.id === 'acme.ui-kit.callout')!
    const out = callout.render({ icon: '⚡', title: 'Hi', body: 'Body', tone: 'info' }, [])
    expect(out.html).toContain('uikit-callout')
    expect(out.html).toContain('Hi')
  })

  it('emits a self-contained modules/index.js (no bare `@pagebuilder/*` or `react` imports)', async () => {
    // Regression gate: module packs are loaded by the QuickJS sandbox via
    // `modulePackVm`, which has NO import map / no module resolver. If the
    // build leaks bare imports of host-runtime packages — typically
    // `@pagebuilder/plugin-sdk`, `@pagebuilder/host-ui`, or `react` —
    // the pack fails to activate, the registry never receives the
    // modules, and the publisher emits `<!-- pb: unknown module -->`
    // comments on every published page that drops one of them.
    //
    // The `inlineHostRuntime: true` option in `bundleEntrypoint` keeps
    // these helpers inlined. This test enforces that contract.
    const src = await readFile(join(result.outputDir, 'modules', 'index.js'), 'utf-8')
    const bareImports = [
      ...src.matchAll(/^(?:import|export)\s+(?:[^'"\n]*\sfrom\s+)?['"]([^'".][^'"]*)['"]/gm),
    ].map((m) => m[1]!)
    const forbidden = bareImports.filter(
      (id) =>
        id === 'react' ||
        id.startsWith('react/') ||
        id === 'react-dom' ||
        id.startsWith('react-dom/') ||
        id.startsWith('@pagebuilder/'),
    )
    expect(forbidden, `modules bundle leaks bare host-runtime imports: ${forbidden.join(', ')}`).toEqual([])
  })

  it('produces a zip the host\'s readPluginPackage round-trips successfully', async () => {
    const bytes = await readFile(result.zipPath)
    const file = new File([bytes], 'ui-kit.plugin.zip', { type: 'application/zip' })
    const pkg = await readPluginPackage(file)
    expect(pkg.manifest.id).toBe('acme.ui-kit')
    expect(pkg.files['plugin.json']).toBeDefined()
    expect(pkg.files['modules/index.js']).toBeDefined()
    expect(pkg.files['pack/site.json']).toBeDefined()
  })

  afterAll(() => {
    // Keep the dist/ output for the user to inspect after running tests
    // — it's gitignored anyway.
  })
})
