/**
 * useRuntimePreviewBuild — owns the runtime-preview iframe build state.
 *
 * Extracted from CanvasRuntimePreview so two render surfaces (the iframe
 * itself, and the status pill in BreakpointFrame's label row) can share one
 * source of truth without spawning duplicate fetches.
 *
 * Build trigger contract:
 * - The build does NOT auto-rebuild on every site change. It used to (when
 *   the iframe overlaid the design canvas), which caused scripts to
 *   re-execute on every keystroke — confetti firing per character, etc.
 * - The build DOES rebuild when something that actually affects the bundle
 *   or the rendered HTML changes:
 *   - script-file content (id + content)
 *   - packageJson (deps added/removed/version edits)
 *   - site.runtime (script config, dependency lock)
 *   - active page navigation
 *   - active breakpoint navigation
 *   - templateContext (entry currently being previewed for templates)
 * - For non-bundle visual edits (class CSS, node prop tweaks) the user
 *   explicitly calls `refresh()` to pull a fresh build. The preview is a
 *   user-controlled snapshot, not an always-live mirror.
 *
 * State architecture:
 * - We hold a single `BuildResult` in state, tagged with the
 *   `buildSignature` it was produced for. Stale results from a previous
 *   signature are filtered out during render — no setState in the effect
 *   body just to "blank" the view.
 * - The freshest `site` is read directly from the editor store at fetch
 *   time (via `useEditorStore.getState()`), so we never need a mutable
 *   ref written during render.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Page, SiteDocument } from '@core/page-tree/schemas'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { useEditorStore } from '@core/editor-store/store'
import { buildCmsRuntimePreview } from '@core/persistence/cmsRuntime'
import {
  collectRuntimeScripts,
  normalizeSiteRuntimeConfig,
  type SiteRuntimeDiagnostic,
} from '@core/site-runtime'
import { materializeRuntimePreviewDocument } from './runtimePreviewDocument'

export type RuntimePreviewStatus = 'idle' | 'building' | 'ready' | 'error'

export interface RuntimePreviewBuildState {
  /** Final HTML to inject into the iframe `srcDoc`. Empty string until first build resolves. */
  srcDoc: string
  /** Build lifecycle status. */
  status: RuntimePreviewStatus
  /** Diagnostics surfaced by the server build (esbuild errors, etc.). */
  diagnostics: SiteRuntimeDiagnostic[]
  /** True when the active page has at least one runtime script enabled in canvas. */
  hasScripts: boolean
  /** Force a rebuild from current site state, bypassing the bundle-signature memo. */
  refresh: () => void
}

interface UseRuntimePreviewBuildArgs {
  page: Page
  breakpointId: string
  templateContext?: TemplateRenderDataContext
  /** Gates the effect — pass `false` while in design mode to skip building entirely. */
  enabled: boolean
}

/**
 * The result of a completed (or failed) build, tagged with the signature it
 * was produced for. Render-time logic compares this against the current
 * signature so we can ignore stale results without a setState-in-effect reset.
 */
interface BuildResult {
  signature: string
  srcDoc: string
  diagnostics: SiteRuntimeDiagnostic[]
  status: 'ready' | 'error'
}

function computeBuildSignature(
  site: SiteDocument | null,
  pageId: string,
  breakpointId: string,
  templateContext: TemplateRenderDataContext | undefined,
): string | null {
  if (!site) return null
  const scriptInputs = site.files
    .filter((file) => file.type === 'script')
    .map((file) => [file.id, file.content ?? ''])
  return JSON.stringify({
    scripts: scriptInputs,
    packageJson: site.packageJson,
    runtime: site.runtime,
    pageId,
    breakpointId,
    templateContext: templateContext ?? null,
  })
}

export function useRuntimePreviewBuild({
  page,
  breakpointId,
  templateContext,
  enabled,
}: UseRuntimePreviewBuildArgs): RuntimePreviewBuildState {
  const site = useEditorStore((s) => s.site)
  const [build, setBuild] = useState<BuildResult | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  const hasScripts = useMemo(() => {
    if (!site) return false
    return collectRuntimeScripts({
      files: site.files,
      runtime: normalizeSiteRuntimeConfig(site.runtime),
      page,
      target: 'canvas',
    }).length > 0
  }, [page, site])

  const buildSignature = useMemo(
    () => computeBuildSignature(site, page.id, breakpointId, templateContext),
    [site, page.id, breakpointId, templateContext],
  )

  const isIdle = !enabled || !site || buildSignature === null

  useEffect(() => {
    if (isIdle || buildSignature === null) return

    let cancelled = false
    let cleanup: (() => void) | null = null

    const timeout = window.setTimeout(() => {
      // Read the freshest site directly from the store at fetch time. site
      // can change in non-bundle-affecting ways (e.g. selection state)
      // without rotating the signature, but the server should still receive
      // the latest snapshot.
      const currentSite = useEditorStore.getState().site
      if (!currentSite) return

      buildCmsRuntimePreview({
        site: currentSite,
        pageId: page.id,
        breakpointId,
        templateContext,
      })
        .then((result) => {
          if (cancelled) return
          const materialized = materializeRuntimePreviewDocument(result)
          cleanup = materialized.revoke
          setBuild({
            signature: buildSignature,
            srcDoc: materialized.html,
            diagnostics: result.diagnostics,
            status: result.diagnostics.some((d) => d.severity === 'error')
              ? 'error'
              : 'ready',
          })
        })
        .catch((error) => {
          if (cancelled) return
          setBuild({
            signature: buildSignature,
            srcDoc: '',
            diagnostics: [
              {
                code: 'runtime-preview-client-error',
                severity: 'error',
                message:
                  error instanceof Error ? error.message : 'Runtime preview failed',
              },
            ],
            status: 'error',
          })
        })
    }, 350)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      cleanup?.()
    }
    // page.id, breakpointId and templateContext are part of buildSignature;
    // listing them as deps would cause an extra rebuild whenever the
    // template-context object reference rotates without changing content.
    // The signature is the single source of truth for "should we rebuild?".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildSignature, isIdle, refreshNonce])

  const refresh = useCallback(() => {
    setRefreshNonce((n) => n + 1)
  }, [])

  // Surface the build state via render-time derivation. Stale builds (whose
  // signature doesn't match the current one) are treated as "still building",
  // which is what the user actually sees while a new build is in flight.
  const matchesCurrent = build !== null && build.signature === buildSignature
  const status: RuntimePreviewStatus = isIdle
    ? 'idle'
    : matchesCurrent
      ? build.status
      : 'building'
  const srcDoc = isIdle || !matchesCurrent ? '' : build.srcDoc
  const diagnostics = isIdle || !matchesCurrent ? [] : build.diagnostics

  return { srcDoc, status, diagnostics, hasScripts, refresh }
}
