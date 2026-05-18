/**
 * Plugin worker IPC protocol.
 *
 * Plugin server modules run inside a Bun `Worker` so:
 *  1. The host process never `import()`s plugin code, eliminating the
 *     `bun --watch` race where a plugin file in the watch graph gets
 *     deleted (during upgrade cleanup) and triggers a server reload
 *     mid-response.
 *  2. A throwing or runaway plugin can't take down the host process —
 *     the worker can be terminated and respawned without affecting
 *     in-flight HTTP requests on other plugins.
 *  3. A future hardening step can drop privileges (no fs / no env)
 *     inside the worker without affecting the host.
 *
 * Design:
 *  - Single shared worker for all plugins (per server process). One
 *    bad plugin therefore can take out its peers, but adding per-plugin
 *    workers later is purely additive — same protocol, multiple workers.
 *  - All messages carry a `correlationId` (nanoid) so request/reply
 *    pairs can be matched even when interleaved.
 *  - Two directions of RPC:
 *      MainToWorker — host invokes plugin code (lifecycle, route handler,
 *        hook listener / filter, loop fetch).
 *      WorkerToMain — plugin code calls into the host's `ServerPluginApi`
 *        (storage, hook emit, settings replace, log, register-route, …).
 *  - Responses use a uniform shape: `{ kind: '*-result', correlationId,
 *    ok, value? | error? }` with `error` carrying a serialized message
 *    string (full Error chain isn't reconstructed across the boundary —
 *    plugins log their own stacks, the host logs `[plugin:<id>]` prefix).
 */

import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { PropertySchemaSchema } from '@core/module-engine/propertySchema'
import type { PluginManifest, PluginPermission } from '@core/plugin-sdk'

// ---------------------------------------------------------------------------
// Shared serialization helpers
// ---------------------------------------------------------------------------

/** Serialized HTTP request — only the fields plugin route handlers can read. */
export interface SerializedRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** Stringified body (typed to JSON-serializable text — large bodies aren't supported in v1). */
  body: string
}

/**
 * Serialized response from a plugin route handler. `value` is the
 * JSON-serializable return; if the plugin returned an actual `Response`
 * via `new Response(...)` the worker pre-extracts status/headers/body.
 */
export type SerializedResponse =
  | { kind: 'json'; value: unknown }
  | { kind: 'response'; status: number; headers: Record<string, string>; body: string }

export interface SerializedUser {
  id: string
  email: string
  capabilities: string[]
}

// ---------------------------------------------------------------------------
// Main → Worker
// ---------------------------------------------------------------------------

export type MainToWorkerMessage =
  | LoadPluginRequest
  | UnloadPluginRequest
  | RunLifecycleRequest
  | RunMigrateRequest
  | RunRouteRequest
  | RunHookListenerRequest
  | RunHookFilterRequest
  | RunLoopFetchRequest
  | RunLoopPreviewRequest
  | ApiReply

export interface LoadPluginRequest {
  kind: 'load-plugin'
  correlationId: string
  pluginId: string
  manifest: PluginManifest
  /** Absolute path to the plugin's server entrypoint module. */
  entryFileUrl: string
  /** Settings snapshot — populated into the worker's local cache so
   *  `settings.get` can resolve synchronously inside the plugin code. */
  settings: Record<string, string | number | boolean>
}

export interface UnloadPluginRequest {
  kind: 'unload-plugin'
  correlationId: string
  pluginId: string
}

export interface RunLifecycleRequest {
  kind: 'run-lifecycle'
  correlationId: string
  pluginId: string
  hook: 'install' | 'activate' | 'deactivate' | 'uninstall'
}

export interface RunMigrateRequest {
  kind: 'run-migrate'
  correlationId: string
  pluginId: string
  fromVersion: string
}

export interface RunRouteRequest {
  kind: 'run-route'
  correlationId: string
  pluginId: string
  routeKey: string
  request: SerializedRequest
  user: SerializedUser | null
  body: Record<string, unknown>
}

export interface RunHookListenerRequest {
  kind: 'run-hook-listener'
  correlationId: string
  pluginId: string
  listenerId: string
  event: string
  payload: unknown
}

export interface RunHookFilterRequest {
  kind: 'run-hook-filter'
  correlationId: string
  pluginId: string
  filterId: string
  name: string
  value: unknown
}

