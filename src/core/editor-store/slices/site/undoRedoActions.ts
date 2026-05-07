/**
 * Undo/redo actions for the site slice.
 *
 * The history stacks themselves (`_historyPast`, `_historyFuture`) are owned
 * by the slice and mutated here via the shared `set` helper. `pushHistory`
 * lives in `helpers.ts` because every mutation helper calls it.
 */

import {
  clonePackageJson,
} from '@core/site-dependencies/manifest'
import {
  cloneSiteRuntimeConfig,
} from '@core/site-runtime'
import type { SiteSlice, SiteSliceHelpers } from './types'

export type UndoRedoActions = Pick<SiteSlice, 'undo' | 'redo'>

export function createUndoRedoActions({ get, set }: SiteSliceHelpers): UndoRedoActions {
  return {
    undo: () => {
      const { _historyPast, site } = get()
      if (_historyPast.length === 0 || !site) return
      const previous = _historyPast[_historyPast.length - 1]
      set((state) => {
        state._historyPast.pop()
        state._historyFuture.push(structuredClone(site))
        const packageJson = clonePackageJson(previous.packageJson)
        const siteRuntime = cloneSiteRuntimeConfig(previous.runtime)
        state.site = { ...previous, packageJson, runtime: siteRuntime }
        state.packageJson = packageJson
        state.siteRuntime = siteRuntime
        state.canUndo = state._historyPast.length > 0
        state.canRedo = true
        state.hasUnsavedChanges = true
        // Keep activePageId valid
        if (!state.site.pages.find((p) => p.id === state.activePageId)) {
          state.activePageId = state.site.pages[0]?.id ?? null
        }
      })
    },

    redo: () => {
      const { _historyFuture, site } = get()
      if (_historyFuture.length === 0 || !site) return
      const next = _historyFuture[_historyFuture.length - 1]
      set((state) => {
        state._historyFuture.pop()
        state._historyPast.push(structuredClone(site))
        const packageJson = clonePackageJson(next.packageJson)
        const siteRuntime = cloneSiteRuntimeConfig(next.runtime)
        state.site = { ...next, packageJson, runtime: siteRuntime }
        state.packageJson = packageJson
        state.siteRuntime = siteRuntime
        state.canUndo = true
        state.canRedo = state._historyFuture.length > 0
        state.hasUnsavedChanges = true
        // Keep activePageId valid
        if (!state.site.pages.find((p) => p.id === state.activePageId)) {
          state.activePageId = state.site.pages[0]?.id ?? null
        }
      })
    },
  }
}
