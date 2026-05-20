/**
 * Analytics plugin — server entrypoint.
 *
 * Wires together storage, routes, hooks, and scheduled jobs using the
 * plugin server SDK. Delegates heavy lifting to the sibling modules:
 *   - ingest.ts  — tracker.event handler + visitor hashing
 *   - rollup.ts  — daily aggregation + retention prune
 *   - stats.ts   — dashboard query helpers
 *   - csv.ts     — CSV serialization for export
 */
import type { ServerPluginApi, ServerPluginModule } from '@pagebuilder/plugin-sdk'
import { handleTrackerEvent } from './ingest'
import { runRollup, runPrune } from './rollup'
import { getDashboardStats } from './stats'
import { eventsToCsv, dailyStatsToCsv } from './csv'

// ---------------------------------------------------------------------------
// Salt seeding
// ---------------------------------------------------------------------------

/**
 * Generate a random 32-char hex string for the visitor-hash salt.
 * Uses Math.random() — not cryptographically strong, but adequate for an
 * analytics salt. (A truly random salt would require `crypto.getRandomValues`,
 * which the QuickJS polyfill does not expose.)
 */
function generateSalt(): string {
  let s = ''
  for (let i = 0; i < 32; i++) {
    s += Math.floor(Math.random() * 16).toString(16)
  }
  return s
}

// ---------------------------------------------------------------------------
// Plugin module
// ---------------------------------------------------------------------------

