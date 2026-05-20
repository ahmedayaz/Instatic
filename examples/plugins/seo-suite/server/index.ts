/**
 * SEO Suite — server entrypoint.
 *
 * Thin orchestrator: imports each feature module and delegates to its
 * `register*` function. All logic lives in the feature modules; this file
 * owns nothing but wiring.
 *
 * Runs inside the QuickJS-WASM sandbox — no Node/Bun ambient access.
 * Everything goes through the SDK (`api.*`).
 */
import type { ServerPluginApi, ServerPluginModule } from '@pagebuilder/plugin-sdk'
import { registerSitemapRoutes } from './sitemap'
import { registerHeadInjection } from './headInjection'
import { registerOgImageJob } from './ogImage'
import { registerSeoEntriesRoutes } from './seoEntriesRoutes'

const mod: ServerPluginModule = {
  install(api: ServerPluginApi) {
    api.plugin.log('SEO Suite installed.')
  },

  activate(api: ServerPluginApi) {
    registerSitemapRoutes(api)
    registerHeadInjection(api)
    registerOgImageJob(api)
    registerSeoEntriesRoutes(api)
    api.plugin.log('SEO Suite activated.')
  },

  deactivate(api: ServerPluginApi) {
    api.plugin.log('SEO Suite deactivated.')
  },

  uninstall(api: ServerPluginApi) {
    api.plugin.log('SEO Suite uninstalled.')
  },
}

export default mod
