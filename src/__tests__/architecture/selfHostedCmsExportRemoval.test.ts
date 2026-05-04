import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '../../..')
const SRC_ROOT = join(ROOT, 'src')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('Self-hosted CMS pivot — static ZIP export removal', () => {
  it('does not keep the old publisher ZIP export module', () => {
    expect(existsSync(join(SRC_ROOT, 'core/publisher/export.ts'))).toBe(false)
  })

  it('does not expose static ZIP export from the publisher barrel', () => {
    expect(existsSync(join(SRC_ROOT, 'core/publisher/index.ts'))).toBe(false)
  })

  it('does not keep JSZip as an application dependency', () => {
    const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(pkg.dependencies?.jszip).toBeUndefined()
    expect(pkg.devDependencies?.['@types/jszip']).toBeUndefined()
  })

  it('removes stale React export file-map state from sitePanelSlice', () => {
    const src = read(join(SRC_ROOT, 'core/editor-store/slices/sitePanelSlice.ts'))
    expect(src).not.toContain('lastReactExport')
    expect(src).not.toContain('setLastReactExport')
  })

  it('does not keep the React ZIP publisher implementation', () => {
    expect(existsSync(join(SRC_ROOT, 'core/react-publisher'))).toBe(false)
  })

  it('does not keep module-level JSX code generation hooks', () => {
    const moduleTypes = read(join(SRC_ROOT, 'core/module-engine/types.ts'))
    expect(moduleTypes).not.toContain('toJsx')
    expect(moduleTypes).not.toContain('reactExport')

    const modulesRoot = join(SRC_ROOT, 'modules')
    const files = Array.from(new Bun.Glob('**/*.{ts,tsx}').scanSync(modulesRoot))
    const offenders = files.filter((file) => {
      const src = read(join(modulesRoot, file))
      return src.includes('toJsx') || src.includes('core/react-publisher')
    })
    expect(offenders).toEqual([])
  })

  it('does not expose local site management routes or dashboard files', () => {
    const router = read(join(SRC_ROOT, 'admin/router.ts'))
    expect(router).not.toContain('Dashboard')
    expect(router).not.toContain('/editor/:projectId')
    expect(router).not.toContain('/editor/:siteId')
    expect(router).toContain("path: '/'")
    expect(router).toContain("to: '/admin/site'")
    expect(router).toContain("path: '/admin/content'")
    expect(existsSync(join(SRC_ROOT, 'admin/Dashboard.tsx'))).toBe(false)
    expect(existsSync(join(SRC_ROOT, 'admin/Dashboard.module.css'))).toBe(false)
  })

  it('does not keep a local IndexedDB persistence adapter', () => {
    expect(existsSync(join(SRC_ROOT, 'core/persistence/local.ts'))).toBe(false)

    const persistence = read(join(SRC_ROOT, 'editor/hooks/usePersistence.ts'))
    expect(persistence).not.toContain('localAdapter')
    expect(persistence).not.toContain('LAST_PROJECT_KEY')
    expect(persistence).not.toContain('rememberLastProject')
    expect(persistence).not.toContain('IndexedDB')
  })

  it('does not keep multi-site persistence operations', () => {
    const adapterTypes = read(join(SRC_ROOT, 'core/persistence/types.ts'))
    const cmsAdapter = read(join(SRC_ROOT, 'core/persistence/cms.ts'))
    const barrel = read(join(SRC_ROOT, 'core/persistence/index.ts'))

    for (const src of [adapterTypes, cmsAdapter, barrel]) {
      expect(src).not.toContain('listProjects')
      expect(src).not.toContain('deleteProject')
      expect(src).not.toContain('ProjectSummary')
    }
  })

  it('uses CMS media only, without site-vs-CMS media mode branching', () => {
    for (const path of [
      'admin/AdminLayout.tsx',
      'editor/components/LeftSidebar/LeftSidebar.tsx',
      'editor/components/RightSidebar/RightSidebar.tsx',
      'editor/components/MediaExplorerPanel/MediaExplorerPanel.tsx',
      'editor/components/PropertyControls/MediaLibraryControl.tsx',
      'editor/components/PropertyControls/PropertyControlRenderer.tsx',
    ]) {
      const src = read(join(SRC_ROOT, path))
      expect(src).not.toContain('mediaMode')
      expect(src).not.toContain('PropertyMediaMode')
    }
  })

  it('does not keep export-mode state on the site document', () => {
    const siteTypes = read(join(SRC_ROOT, 'core/page-tree/schemas.ts'))
    const siteSlice = read(join(SRC_ROOT, 'core/editor-store/slices/siteSlice.ts'))
    const validate = read(join(SRC_ROOT, 'core/persistence/validate.ts'))
    const cmsRepository = read(join(ROOT, 'server/cms/siteRepository.ts'))

    expect(siteTypes).not.toContain('projectMode')
    expect(siteSlice).not.toContain('setProjectMode')
    expect(validate).not.toContain('projectMode')
    expect(cmsRepository).not.toContain('projectMode')
  })
})
