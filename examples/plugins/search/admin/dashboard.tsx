/**
 * Search plugin — admin dashboard.
 *
 * Tabs:
 *   Stats      — index status (doc count, backend, endpoint)
 *   Documents  — browse / search indexed documents
 *   Analytics  — top queries + top no-result queries
 *   Sync       — reindex all / clear index
 *
 * Tabs are implemented with native <button> elements carrying full
 * ARIA tablist/tab/tabpanel semantics. The @pagebuilder/host-ui Button
 * primitive does not expose `role`, `aria-selected`, or `aria-controls`
 * props required for a compliant tab widget — this is a §8 exception.
 *
 * Uses @pagebuilder/host-ui primitives for all non-tab controls and the
 * plugin's own routes via usePluginRoutes().
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Heading, Stack } from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'
import { definePluginAdminApp } from '@pagebuilder/plugin-sdk'

import { StatsCard } from './sections/StatsCard'
import { DocumentsList } from './sections/DocumentsList'
import { AnalyticsPanel } from './sections/AnalyticsPanel'
import { ReindexPanel } from './sections/ReindexPanel'
import styles from './dashboard.module.css'
import { StatusResponseSchema, type StatusResponse } from './apiSchemas'

type Tab = 'stats' | 'documents' | 'analytics' | 'sync'

const TABS: { id: Tab; label: string }[] = [
  { id: 'stats', label: 'Stats' },
  { id: 'documents', label: 'Documents' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'sync', label: 'Settings sync' },
]

function SearchDashboard() {
  const routes = usePluginRoutes()
  const [activeTab, setActiveTab] = useState<Tab>('stats')
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)

  const tabRefs = useRef<Map<Tab, HTMLButtonElement>>(new Map())

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      const body = await routes.json('status', StatusResponseSchema)
      setStatus(body)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Failed to load status')
    } finally {
      setStatusLoading(false)
    }
  }, [routes])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  // Keyboard navigation: ArrowLeft / ArrowRight cycle through tabs.
  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const delta = e.key === 'ArrowRight' ? 1 : -1
      const next = (currentIndex + delta + TABS.length) % TABS.length
      const nextTab = TABS[next]
      setActiveTab(nextTab.id)
      tabRefs.current.get(nextTab.id)?.focus()
    },
    [],
  )

  return (
    <div className={styles.root}>
      <div className={styles.headerRow}>
        <Heading level={2}>Search</Heading>
        <div className={styles.refreshBtn}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refreshStatus()}
            disabled={statusLoading}
          >
            {statusLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {statusError && (
        <Alert tone="danger" title="Status unavailable">
          {statusError}
        </Alert>
      )}

      {/* Tab bar — §8 exception: native <button> required for ARIA tablist semantics.
          @pagebuilder/host-ui Button does not expose role/aria-selected/aria-controls. */}
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Search plugin sections"
      >
        {TABS.map((tab, i) => (
          <button
            key={tab.id}
            id={`search-tab-${tab.id}`}
            ref={(el) => {
              if (el) tabRefs.current.set(tab.id, el)
              else tabRefs.current.delete(tab.id)
            }}
            className={`${styles.tab} ${activeTab === tab.id ? styles.tabActive : ''}`}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`search-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(e) => handleTabKeyDown(e, i)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      {TABS.map((tab) => (
        <div
          key={tab.id}
          id={`search-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`search-tab-${tab.id}`}
          hidden={activeTab !== tab.id}
          className={styles.section}
        >
          {tab.id === 'stats' && (
            <Stack gap={16}>
              <StatsCard status={status} loading={statusLoading} />
              {!statusLoading && status && !status.configured && (
                <Alert tone="info" title="Not configured">
                  Open <strong>Settings</strong> on the plugin card to set the search backend
                  endpoint and API keys.
                </Alert>
              )}
            </Stack>
          )}
          {tab.id === 'documents' && <DocumentsList />}
          {tab.id === 'analytics' && <AnalyticsPanel />}
          {tab.id === 'sync' && <ReindexPanel />}
        </div>
      ))}
    </div>
  )
}

export default definePluginAdminApp(SearchDashboard)
