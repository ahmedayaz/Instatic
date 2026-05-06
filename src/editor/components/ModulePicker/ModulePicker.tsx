/**
 * ModulePicker — searchable list of base modules and Visual Components,
 * designed to live INSIDE a `ContextMenu` (top-level toolbar dropdown) or a
 * `ContextMenuSubmenu` (right-click DOM-panel second level).
 *
 * The picker reuses the dropdown primitives directly:
 *   - rows are `ContextMenuItem` (same hover, padding, typography as any
 *     other dropdown row);
 *   - groups are separated by `ContextMenuSeparator`;
 *   - the only custom style is the sticky search header at the top.
 *
 * Selection callbacks are wired by the caller, which decides the parent
 * and any post-insert side effects.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { useEditorStore } from '@core/editor-store/store'
import { registry } from '@core/module-engine/registry'
import type { AnyModuleDefinition } from '@core/module-engine/types'
import type { VisualComponent } from '@core/visualComponents/schemas'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { SearchBar } from '@ui/components/SearchBar'
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@ui/components/ContextMenu'
import { ModuleIcon } from '../../ui/ModuleIcon'
import styles from './ModulePicker.module.css'

const EMPTY_VCS: VisualComponent[] = []

interface ModulePickerProps {
  /** Called when the user picks a base module. */
  onSelectModule: (mod: AnyModuleDefinition) => void
  /** Called when the user picks a site Visual Component. */
  onSelectVC: (vcId: string) => void
  /** Auto-focus the search input on mount. Default: true. */
  autoFocusSearch?: boolean
  /**
   * Element whose `[role="menuitem"]` descendants are the navigation targets
   * for the search bar's ArrowDown bridge. Typically the wrapping ContextMenu
   * (or submenu panel) ref. When omitted, ArrowDown does nothing.
   */
  containerRef?: RefObject<HTMLElement | null>
}

export function ModulePicker({
  onSelectModule,
  onSelectVC,
  autoFocusSearch = true,
  containerRef,
}: ModulePickerProps) {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const activeDocument = useEditorStore((s) => s.activeDocument)
  const visualComponents = useEditorStore(
    (s) => s.site?.visualComponents ?? EMPTY_VCS,
  )

  // ─── Auto-focus search on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!autoFocusSearch) return
    const id = setTimeout(() => searchRef.current?.focus(), 30)
    return () => clearTimeout(id)
  }, [autoFocusSearch])

  // ─── Module list + search filter ─────────────────────────────────────────
  const isVCMode = activeDocument?.kind === 'visualComponent'

  const moduleGroups = useMemo<AnyModuleDefinition[][]>(() => {
    const groups: AnyModuleDefinition[][] = []
    for (const mods of Object.values(registry.listByCategory())) {
      const visible = mods.filter((m) => {
        if (m.id === 'base.body') return false
        if (m.id === 'base.visual-component-ref') return false
        if (m.id === 'base.slot-outlet') return isVCMode
        return true
      })
      if (visible.length > 0) groups.push(visible)
    }
    return groups
  }, [isVCMode])

  const filteredModuleGroups = useMemo<AnyModuleDefinition[][]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return moduleGroups
    return moduleGroups
      .map((g) =>
        g.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.id.toLowerCase().includes(q),
        ),
      )
      .filter((g) => g.length > 0)
  }, [moduleGroups, query])

  const filteredVcs = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return visualComponents
    return visualComponents.filter((vc) => vc.name.toLowerCase().includes(q))
  }, [visualComponents, query])

  const isEmpty =
    filteredModuleGroups.length === 0 && filteredVcs.length === 0

  // ─── Keyboard navigation: ArrowDown from search jumps to first row ───────
  const handleSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'ArrowDown') return
      e.preventDefault()
      const first =
        containerRef?.current?.querySelector<HTMLElement>('[role="menuitem"]')
      first?.focus()
    },
    [containerRef],
  )

  // Render groups separated by ContextMenuSeparator. VCs get their own group
  // at the end so they're visually distinguishable from base modules.
  const groupCount = filteredModuleGroups.length + (filteredVcs.length > 0 ? 1 : 0)

  return (
    <>
      <div
        className={styles.searchHeader}
        // Clicks on the header (e.g. the search input) inside a
        // ContextMenuSubmenu must not bubble to the panel-level click handler
        // — those are handled by the closeOnItemClickOnly flag, but
        // stopPropagation here is a defensive belt to also cover any
        // pointerdown-driven dismiss elsewhere.
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <SearchBar
          ref={searchRef}
          placeholder="Search modules…"
          value={query}
          onValueChange={setQuery}
          aria-label="Search modules"
          onKeyDown={handleSearchKeyDown}
          className={styles.searchField}
        />
      </div>

      {isEmpty && (
        <ContextMenuItem disabled aria-disabled="true">
          No modules match
        </ContextMenuItem>
      )}

      {filteredModuleGroups.map((group, groupIdx) => (
        <Fragment key={`g-${groupIdx}`}>
          {groupIdx > 0 && <ContextMenuSeparator />}
          {group.map((mod) => (
            <ContextMenuItem
              key={mod.id}
              data-module-id={mod.id}
              onClick={() => onSelectModule(mod)}
            >
              <span aria-hidden="true">
                <ModuleIcon module={mod} size={13} />
              </span>
              {mod.name}
            </ContextMenuItem>
          ))}
        </Fragment>
      ))}

      {filteredVcs.length > 0 && (
        <>
          {groupCount > 1 && <ContextMenuSeparator />}
          {filteredVcs.map((vc) => (
            <ContextMenuItem
              key={vc.id}
              data-vc-id={vc.id}
              onClick={() => onSelectVC(vc.id)}
            >
              <span aria-hidden="true">
                <BracesIcon size={13} />
              </span>
              {vc.name}
            </ContextMenuItem>
          ))}
        </>
      )}
    </>
  )
}
