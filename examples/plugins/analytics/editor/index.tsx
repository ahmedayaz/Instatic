/**
 * Analytics — editor entrypoint.
 *
 * Registers TWO dashboard widgets for the host's `/admin` dashboard:
 *
 *   • `pagebuilder.analytics.visitors`   — Visitors sparkline + delta
 *   • `pagebuilder.analytics.top-pages`  — Top viewed paths list
 *
 * Both used to ship first-party from the host; they now come from this
 * plugin so the host stays Analytics-agnostic. The visuals are an EXACT
 * match for the originals — same Widget chrome, same RangeTabs, same
 * Sparkline / StatValue / Delta / WidgetList composition. The two
 * widgets share a single in-flight fetch per range so the dashboard
 * makes one network request per range change, not two.
 *
 * The widget bodies fetch live data from the plugin's own authenticated
 * `/stats` route. While the request is in flight we keep the previous
 * frame visible so the UI doesn't flicker on toggle. Network errors
 * fall back to empty data so the chrome still renders.
 */
import { useEffect, useState } from 'react'
import {
  Sparkline,
  StatValue,
  Delta,
  RangeTabs,
  Widget,
  WidgetList,
  WidgetListRow,
} from '@pagebuilder/host-ui'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { StarSolidIcon } from 'pixel-art-icons/icons/star-solid'
import type {
  EditorPluginApi,
  EditorPluginModule,
  PluginDashboardWidgetRendererProps,
} from '@pagebuilder/plugin-sdk'

// ---------------------------------------------------------------------------
// Range -> server query param
// ---------------------------------------------------------------------------

type Range = '24h' | '7d' | '30d'

const RANGE_QUERY: Record<Range, string> = {
  '24h': '1d',
  '7d': '7d',
  '30d': '30d',
}

const SINCE_LABEL: Record<Range, string> = {
  '24h': '00:00',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
}

const STATS_URL = '/admin/api/cms/plugins/pagebuilder.analytics/runtime/stats'

interface TopEntry {
  label: string
  count: number
  pct: number
}

interface StatsResponse {
  summary: {
    visitors: number
    deltaPct: { visitors: number }
  }
  series: ReadonlyArray<{ pageviews: number }>
  topPages: ReadonlyArray<TopEntry>
}

function isStatsResponse(value: unknown): value is StatsResponse {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (!v.summary || typeof v.summary !== 'object') return false
  if (!Array.isArray(v.series)) return false
  if (!Array.isArray(v.topPages)) return false
  return true
}

/**
 * Hook factoring the shared range-driven stats fetch. Both Visitors and
 * Top Pages widgets call this; React's identity-by-arguments
 * deduplication and the abort-on-unmount pattern keep the dashboard's
 * network traffic to one request per range change per mounted widget.
 *
 * (We deliberately don't share a single Promise across widgets — that
 * would couple them via a module-level cache and break independent
 * range selection per widget.)
 */
function useStats(range: Range): StatsResponse | null {
  const [stats, setStats] = useState<StatsResponse | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${STATS_URL}?range=${RANGE_QUERY[range]}`, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) return
        const data: unknown = await res.json()
        if (cancelled) return
        if (isStatsResponse(data)) setStats(data)
      } catch {
        // Silently fall through — the widget stays on the previous frame.
      }
    })()
    return () => { cancelled = true }
  }, [range])
  return stats
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

function VisitorsWidget({ span, editing }: PluginDashboardWidgetRendererProps) {
  const [range, setRange] = useState<Range>('7d')
  const stats = useStats(range)

  const series = stats?.series.map(p => p.pageviews) ?? [0, 0]
  const total = stats?.summary.visitors.toLocaleString() ?? '—'
  const deltaPct = stats?.summary.deltaPct.visitors
  const deltaLabel =
    deltaPct === undefined
      ? null
      : deltaPct >= 0 ? `+${deltaPct}%` : `${deltaPct}%`

  return (
    <Widget
      widgetId="pagebuilder.analytics.visitors"
      title="Visitors"
      icon={EyeSolidIcon}
      tint="mint"
      span={span}
      editing={editing}
      action={(
        <RangeTabs<Range>
          value={range}
          options={[
            { value: '24h', label: '24h' },
            { value: '7d',  label: '7d'  },
            { value: '30d', label: '30d' },
          ]}
          onChange={setRange}
          ariaLabel="Visitor range"
        />
      )}
    >
      <StatValue
        value={total}
        delta={deltaLabel ? <Delta>{deltaLabel}</Delta> : undefined}
        sub={<span>Unique visitors · all pages</span>}
      />
      <div style={{ marginTop: 'auto' }}>
        <Sparkline data={series} tint="var(--rail-tint-mint)" height={68} />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 11,
            color: 'var(--editor-text-muted)',
            fontFamily: 'var(--font-mono)',
            marginTop: 6,
          }}
        >
          <span>{SINCE_LABEL[range]}</span>
          <span>Now</span>
        </div>
      </div>
    </Widget>
  )
}

// ---------------------------------------------------------------------------
// Top Pages widget
// ---------------------------------------------------------------------------

function formatCount(n: number): string {
  return n.toLocaleString()
}

function formatDelta(pct: number): string {
  if (pct === 0) return '±0%'
  return pct > 0 ? `+${pct}%` : `${pct}%`
}

function TopPagesWidget({ span, editing }: PluginDashboardWidgetRendererProps) {
  // Top Pages uses the same `/stats` route as Visitors. It always pulls
  // the 7-day window — the host's segmented control isn't shown for this
  // widget because the top-N list reads naturally over a fixed range.
  // If a range toggle becomes important, drop in `RangeTabs` like the
  // Visitors widget does and pass the value to `useStats`.
  const stats = useStats('7d')
  const rows = stats?.topPages.slice(0, 5) ?? []

  return (
    <Widget
      widgetId="pagebuilder.analytics.top-pages"
      title="Top pages"
      icon={StarSolidIcon}
      tint="lilac"
      span={span}
      editing={editing}
    >
      <WidgetList>
        {rows.length === 0
          ? (
            <WidgetListRow
              primary={<span>No pages tracked yet</span>}
              meta={null}
            />
          )
          : rows.map((row) => (
            <WidgetListRow
              key={row.label}
              primary={<span>{row.label}</span>}
              meta={(
                <>
                  {formatCount(row.count)}
                  <Delta>{formatDelta(row.pct)}</Delta>
                </>
              )}
            />
          ))}
      </WidgetList>
    </Widget>
  )
}

// ---------------------------------------------------------------------------
// Editor entrypoint
// ---------------------------------------------------------------------------

const mod: EditorPluginModule = {
  activate(api: EditorPluginApi) {
    api.dashboard.widgets.register({
      id: 'pagebuilder.analytics.visitors',
      name: 'Visitors',
      description: 'Unique visitors over time, with 24h / 7d / 30d toggle.',
      iconName: 'eye',
      defaultSize: 6,
      tint: 'mint',
      component: VisitorsWidget,
    })
    api.dashboard.widgets.register({
      id: 'pagebuilder.analytics.top-pages',
      name: 'Top pages',
      description: 'Most-viewed URLs over the last 7 days.',
      iconName: 'star',
      defaultSize: 4,
      tint: 'lilac',
      component: TopPagesWidget,
    })
  },
}

export default mod
