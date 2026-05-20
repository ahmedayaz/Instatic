/**
 * Analytics plugin — live feed section.
 *
 * Shows the last 5 minutes of raw events. Polls every 5 seconds when toggled
 * on. Response is validated with TypeBox via `routes.json()`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, Heading, Stack, Text, Button, Alert } from '@pagebuilder/host-ui'
import { LiveResponseSchema, type AnalyticsPluginRecord } from '../schemas'
import type { usePluginRoutes } from '@pagebuilder/host-hooks'

type Routes = ReturnType<typeof usePluginRoutes>

export interface LiveFeedProps {
  routes: Routes
}

export function LiveFeed({ routes }: LiveFeedProps) {
  const [active, setActive]   = useState(false)
  const [events, setEvents]   = useState<AnalyticsPluginRecord[]>([])
  const [error, setError]     = useState<string | null>(null)
  const intervalRef           = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchLive = useCallback(async () => {
    try {
      // TypeBox validates the response at the boundary — no cast needed
      const data = await routes.json('live', LiveResponseSchema)
      setEvents(data.events)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load live feed')
    }
  }, [routes])

  useEffect(() => {
    if (!active) {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return undefined
    }

    void fetchLive()
    intervalRef.current = setInterval(() => { void fetchLive() }, 5_000)

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [active, fetchLive])

  return (
    <Card padding={16} bordered>
      <Stack gap={12}>
        <Stack direction="row" justify="between" align="center">
          <Heading level={3}>Live Feed</Heading>
          <Button
            variant={active ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setActive(v => !v)}
          >
            {active ? 'Stop' : 'Start live feed'}
          </Button>
        </Stack>

        {error && <Alert tone="danger" title="Error">{error}</Alert>}

        {!active && (
          <Text variant="muted" size="sm">
            Toggle the live feed to see events from the last 5 minutes in real time (polls every 5 s).
          </Text>
        )}

        {active && events.length === 0 && !error && (
          <Text variant="muted" size="sm">Waiting for events…</Text>
        )}

        {active && events.length > 0 && (
          <Stack gap={4}>
            {events.map(evt => (
              <Stack key={evt.id} direction="row" gap={12} align="center">
                <Text size="sm" variant="muted" style={{ minWidth: 56 }}>
                  {new Date(String(evt.data['received-at'] ?? evt.createdAt)).toLocaleTimeString()}
                </Text>
                <Text size="sm" variant="mono">{String(evt.data.name ?? '')}</Text>
                <Text size="sm" variant="muted">{String(evt.data.path ?? '')}</Text>
                {evt.data.device && (
                  <Text size="sm" variant="muted" style={{ marginLeft: 'auto' }}>
                    {String(evt.data.device)}
                  </Text>
                )}
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  )
}
