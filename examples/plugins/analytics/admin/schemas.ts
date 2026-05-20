/**
 * Analytics plugin — TypeBox schemas for admin HTTP boundary validation.
 *
 * All shapes that cross the HTTP boundary (dashboard stats, live feed) are
 * validated here. Types are derived via `Static<typeof Schema>` — no parallel
 * interface definitions.
 */
import { Type, type Static } from '@sinclair/typebox'

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

const TopEntrySchema = Type.Object({
  label: Type.String(),
  count: Type.Number(),
  pct:   Type.Number(),
})

export type TopEntry = Static<typeof TopEntrySchema>

// ---------------------------------------------------------------------------
// Dashboard stats — returned by GET /stats?range=*
// ---------------------------------------------------------------------------

export const DashboardStatsSchema = Type.Object({
  summary: Type.Object({
    pageviews:  Type.Number(),
    visitors:   Type.Number(),
    sessions:   Type.Number(),
    bounceRate: Type.Number(),
    deltaPct: Type.Object({
      pageviews:  Type.Number(),
      visitors:   Type.Number(),
      sessions:   Type.Number(),
      bounceRate: Type.Number(),
    }),
  }),
  series: Type.Array(Type.Object({
    date:      Type.String(),
    pageviews: Type.Number(),
  })),
  topPages:     Type.Array(TopEntrySchema),
  topReferrers: Type.Array(TopEntrySchema),
  topCountries: Type.Array(TopEntrySchema),
  topDevices:   Type.Array(TopEntrySchema),
})

export type DashboardStats = Static<typeof DashboardStatsSchema>

// ---------------------------------------------------------------------------
// PluginRecord — mirrors the SDK type for the live-feed response
// ---------------------------------------------------------------------------

const PluginRecordSchema = Type.Object({
  id:         Type.String(),
  pluginId:   Type.String(),
  resourceId: Type.String(),
  data:       Type.Record(Type.String(), Type.Unknown()),
  createdAt:  Type.String(),
  updatedAt:  Type.String(),
})

export type AnalyticsPluginRecord = Static<typeof PluginRecordSchema>

// ---------------------------------------------------------------------------
// Live feed — returned by GET /live
// ---------------------------------------------------------------------------

export const LiveResponseSchema = Type.Object({
  ok:     Type.Boolean(),
  events: Type.Array(PluginRecordSchema),
})

export type LiveResponse = Static<typeof LiveResponseSchema>
