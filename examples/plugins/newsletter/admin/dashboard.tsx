/**
 * Newsletter plugin — admin dashboard entry point.
 *
 * Tab navigation using React state (no router — admin is a 4-tab SPA).
 * Each tab is a separate section component imported from ./sections/*.
 *
 * Externalised imports: react, @pagebuilder/host-ui, @pagebuilder/host-hooks,
 * @pagebuilder/plugin-sdk — resolved by the host's import map at runtime.
 */
import { useState } from 'react'
import { Heading, Stack, Text } from '@pagebuilder/host-ui'
import { definePluginAdminApp } from '@pagebuilder/plugin-sdk'
import { Stats } from './sections/Stats'
import { Subscribers } from './sections/Subscribers'
import { Lists } from './sections/Lists'
import { Broadcasts } from './sections/Broadcasts'

type Tab = 'overview' | 'subscribers' | 'lists' | 'broadcasts'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'subscribers', label: 'Subscribers' },
  { id: 'lists', label: 'Lists' },
  { id: 'broadcasts', label: 'Broadcasts' },
]

function NewsletterDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('overview')

  return (
    <Stack gap={24}>
      <Stack gap={4}>
        <Heading level={2}>Newsletter</Heading>
        <Text variant="muted">
          Manage subscribers, lists, and broadcasts. Powered by{' '}
          <a
            href="https://resend.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'inherit' }}
          >
            Resend
          </a>
          .
        </Text>
      </Stack>

      {/* Tab bar */}
      <nav
        role="tablist"
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--panel-border)',
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '8px 16px',
              background: 'none',
              border: 'none',
              borderBottom:
                activeTab === tab.id ? '2px solid var(--editor-text)' : '2px solid transparent',
              cursor: 'pointer',
              fontSize: 14,
              fontFamily: 'inherit',
              color: activeTab === tab.id ? 'var(--editor-text)' : 'var(--editor-text-muted)',
              fontWeight: activeTab === tab.id ? 600 : 400,
              marginBottom: -1,
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Tab panels */}
      <div role="tabpanel">
        {activeTab === 'overview' && <Stats />}
        {activeTab === 'subscribers' && <Subscribers />}
        {activeTab === 'lists' && <Lists />}
        {activeTab === 'broadcasts' && <Broadcasts />}
      </div>
    </Stack>
  )
}

export default definePluginAdminApp(NewsletterDashboard)
