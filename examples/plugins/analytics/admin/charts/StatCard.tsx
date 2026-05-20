/**
 * Analytics plugin — stat card tile.
 *
 * Displays a single metric with an optional delta indicator.
 * Delegates to host-ui `StatValue` and `Delta` for consistent styling.
 */
import { Card, Stack, Text, StatValue, Delta } from '@pagebuilder/host-ui'

export interface StatCardProps {
  label: string
  value: number | string
  delta?: number
  format?: 'number' | 'percent' | 'duration'
}

function formatValue(value: number | string, format?: StatCardProps['format']): string {
  if (typeof value === 'string') return value
  switch (format) {
    case 'percent':
      return `${value}%`
    case 'duration': {
      const minutes = Math.floor(value / 60)
      const seconds = value % 60
      return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
    }
    default:
      return value.toLocaleString()
  }
}

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}%` : `${delta}%`
}

export function StatCard({ label, value, delta, format }: StatCardProps) {
  return (
    <Card padding={16} bordered>
      <Stack gap={6}>
        <Text variant="muted" size="sm">{label}</Text>
        <StatValue
          value={formatValue(value, format)}
          delta={delta !== undefined ? (
            <Delta tone="auto">{formatDelta(delta)}</Delta>
          ) : undefined}
        />
      </Stack>
    </Card>
  )
}