export interface RunLoopFetchRequest {
  kind: 'run-loop-fetch'
  correlationId: string
  pluginId: string
  sourceId: string
  ctx: unknown
}

export interface RunLoopPreviewRequest {
  kind: 'run-loop-preview'
  correlationId: string
  pluginId: string
  sourceId: string
  ctx: unknown
}

/** Host's reply to a worker-initiated `api-call`. */
export interface ApiReply {
  kind: 'api-reply'
  correlationId: string
  ok: boolean
  value?: unknown
  error?: string
}

// ---------------------------------------------------------------------------
// Worker → Main
// ---------------------------------------------------------------------------

export type WorkerToMainMessage =
  | LoadPluginResult
  | UnloadPluginResult
  | LifecycleResult
  | RouteResult
  | HookListenerResult
  | HookFilterResult
  | LoopFetchResult
  | LoopPreviewResult
  | ApiCall
  | WorkerLogEvent

export interface LoadPluginResult {
  kind: 'load-plugin-result'
  correlationId: string
  ok: boolean
  error?: string
  /**
   * List of hook names the plugin module exports. Lets the host skip the
   * round-trip when calling a non-existent lifecycle hook.
   */
  hooks?: Array<'install' | 'activate' | 'deactivate' | 'uninstall' | 'migrate'>
}

export interface UnloadPluginResult {
  kind: 'unload-plugin-result'
  correlationId: string
  ok: boolean
}

export interface LifecycleResult {
  kind: 'lifecycle-result'
  correlationId: string
  ok: boolean
  error?: string
}

export interface RouteResult {
  kind: 'route-result'
  correlationId: string
  ok: boolean
  response?: SerializedResponse
  error?: string
}

export interface HookListenerResult {
  kind: 'hook-listener-result'
  correlationId: string
  ok: boolean
  error?: string
}

export interface HookFilterResult {
  kind: 'hook-filter-result'
  correlationId: string
  ok: boolean
  /** Plugin-transformed value (when ok). */
  value?: unknown
  error?: string
}

export interface LoopFetchResult {
  kind: 'loop-fetch-result'
  correlationId: string
  ok: boolean
  /** `{ items, totalItems }` shape from the plugin's source — re-validated host-side. */
  value?: { items: unknown[]; totalItems: number }
  error?: string
}

export interface LoopPreviewResult {
  kind: 'loop-preview-result'
  correlationId: string
  ok: boolean
  value?: unknown[]
  error?: string
}

/**
 * Worker-initiated call into the host's ServerPluginApi. Awaiting an
 * `ApiReply` with the same correlationId.
 *
 * `target` is a dotted path like `cms.storage.list`, `cms.hooks.emit`,
 * `cms.routes.register`, `cms.settings.replace`, `cms.loops.registerSource`,
 * `cms.hooks.on`, `cms.hooks.filter`. The host validates each target
 * against an allowlist before dispatch.
 */
export interface ApiCall {
  kind: 'api-call'
  correlationId: string
  pluginId: string
  target: string
  args: unknown[]
}

/**
 * Plugin `api.plugin.log(...)` — fire-and-forget, no correlation id.
 * Host prints with `[plugin:<id>]` prefix.
 */
export interface WorkerLogEvent {
  kind: 'log'
  pluginId: string
  args: unknown[]
}

// ---------------------------------------------------------------------------
// Allowlist of API targets the host accepts from a worker
// ---------------------------------------------------------------------------

export const ALLOWED_API_TARGETS = [
  // Routes — recorded but not actually invoked from worker (worker is the
  // origin of registration; main is the consumer). Host stores route
  // handler ids per pluginId+method+path.
  'cms.routes.register',
  // Hooks
  'cms.hooks.on',
  'cms.hooks.filter',
  'cms.hooks.emit',
  // Loops
  'cms.loops.registerSource',
  // Storage
  'cms.storage.list',
  'cms.storage.create',
  'cms.storage.update',
  'cms.storage.delete',
  // Settings (read is local to worker via settings cache; replace is RPC)
  'cms.settings.replace',
  // Network — gated by `network.outbound` permission + manifest's
  // `networkAllowedHosts`. Host validates the URL host BEFORE making the
  // outbound request.
  'network.fetch',
] as const

export type AllowedApiTarget = typeof ALLOWED_API_TARGETS[number]

export function isAllowedApiTarget(target: string): target is AllowedApiTarget {
  return (ALLOWED_API_TARGETS as readonly string[]).includes(target)
}

