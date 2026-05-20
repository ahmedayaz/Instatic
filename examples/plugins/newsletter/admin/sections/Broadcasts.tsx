import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Heading, Stack, Text } from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'
import { BroadcastComposer } from './BroadcastComposer'

interface BroadcastRow {
  id: string
  subject: string
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed'
  scheduledAt: string | null
  sentAt: string | null
  listIds: string[]
  recipientCount: number
  openCount: number
  clickCount: number
  createdAt: string
  htmlBody?: string
  plainBody?: string
}

interface ListRow {
  id: string
  name: string
}

function statusStyle(status: string): React.CSSProperties {
  const map: Record<string, { background: string; color: string }> = {
    draft: { background: 'var(--panel-border)', color: 'var(--editor-text-muted)' },
    scheduled: { background: 'var(--editor-warning-bg, #fef9c3)', color: '#854d0e' },
    sending: { background: 'var(--editor-warning-bg, #fef9c3)', color: '#854d0e' },
    sent: { background: 'var(--editor-success-bg)', color: 'var(--editor-success-green)' },
    failed: { background: 'var(--editor-danger-bg)', color: 'var(--editor-danger)' },
  }
  const s = map[status] ?? map.draft
  return {
    display: 'inline-block',
    padding: '2px 8px',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    borderRadius: 4,
    ...s,
  }
}

export function Broadcasts() {
  const routes = usePluginRoutes()
  const [broadcasts, setBroadcasts] = useState<BroadcastRow[]>([])
  const [lists, setLists] = useState<ListRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [composing, setComposing] = useState(false)
  const [editBroadcast, setEditBroadcast] = useState<BroadcastRow | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [bRes, lRes] = await Promise.all([
        routes.fetch('broadcasts'),
        routes.fetch('lists'),
      ])
      const bBody = (await bRes.json()) as { ok: boolean; broadcasts: BroadcastRow[]; error?: string }
      const lBody = (await lRes.json()) as { ok: boolean; lists: ListRow[]; error?: string }
      if (bBody.error) throw new Error(bBody.error)
      // Sort newest first
      const sorted = [...(bBody.broadcasts ?? [])].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      setBroadcasts(sorted)
      setLists(lBody.lists ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load broadcasts')
    } finally {
      setLoading(false)
    }
  }, [routes])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function openNew() {
    setEditBroadcast(null)
    setComposing(true)
  }

  function openEdit(b: BroadcastRow) {
    setEditBroadcast(b)
    setComposing(true)
  }

  function handleSaved(b: BroadcastRow) {
    setBroadcasts((prev) => {
      const idx = prev.findIndex((x) => x.id === b.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], ...b }
        return next
      }
      return [b, ...prev]
    })
  }

  async function handleSend(id: string) {
    setError(null)
    try {
      const res = await routes.fetch(`broadcasts/${id}/send`, { method: 'POST' })
      const body = (await res.json()) as { ok?: boolean; recipientCount?: number; error?: string }
      if (body.error) throw new Error(body.error)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed')
    }
  }

  if (composing) {
    return (
      <BroadcastComposer
        lists={lists}
        broadcast={editBroadcast}
        onClose={() => { setComposing(false); void refresh() }}
        onSaved={handleSaved}
      />
    )
  }

  return (
    <Stack gap={16}>
      <Stack direction="row" gap={8}>
        <Heading level={3} style={{ flex: 1 }}>
          Broadcasts
        </Heading>
        <Button variant="primary" size="sm" onClick={openNew}>
          New broadcast
        </Button>
      </Stack>

      {error && (
        <Alert tone="danger" title="Error" role="alert">
          {error}
        </Alert>
      )}

      {loading && <Text variant="muted">Loading…</Text>}

      {!loading && broadcasts.length === 0 && (
        <Alert tone="info" title="No broadcasts yet">
          Create your first broadcast to send a newsletter.
        </Alert>
      )}

      {broadcasts.map((b) => {
        const openRate =
          b.recipientCount > 0 ? Math.round((b.openCount / b.recipientCount) * 100) : 0
        const clickRate =
          b.recipientCount > 0 ? Math.round((b.clickCount / b.recipientCount) * 100) : 0
        const listNames = b.listIds
          .map((id) => lists.find((l) => l.id === id)?.name ?? id)
          .join(', ')

        return (
          <Card key={b.id} padding={16}>
            <Stack gap={8}>
              <Stack direction="row" gap={8}>
                <Stack gap={4} style={{ flex: 1 }}>
                  <Stack direction="row" gap={8}>
                    <Text>
                      <strong>{b.subject}</strong>
                    </Text>
                    <span style={statusStyle(b.status)}>{b.status}</span>
                  </Stack>
                  <Text variant="muted" style={{ fontSize: 12 }}>
                    {listNames || 'All subscribers'}
                    {b.sentAt && ` · Sent ${new Date(b.sentAt).toLocaleString()}`}
                    {b.scheduledAt && !b.sentAt && ` · Scheduled ${new Date(b.scheduledAt).toLocaleString()}`}
                  </Text>
                </Stack>

                <Stack direction="row" gap={6}>
                  {(b.status === 'draft' || b.status === 'scheduled') && (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => openEdit(b)}>
                        Edit
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void handleSend(b.id)}
                      >
                        Send now
                      </Button>
                    </>
                  )}
                  {b.status === 'failed' && (
                    <Button variant="destructive" size="sm" onClick={() => void handleSend(b.id)}>
                      Retry
                    </Button>
                  )}
                </Stack>
              </Stack>

              {b.status === 'sent' && (
                <Stack direction="row" gap={16}>
                  <Text variant="muted" style={{ fontSize: 12 }}>
                    {b.recipientCount} sent
                  </Text>
                  <Text variant="muted" style={{ fontSize: 12 }}>
                    {b.openCount} opens ({openRate}%)
                  </Text>
                  <Text variant="muted" style={{ fontSize: 12 }}>
                    {b.clickCount} clicks ({clickRate}%)
                  </Text>
                </Stack>
              )}
            </Stack>
          </Card>
        )
      })}
    </Stack>
  )
}
