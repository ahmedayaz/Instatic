/**
 * Analytics plugin — admin dashboard app.
 *
 * Exports via `definePluginAdminApp` so the host's admin loader can mount it.
 * Every HTTP boundary is validated with a TypeBox schema via `routes.json()`.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Heading,
  Select,
  Sparkline,
  Stack,
  Text,
} from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'
import { definePluginAdminApp } from '@pagebuilder/plugin-sdk'
import { DashboardStatsSchema, type DashboardStats } from './schemas'
import { StatCard } from './charts/StatCard'
import { TopPages } from './sections/TopPages'
import { TopReferrers } from './sections/TopReferrers'
import { Countries } from './sections/Countries'
import { DevicesBreakdown } from './sections/DevicesBreakdown'
import { LiveFeed } from './sections/LiveFeed'

// ---------------------------------------------------------------------------
// Range options
// ---------------------------------------------------------------------------

const RANGE_OPTIONS = [
  { label: 'Today',        value: '1d'  },
  { label: 'Last 7 days',  value: '7d'  },
  { label: 'Last 30 days', value: '30d' },
  { label: 'Last 90 days', value: '90d' },
] as const

type RangeValue = typeof RANGE_OPTIONS[number]['value']

const ROUTE_BASE = '/admin/api/cms/plugins/pagebuilder.analytics/runtime'

// ---------------------------------------------------------------------------
// Dashboard component
// ---------------------------------------------------------------------------

function AnalyticsDashboard() {
  const routes = usePluginRoutes()

  const [range, setRange]     = useState<RangeValue>('7d')
  const [stats, setStats]     = useState<DashboardStats | null>(null)
  const [error, setError]     = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (r: RangeValue) => {
    setLoading(true)
    setError(null)
    try {
      // routes.json validates the response against DashboardStatsSchema at the boundary
      const data = await routes.json(`stats?range=${r}`, DashboardStatsSchema)
      setStats(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [routes])

  useEffect(() => {
    void load(range)
  }, [load, range])

  const handleRangeChange = (value: string) => {
    const valid = RANGE_OPTIONS.find(o => o.value === value)
    if (valid) setRange(valid.value)
  }

  return (
    <Stack gap={24}>
      {/* Header */}
      <Stack direction="row" justify="between" align="center">
        <Heading level={2}>Analytics</Heading>
        <Stack direction="row" gap={8} align="center">
          <Select
            value={range}
            options={RANGE_OPTIONS.map(o => ({ label: o.label, value: o.value }))}
            onChange={handleRangeChange}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void load(range)}
            disabled={loading}
          >
            Refresh
          </Button>
          <a
            href={`${ROUTE_BASE}/export.csv?resource=events&range=${range}`}
            download
            style={{ textDecoration: 'none' }}
          >
            <Button variant="ghost" size="sm">Export CSV</Button>
          </a>
        </Stack>
      </Stack>

      {error && (
        <Alert tone="danger" title="Failed to load analytics">{error}</Alert>
      )}

      {/* Skeleton while loading for the first time */}
      {loading && !stats && (
        <Stack direction="row" gap={12}>
          {[0, 1, 2, 3].map(i => (
            <div key={i} style={{ flex: 1 }}>
              <Card padding={16} bordered>
                <Text variant="muted" size="sm">Loading…</Text>
              </Card>
            </div>
          ))}
        </Stack>
      )}

      {stats && (
        <Stack gap={24}>
          {/* Stat cards */}
          <Stack direction="row" gap={12} wrap>
            <div style={{ flex: '1 1 140px' }}>
              <StatCard label="Visitors"   value={stats.summary.visitors}   delta={stats.summary.deltaPct.visitors} />
            </div>
            <div style={{ flex: '1 1 140px' }}>
              <StatCard label="Page Views" value={stats.summary.pageviews}  delta={stats.summary.deltaPct.pageviews} />
            </div>
            <div style={{ flex: '1 1 140px' }}>
              <StatCard label="Sessions"   value={stats.summary.sessions}   delta={stats.summary.deltaPct.sessions} />
            </div>
            <div style={{ flex: '1 1 140px' }}>
              <StatCard label="Bounce Rate" value={stats.summary.bounceRate} delta={stats.summary.deltaPct.bounceRate} format="percent" />
            </div>
          </Stack>

          {/* Pageviews over time — mirror the host VisitorsWidget pattern:
              clean Sparkline (no gridlines, no axis ticks, no dots) with a
              simple caption row underneath showing the first day and "Now".
              The full date series is implicit from the range Select above. */}
          <Card padding={16} bordered>
            <Stack gap={12}>
              <Heading level={3}>Page Views Over Time</Heading>
              <Sparkline
                data={stats.series.map(s => s.pageviews)}
                tint="var(--editor-chart-default-tint)"
                height={140}
                ariaLabel="Page views over the selected range"
              />
              <Stack direction="row" justify="between">
                <Text variant="muted" size="sm">
                  {stats.series[0]?.date.slice(5).replace('-', '/') ?? ''}
                </Text>
                <Text variant="muted" size="sm">Now</Text>
              </Stack>
            </Stack>
          </Card>

          {/* Top pages + referrers */}
          <Stack direction="row" gap={16} wrap>
            <div style={{ flex: '1 1 280px' }}><TopPages     data={stats.topPages}     /></div>
            <div style={{ flex: '1 1 280px' }}><TopReferrers data={stats.topReferrers} /></div>
          </Stack>

          {/* Devices + countries */}
          <Stack direction="row" gap={16} wrap>
            <div style={{ flex: '1 1 280px' }}><DevicesBreakdown data={stats.topDevices}   /></div>
            <div style={{ flex: '1 1 280px' }}><Countries        data={stats.topCountries} /></div>
          </Stack>

          {/* Live feed */}
          <LiveFeed routes={routes} />
        </Stack>
      )}
    </Stack>
  )
}

export default definePluginAdminApp(AnalyticsDashboard)
