/**
 * AnalyticsPanel — top queries and top no-result queries from the query log.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Card, Heading, Stack, Text } from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'
import { AnalyticsResponseSchema, type TopQuery } from '../apiSchemas'
import styles from './AnalyticsPanel.module.css'

export function AnalyticsPanel() {
  const routes = usePluginRoutes()
  const [data, setData] = useState<{ topQueries: TopQuery[]; topNoResults: TopQuery[]; loggingDisabled?: boolean } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body = await routes.json('analytics', AnalyticsResponseSchema)
      setData({
        topQueries: body.topQueries,
        topNoResults: body.topNoResults,
        loggingDisabled: body.loggingDisabled,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [routes])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (loading && !data) return <Text variant="muted">Loading analytics…</Text>

  if (error) {
    return (
      <Alert tone="danger" title="Analytics unavailable">
        {error}
      </Alert>
    )
  }

  if (!data) return null

  if (data.loggingDisabled) {
    return (
      <Alert tone="info" title="Query logging is disabled">
        Enable <strong>Log search queries</strong> in plugin Settings to collect analytics.
      </Alert>
    )
  }

  return (
    <Stack gap={16}>
      <Heading level={4}>Query Analytics (last 7 days)</Heading>

      <Stack gap={8}>
        <Text className={styles.sectionTitle}>Top queries</Text>
        {data.topQueries.length === 0 ? (
          <Text variant="muted">No queries recorded yet.</Text>
        ) : (
          <Card padding={0}>
            <QueryTable rows={data.topQueries} showResults />
          </Card>
        )}
      </Stack>

      <Stack gap={8}>
        <Text className={styles.sectionTitle}>Top no-result queries</Text>
        {data.topNoResults.length === 0 ? (
          <Text variant="muted">No zero-result queries recorded.</Text>
        ) : (
          <Card padding={0}>
            <QueryTable rows={data.topNoResults} showResults={false} />
          </Card>
        )}
      </Stack>
    </Stack>
  )
}

function QueryTable({
  rows,
  showResults,
}: {
  rows: TopQuery[]
  showResults: boolean
}) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th className={styles.th}>Query</th>
          <th className={`${styles.th} ${styles.thRight}`}>Searches</th>
          {showResults && (
            <th className={`${styles.th} ${styles.thRight}`}>Avg results</th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.query} className={i % 2 === 0 ? styles.rowEven : styles.rowOdd}>
            <td className={styles.td}>{row.query}</td>
            <td className={`${styles.td} ${styles.tdRight}`}>{row.count}</td>
            {showResults && (
              <td className={`${styles.td} ${styles.tdRight}`}>{row.avgResultCount}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
