import { useState } from 'react'
import { Alert, Button, Heading, Input, Stack, Text, Textarea } from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'

interface ListRow {
  id: string
  name: string
}

interface BroadcastRow {
  id: string
  subject: string
  status: string
  htmlBody: string
  plainBody: string
  listIds: string[]
}

interface BroadcastComposerProps {
  lists: ListRow[]
  broadcast: BroadcastRow | null
  onClose: () => void
  onSaved: (broadcast: BroadcastRow) => void
}

export function BroadcastComposer({ lists, broadcast, onClose, onSaved }: BroadcastComposerProps) {
  const routes = usePluginRoutes()

  const [subject, setSubject] = useState(broadcast?.subject ?? '')
  const [htmlBody, setHtmlBody] = useState(broadcast?.htmlBody ?? '')
  const [plainBody, setPlainBody] = useState(broadcast?.plainBody ?? '')
  const [selectedListIds, setSelectedListIds] = useState<string[]>(broadcast?.listIds ?? [])
  const [scheduledAt, setScheduledAt] = useState('')
  const [previewEmail, setPreviewEmail] = useState('')
  const [showPreviewInput, setShowPreviewInput] = useState(false)

  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [currentId, setCurrentId] = useState<string | null>(broadcast?.id ?? null)

  function toggleList(id: string) {
    setSelectedListIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  async function handleSaveDraft() {
    if (!subject.trim()) {
      setError('Subject is required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const payload = { subject, htmlBody, plainBody, listIds: selectedListIds }
      const res = currentId
        ? await routes.fetch(`broadcasts/${currentId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await routes.fetch('broadcasts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
      const body = (await res.json()) as { ok?: boolean; broadcast?: BroadcastRow; error?: string }
      if (body.error) throw new Error(body.error)
      if (body.broadcast) {
        setCurrentId(body.broadcast.id)
        onSaved(body.broadcast)
      }
      setStatus('Draft saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleSchedule() {
    if (!scheduledAt) {
      setError('Please enter a scheduled date/time')
      return
    }
    if (!currentId) {
      setError('Save as draft first')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await routes.fetch(`broadcasts/${currentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduledAt: new Date(scheduledAt).toISOString() }),
      })
      const body = (await res.json()) as { ok?: boolean; error?: string }
      if (body.error) throw new Error(body.error)
      setStatus('Broadcast scheduled.')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Schedule failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleSendNow() {
    if (!currentId) {
      setError('Save as draft first')
      return
    }
    setSending(true)
    setError(null)
    try {
      const res = await routes.fetch(`broadcasts/${currentId}/send`, { method: 'POST' })
      const body = (await res.json()) as { ok?: boolean; recipientCount?: number; error?: string }
      if (body.error) throw new Error(body.error)
      setStatus(`Sent to ${body.recipientCount ?? 0} recipient(s).`)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

  async function handleSendPreview() {
    if (!currentId) {
      setError('Save as draft first')
      return
    }
    if (!previewEmail.trim()) {
      setError('Enter a preview email address')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await routes.fetch(`broadcasts/${currentId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: previewEmail.trim() }),
      })
      const body = (await res.json()) as { ok?: boolean; error?: string }
      if (body.error) throw new Error(body.error)
      setStatus(`Preview sent to ${previewEmail}.`)
      setShowPreviewInput(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview send failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Stack gap={16}>
      <Stack direction="row" gap={8}>
        <Heading level={3} style={{ flex: 1 }}>
          {currentId ? 'Edit broadcast' : 'New broadcast'}
        </Heading>
        <Button variant="secondary" size="sm" onClick={onClose}>
          ← Back
        </Button>
      </Stack>

      {error && (
        <Alert tone="danger" title="Error" role="alert">
          {error}
        </Alert>
      )}
      {status && (
        <Alert tone="success" title="Done" role="status">
          {status}
        </Alert>
      )}

      <Input
        label="Subject"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Your newsletter subject"
      />

      <Stack gap={4}>
        <Text>Lists</Text>
        <Stack direction="row" gap={8} wrap>
          {lists.length === 0 && <Text variant="muted">No lists yet — create one in the Lists tab.</Text>}
          {lists.map((list) => (
            <label
              key={list.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
                fontSize: 13,
                padding: '4px 10px',
                borderRadius: 4,
                border: '1px solid var(--panel-border)',
                background: selectedListIds.includes(list.id)
                  ? 'var(--editor-success-bg)'
                  : 'transparent',
              }}
            >
              <input
                type="checkbox"
                checked={selectedListIds.includes(list.id)}
                onChange={() => toggleList(list.id)}
              />
              {list.name}
            </label>
          ))}
        </Stack>
        {selectedListIds.length === 0 && (
          <Text variant="muted" style={{ fontSize: 12 }}>
            No lists selected — broadcast will send to all confirmed subscribers.
          </Text>
        )}
      </Stack>

      <Stack direction="row" gap={16}>
        <Stack gap={4} style={{ flex: 1 }}>
          <Text>HTML body</Text>
          <Textarea
            value={htmlBody}
            onChange={(e) => setHtmlBody(e.target.value)}
            placeholder="<p>Hello {{name}},</p>..."
            rows={16}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
          <Text variant="muted" style={{ fontSize: 12 }}>
            Available placeholders: {'{{preferences_url}}'}, {'{{unsubscribe_url}}'}
          </Text>
        </Stack>

        <Stack gap={4} style={{ flex: 1 }}>
          <Text>Preview</Text>
          <iframe
            srcDoc={htmlBody || '<p style="color:#aaa;font-family:sans-serif;padding:16px">HTML preview will appear here.</p>'}
            style={{
              border: '1px solid var(--panel-border)',
              borderRadius: 4,
              width: '100%',
              height: 340,
              background: '#fff',
            }}
            title="Email preview"
            sandbox="allow-same-origin"
          />
        </Stack>
      </Stack>

      <Textarea
        label="Plain-text body (optional)"
        value={plainBody}
        onChange={(e) => setPlainBody(e.target.value)}
        placeholder="Plain text version for email clients that don't render HTML."
        rows={4}
      />

      <Stack gap={8}>
        <Text>Schedule</Text>
        <Stack direction="row" gap={8}>
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            style={{
              padding: '8px 12px',
              border: '1px solid var(--panel-border)',
              borderRadius: 6,
              fontSize: 13,
              color: 'inherit',
              background: 'var(--input-bg)',
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleSchedule()}
            disabled={saving || !scheduledAt || !currentId}
          >
            Schedule
          </Button>
        </Stack>
      </Stack>

      <Stack direction="row" gap={8} wrap>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleSaveDraft()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save draft'}
        </Button>

        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleSendNow()}
          disabled={sending || !currentId}
        >
          {sending ? 'Sending…' : 'Send now'}
        </Button>

        {showPreviewInput ? (
          <>
            <Input
              value={previewEmail}
              onChange={(e) => setPreviewEmail(e.target.value)}
              placeholder="preview@example.com"
              type="email"
              style={{ flex: '1 1 200px' }}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleSendPreview()}
              disabled={saving || !currentId}
            >
              Send preview
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowPreviewInput(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPreviewInput(true)}
            disabled={!currentId}
          >
            Send preview…
          </Button>
        )}
      </Stack>
    </Stack>
  )
}
