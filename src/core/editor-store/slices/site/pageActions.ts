/**
 * Page mutation actions: addPage, deletePage, renamePage, duplicatePage,
 * reorderPages, convertPageToTemplate, convertTemplateToPage.
 */

import {
  type Page,
  addPage,
  deletePage,
  renamePage,
  reorderPages,
  duplicatePage,
} from '@core/page-tree'
import type { SiteSlice, SiteSliceHelpers } from './types'

export type PageActions = Pick<
  SiteSlice,
  | 'addPage'
  | 'deletePage'
  | 'renamePage'
  | 'duplicatePage'
  | 'reorderPages'
  | 'convertPageToTemplate'
  | 'convertTemplateToPage'
>

export function createPageActions({
  get,
  set,
  mutateSite,
}: SiteSliceHelpers): PageActions {
  return {
    addPage: (title, slug) => {
      let newPage!: Page
      mutateSite((p) => {
        newPage = addPage(p, title, slug ?? title)
      })
      set((state) => { state.activePageId = newPage.id })
      return newPage
    },

    deletePage: (pageId) => {
      mutateSite((p) => deletePage(p, pageId))
      const { site, activePageId } = get()
      if (activePageId === pageId && site) {
        set((state) => { state.activePageId = site.pages[0]?.id ?? null })
      }
    },

    renamePage: (pageId, title, slug) => {
      mutateSite((p) => renamePage(p, pageId, title, slug))
    },

    duplicatePage: (sourcePageId, title, slug) => {
      let newPage!: Page
      mutateSite((p) => {
        newPage = duplicatePage(p, sourcePageId, title, slug)
      })
      return newPage
    },

    reorderPages: (fromIndex, toIndex) => {
      mutateSite((p) => reorderPages(p, fromIndex, toIndex))
    },

    convertPageToTemplate: (pageId, config) => {
      mutateSite((site) => {
        const page = site.pages.find((candidate) => candidate.id === pageId)
        if (!page) return
        page.template = config
      })
    },

    convertTemplateToPage: (pageId) => {
      mutateSite((site) => {
        const page = site.pages.find((candidate) => candidate.id === pageId)
        if (!page) return
        delete page.template
        for (const node of Object.values(page.nodes)) {
          delete node.dynamicBindings
        }
      })
    },
  }
}
