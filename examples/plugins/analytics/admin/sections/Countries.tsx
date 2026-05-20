/**
 * Analytics plugin — countries section.
 *
 * Converts ISO 3166-1 alpha-2 country codes to flag emoji using regional
 * indicator symbol characters (offset 127397 from 'A').
 */
import { Card, Heading, Stack, Text, EmptyState } from '@pagebuilder/host-ui'

export interface TopEntry {
  label: string
  count: number
  pct: number
}

export interface CountriesProps {
  data: TopEntry[]
}

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return '🌐'
  const upper = code.toUpperCase()
  try {
    return String.fromCodePoint(
      127397 + upper.charCodeAt(0),
      127397 + upper.charCodeAt(1),
    )
  } catch {
    return '🌐'
  }
}

function countryName(code: string): string {
  if (!code) return 'Unknown'
  // Return code as-is; a full locale list would add unnecessary bundle weight
  return code.toUpperCase()
}

export function Countries({ data }: CountriesProps) {
  return (
    <Card padding={16} bordered>
      <Stack gap={12}>
        <Heading level={3}>Countries</Heading>
        {data.length === 0 ? (
          <EmptyState title="No country data" />
        ) : (
          <Stack gap={6}>
            {data.map(entry => (
              <Stack key={entry.label} direction="row" justify="between" align="center">
                <Stack direction="row" gap={8} align="center">
                  <span style={{ fontSize: 18, lineHeight: 1 }} aria-hidden="true">
                    {countryFlag(entry.label)}
                  </span>
                  <Text size="sm">{countryName(entry.label)}</Text>
                </Stack>
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
