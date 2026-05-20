/**
 * Analytics plugin — top referrers section.
 */
import { Card, Heading, Stack, Text, EmptyState } from '@pagebuilder/host-ui'

export interface TopEntry {
  label: string
  count: number
  pct: number
}

export interface TopReferrersProps {
  data: TopEntry[]
}

function cleanReferrer(ref: string): string {
  try {
    const url = new URL(ref)
    return url.hostname
  } catch {
    return ref || '(direct)'
  }
}

export function TopReferrers({ data }: TopReferrersProps) {
  return (
    <Card padding={16} bordered>
      <Stack gap={12}>
        <Heading level={3}>Top Referrers</Heading>
        {data.length === 0 ? (
          <EmptyState title="No referrers recorded" />
        ) : (
          <Stack gap={6}>
            {data.map(entry => (
              <Stack key={entry.label} direction="row" justify="between" align="center">
                <Text size="sm" variant="mono">{cleanReferrer(entry.label)}</Text>
                <Stack direction="row" gap={8} align="center">
                  <Text size="sm" variant="muted">{entry.pct}%</Text>
                  <Text size="sm">{entry.count.toLocaleString()}</Text>
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  )
}
