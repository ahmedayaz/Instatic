import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Heading, Input, Stack, Text, Switch } from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'

interface ListRow {
  id: string
  name: string
  description: string
  isDefault: boolean
  createdAt: string
}

interface ListFormState {
  name: string
  description: string
  isDefault: boolean
}

const emptyForm: ListFormState = { name: '', description: '', isDefault: false }

export function Lists() {
  const routes = usePluginRoutes()
  const [lists, setLists] = useState<ListRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState<ListFormState>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await routes.fetch('lists')
      const body = (await res.json()) as { ok: boolean; lists: ListRow[]; error?: string }
      if (body.error) throw new Error(body.error)
      setLists(body.lists ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load lists')
    } finally {
      setLoading(false)
    }
  }, [routes])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function openCreate() {
    setEditId(null)
    setForm(emptyForm)
    setFormError(null)
    setModalOpen(true)
  }

  function openEdit(list: ListRow) {
    setEditId(list.id)
    setForm({ name: list.name, description: list.description, isDefault: list.isDefault })
    setFormError(null)
    setModalOpen(true)
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setFormError('Name is required')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const res = editId
        ? await routes.fetch(`lists/${editId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(form),
          })
        : await routes.fetch('lists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(form),
          })
      const body = (await res.json()) as { ok?: boolean; error?: string }
      if (body.error) throw new Error(body.error)
      setModalOpen(false)
      await refresh()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    try {
      await routes.fetch(`lists/${id}`, { method: 'DELETE' })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  if (loading) return <Text variant="muted">Loading lists…</Text>

  return (
    <Stack gap={16}>
      <Stack direction="row" gap={8}>
        <Heading level={3} style={{ flex: 1 }}>
          Lists
        </Heading>
        <Button variant="primary" size="sm" onClick={openCreate}>
          New list
        </Button>
      </Stack>

      {error && (
        <Alert tone="danger" title="Error" role="alert">
          {error}
        </Alert>
      )}

      {lists.length === 0 && !loading && (
        <Alert tone="info" title="No lists yet">
          Create a list to start segmenting your subscribers.
        </Alert>
      )}

      {lists.map((list) => (
        <Card key={list.id} padding={12}>
          <Stack direction="row" gap={8}>
            <Stack gap={4} style={{ flex: 1 }}>
              <Text>
                <strong>{list.name}</strong>
                {list.isDefault && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 11,
                      padding: '2px 6px',
                      background: 'var(--editor-success-bg)',
                      color: 'var(--editor-success-green)',
                      borderRadius: 4,
                    }}
                  >
                    default
                  </span>
                )}
              </Text>
              {list.description && <Text variant="muted">{list.description}</Text>}
            </Stack>
            <Button variant="secondary" size="sm" onClick={() => openEdit(list)}>
              Edit
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDelete(list.id)}
              disabled={list.isDefault}
            >
              Delete
            </Button>
          </Stack>
        </Card>
      ))}

      {modalOpen && (
        <div role="dialog" aria-modal="true" aria-label={editId ? 'Edit list' : 'Create list'}>
          <Card padding={24}>
            <Stack gap={16}>
              <Heading level={4}>{editId ? 'Edit list' : 'Create list'}</Heading>
              {formError && (
                <Alert tone="danger" title="Error" role="alert">
                  {formError}
                </Alert>
              )}
              <Input
                label="Name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="General"
              />
              <Input
                label="Description"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Main newsletter list"
              />
              <Switch
                label="Default list"
                checked={form.isDefault}
                onChange={(checked) => setForm((f) => ({ ...f, isDefault: checked }))}
              />
              <Stack direction="row" gap={8}>
                <Button variant="primary" size="sm" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setModalOpen(false)}>
                  Cancel
                </Button>
              </Stack>
            </Stack>
          </Card>
        </div>
      )}
    </Stack>
  )
}
