/**
 * Breakpoint mutation actions: addBreakpoint, updateBreakpoint, removeBreakpoint,
 * reorderBreakpoints.
 */

import { nanoid } from 'nanoid'
import type { Breakpoint } from '@core/page-tree'
import type { SiteSlice, SiteSliceHelpers } from './types'

export type BreakpointActions = Pick<
  SiteSlice,
  'addBreakpoint' | 'updateBreakpoint' | 'removeBreakpoint' | 'reorderBreakpoints'
>

export function createBreakpointActions({
  get,
  set,
  mutateSite,
}: SiteSliceHelpers): BreakpointActions {
  return {
    addBreakpoint: (bp) => {
      const newBp: Breakpoint = { ...bp, id: nanoid(8) }
      mutateSite((p) => { p.breakpoints.push(newBp) })
      return newBp
    },

    updateBreakpoint: (id, patch) => {
      mutateSite((p) => {
        const idx = p.breakpoints.findIndex((b) => b.id === id)
        if (idx !== -1) Object.assign(p.breakpoints[idx], patch)
      })
    },

    removeBreakpoint: (id) => {
      mutateSite((p) => {
        p.breakpoints = p.breakpoints.filter((b) => b.id !== id)
      })
      // If the active breakpoint was removed, fall back to desktop
      if (get().activeBreakpointId === id) {
        set((state) => { state.activeBreakpointId = 'desktop' })
      }
    },

    reorderBreakpoints: (fromIndex, toIndex) => {
      mutateSite((p) => {
        const [item] = p.breakpoints.splice(fromIndex, 1)
        p.breakpoints.splice(toIndex, 0, item)
      })
    },
  }
}
