import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

function read(path: string) {
  return readFileSync(join(root, path), 'utf8')
}

describe('admin feature folders', () => {
  it('keeps admin page entry points in src/admin feature folders', () => {
    expect(existsSync(join(root, 'src/admin/layouts/AdminCanvasLayout/AdminCanvasLayout.tsx'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/layouts/AdminPageLayout/AdminPageLayout.tsx'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/AdminEntry.tsx'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/router.tsx'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/pages/site/SitePage.tsx'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/pages/content/ContentPage.tsx'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/pages/plugins/PluginsPage.tsx'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/pages/plugins/PluginPage.tsx'))).toBe(true)
  })

  it('uses page names instead of admin-specific component names', () => {
    // The per-workspace page components live in `AuthenticatedAdmin.tsx`
    // (split out of `AdminEntry.tsx` as a lazy boundary so the cold login
    // screen doesn't compile / evaluate them). `AdminEntry` itself only
    // owns the boot probe + the login form; nothing workspace-specific
    // belongs there.
    const authenticatedAdmin = read('src/admin/AuthenticatedAdmin.tsx')

    expect(authenticatedAdmin).toContain('<SitePage />')
    expect(authenticatedAdmin).toContain('<ContentPage />')
    expect(authenticatedAdmin).toContain('<PluginsPage />')
    expect(authenticatedAdmin).toContain('<PluginPage />')
    expect(authenticatedAdmin).not.toContain('ContentAdmin')
    expect(authenticatedAdmin).not.toContain('PluginsAdmin')
    expect(authenticatedAdmin).not.toContain('PluginPageAdmin')
  })

  it('keeps reusable markdown utilities outside admin pages', () => {
    expect(existsSync(join(root, 'src/core/markdown/markdownDocument.ts'))).toBe(true)
    expect(existsSync(join(root, 'src/core/markdown/renderMarkdown.ts'))).toBe(true)
  })
})