// ---------------------------------------------------------------------------
// Runtime validation for worker-initiated api-calls
// ---------------------------------------------------------------------------

const RouteMethodSchema = Type.Union([
  Type.Literal('GET'),
  Type.Literal('POST'),
  Type.Literal('PATCH'),
  Type.Literal('DELETE'),
])

const RouteRegistrationArgSchema = Type.Object(
  {
    method: RouteMethodSchema,
    path: Type.String({ minLength: 1 }),
    capability: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    routeKey: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

const HookListenerArgSchema = Type.Object(
  {
    event: Type.String({ minLength: 1 }),
    listenerId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

const HookFilterArgSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    filterId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

const HookEmitArgSchema = Type.Object(
  {
    event: Type.String({ minLength: 1 }),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
)

const LoopSourceFieldSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    format: Type.Optional(Type.Union([
      Type.Literal('plain'),
      Type.Literal('html'),
      Type.Literal('url'),
      Type.Literal('media'),
    ])),
  },
  { additionalProperties: false },
)

const LoopSourceDescriptorSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    filterSchema: PropertySchemaSchema,
    orderByOptions: Type.Array(Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        label: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    )),
    fields: Type.Array(LoopSourceFieldSchema),
  },
  { additionalProperties: false },
)

const JsonRecordSchema = Type.Record(Type.String(), Type.Unknown())

