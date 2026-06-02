import { StrictMode } from 'react'
import { createRoot, type ErrorInfo } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SkeletonTheme } from 'react-loading-skeleton'
import { Router } from './lib/routing'
import { AdminRoutes } from './router'
import { AdminContextMenuGuard } from './shared/AdminContextMenuGuard'
import { ErrorBoundary, flattenErrorChain, logErrorChain } from '@ui/components/ErrorBoundary'
import { ToastProvider, pushToast } from '@ui/components/Toast'
import 'react-loading-skeleton/dist/skeleton.css'
import '../styles/globals.css'

// Theme tokens shared with every <Skeleton>, <SkeletonBlock>, etc. across
// the admin. Surface tones come from the editor's design tokens so the
// shimmer reads as part of the dark surface palette instead of the
// package's default light theme. Border radius matches `--editor-radius-sm`
// (3 px) — the same radius the rest of the editor's small UI elements
// use, so skeleton bars land flush with the chrome they replace.
const SKELETON_THEME_BASE = '#323232'      // --editor-surface-3
const SKELETON_THEME_HIGHLIGHT = '#4a4a4a'  // --editor-surface-4
const SKELETON_THEME_RADIUS = 3              // --editor-radius-sm


// `installPluginRuntime()` used to be called here, eagerly. That dragged
// the whole plugin-host-hooks module (which imports `useEditorStore` from
// `@site/store/store`) into the first-paint bundle — roughly 116 KB of
// editor-store code that the login screen never uses. The plugin runtime
// is now installed from inside `AdminEntry`'s lazy chunk, which still runs
// well before any plugin chunk actually loads (plugin chunks come in via
// AdminEntry's downstream lazy routes). Net effect: removed `store-*.js`
// and most state-vendor traffic from the eager paint.
//
// Base module registration is also deferred to AdminEntry (the lazy admin
// chunk) so the publisher / page-tree / sanitize stack stays out of the
// eager entry bundle. See src/modules/base/index.ts.

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

// React 19 root-level error callbacks — single telemetry funnel that fires
// even for errors caught by an <ErrorBoundary>. Logs follow the project's
// `[<module>]` prefix convention and walk error.cause chains so domain-typed
// errors render their full provenance.
//
// `onCaughtError` fires AFTER a boundary catches; we don't toast for those
// because the boundary itself already toasted with location context.
// `onUncaughtError` fires when no boundary caught — these are the dangerous
// ones; we toast loudly.
// `onRecoverableError` fires when React recovered (e.g. failed hydration that
// fell back to client render). Logged but not toasted.
function handleRootError(
  prefix: string,
  error: unknown,
  info: ErrorInfo,
  toastTitle: string | null,
): void {
  const chain = flattenErrorChain(error)
  logErrorChain(prefix, chain, info.componentStack ?? null)
  if (toastTitle) {
    const head = chain[0]
    pushToast({
      kind: 'error',
      title: toastTitle,
      body: `${head.name}: ${head.message}`,
      location: prefix,
    })
  }
}

const root = createRoot(rootElement, {
  onCaughtError: (error, info) => {
    handleRootError('react-root:caught', error, info, null)
  },
  onUncaughtError: (error, info) => {
    handleRootError(
      'react-root:uncaught',
      error,
      info,
      'Unhandled render error',
    )
  },
  onRecoverableError: (error, info) => {
    handleRootError('react-root:recoverable', error, info, null)
  },
})

