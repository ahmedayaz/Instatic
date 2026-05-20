/**
 * Analytics plugin — device breakdown section.
 *
 * Renders a donut chart alongside a legend for the four device categories.
 */
import { Card, Heading, Stack, Text, EmptyState } from '@pagebuilder/host-ui'
import { Donut } from '../charts/Donut'

export interface TopEntry {
  label: string
  count: number
  pct: number
}

export interface DevicesBreakdownProps {
  data: TopEntry[]
}

const DEVICE_COLORS: Record<string, string> = {
  desktop: 'var(--rail-tint-sky)',
  mobile:  'var(--rail-tint-mint)',
  tablet:  'var(--rail-tint-lilac)',
  bot:     'var(--rail-tint-peach)',
}

const DEVICE_LABELS: Record<string, string> = {
  desktop: 'Desktop',
  mobile:  'Mobile',
  tablet:  'Tablet',
  bot:     'Bot',
}

export function DevicesBreakdown({ data }: DevicesBreakdownProps) {
  const donutData = data.map(d => ({
    label: DEVICE_LABELS[d.label] ?? d.label,
    value: d.count,
    color: DEVICE_COLORS[d.label],
  }))

  return (
    <Card padding={16} bordered>
      <Stack gap={12}>
        <Heading level={3}>Devices</Heading>
        {data.length === 0 ? (
          <EmptyState title="No device data" />
        ) : (
          <Stack direction="row" gap={24} align="center">
            <Donut data={donutData} size={140} />
            <Stack gap={8}>
              {data.map(entry => (
                <Stack key={entry.label} direction="row" gap={8} align="center">
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      background: DEVICE_COLORS[entry.label] ?? 'var(--editor-border)',
                      flexShrink: 0,
                    }}
                  />
                  <Text size="sm">{DEVICE_LABELS[entry.label] ?? entry.label}</Text>
                  <Text size="sm" variant="muted">{entry.pct}%</Text>
                </Stack>
              ))}
            </Stack>
          </Stack>
        )}
      </Stack>
    </Card>
  )
}
