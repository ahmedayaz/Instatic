/**
 * Plugin build pipeline.
 *
 * Reads `<dir>/pb-plugin.config.ts`, evaluates it via `import()` (Bun
 * transpiles TypeScript natively), and writes the runtime zip layout that
 * the host package installer expects:
 *
 *   <dir>/dist/
 *     plugin.json
 *     modules/index.js
 *     pack/site.json
 *     server/index.js              (when source has server/index.{ts,js})
 *     editor/index.js              (when source has editor/index.{ts,js})
 *     frontend/tracker.js          (when source has frontend/tracker.{ts,js})
 *     admin/<entry>.js             (per declared admin app entry)
 *
 * Then zips `dist/` into `<dir-parent>/<plugin-id>.plugin.zip`.
 *
 * Bundling: each entrypoint is bundled with `Bun.build()` as ESM. Plugin
 * authors get one self-contained bundle per entrypoint with no
 * node_modules in the zip.
 */
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import type { PluginDefinition } from '../builders/definePlugin'
import { assertSandboxSafe } from '@core/plugins/sandboxScan'

export interface PluginBuildResult {
  pluginId: string
  outputDir: string
  zipPath: string
}

export async function readPluginDefinition(sourceDir: string): Promise<PluginDefinition> {
  const configPath = join(sourceDir, 'pb-plugin.config.ts')
  if (!existsSync(configPath)) {
    throw new Error(`pb-plugin.config.ts not found at ${configPath}`)
  }
  const mod = await import(pathToFileURL(configPath).href + `?ts=${Date.now()}`) as { default: PluginDefinition }
  if (!mod.default || typeof mod.default !== 'object') {
    throw new Error(`pb-plugin.config.ts must default-export a definePlugin() result`)
  }
  return mod.default
}

/**
 * Externals for plugin **admin/editor** bundles (admin pages, editor
 * entrypoints, canvas modules).
 *
 * Bun.build leaves these names as bare imports. At runtime, the host's
 * import map (`index.html`) resolves them to the host's React instance,
 * design-system primitives, plugin SDK helpers, and editor/settings
 * hooks — so plugins share host React + host UI without bundling a
 * copy. This is what gives plugin bundles ~kilobyte sizes and keeps
 * the editor's design-system contract stable across plugin upgrades.
 *
 * Two bundle modes that DO NOT externalize:
 *   - `serverSide: true` — server entrypoints load in the host's Bun
 *     worker; no browser host runtime there.
 *   - `frontendBundle: true` — frontend scripts run on PUBLISHED pages,
 *     which never load the editor's import map. A bare `import 'react'`
 *     in a frontend bundle would crash at runtime ("Failed to resolve
 *     module specifier"). Frontend scripts must either bundle React
 *     themselves or stick to `window.__pb` and vanilla DOM.
 */
const HOST_RUNTIME_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  '@pagebuilder/host-ui',
  '@pagebuilder/host-hooks',
  '@pagebuilder/plugin-sdk',
]

interface BundleOptions {
  /**
   * When set, the entrypoint will be wrapped in an IIFE that assigns the
   * plugin's exports to the given globalThis slot. Used for sandboxed code
   * — server entrypoints (`__plugin_exports`) and module packs
   * (`__module_pack`) — which run inside a QuickJS-WASM VM that cannot
   * resolve ES module syntax. The host's `pluginWorker.ts` /
   * `modulePackVm.ts` read from these globals.
   *
   * When this is set:
   *  - Externals are omitted (the bundle must be self-contained)
   *  - The bundled source is scanned for forbidden literals (`node:*`,
   *    `bun:*`, `require(`) and the build FAILS with a clear message if
   *    any are found — saves authors the round-trip of finding out at
   *    install time
   *  - For 'modules' kind, only the default export is exfiltrated; for
   *    'server' kind, the whole namespace becomes `__plugin_exports`
   */
  sandbox?: 'server' | 'modules'
  /**
   * When true, omit the host-runtime externals — use for `frontend.scripts`
   * bundles. Published pages don't have the host import map, so frontend
   * code can't rely on bare `react` / `@pagebuilder/*` imports being
   * resolved. Bundle locally (or stick to `window.__pb`).
   */
  frontendBundle?: boolean
}

