/**
 * useRuntimePreviewBuild — owns the runtime-preview iframe build state.
 *
 * Build trigger contract:
 * - The build rebuilds on any site mutation (debounced by 350ms). Tracked
 *   via `site.updatedAt`, which every site-mutating slice action bumps.
 *   That covers script edits, packageJson edits, page tree edits, class
 *   CSS edits, etc. — i.e. anything the user can change in design mode is
 *   reflected the next time the preview surface renders.
 * - It also rebuilds on context changes that don't mutate the site:
 *     - active page navigation
 *     - active breakpoint navigation
 *     - templateContext (entry currently previewed for templates)
 *     - explicit Refresh action
 *
 * Design rationale:
 * - The hook only runs while the canvas is in preview mode (see
 *   CanvasPreviewSurface). It does NOT run while the user is typing or
 *   dragging in the design canvas — design and preview are mutually
 *   exclusive surfaces. So rebuilding on every site edit doesn't cause
 *   the "scripts re-execute on every keystroke" problem the previous
 *   overlay design suffered from. The 350ms debounce coalesces rapid
 *   external mutations (e.g. agent tool batches).
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

import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react'
import type { Page, SiteDocument } from '@core/page-tree/schemas'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { useEditorStore } from '@site/store/store'
import { buildCmsRuntimePreview } from '@core/persistence/cmsRuntime'
import type { SiteRuntimeDiagnostic } from '@core/site-runtime'
import { materializeRuntimePreviewDocument } from './runtimePreviewDocument'

export type RuntimePreviewStatus = 'idle' | 'building' | 'ready' | 'error'

export interface RuntimePreviewBuildState {
  /** Final HTML to inject into the iframe `srcDoc`. Empty string until first build resolves. */
  srcDoc: string
  /** Build lifecycle status. */
  status: RuntimePreviewStatus
  /** Diagnostics surfaced by the server build (esbuild errors, etc.). */
  diagnostics: SiteRuntimeDiagnostic[]
  /** Force a rebuild from current site state, bypassing the bundle-signature memo. */
  refresh: () => void
}

interface UseRuntimePreviewBuildArgs {
  /**
   * Active page being previewed. May be null while the editor is between
   * pages — the hook will quietly idle without firing a build until a page
   * arrives. Callers that genuinely require a page (e.g. design canvas)
   * should check before passing.
   */
  page: Page | null
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
  pageId: string | null,
  breakpointId: string,
  templateContext: TemplateRenderDataContext | undefined,
): string | null {
  if (!site || !pageId) return null
  // site.updatedAt is bumped by every site-mutating slice action (classSlice,
  // siteSlice, filesSlice, visualComponentsSlice, sitePanelSlice). Including
  // it here means the next preview build always reflects the user's latest
  // canvas edits — no need to press Publish, no need to click Refresh.
  return JSON.stringify({
    siteUpdatedAt: site.updatedAt,
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

  const buildSignature = useMemo(
    () => computeBuildSignature(site, page?.id ?? null, breakpointId, templateContext),
    [site, page?.id, breakpointId, templateContext],
  )

  const isIdle = !enabled || !site || !page || buildSignature === null

  // useEffectEvent reads the freshest `page`, `breakpointId`, `templateContext`
  // at fire time without making them deps — the buildSignature is the single
  // source of truth for "should we rebuild". The signature collapses
  // semantically-equivalent template-context object rotations, so listing the
  // raw inputs as deps would cause spurious rebuilds.
  const kickOffBuild = useEffectEvent(() => {
    if (page === null) return null
    const pageId = page.id
    const capturedBreakpointId = breakpointId
    const capturedTemplateContext = templateContext

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
        pageId,
        breakpointId: capturedBreakpointId,
        templateContext: capturedTemplateContext,
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
  })

  useEffect(() => {
    if (isIdle || buildSignature === null) return
    return kickOffBuild() ?? undefined
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

  return { srcDoc, status, diagnostics, refresh }
}
