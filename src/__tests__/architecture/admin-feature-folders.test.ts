import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

function read(path: string) {
  return readFileSync(join(root, path), 'utf8')
}

describe('admin feature folders', () => {
  it('keeps admin page entry points in src/admin feature folders', () => {
    expect(existsSync(join(root, 'src/admin/AdminLayout.tsx'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/AdminEntry.tsx'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/router.ts'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/site/SitePage.tsx'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/content/ContentPage.tsx'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/plugins/PluginsPage.tsx'))).toBe(true)
    expect(existsSync(join(root, 'src/admin/plugins/PluginPage.tsx'))).toBe(true)
  })

  it('uses page names instead of admin-specific component names', () => {
    const adminEntry = read('src/admin/AdminEntry.tsx')

    expect(adminEntry).toContain('<SitePage />')
    expect(adminEntry).toContain('<ContentPage />')
    expect(adminEntry).toContain('<PluginsPage />')
    expect(adminEntry).toContain('<PluginPage />')
    expect(adminEntry).not.toContain('ContentAdmin')
    expect(adminEntry).not.toContain('PluginsAdmin')
    expect(adminEntry).not.toContain('PluginPageAdmin')
  })

  it('keeps reusable content domain code outside admin pages', () => {
    expect(existsSync(join(root, 'src/core/content/schemas.ts'))).toBe(true)
    expect(existsSync(join(root, 'src/core/content/markdown.ts'))).toBe(true)
  })
})
