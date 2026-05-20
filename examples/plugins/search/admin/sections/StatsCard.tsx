/**
 * StatsCard — shows live backend stats on the Search admin dashboard.
 */
import { Card, Heading, Stack, Text } from '@pagebuilder/host-ui'
import type { StatusResponse } from '../apiSchemas'
import styles from './StatsCard.module.css'

export type { StatusResponse }

interface Props {
  status: StatusResponse | null
  loading: boolean
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function StatsCard({ status, loading }: Props) {
  if (loading && !status) {
    return (
      <Card padding={16}>
        <Text variant="muted">Loading stats…</Text>
      </Card>
    )
  }

  if (!status) return null

  if (!status.ok || !status.stats) {
    return (
      <Card padding={16}>
        <Stack gap={8}>
          <Heading level={4}>Index Status</Heading>
          <Text variant="muted">
            {status.message ?? 'Configure the endpoint and API keys in plugin Settings to get started.'}
          </Text>
        </Stack>
      </Card>
    )
  }

  const { stats } = status
  return (
    <Card padding={16}>
      <Stack gap={12}>
        <Heading level={4}>Index Status</Heading>
        <Stack gap={6}>
          <StatRow label="Backend" value={stats.backend === 'typesense' ? 'Typesense' : 'MeiliSearch'} />
          <StatRow label="Endpoint" value={stats.endpointHost} />
          <StatRow label="Documents" value={String(stats.docCount)} />
          {stats.sizeBytes !== null && (
            <StatRow label="Index size" value={formatBytes(stats.sizeBytes)} />
          )}
          <StatRow
            label="Last sync"
            value={stats.lastSyncedAt ? new Date(stats.lastSyncedAt).toLocaleString() : 'Never'}
          />
        </Stack>
      </Stack>
    </Card>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <Text>{value}</Text>
    </div>
  )
}