const mod: ServerPluginModule = {
  install(api: ServerPluginApi) {
    // Seed the salt on first install so visitor hashes are unpredictable
    const existing = api.cms.settings.get('salt')
    if (!existing) {
      void api.cms.settings.replace({
        ...api.cms.settings.getAll(),
        salt: generateSalt(),
      })
    }
    api.plugin.log('[analytics] installed')
  },

  activate(api: ServerPluginApi) {
    api.plugin.log('[analytics] activating')

    // ── Storage handles ────────────────────────────────────────────
    const events     = api.cms.storage.collection('events')
    const dailyStats = api.cms.storage.collection('daily-stats')

    // ── tracker.event hook ─────────────────────────────────────────
    api.cms.hooks.on('tracker.event', async (evt) => {
      if (evt.pluginId !== api.plugin.id && evt.pluginId !== '__implicit__') return
      try {
        await handleTrackerEvent(api, evt)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        api.plugin.log('[analytics] ingest failed:', msg)
      }
    })

    // ── settings.changed ───────────────────────────────────────────
    api.cms.hooks.on('settings.changed', (payload) => {
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'pluginId' in payload &&
        payload.pluginId !== api.plugin.id
      ) return
      api.plugin.log('[analytics] settings updated')
    })

    // ── Authenticated routes ───────────────────────────────────────

    // GET /stats?range=7d — full dashboard payload
    api.cms.routes.get('/stats', 'plugins.manage', async (ctx) => {
      const url = new URL(ctx.req.url)
      const rangeParam = url.searchParams.get('range') ?? '7d'
      const validRanges = ['1d', '7d', '30d', '90d'] as const
      type RangeStr = typeof validRanges[number]
      const range: RangeStr = (validRanges as readonly string[]).includes(rangeParam)
        ? rangeParam as RangeStr
        : '7d'
      return getDashboardStats(api, range)
    })

    // GET /live — last 5 minutes of raw events (at most 100)
    api.cms.routes.get('/live', 'plugins.manage', async () => {
      const all = await events.list()
      const cutoff = Date.now() - 5 * 60_000
      const recent = all
        .filter(r => {
          const at = String(r.data['received-at'] ?? r.createdAt)
          return new Date(at).getTime() >= cutoff
        })
        .slice(-100)
        .reverse()
      return { ok: true, events: recent }
    })

    // GET /export.csv?resource=events|daily-stats&range=30d
    api.cms.routes.get('/export.csv', 'plugins.manage', async (ctx) => {
      const url = new URL(ctx.req.url)
      const resource = url.searchParams.get('resource') ?? 'events'
      const rangeParam = url.searchParams.get('range') ?? '30d'
      const days = rangeParam === '7d' ? 7 : rangeParam === '30d' ? 30 : rangeParam === '90d' ? 90 : 30
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()

      let csvBody: string
      let filename: string

      if (resource === 'daily-stats') {
        const rows = await dailyStats.list()
        csvBody = dailyStatsToCsv(rows)
        filename = `analytics-daily-stats-${rangeParam}.csv`
      } else {
        const all = await events.list()
        const filtered = all.filter(r => {
          const at = String(r.data['received-at'] ?? r.createdAt)
          return at >= cutoff
        })
        csvBody = eventsToCsv(filtered)
        filename = `analytics-events-${rangeParam}.csv`
      }

      return {
        __response: true,
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
        body: csvBody,
      }
    })

    // ── Public routes ──────────────────────────────────────────────

    // GET /geo — country lookup from CF-IPCountry header (cached per session by tracker)
    api.cms.routes.getPublic('/geo', async (ctx) => {
      const country =
        ctx.req.headers.get('CF-IPCountry') ??
        ctx.req.headers.get('X-Country-Code') ??
        ''
      return { country }
    })

    // GET /is-admin — detects whether the requesting browser has an active
    // admin session cookie. The host's session cookie name is `pb_admin_session`;
    // presence (not validity) is sufficient to identify admin self-traffic.
    // The frontend tracker calls this once per session and includes the result
    // in every subsequent event payload. The ingest handler drops admin events
    // when `excludeAdmins` is true.
    api.cms.routes.getPublic('/is-admin', async (ctx) => {
      const cookie = ctx.req.headers.get('cookie') ?? ''
      // Cookie presence check — an expired-but-not-cleared cookie gives a
      // false positive, which is the safe direction (under-count, not over-count).
      const admin = cookie.includes('pb_admin_session=')
      return { admin }
    })

    // GET /public-stats.json?token=<publicStatsToken>
    api.cms.routes.getPublic('/public-stats.json', async (ctx) => {
      const token = api.cms.settings.get<string>('publicStatsToken') ?? ''
      if (!token) {
        return { __response: true, status: 404, headers: {}, body: '{"error":"disabled"}' }
      }
      const url = new URL(ctx.req.url)
      const provided = url.searchParams.get('token') ?? ''
      if (provided !== token) {
        return { __response: true, status: 403, headers: {}, body: '{"error":"forbidden"}' }
      }
      return getDashboardStats(api, '30d')
    })

    // ── Scheduled jobs ─────────────────────────────────────────────

    // Daily roll-up at 02:00 UTC
    api.cms.schedule.register({
      id: 'roll-up',
      cadence: { interval: 'daily', at: '02:00' },
      maxDurationMs: 60_000,
      overlap: 'skip',
      handler: async () => runRollup(api),
    })

    // Retention prune at 03:00 UTC
    api.cms.schedule.register({
      id: 'prune',
      cadence: { interval: 'daily', at: '03:00' },
      maxDurationMs: 60_000,
      overlap: 'skip',
      handler: async () => runPrune(api),
    })

    api.plugin.log('[analytics] activated')
  },

  deactivate(api: ServerPluginApi) {
    api.plugin.log('[analytics] deactivated')
  },

  async uninstall(api: ServerPluginApi) {
    // Clean up all stored data on uninstall
    const eventsCol = api.cms.storage.collection('events')
    const statsCol  = api.cms.storage.collection('daily-stats')
    const [allEvents, allStats] = await Promise.all([eventsCol.list(), statsCol.list()])
    await Promise.all([
      ...allEvents.map(r => eventsCol.delete(r.id)),
      ...allStats.map(r => statsCol.delete(r.id)),
    ])
    api.plugin.log(`[analytics] uninstalled — removed ${allEvents.length} events, ${allStats.length} daily-stats rows`)
  },
}

export default mod
