/**
 * ReindexPanel — "Reindex all" and "Clear index" controls.
 *
 * Both actions are destructive (Clear index removes all documents).
 * "Clear index" shows an inline confirm state to prevent accidental use.
 * We do NOT use window.confirm() — per project rules.
 *
 * "Reindex all" works by asking the operator to re-publish all pages via
 * the site editor's Publish All action. The search plugin has no API to
 * enumerate published pages — indexing happens automatically when pages are
 * published (via the publish.html filter). This is documented clearly in
 * the README.
 */
import { useCallback, useState } from 'react'
import { Alert, Button, Card, Heading, Stack, Text } from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'
import { OkResponseSchema } from '../apiSchemas'
import styles from './ReindexPanel.module.css'

export function ReindexPanel() {
  const routes = usePluginRoutes()

  const [clearConfirm, setClearConfirm] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearMessage, setClearMessage] = useState<string | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)

  const handleClear = useCallback(async () => {
    setClearing(true)
    setClearMessage(null)
    setClearError(null)
    try {
      const body = await routes.json('clear', OkResponseSchema, { method: 'POST' })
      if (body.ok) {
        setClearMessage(body.message ?? 'Index cleared.')
        setClearConfirm(false)
      } else {
        setClearError(body.message ?? 'Clear failed.')
      }
    } catch (err) {
      setClearError(err instanceof Error ? err.message : 'Clear failed.')
    } finally {
      setClearing(false)
    }
  }, [routes])

  return (
    <Stack gap={12}>
      <Heading level={4}>Index Management</Heading>

      {/* Reindex all — informational (no server-side page enumeration possible) */}
      <Card padding={16}>
        <Stack gap={10}>
          <Text className={styles.sectionTitle}>Reindex all published pages</Text>
          <Text variant="muted">
            The search plugin indexes each page automatically when it is published. To rebuild the
            full index from scratch, use the <strong>Publish All</strong> action in the site editor
            — this runs every page through the publish pipeline, which indexes its content. There is
            no in-plugin bulk-crawl API because the plugin sandbox does not have access to a
            published-pages enumeration endpoint.
          </Text>
          <Alert tone="info" title="How to rebuild the index">
            1. Click <strong>Clear index</strong> below to remove stale documents.
            <br />
            2. Open the site editor and use <strong>Publish All</strong> to re-publish every page.
            <br />
            Each page will be indexed automatically as it publishes.
          </Alert>
        </Stack>
      </Card>

      {/* Clear index */}
      <Card padding={16}>
        <Stack gap={10}>
          <Text className={styles.sectionTitle}>Clear index</Text>
          <Text variant="muted">
            Removes all documents from the search index. The index structure is preserved, but all
            content is deleted. Re-publish your pages to restore search.
          </Text>
          {clearMessage && (
            <Alert tone="success" title="Index cleared">
              {clearMessage}
            </Alert>
          )}
          {clearError && (
            <Alert tone="danger" title="Clear failed">
              {clearError}
            </Alert>
          )}

          {!clearConfirm ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setClearConfirm(true)}
            >
              Clear index…
            </Button>
          ) : (
            <Stack gap={8}>
              <Alert tone="danger" title="Are you sure?">
                This will remove all documents from the search index. This cannot be undone.
              </Alert>
              <Stack direction="row" gap={8}>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void handleClear()}
                  disabled={clearing}
                >
                  {clearing ? 'Clearing…' : 'Yes, clear the index'}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setClearConfirm(false)}
                  disabled={clearing}
                >
                  Cancel
                </Button>
              </Stack>
            </Stack>
          )}
        </Stack>
      </Card>
    </Stack>
  )
}
