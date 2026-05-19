/**
 * Admin layouts — pick one of these as the root of any admin page:
 *
 *   - AdminCanvasLayout: the editor canvas shell (Site, Content, Data,
 *     Media). Carries floating editor panels, the page canvas, the DnD
 *     context wired to the SiteExplorer, and the per-workspace sidebars.
 *     Heavy (~165 KB editor store + canvas + panels).
 *   - AdminPageLayout: the lightweight admin-page shell (Plugins, Users,
 *     Account, plugin admin pages). Toolbar + a centered, scrollable
 *     page body with a unified header (title, description, optional tabs
 *     and actions slots). NO editor-store dependency.
 *
 * IMPORTANT: import directly from the per-layout module (not this barrel)
 * so rolldown can split the two layouts into separate chunks. The barrel
 * defeats tree-shaking when both re-exports are reachable, which is what
 * makes the heavy AdminCanvasLayout graph leak into non-editor admin
 * pages.
 *
 *   import { AdminPageLayout }   from '@admin/layouts/AdminPageLayout'
 *   import { AdminCanvasLayout } from '@admin/layouts/AdminCanvasLayout'
 *
 * This file intentionally exports nothing — keep deep imports the only
 * supported path.
 */
export {}