const NetworkFetchInitSchema = Type.Object(
  {
    method: Type.Optional(Type.String({ maxLength: 16 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    body: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
)

function apiCallSchema<TTarget extends AllowedApiTarget, TArgs extends TSchema>(
  target: TTarget,
  args: TArgs,
) {
  return Type.Object(
    {
      kind: Type.Literal('api-call'),
      correlationId: Type.String({ minLength: 1 }),
      pluginId: Type.String({ minLength: 1 }),
      target: Type.Literal(target),
      args,
    },
    { additionalProperties: false },
  )
}

const ApiCallSchemas = {
  'cms.routes.register': apiCallSchema('cms.routes.register', Type.Tuple([RouteRegistrationArgSchema])),
  'cms.hooks.on': apiCallSchema('cms.hooks.on', Type.Tuple([HookListenerArgSchema])),
  'cms.hooks.filter': apiCallSchema('cms.hooks.filter', Type.Tuple([HookFilterArgSchema])),
  'cms.hooks.emit': apiCallSchema('cms.hooks.emit', Type.Tuple([HookEmitArgSchema])),
  'cms.loops.registerSource': apiCallSchema('cms.loops.registerSource', Type.Tuple([LoopSourceDescriptorSchema])),
  'cms.storage.list': apiCallSchema('cms.storage.list', Type.Tuple([Type.String({ minLength: 1 })])),
  'cms.storage.create': apiCallSchema('cms.storage.create', Type.Tuple([Type.String({ minLength: 1 }), JsonRecordSchema])),
  'cms.storage.update': apiCallSchema('cms.storage.update', Type.Tuple([
    Type.String({ minLength: 1 }),
    Type.String({ minLength: 1 }),
    JsonRecordSchema,
  ])),
  'cms.storage.delete': apiCallSchema('cms.storage.delete', Type.Tuple([
    Type.String({ minLength: 1 }),
    Type.String({ minLength: 1 }),
  ])),
  'cms.settings.replace': apiCallSchema('cms.settings.replace', Type.Tuple([JsonRecordSchema])),
  'network.fetch': apiCallSchema('network.fetch', Type.Tuple([
    Type.String({ minLength: 1, maxLength: 2048 }),
    NetworkFetchInitSchema,
  ])),
} satisfies Record<AllowedApiTarget, TSchema>

export type RouteRegistrationApiCall = Static<typeof ApiCallSchemas['cms.routes.register']>
export type HookOnApiCall = Static<typeof ApiCallSchemas['cms.hooks.on']>
export type HookFilterApiCall = Static<typeof ApiCallSchemas['cms.hooks.filter']>
export type HookEmitApiCall = Static<typeof ApiCallSchemas['cms.hooks.emit']>
export type LoopSourceRegisterApiCall = Static<typeof ApiCallSchemas['cms.loops.registerSource']>
export type StorageListApiCall = Static<typeof ApiCallSchemas['cms.storage.list']>
export type StorageCreateApiCall = Static<typeof ApiCallSchemas['cms.storage.create']>
export type StorageUpdateApiCall = Static<typeof ApiCallSchemas['cms.storage.update']>
export type StorageDeleteApiCall = Static<typeof ApiCallSchemas['cms.storage.delete']>
export type SettingsReplaceApiCall = Static<typeof ApiCallSchemas['cms.settings.replace']>
export type NetworkFetchApiCall = Static<typeof ApiCallSchemas['network.fetch']>

export type ValidatedApiCall =
  | RouteRegistrationApiCall
  | HookOnApiCall
  | HookFilterApiCall
  | HookEmitApiCall
  | LoopSourceRegisterApiCall
  | StorageListApiCall
  | StorageCreateApiCall
  | StorageUpdateApiCall
  | StorageDeleteApiCall
  | SettingsReplaceApiCall
  | NetworkFetchApiCall

export class ApiCallValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiCallValidationError'
  }
}

function firstSchemaError(schema: TSchema, value: unknown): string {
  const [error] = [...Value.Errors(schema, value)]
  if (!error) return 'unknown validation error'
  const path = error.path || '/'
  return `${path}: ${error.message}`
}

function normalizeRoutePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') return '/'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

function validateApiCallSemantics(call: ValidatedApiCall): void {
  if (call.target !== 'cms.routes.register') return

  const [route] = call.args
  const normalizedPath = normalizeRoutePath(route.path)
  if (route.path !== normalizedPath) {
    throw new ApiCallValidationError(
      `Invalid api-call payload for cms.routes.register: path must be normalized as "${normalizedPath}"`,
    )
  }

  const expectedRouteKey = `${route.method}:${normalizedPath}`
  if (route.routeKey !== expectedRouteKey) {
    throw new ApiCallValidationError(
      `Invalid api-call payload for cms.routes.register: routeKey must be "${expectedRouteKey}"`,
    )
  }
}

function decodeApiCall(target: AllowedApiTarget, value: unknown): ValidatedApiCall {
  switch (target) {
    case 'cms.routes.register':
      return Value.Decode(ApiCallSchemas['cms.routes.register'], value)
    case 'cms.hooks.on':
      return Value.Decode(ApiCallSchemas['cms.hooks.on'], value)
    case 'cms.hooks.filter':
      return Value.Decode(ApiCallSchemas['cms.hooks.filter'], value)
    case 'cms.hooks.emit':
      return Value.Decode(ApiCallSchemas['cms.hooks.emit'], value)
    case 'cms.loops.registerSource':
      return Value.Decode(ApiCallSchemas['cms.loops.registerSource'], value)
    case 'cms.storage.list':
      return Value.Decode(ApiCallSchemas['cms.storage.list'], value)
    case 'cms.storage.create':
      return Value.Decode(ApiCallSchemas['cms.storage.create'], value)
    case 'cms.storage.update':
      return Value.Decode(ApiCallSchemas['cms.storage.update'], value)
    case 'cms.storage.delete':
      return Value.Decode(ApiCallSchemas['cms.storage.delete'], value)
    case 'cms.settings.replace':
      return Value.Decode(ApiCallSchemas['cms.settings.replace'], value)
    case 'network.fetch':
      return Value.Decode(ApiCallSchemas['network.fetch'], value)
  }
}

export function parseApiCall(value: unknown): ValidatedApiCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiCallValidationError('Invalid api-call payload: expected object')
  }

  const target = (value as { target?: unknown }).target
  if (typeof target !== 'string' || !isAllowedApiTarget(target)) {
    throw new ApiCallValidationError('Invalid api-call payload: unknown target')
  }

  const schema = ApiCallSchemas[target]
  if (!Value.Check(schema, value)) {
    throw new ApiCallValidationError(
      `Invalid api-call payload for ${target}: ${firstSchemaError(schema, value)}`,
    )
  }

  const parsed = decodeApiCall(target, value)
  validateApiCallSemantics(parsed)
  return parsed
}

// ---------------------------------------------------------------------------
// Permissions snapshot — sent with `load-plugin` so the worker can enforce
// `assertPluginPermission` BEFORE round-tripping back to the host.
// ---------------------------------------------------------------------------

export interface ManifestSnapshotForWorker {
  id: string
  version: string
  permissions: PluginPermission[]
  grantedPermissions: PluginPermission[]
}
