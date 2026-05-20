/**
 * Analytics plugin — frontend tracker bundle.
 *
 * Loaded on every published page via the `frontend.scripts` permission.
 * Runs as an IIFE; uses ONLY `window.__pb` and vanilla DOM APIs — no React,
 * no host-ui, no imports (types only, which compile away).
 *
 * Responsibilities:
 *   1. Do-Not-Track + opt-out flag check  (exits early when active)
 *   2. Country enrichment via /geo (once per session, cached in sessionStorage)
 *   3. Admin-session detection via /is-admin (once per session, cached in sessionStorage)
 *   4. page-view, link-click, scroll-depth event forwarding
 *   5. Web Vitals (LCP, CLS, FID) flushed on page hide
 *   6. Bounce detection (session with 0 interactions in < 10 s) flushed on page hide
 */
import type { } from '@pagebuilder/plugin-sdk' // type-only import; compiles away

declare global {
  interface Window {
    __pb?: {
      visitorId: string
      sessionId: string
      hooks: {
        on(event: string, handler: (detail: Record<string, unknown>) => void): () => void
        emit(event: string, detail: Record<string, unknown>): void
      }
      tracker: {
        send(name: string, payload?: Record<string, unknown>): Promise<unknown>
        sendFor(pluginId: string, name: string, payload?: Record<string, unknown>): Promise<unknown>
      }
    }
  }
}

const PLUGIN_ID      = 'pagebuilder.analytics'
const GEO_CACHE_KEY  = '__pb_analytics_geo'
const ADMIN_CACHE_KEY = '__pb_analytics_admin'
const OPT_OUT_KEY    = '__pb_analytics_optout'

const ROUTE_BASE = '/admin/api/cms/plugins/pagebuilder.analytics/runtime'