/**
 * Generate the IIFE facade source that re-exports the user's entrypoint to
 * a `globalThis.<slot>` so the QuickJS sandbox can find it. The user's
 * source is left untouched; this facade is bundled WITH it.
 *
 * For 'server' sandboxes, the entire export namespace becomes the slot
 * value (so `export function activate` → `globalThis.__plugin_exports.activate`).
 * For 'modules' sandboxes, only the default export is exfiltrated (the
 * SDK's `definePack` builder default-exports the array of modules).
 */
function generateSandboxFacade(entrypointAbsolutePath: string, kind: 'server' | 'modules'): string {
  // Bun's bundler accepts absolute paths in import specifiers.
  const importPath = JSON.stringify(entrypointAbsolutePath)
  if (kind === 'server') {
    return [
      `import * as __plugin from ${importPath};`,
      `globalThis.__plugin_exports = __plugin;`,
    ].join('\n')
  }
  return [
    `import __default from ${importPath};`,
    `globalThis.__module_pack = __default;`,
  ].join('\n')
}

async function bundleEntrypoint(
  sourcePath: string,
  outFile: string,
  options: BundleOptions = {},
): Promise<void> {
  const external = options.sandbox || options.frontendBundle
    ? []
    : HOST_RUNTIME_EXTERNALS

  // Sandboxed bundles go through a generated facade so the bundler can
  // resolve the user's entrypoint normally and we just hand-write the
  // global-slot assignment. The facade lives next to the entrypoint
  // briefly and is removed after the build.
  let entryToBundle = sourcePath
  let facadeCleanup: string | null = null
  if (options.sandbox) {
    const facade = generateSandboxFacade(resolve(sourcePath), options.sandbox)
    const facadePath = join(dirname(sourcePath), `__sandbox-facade-${Date.now()}.ts`)
    await writeFile(facadePath, facade, 'utf-8')
    entryToBundle = facadePath
    facadeCleanup = facadePath
  }

  try {
    const result = await Bun.build({
      entrypoints: [entryToBundle],
      target: 'browser',
      format: options.sandbox ? 'iife' : 'esm',
      splitting: false,
      minify: false,
      external,
    })
    if (!result.success) {
      const messages = result.logs.map((l) => l.message).join('\n')
      throw new Error(`Failed to bundle ${sourcePath}:\n${messages}`)
    }
    const built = result.outputs[0]
    if (!built) throw new Error(`No output from Bun.build for ${sourcePath}`)
    const text = await built.text()

    if (options.sandbox) {
      // Defense in depth — fail the build NOW if the bundled output (after
      // tree-shaking and external resolution) still references Node/Bun
      // primitives. Plugin authors get a clear error instead of a
      // sandbox-time activation failure.
      assertSandboxSafe(text, sourcePath)
    }

    await mkdir(dirname(outFile), { recursive: true })
    await writeFile(outFile, text, 'utf-8')
  } finally {
    if (facadeCleanup) await rm(facadeCleanup, { force: true })
  }
}

