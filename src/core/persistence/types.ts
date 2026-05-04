import type { SiteDocument } from '../page-tree/schemas'

/**
 * IPersistenceAdapter — the interface the CMS draft storage backend satisfies.
 */
export interface IPersistenceAdapter {
  /** Persist the single site draft document. */
  saveSite(site: SiteDocument): Promise<void>

  /** Load the single site draft document. Returns undefined before setup creates it. */
  loadSite(id: string): Promise<SiteDocument | undefined>
}