// Force the initial mount to be SYNCHRONOUS. By default React 19 schedules
// the first render in concurrent mode and the scheduler defers the commit
// behind the browser's other work — we measured a consistent 280 ms gap
// between `createRoot().render(...)` completing and the first `useEffect`
// callback firing, even on a localhost build with all chunks already in
// memory. `flushSync` forces the entire initial render + commit to happen
// inside this microtask, so the user's first interaction-ready paint is
// not deferred behind layout / paint / prefetch work.
//
// Trade-off: this turns the initial render into a single blocking task.
// In practice the eager bundle is small enough (~96 KB gz / 36 ms of
// actual JS execution per our CPU profile) that the user does not see a
// frame drop. Subsequent renders still run in concurrent mode.
// Eliminate the concurrent-mode re-render that fires after AuthenticatedAdmin's
// prewarmedLazy Suspense resolves.
//
// Sequence WITHOUT this preload:
//   1. flushSync render boots AdminEntry → status='loading' → AppLoadingScreen.
//   2. useAdminBoot's useEffect resolves /me → flushSync setState → editor.
//   3. AdminEntry re-renders → tries to render AuthenticatedAdmin → throws
//      (prewarmedLazy hasn't loaded yet) → Suspense fallback.
//   4. AuthenticatedAdmin chunk loads → Suspense promise resolves → React
//      schedules a re-render. THIS RE-RENDER GOES THROUGH THE CONCURRENT
//      SCHEDULER (Suspense's retry is concurrent by default), which can
//      defer the commit ~280–300 ms behind layout / paint / prefetch work.
//
// Sequence WITH this preload (when authenticated):
//   1. main.tsx awaits AuthenticatedAdmin's chunk before mounting React.
//      The chunk is in HTTP cache (SSR prefetch hint) so this typically
//      resolves in <5 ms.
//   2. flushSync render boots AdminEntry → status='loading'.
//   3. useAdminBoot's useEffect resolves /me → flushSync setState → editor.
//   4. AdminEntry re-renders → prewarmedLazy.cached IS set → renders
//      AuthenticatedAdmin synchronously, NO Suspense round-trip.
//   5. Whole tree commits within flushSync → no concurrent-scheduler
//      delay. Dashboard paint follows in the next animation frame (~16 ms
//      instead of ~300 ms).
//
// Unauthenticated users (no cookie) skip the preload entirely — they
// don't pay for the AuthenticatedAdmin chunk on the login screen.
// `window.__instaticAuthed` is injected by `server/static.ts` ONLY when the
// request carried a valid session cookie. We can't read the cookie
// directly (it's HttpOnly), so the server tells us via this flag.
//
// We await BOTH the AuthenticatedAdmin chunk AND the section page chunk
// matching the URL. Without the section preload, AuthenticatedAdmin's
// inner `<Suspense fallback={<AppLoadingScreen />}>` boundary catches
// the cold-render of DashboardPage / SitePage / etc., and Suspense's
// retry runs in concurrent mode — the same ~300 ms commit deferral
// that we just removed for AuthenticatedAdmin. Preloading the section
// page lets the prewarmedLazy synchronous fast-path engage on the very
// first render, so the whole tree commits inside flushSync.
//
// The mapping below is hand-maintained — `import('./pages/' + section + '/...')`
// would silently break Vite/Rolldown's static-analysis chunk-resolution.
// Adding a new workspace section requires one new entry here.
if (typeof window !== 'undefined' && (window as unknown as { __instaticAuthed?: number }).__instaticAuthed === 1) {
  const pathname = window.location.pathname
  const sectionImport: Promise<unknown> = (() => {
    if (pathname.startsWith('/admin/dashboard')) return import('./pages/dashboard/DashboardPage')
    if (pathname.startsWith('/admin/site')) return import('./pages/site/SitePage')
    if (pathname.startsWith('/admin/content')) return import('./pages/content/ContentPage')
    if (pathname.startsWith('/admin/data')) return import('./pages/data/DataPage')
    if (pathname.startsWith('/admin/media')) return import('./pages/media/MediaPage')
    if (pathname.startsWith('/admin/plugins/')) return import('./pages/plugins/PluginPage')
    if (pathname.startsWith('/admin/plugins')) return import('./pages/plugins/PluginsPage')
    if (pathname.startsWith('/admin/users')) return import('./pages/users/UsersPage')
    if (pathname.startsWith('/admin/ai')) return import('./pages/ai/AiPage')
    if (pathname.startsWith('/admin/account')) return import('./pages/account/AccountPage')
    // `/admin/` or `/admin` redirect to `/admin/dashboard` — preload dashboard.
    return import('./pages/dashboard/DashboardPage')
  })()
  await Promise.all([
    import('./AuthenticatedAdmin'),
    sectionImport,
  ])
}

flushSync(() => {
  root.render(
    <StrictMode>
      <SkeletonTheme
        baseColor={SKELETON_THEME_BASE}
        highlightColor={SKELETON_THEME_HIGHLIGHT}
        borderRadius={SKELETON_THEME_RADIUS}
        duration={1.4}
      >
        <ErrorBoundary location="admin-shell">
          <Router>
            <AdminRoutes />
          </Router>
          <AdminContextMenuGuard />
        </ErrorBoundary>
        <ToastProvider />
      </SkeletonTheme>
    </StrictMode>,
  )
})
