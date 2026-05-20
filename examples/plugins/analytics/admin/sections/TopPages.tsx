/**
 * Analytics plugin — top pages section.
 */
import { Card, Heading, Stack, Text, EmptyState, Bars } from '@pagebuilder/host-ui'

export interface TopEntry {
  label: string
  count: number
  pct: number
}

export interface TopPagesProps {
  data: TopEntry[]
}

export function TopPages({ data }: TopPagesProps) {
  return (
    <Card padding={16} bordered>
      <Stack gap={12}>
        <Heading level={3}>Top Pages</Heading>
        {data.length === 0 ? (
          <EmptyState title="No page views yet" />
        ) : (
          <Stack gap={8}>
            {data.map(entry => (
              <Stack key={entry.label} gap={4}>
                <Stack direction="row" justify="between" align="center">
                  <Text size="sm" variant="mono">{entry.label || '/'}</Text>
                  <Text size="sm" variant="muted">{entry.count.toLocaleString()}</Text>
                </Stack>
                <Bars data={[entry.pct]} height={6} />
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  )
}