;(function init() {
  // ── 1. Privacy checks ──────────────────────────────────────────────────
  const dnt =
    (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') ||
    (typeof window !== 'undefined' && (window as Record<string, unknown>).doNotTrack === '1')
  if (dnt) return

  try {
    if (localStorage.getItem(OPT_OUT_KEY) === '1') return
  } catch {
    // localStorage unavailable — continue tracking
  }

  const pb = window.__pb
  if (!pb?.tracker) {
    console.warn('[analytics] page runtime not available')
    return
  }

  // ── 2. Country enrichment ──────────────────────────────────────────────
  let cachedCountry = ''
  try {
    cachedCountry = sessionStorage.getItem(GEO_CACHE_KEY) ?? ''
  } catch {
    // sessionStorage unavailable
  }

  function fetchCountry(): void {
    if (cachedCountry) return
    fetch(`${ROUTE_BASE}/geo`, { method: 'GET', credentials: 'omit' })
      .then(r => r.json() as Promise<{ country?: string }>)
      .then(data => {
        const country = typeof data.country === 'string' ? data.country : ''
        cachedCountry = country
        try { sessionStorage.setItem(GEO_CACHE_KEY, country) } catch { /* noop */ }
      })
      .catch(() => { /* geo is optional; ignore failures */ })
  }

  // ── 3. Admin-session detection ────────────────────────────────────────
  // Checked once per session. The ingest handler on the server respects the
  // `excludeAdmins` setting and drops events where `isAdmin === true`.
  // Defaults to `false` (not admin) so that events before the check resolves
  // are recorded (they're better than nothing; admin self-traffic is rare).
  let cachedIsAdmin: boolean = false
  let adminCheckResolved     = false

  try {
    const cached = sessionStorage.getItem(ADMIN_CACHE_KEY)
    if (cached !== null) {
      cachedIsAdmin = cached === '1'
      adminCheckResolved = true
    }
  } catch {
    // sessionStorage unavailable
  }

  function fetchIsAdmin(): void {
    if (adminCheckResolved) return
    // Include cookies so the server can inspect the admin session cookie.
    // Same origin: published pages and admin run on the same Bun server.
    fetch(`${ROUTE_BASE}/is-admin`, { method: 'GET', credentials: 'include' })
      .then(r => r.json() as Promise<{ admin?: boolean }>)
      .then(data => {
        cachedIsAdmin = data.admin === true
        adminCheckResolved = true
        try { sessionStorage.setItem(ADMIN_CACHE_KEY, cachedIsAdmin ? '1' : '0') } catch { /* noop */ }
      })
      .catch(() => {
        // Assume not admin on network error; don't suppress visitor data
        cachedIsAdmin = false
        adminCheckResolved = true
      })
  }

  // Kick off both session-scoped lookups immediately
  fetchCountry()
  fetchIsAdmin()

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''

  function payload(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      country: cachedCountry,
      userAgent: ua,
      isAdmin: cachedIsAdmin,
      ...extra,
    }
  }

  // ── 4. Event forwarding ────────────────────────────────────────────────
  let pageStartTime    = Date.now()
  let interactionCount = 0

  function bumpInteraction() { interactionCount++ }
  document.addEventListener('click',    bumpInteraction, { passive: true, capture: true })
  document.addEventListener('keypress', bumpInteraction, { passive: true, capture: true })
  document.addEventListener('scroll',   bumpInteraction, { passive: true, capture: true, once: true })

  pb.hooks.on('page-view', (detail) => {
    pageStartTime    = Date.now()
    interactionCount = 0
    void pb.tracker.sendFor(PLUGIN_ID, 'page-view', payload({
      path:     detail.path,
      title:    detail.title,
      referrer: document.referrer,
    }))
  })

  pb.hooks.on('link-click', (detail) => {
    const href = typeof detail.href === 'string' ? detail.href : ''
    let outbound = false
    try { outbound = href.startsWith('http') && new URL(href).hostname !== location.hostname } catch { /* noop */ }
    void pb.tracker.sendFor(PLUGIN_ID, 'link-click', payload({ href, text: detail.text, outbound }))
  })

  pb.hooks.on('scroll-depth', (detail) => {
    void pb.tracker.sendFor(PLUGIN_ID, 'scroll-depth', payload({ depth: detail.depth, path: location.pathname }))
  })

  // ── 5. Web Vitals ──────────────────────────────────────────────────────
  interface VitalsBuffer {
    lcp: number | null
    cls: number
    fid: number | null
  }
  const vitals: VitalsBuffer = { lcp: null, cls: 0, fid: null }

  function observeVitals(): void {
    if (typeof PerformanceObserver === 'undefined') return

    // LCP
    try {
      const lcpObs = new PerformanceObserver(list => {
        const entries = list.getEntries()
        const last = entries[entries.length - 1] as PerformanceEntry & { startTime: number }
        if (last) vitals.lcp = Math.round(last.startTime)
      })
      lcpObs.observe({ type: 'largest-contentful-paint', buffered: true })
    } catch { /* not supported */ }

    // CLS
    try {
      const clsObs = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number }
          if (!e.hadRecentInput && typeof e.value === 'number') vitals.cls += e.value
        }
      })
      clsObs.observe({ type: 'layout-shift', buffered: true })
    } catch { /* not supported */ }

    // FID
    try {
      const fidObs = new PerformanceObserver(list => {
        const first = list.getEntries()[0] as PerformanceEntry & { processingStart?: number; startTime: number }
        if (first && vitals.fid === null && first.processingStart !== undefined) {
          vitals.fid = Math.round(first.processingStart - first.startTime)
        }
      })
      fidObs.observe({ type: 'first-input', buffered: true })
    } catch { /* not supported */ }
  }

  observeVitals()

  function flushVitals(): void {
    if (vitals.lcp === null && vitals.cls === 0 && vitals.fid === null) return
    void pb.tracker.sendFor(PLUGIN_ID, 'web-vitals', payload({
      lcp:  vitals.lcp,
      cls:  Math.round(vitals.cls * 1000) / 1000,
      fid:  vitals.fid,
      path: location.pathname,
    }))
  }

  // ── 6. Bounce detection ────────────────────────────────────────────────
  function flushBounce(): void {
    if (interactionCount === 0 && Date.now() - pageStartTime < 10_000) {
      void pb.tracker.sendFor(PLUGIN_ID, 'bounce', payload({ path: location.pathname }))
    }
  }

  // ── Page hide — flush vitals and bounce ────────────────────────────────
  function onPageHide(): void {
    flushVitals()
    flushBounce()
  }

  window.addEventListener('pagehide',      onPageHide, { capture: true, once: true })
  window.addEventListener('beforeunload',  onPageHide, { capture: true, once: true })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushVitals()
  })
})()
