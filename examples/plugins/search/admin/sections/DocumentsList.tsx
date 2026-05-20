/**
 * DocumentsList — browse / search the indexed documents.
 *
 * Calls the plugin's authenticated /admin-search route (not the public
 * /search route, which isn't reachable via usePluginRoutes()).
 */
import { useCallback, useState } from 'react'
import { Alert, Button, Card, Heading, Input, Stack, Text } from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'
import { SearchResponseSchema, type SearchHit } from '../apiSchemas'
import styles from './DocumentsList.module.css'

export function DocumentsList() {
  const routes = usePluginRoutes()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[] | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults(null)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const body = await routes.json(
          `admin-search?q=${encodeURIComponent(q)}&per-page=20`,
          SearchResponseSchema,
        )
        setResults(body.results)
        setTotal(body.total)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed')
      } finally {
        setLoading(false)
      }
    },
    [routes],
  )

  return (
    <Stack gap={12}>
      <Heading level={4}>Browse Documents</Heading>
      <Text variant="muted">
        Search the index to preview what is currently indexed. Results come from the live backend.
      </Text>

      <Stack direction="row" gap={8}>
        <Input
          value={query}
          onChange={(v) => setQuery(v)}
          placeholder="Type to search the index…"
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === 'Enter') void runSearch(query)
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void runSearch(query)}
          disabled={loading}
        >
          {loading ? 'Searching…' : 'Search'}
        </Button>
      </Stack>

      {error && (
        <Alert tone="danger" title="Search error">
          {error}
        </Alert>
      )}

      {results !== null && (
        <Stack gap={4}>
          <Text variant="muted">
            {total > 0
              ? `Found ${total} document${total !== 1 ? 's' : ''} — showing up to 20`
              : 'No results found.'}
          </Text>
          {results.map((hit) => (
            <Card key={hit.id} padding={12}>
              <Stack gap={4}>
                <div className={styles.resultRow}>
                  <span className={styles.resultTitle}>{hit.title || hit.slug}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpanded(expanded === hit.id ? null : hit.id)}
                  >
                    {expanded === hit.id ? 'Collapse' : 'Expand'}
                  </Button>
                </div>
                <Text variant="muted">{hit.slug}</Text>
                {expanded === hit.id && hit.excerpt && (
                  <Text>{hit.excerpt}</Text>
                )}
              </Stack>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  )
}
