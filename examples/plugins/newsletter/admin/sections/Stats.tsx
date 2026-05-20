import { useCallback, useEffect, useState } from 'react'
import { Alert, Card, Heading, Stack, Text } from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'

interface StatsData {
  ok: boolean
  subscribers: {
    total: number
    pending: number
    confirmed: number
    unsubscribed: number
    bounced: number
  }
  broadcasts: {
    total: number
    draft: number
    scheduled: number
    sending: number
    sent: number
    failed: number
  }
  deliveries: {
    total: number
    opened: number
    clicked: number
  }
}

function StatRow({ label, value }: { label: string; value: number | string }) {
  return (
    <Stack direction="row" gap={8}>
      <Text variant="muted" style={{ minWidth: 140 }}>
        {label}
      </Text>
      <Text>
        <strong>{value}</strong>
      </Text>
    </Stack>
  )
}

export function Stats() {
  const routes = usePluginRoutes()
  const [data, setData] = useState<StatsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await routes.fetch('stats')
      setData((await res.json()) as StatsData)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load stats')
    } finally {
      setLoading(false)
    }
  }, [routes])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (loading) return <Text variant="muted">Loading stats…</Text>
  if (error) return <Alert tone="danger" title="Error">{error}</Alert>
  if (!data) return null

  const openRate =
    data.deliveries.total > 0
      ? Math.round((data.deliveries.opened / data.deliveries.total) * 100)
      : 0
  const clickRate =
    data.deliveries.total > 0
      ? Math.round((data.deliveries.clicked / data.deliveries.total) * 100)
      : 0

  return (
    <Stack gap={16}>
      <Heading level={3}>Overview</Heading>
      <Stack direction="row" gap={16} wrap>
        <Card padding={16} style={{ flex: '1 1 200px' }}>
          <Stack gap={8}>
            <Heading level={4}>Subscribers</Heading>
            <StatRow label="Total" value={data.subscribers.total} />
            <StatRow label="Confirmed" value={data.subscribers.confirmed} />
            <StatRow label="Pending" value={data.subscribers.pending} />
            <StatRow label="Unsubscribed" value={data.subscribers.unsubscribed} />
            <StatRow label="Bounced" value={data.subscribers.bounced} />
          </Stack>
        </Card>

        <Card padding={16} style={{ flex: '1 1 200px' }}>
          <Stack gap={8}>
            <Heading level={4}>Broadcasts</Heading>
            <StatRow label="Sent" value={data.broadcasts.sent} />
            <StatRow label="Scheduled" value={data.broadcasts.scheduled} />
            <StatRow label="Draft" value={data.broadcasts.draft} />
            <StatRow label="Failed" value={data.broadcasts.failed} />
          </Stack>
        </Card>

        <Card padding={16} style={{ flex: '1 1 200px' }}>
          <Stack gap={8}>
            <Heading level={4}>Engagement</Heading>
            <StatRow label="Total sent" value={data.deliveries.total} />
            <StatRow label="Opens" value={`${data.deliveries.opened} (${openRate}%)`} />
            <StatRow label="Clicks" value={`${data.deliveries.clicked} (${clickRate}%)`} />
          </Stack>
        </Card>
      </Stack>
    </Stack>
  )
}
