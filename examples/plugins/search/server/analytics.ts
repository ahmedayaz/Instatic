/**
 * Query analytics — reads and writes query log records via cms.storage.
 *
 * Records are stored in the 'queries' resource collection. Each record holds:
 *   { query, result-count, took-ms, searched-at }
 *
 * This module only provides helpers; the decision whether to log is in the
 * caller (server/index.ts checks the `enableQueryLogging` setting).
 */

import type { ServerPluginApi } from '@pagebuilder/plugin-sdk'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueryRecord {
  query: string
  'result-count': number
  'took-ms': number
  'searched-at': string
}

export interface TopQuery {
  query: string
  count: number
  avgResultCount: number
}

export interface AnalyticsSnapshot {
  topQueries: TopQuery[]
  topNoResults: TopQuery[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isQueryRecord(v: unknown): v is QueryRecord {
  if (typeof v !== 'object' || v === null) return false
  const obj = v as Record<string, unknown>
  return typeof obj.query === 'string' && typeof obj['searched-at'] === 'string'
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append one query log entry. Silently swallows storage errors so a logging
 * failure never breaks a user-facing search response.
 */
export async function logQuery(
  api: ServerPluginApi,
  query: string,
  resultCount: number,
  tookMs: number,
): Promise<void> {
  try {
    await api.cms.storage.collection('queries').create({
      query,
      'result-count': resultCount,
      'took-ms': tookMs,
      'searched-at': new Date().toISOString(),
    })
  } catch (_err) {
    // Don't let a storage error propagate into the search response.
  }
}

/**
 * Compute top-10 queries and top-10 no-result queries from stored logs.
 * Looks at the last 7 days to bound the query size.
 */
export async function getAnalyticsSnapshot(
  api: ServerPluginApi,
): Promise<AnalyticsSnapshot> {
  const all = await api.cms.storage.collection('queries').list()

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  const recent = all.filter((r) => {
    const record = r.data
    if (!isQueryRecord(record)) return false
    return new Date(record['searched-at']).getTime() >= cutoff
  })

  // Aggregate by normalised query string.
  const byQuery = new Map<string, { count: number; resultTotal: number; noResults: number }>()
  for (const r of recent) {
    const record = r.data as QueryRecord
    const key = record.query.trim().toLowerCase()
    if (!key) continue
    const existing = byQuery.get(key) ?? { count: 0, resultTotal: 0, noResults: 0 }
    existing.count++
    const rc = typeof record['result-count'] === 'number' ? record['result-count'] : 0
    existing.resultTotal += rc
    if (rc === 0) existing.noResults++
    byQuery.set(key, existing)
  }

  // Sort by count descending, take top 10.
  const sorted = Array.from(byQuery.entries())
    .sort((a, b) => b[1].count - a[1].count)

  const topQueries: TopQuery[] = sorted.slice(0, 10).map(([q, s]) => ({
    query: q,
    count: s.count,
    avgResultCount: s.count > 0 ? Math.round(s.resultTotal / s.count) : 0,
  }))

  const topNoResults: TopQuery[] = sorted
    .filter(([, s]) => s.noResults > 0)
    .sort((a, b) => b[1].noResults - a[1].noResults)
    .slice(0, 10)
    .map(([q, s]) => ({
      query: q,
      count: s.noResults,
      avgResultCount: 0,
    }))

  return { topQueries, topNoResults }
}