async function findEntrypoint(sourceDir: string, basename: string): Promise<string | null> {
  // Prefer .tsx so plugin entrypoints can use JSX directly.
  for (const ext of ['tsx', 'ts', 'js', 'mjs']) {
    const candidate = join(sourceDir, `${basename}.${ext}`)
    if (existsSync(candidate)) return candidate
  }
  for (const ext of ['tsx', 'ts', 'js', 'mjs']) {
    const candidate = join(sourceDir, basename, `index.${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function bundleAdminApps(
  sourceDir: string,
  outputDir: string,
  definition: PluginDefinition,
): Promise<void> {
  for (const page of definition.manifest.adminPages) {
    if (page.content.kind !== 'app') continue
    const entry = page.content.entry
    const sourceCandidate = join(sourceDir, entry)
    // Plugin source is .tsx (JSX) or .ts (no JSX). The manifest's `entry`
    // field always points at the BUNDLED output (.js); we resolve to one
    // of the typed sources here.
    const sourceTsx = sourceCandidate.replace(/\.js$/, '.tsx')
    const sourceTs = sourceCandidate.replace(/\.js$/, '.ts')
    const sourcePath = existsSync(sourceTsx)
      ? sourceTsx
      : existsSync(sourceTs)
        ? sourceTs
        : sourceCandidate
    if (!existsSync(sourcePath)) {
      throw new Error(`Admin app entry "${entry}" not found at ${sourcePath}`)
    }
    const outFile = join(outputDir, entry)
    await bundleEntrypoint(sourcePath, outFile)
  }
}

async function zipDirectory(sourceDir: string, zipPath: string): Promise<void> {
  await rm(zipPath, { force: true })
  await new Promise<void>((resolveZip, rejectZip) => {
    const child = spawn('zip', ['-qr', zipPath, '.'], {
      cwd: sourceDir,
      stdio: 'inherit',
    })
    child.on('exit', (code) => {
      if (code === 0) resolveZip()
      else rejectZip(new Error(`zip exited with code ${code}`))
    })
    child.on('error', rejectZip)
  })
}

export interface BuildPluginOptions {
  /** When false, skip producing the .plugin.zip (used by `pb-plugin dev`). */
  zip?: boolean
}

export async function buildPlugin(
  sourceDir: string,
  options: BuildPluginOptions = {},
): Promise<PluginBuildResult> {
  const absoluteSource = resolve(sourceDir)
  const definition = await readPluginDefinition(absoluteSource)
  const distDir = join(absoluteSource, 'dist')

  await rm(distDir, { recursive: true, force: true })
  await mkdir(distDir, { recursive: true })

  // 1. Manifest — build entrypoint paths from what we'll emit.
  const entrypoints: NonNullable<typeof definition.manifest.entrypoints> = {}
  if (definition.modules.length > 0) {
    entrypoints.modules = 'modules/index.js'
  }
  const editorSource = await findEntrypoint(absoluteSource, 'editor')
  if (editorSource) entrypoints.editor = 'editor/index.js'
  const serverSource = await findEntrypoint(absoluteSource, 'server')
  if (serverSource) entrypoints.server = 'server/index.js'

  // Frontend entry. Authors can ship either a top-level `frontend.{ts,js}`
  // (or `frontend/index.{ts,js}`) — both bundle to `frontend/index.js` —
  // or the conventional `frontend/tracker.{ts,js}` which bundles to
  // `frontend/tracker.js`. Pick the source AND its destination together
  // so the manifest entrypoint and the bundled file always match.
  let frontendSource: string | null = await findEntrypoint(absoluteSource, 'frontend')
  let frontendOutputPath: string | null = null
  if (frontendSource) {
    entrypoints.frontend = 'frontend/index.js'
    frontendOutputPath = 'frontend/index.js'
  } else {
    const trackerSource = await findEntrypoint(absoluteSource, 'frontend/tracker')
    if (trackerSource) {
      frontendSource = trackerSource
      entrypoints.frontend = 'frontend/tracker.js'
      frontendOutputPath = 'frontend/tracker.js'
    }
  }

  const finalManifest = {
    ...definition.manifest,
    entrypoints,
    ...(definition.pack ? { pack: { path: 'pack/site.json' } } : {}),
  }
  await writeFile(join(distDir, 'plugin.json'), JSON.stringify(finalManifest, null, 2), 'utf-8')

  // 2. Modules entrypoint — bundle a generated facade that re-exports every
  //    defined module via a default-exported array. The facade is written
  //    next to the plugin source (not under dist/) so its relative imports
  //    of `./modules/<file>` resolve correctly.
  if (definition.modules.length > 0) {
    const modulesFacade = generateModulesFacade(absoluteSource)
    const modulesFacadePath = join(absoluteSource, '__modules-facade.ts')
    await writeFile(modulesFacadePath, modulesFacade, 'utf-8')
    try {
      // Module packs are loaded by BOTH the browser editor (as an ES
      // module via dynamic import for the canvas preview) AND the server
      // (inside the QuickJS sandbox via `modulePackVm`). We emit ESM here;
      // `modulePackVm.ts` runtime-transforms `export default …` into a
      // `globalThis.__module_pack = …` assignment that QuickJS can eval.
      await bundleEntrypoint(modulesFacadePath, join(distDir, 'modules', 'index.js'))
    } finally {
      await rm(modulesFacadePath, { force: true })
    }
  }

  // 3. Editor / server / frontend entrypoints — passthrough bundle. Only
  //    the server entrypoint runs in the host's QuickJS sandbox; the rest
  //    run in the browser and externalize React + the host runtime
  //    packages so plugins share host React via the editor's import map.
  if (editorSource) await bundleEntrypoint(editorSource, join(distDir, 'editor', 'index.js'))
  if (serverSource) {
    await bundleEntrypoint(serverSource, join(distDir, 'server', 'index.js'), { sandbox: 'server' })
  }
  if (frontendSource && frontendOutputPath) {
    await bundleEntrypoint(
      frontendSource,
      join(distDir, frontendOutputPath),
      { frontendBundle: true },
    )
  }

  // 4. Admin apps — one bundle per declared app entry.
  await bundleAdminApps(absoluteSource, distDir, definition)

  // 5. Pack.
  if (definition.pack) {
    await mkdir(join(distDir, 'pack'), { recursive: true })
    await writeFile(
      join(distDir, 'pack', 'site.json'),
      JSON.stringify(definition.pack, null, 2),
      'utf-8',
    )
  }

  // 5b. Marketplace icon — passthrough copy. The manifest path is
  // validated by the schema (no `..` traversal, allowed extensions only),
  // so a missing file is the only realistic failure here.
  if (definition.manifest.icon) {
    const iconSource = join(absoluteSource, definition.manifest.icon)
    if (!existsSync(iconSource)) {
      throw new Error(`Plugin icon "${definition.manifest.icon}" not found at ${iconSource}`)
    }
    await copyFile(iconSource, join(distDir, definition.manifest.icon))
  }

  // 6. Zip — skipped during `dev` mode where the dist directory is synced
  //    directly into the host's uploads folder.
  let zipPath = ''
  if (options.zip !== false) {
    zipPath = join(dirname(absoluteSource), `${basename(absoluteSource)}.plugin.zip`)
    await zipDirectory(distDir, zipPath)
  }

  return {
    pluginId: definition.manifest.id,
    outputDir: distDir,
    zipPath,
  }
}

/**
 * Generate a tiny facade module that imports each module file in
 * `<src>/modules/`, collects the default exports, and re-exports them as a
 * single array. The facade is what gets bundled into `dist/modules/index.js`.
 *
 * Convention: every `.ts` file directly under `<src>/modules/` whose default
 * export is a `PluginModuleDefinition` becomes a registered module.
 */
function generateModulesFacade(sourceDir: string): string {
  const modulesDir = join(sourceDir, 'modules')
  if (!existsSync(modulesDir)) {
    throw new Error(`Plugin declares modules but ${modulesDir} does not exist`)
  }
  const files = readdirSync(modulesDir)
  const moduleFiles = files.filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.startsWith('index.'))
  if (moduleFiles.length === 0) {
    throw new Error(`No module files found under ${modulesDir}`)
  }
  const imports = moduleFiles
    .map((file, idx) => `import m${idx} from './modules/${file.replace(/\.(tsx?|m?js)$/, '')}'`)
    .join('\n')
  const defaultExport = `export default [${moduleFiles.map((_, idx) => `m${idx}`).join(', ')}]`
  return `${imports}\n${defaultExport}\n`
}
