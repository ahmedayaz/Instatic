/**
 * useSiteEditorDeepLink — reads `?row=<id>&table=<slug>` from the URL after
 * the site finishes loading and selects the matching page or component in
 * the editor.
 *
 * URL contract (produced by the Data workspace's "Open in Site editor"
 * button — see `handleOpenInSiteEditor` in `DataPage.tsx`):
 *
 *   /admin/site?table=pages&row=<rowId>       → setActivePage(rowId)
 *   /admin/site?table=components&row=<rowId>  → setActiveDocument({ kind: 'visualComponent', id: rowId })
 *
 * The params are consumed once: after dispatching the matching action the
 * hook replaces the URL with the bare `/admin/site` so a subsequent reload
 * doesn't re-apply the same selection (and stale ids never re-trigger).
 *
 * The hook is a no-op when:
 *   - the site hasn't loaded yet (no `site.pages` / `site.visualComponents`),
 *   - the URL doesn't carry both params,
 *   - the `row` id doesn't match any current page / component,
 *   - we've already applied the deep link this mount.
 */
import { useEffect, useRef } from 'react'
import { useEditorStore } from '@site/store/store'

interface UseSiteEditorDeepLinkOptions {
  /** When false, the hook does nothing. Pass `workspace === 'site'`. */
  enabled: boolean
  /** Set to `true` when the persistence load has completed. */
  loaded: boolean
}

export function useSiteEditorDeepLink({ enabled, loaded }: UseSiteEditorDeepLinkOptions): void {
  /** Whether we've consumed the URL params for this mount already. */
  const appliedRef = useRef(false)

  useEffect(() => {
    if (!enabled || !loaded) return
    if (appliedRef.current) return
    if (typeof window === 'undefined') return

    const search = new URLSearchParams(window.location.search)
    const table = search.get('table')
    const rowId = search.get('row')
    if (!table || !rowId) return

    const site = useEditorStore.getState().site
    if (!site) return

    if (table === 'pages') {
      const page = site.pages.find((p) => p.id === rowId)
      if (!page) return
      useEditorStore.getState().openPageInCanvas(rowId)
      appliedRef.current = true
    } else if (table === 'components') {
      const vc = site.visualComponents.find((c) => c.id === rowId)
      if (!vc) return
      useEditorStore.getState().setActiveDocument({ kind: 'visualComponent', vcId: rowId })
      appliedRef.current = true
    } else {
      // Unknown table slug — ignore.
      return
    }

    // Strip the params from the URL so reloads / back-button navigation
    // don't re-trigger the deep-link on this mount or subsequent renders.
    const url = new URL(window.location.href)
    url.searchParams.delete('table')
    url.searchParams.delete('row')
    window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash)
  }, [enabled, loaded])
}
