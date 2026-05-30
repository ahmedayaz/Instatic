# Plugin background queue and jobs

A plan to give plugins a typed, durable, retry-aware background-job queue — `api.cms.queue.*` — that runs handlers off the request path with per-job budgets up to 30 min, exponential backoff, checkpoint/resume, per-queue concurrency, priority, dedupe, and a dead-letter state. This unblocks newsletters, transcoders, importers, embeddings indexers, AI batch processing, and every other plugin class that needs to do work longer than the current 5 s eval ceiling.

This is a plan, not a doc. It describes work that has not been built. When it ships, the lasting parts move into `docs/features/plugin-system.md`; this file is deleted.

---

## TL;DR

- **The gap.** `api.cms.schedule.*` covers cadence-driven work but caps every fire at 5 min (`server/plugins/quickjs/bootstrap/api.ts:194-195`), passes no payload (handler closes over state), has no retries, no progress reporting, no per-attempt backoff, no dedupe, and no DLQ. Plugins that need "process THIS thing, ASAP, with retries" reinvent all of that on top of `cms.storage` + a 5-min schedule. The existing newsletter plugin's `executeSend` at `examples/plugins/newsletter/server/broadcasts.ts:243-340` is the canonical example: hand-rolled batch loop, no resume on failure, no progress UI, doesn't fit blasts bigger than ~10k recipients into one tick.
- **The shape.** `api.cms.queue.define(name, { handler, concurrency, maxAttempts, backoff, perJobMaxDurationMs })` declares a queue at activate-time. `api.cms.queue.enqueue(name, { payload, delayMs?, priority?, uniqueKey? })` puts a job on it. The host's queue tick (1 s) dispatches up to `concurrency` jobs per queue per tick, respecting priority + run-after-time + per-plugin claim.
- **Reuses the scheduler pattern verbatim** — `pg_try_advisory_lock` leader election, atomic per-row `running_token + lock_until` claim, dialect-naive SQL, history-trim cap. The queue is the scheduler's third use-case, not a parallel system.
- **Checkpoints decouple jobs from the 5-min eval ceiling.** `await checkpoint({ progress, message, state })` from inside a handler (a) persists `progress_state_json` to the row, (b) resets the wall-clock deadline via `withDeadline` in the eval loop, (c) updates the admin-visible progress. A handler that checkpoints every chunk can run for the full `perJobMaxDurationMs` (default 30 min, host-cap 60 min) — and if the worker crashes mid-job, the next attempt picks up from `job.checkpointState`.
- **Built-in retries + backoff.** Failed jobs are scheduled with `run_after = now + computeBackoff(attempt, policy)`. After `maxAttempts`, the row flips to `state='dead'` (DLQ) instead of pausing the whole queue. The admin can requeue dead rows manually.
- **Priority + delay + dedupe.** Priority is an integer 0..100 (default 50); higher fires sooner. `delayMs` is a future scheduling hint (any non-zero value writes `run_after = now + delayMs`). `uniqueKey` is a partial-unique index — re-enqueueing the same key while a job is `pending` or `running` is a no-op (returns the existing job's id).
- **AbortSignal threaded through every handler.** The existing `AbortController` polyfill at `server/plugins/quickjs/bootstrap/polyfills.ts:229-331` is reused — cancellation flips `state='cancelled'` and aborts the in-VM handler via the host-side controller.
- **Two new RPC targets (`cms.queue.enqueue`, `cms.queue.cancel`, `cms.queue.status`, `cms.queue.list`, `cms.queue.requeue`).** `cms.queue.define` is local to the VM (handler stays inside the VM); the host learns about the queue from the VM's `define` call via `cms.queue.declare`, which records the static config (concurrency, maxAttempts, etc.) in `plugin_queues`.
- **One new permission.** `cms.queue` (high). Mirrors `cms.schedule`.
- **One PR.** Migration + repo + scheduler-pattern reuse + handlers + bootstrap + SDK types + newsletter migration. The newsletter `executeSend` collapses from ~100 lines of hand-rolled batching into a per-recipient queue job.

---

## Why this is a plan

Three specific things in the current system make this work worth doing now.

### 1. The 5-min cap is a load-bearing ceiling, not a soft cap

Every cross-bridge eval is wrapped in `withDeadline(ctx, timeoutMs, body)` at `server/plugins/quickjs/eval.ts:21-27`. The deadline is enforced via `shouldInterruptAfterDeadline(deadline)` from QuickJS — a cooperative interrupt that aborts the VM with `InternalError: interrupted`. The default budget is 5 s (`DEFAULT_EVAL_TIMEOUT_MS` in `limits.ts:32`). Schedules can request more, but the bootstrap clamps at 5 min (`bootstrap/api.ts:194-195`):

```js
if (maxDurationMs > 5 * 60 * 1000) maxDurationMs = 5 * 60 * 1000;
```

For real long-running work this is the limit:

| Use case | Plausible duration | Fits today? |
|---|---|---|
| Newsletter blast (10k recipients, batch 50, 1 s/batch) | ~200 s | borderline |
| Newsletter blast (50k recipients) | ~1000 s | no |
| WordPress XML import (5k posts, 50ms each) | ~250 s | borderline |
| Video transcode (1 min ffmpeg per file) | ~60 s base × N files | no for >5 files |
| Embeddings indexer over the page corpus | minutes to hours | no |
| AI bulk-translate 200 pages | ~10s/page × 200 = 33 min | no |

Plugins working around this reinvent: "split the work, store progress in `cms.storage`, schedule the next chunk via a 5-min cadence." Always custom, never composable, often subtly broken on failure.

### 2. The newsletter plugin is the existence proof

`examples/plugins/newsletter/server/broadcasts.ts:210-235` declares a 5-min schedule that picks up `status='scheduled'` broadcasts and calls `executeSend(broadcastId, ...)`. `executeSend` (lines 243-340):

- Lists all 1000-capped confirmed subscribers (`subs.list({ limit: 1000 })`).
- Filters in JS for list membership.
- Loops in batches of 50, calls `sendBatch(...)` to Resend.
- On any batch failure: sets `failed = true`, breaks the loop, leaves the broadcast in `status='sending'`.
- No resume — the next 5-min tick won't pick up `status='sending'` (only `status='scheduled'`), so a failure permanently strands the broadcast.

What this plugin actually wants is: enqueue one job per recipient, concurrency 10, exponential backoff on the Resend 429, dead-letter the recipients Resend rejects, surface progress to the admin. With `api.cms.queue.*` the plugin's `executeSend` becomes:

```ts
async function executeSend(broadcastId, api) {
  const broadcast = await getBroadcast(broadcastId)
  const targets = await listTargetSubscribers(broadcast)
  await broadcasts.update(broadcastId, { status: 'sending' })
  for (const sub of targets) {
    await api.cms.queue.enqueue('send-broadcast-email', {
      payload: { broadcastId, subscriberId: sub.id },
      uniqueKey: `${broadcastId}:${sub.id}`,    // re-send is idempotent
    })
  }
  return { ok: true, queued: targets.length }
}
```

…and the handler is per-recipient, retried with backoff for free, progress visible per-broadcast.

### 3. The scheduler already solves 70% of the problem

`server/plugins/scheduler.ts` is a finished, tested implementation of:

- HA leader election (`tryAcquireLeader` via `pg_try_advisory_lock`).
- Atomic per-row claim (`tryClaimSchedule` in `server/repositories/pluginSchedules.ts:314-331` — UPDATE with `running_token is null OR lock_until <= now` precondition).
- Wall-clock lock auto-expiry (`lock_until = now + maxDurationMs * 2`).
- Failure-cap auto-pause (5 consecutive failures → `enabled=false`).
- Dialect-naive SQL gated by `db-postgres-isms.test.ts`.
- Per-fire deadline override of the VM's default (`runScheduleInWorker` at `host/rpc.ts:313-334` passes `maxDurationMs` into `vm.runSchedule` at `quickjs/vm.ts:291-296`).

The queue is the same machinery applied to a different selection predicate (`state='pending' AND run_after <= now` instead of `enabled=true AND next_run_at <= now`) plus four additions: payloads, per-attempt backoff, checkpoints, concurrency. Building it as a parallel system to the scheduler would be wrong — it's the scheduler's third use case (after schedules and "run now" manual fires).

### What we leverage

| Concern | Lives in | Already does |
|---|---|---|
| HA leader election + per-row claim | `server/plugins/scheduler.ts:137-241` + `repositories/pluginSchedules.ts:314-381` | Two-level lock (advisory + row-token). Reused unchanged. |
| Dialect-naive repository pattern | `server/repositories/pluginSchedules.ts` (gated by `db-postgres-isms.test.ts`) | Source of the queue repository's shape and style. |
| Per-call deadline override | `server/plugins/quickjs/eval.ts:21-27` (`withDeadline`) + `vm.ts:291-296` | Already accepts a per-call ceiling that overrides the default. Reused with longer budgets + reset on checkpoint. |
| AbortController/AbortSignal polyfill | `server/plugins/quickjs/bootstrap/polyfills.ts:229-331` | Plugin handlers receive a real `AbortSignal`; cancellation tears down both in-VM and (where applicable) upstream fetches. |
| Permission catalog + install consent | `src/core/plugin-sdk/capabilities.ts` | Adds one new entry (`cms.queue`). |
| Settings-changed pump | `server/plugins/host/handlers/settings.ts` + the worker's settings mirror | Pattern for "the host pushes state updates into the VM via a small evalCode call" — re-used for `checkpoint` writes back into the running handler. |
| Boot-time queue declaration on `activate` | `server/plugins/runtime.ts:activateInstalledServerPlugins` | The same boot path that re-binds schedules calls `define()` for queues, which RPCs `cms.queue.declare` to upsert `plugin_queues` rows. |
| Crash recovery + respawn | `server/plugins/host/crashRecovery.ts` + `runtime.ts` | A crashed worker mid-job releases its claim (because `lock_until` expires); next tick re-fires the job with `attempt += 1`. No queue-specific recovery code needed. |
| `data_rows.plugin_actor_id` audit column | The Gap A.2 plan (`2026-05-30-plugin-cms-content-access.md`) | When queue jobs write to CMS content, the same actor column records the plugin id. Queue + content access compose cleanly. |

The leader-election layer, the claim primitive, the dialect-naive SQL style, the per-call deadline override, the abort polyfill, and the activate hook all exist. The plan adds two tables, a tick loop, a payload + checkpoint protocol, and the VM bootstrap helpers.

---

## Goals and non-goals

### Goals

- Typed, declarative queue definition via `api.cms.queue.define(name, config)`.
- Payload-carrying enqueue via `api.cms.queue.enqueue(name, { payload, delayMs?, priority?, uniqueKey? })`.
- Per-job retries with exponential backoff and a built-in jitter.
- Per-job progress reporting and mid-job checkpointing that resets the wall-clock budget.
- Per-queue concurrency cap, host-enforced.
- Dead-letter state after `maxAttempts`, NOT a queue-wide pause.
- Cancel + status + list + requeue APIs visible to plugin code and the admin UI.
- AbortSignal threaded into every handler.
- Single dispatcher tick handling all plugins' queues (one tick, multiple queues).
- Newsletter plugin migrated as the first consumer in the same change.

### Non-goals

- **Per-job timezone-aware cron scheduling.** Queues are "do this thing", schedules are "do this on a cadence." If a plugin needs both ("send the weekly digest every Monday 09:00 then queue per-recipient sends"), the schedule fires and enqueues — the two compose explicitly. No fused `cms.scheduledQueue` API.
- **Cross-plugin queue subscription.** A plugin can only enqueue to queues it defined. Cross-plugin "service" calls are a separate plan (Gap B.1).
- **Job result chaining / DAGs.** No `enqueue(A).then(B)` builder. Plugins compose chains by having handler A call `api.cms.queue.enqueue('B', { ... })` at the end.
- **Distributed handler shards.** A single Bun.Worker per plugin runs all that plugin's queue handlers (alongside its routes / hooks / schedules). Plugins that need horizontal scaling out-of-process get the next architecture step, not this plan.
- **Per-job memory cap above 64 MB.** Queues are the workaround for the time budget. Memory is its own plan.
- **Backwards compatibility with hand-rolled scheduled-batch patterns.** Per `CLAUDE.md` pre-release rule: newsletter migrates fully; nothing wrapping the old shape stays.

---

## The API surface

Added to `ServerPluginApi.cms` in `src/core/plugin-sdk/types/serverApi.ts`.

```ts
api.cms.queue: {
  /**
   * Declare a queue + register its handler. Called once during `activate()`.
   * The handler lives in the VM (closure scope); the host learns only the
   * static config and dispatches into the VM via __runQueueJob(jobId).
   *
   * Idempotent on re-activation — same name re-registers and replaces the
   * handler while preserving any pending / running jobs.
   */
  define<TPayload = unknown, TResult = unknown>(
    queueName: string,
    config: QueueDefinition<TPayload, TResult>,
  ): void

  /**
   * Add a job to a previously-defined queue. Returns the job's id (a fresh
   * nanoid) — or, when `uniqueKey` matches an already-pending or already-
   * running job, the existing job's id.
   *
   * Permission check: enqueueing into a queue NOT defined by this plugin
   * is rejected at the host bridge. Cross-plugin queue calls go through
   * cms.services (separate plan).
   */
  enqueue<TPayload = unknown>(
    queueName: string,
    options: { payload: TPayload; delayMs?: number; priority?: number; uniqueKey?: string },
  ): Promise<string>

  /** Cancel a pending or running job. Running jobs receive AbortSignal. */
  cancel(jobId: string): Promise<void>

  /** Read one job. */
  status(jobId: string): Promise<JobStatus | null>

  /** List jobs for a queue, with filters. Admin uses the same call. */
  list(queueName: string, options?: ListJobsOptions): Promise<{ jobs: JobStatus[]; totalCount: number }>

  /** Requeue a dead-letter job — sets state='pending', attempt=0. */
  requeue(jobId: string): Promise<void>
}
```

### `QueueDefinition`

```ts
export interface QueueDefinition<TPayload, TResult> {
  /**
   * Max concurrent running jobs for this queue, across all worker ticks.
   * Default 1 (serial). Host-cap 16 per queue.
   */
  concurrency?: number

  /**
   * Maximum attempts before a failed job lands in DLQ (state='dead').
   * Default 5; host-cap 20.
   */
  maxAttempts?: number

  /**
   * Backoff between attempts.
   * 'fixed'        — wait `delayMs` flat between attempts.
   * 'exponential'  — wait `baseMs * 2^(attempt-1)`, capped at `maxMs`,
   *                  with `jitter` (0..1) of uniform random multiplier.
   * Default: { kind: 'exponential', baseMs: 1000, maxMs: 60_000, jitter: 0.2 }.
   */
  backoff?:
    | { kind: 'fixed'; delayMs: number }
    | { kind: 'exponential'; baseMs: number; maxMs: number; jitter?: number }

  /**
   * Wall-clock budget for ONE attempt. Reset by every successful
   * `checkpoint()` call. Default 60_000ms. Host-cap 60 min.
   * Note: must exceed the schedule's 5-min ceiling — this is the whole point.
   */
  perJobMaxDurationMs?: number

  /**
   * Trim policy for completed-job rows. Default keeps the latest 500 per
   * queue. The host's history trim runs on the same cadence as the
   * scheduler's (HISTORY_TRIM_INTERVAL_MS).
   */
  historyRetention?: { mode: 'count'; keep: number } | { mode: 'days'; days: number }

  /**
   * The actual handler. Receives the typed payload + a ctx with progress,
   * checkpoint, and abort.
   */
  handler: (
    job: { id: string; payload: TPayload; attempt: number; checkpointState: unknown; enqueuedAt: string },
    ctx: { progress: (fraction: number, message?: string) => Promise<void>
           checkpoint: (state: unknown) => Promise<void>
           signal: AbortSignal },
  ) => Promise<TResult> | TResult
}
```

### `JobStatus`

```ts
export const JobStatusSchema = Type.Object({
  id: Type.String(),
  pluginId: Type.String(),
  queueName: Type.String(),
  state: Type.Union([
    Type.Literal('pending'),
    Type.Literal('running'),
    Type.Literal('succeeded'),
    Type.Literal('failed'),       // last attempt failed; will retry
    Type.Literal('cancelled'),
    Type.Literal('dead'),          // exhausted retries → DLQ
  ]),
  attempt: Type.Integer(),
  maxAttempts: Type.Integer(),
  priority: Type.Integer(),
  progress: Type.Number(),                   // 0..1
  progressMessage: Type.Union([Type.String(), Type.Null()]),
  payload: Type.Unknown(),
  result: Type.Unknown(),                    // populated when state='succeeded'
  lastError: Type.Union([Type.String(), Type.Null()]),
  enqueuedAt: Type.String(),
  runAfter: Type.String(),
  startedAt: Type.Union([Type.String(), Type.Null()]),
  finishedAt: Type.Union([Type.String(), Type.Null()]),
})
export type JobStatus = Static<typeof JobStatusSchema>
```

`ListJobsOptions` mirrors `StorageListOptions` (existing TypeBox at `src/core/plugin-sdk/storageSchemas.ts:78-90`) — same filter operator family for `payload` keys + a `state` enum filter. One filter shape across the SDK.

---

## Permission

One new entry in `src/core/plugin-sdk/capabilities.ts`:

```ts
{
  permission: 'cms.queue',
  label: 'Register background-job queues',
  description: 'Allows the plugin to define queues, enqueue jobs with payloads, and consume jobs with retries, exponential backoff, checkpointing, and a dead-letter state. Each attempt runs inside the QuickJS sandbox with a wall-clock budget the plugin declares (default 60s, host-capped at 60 min). Distinct from cms.schedule (which is cadence-driven, 5-min capped, no payload).',
  risk: 'high',
  surfaces: ['server'],
}
```

Added to `PLUGIN_PERMISSION_VALUES` in `src/core/plugin-sdk/types/permissions.ts` and the `permissions` alias map in `src/core/plugin-sdk/builders/permissions.ts` (as `cmsQueue`).

---

## Schema

Two new tables. Same migration id in both `server/db/migrations-pg.ts` and `server/db/migrations-sqlite.ts` (gated by `migration-parity.test.ts`).

```sql
-- ─── plugin_queues — one row per (plugin_id, queue_name) ─────────────────
create table if not exists plugin_queues (
  plugin_id text not null references installed_plugins(id) on delete cascade,
  queue_name text not null,
  concurrency integer not null default 1,
  max_attempts integer not null default 5,
  backoff_json jsonb not null,                 -- { kind, baseMs?, maxMs?, jitter?, delayMs? }
  per_job_max_duration_ms integer not null default 60000,
  history_retention_json jsonb not null,        -- { mode, keep? / days? }
  enabled boolean not null default true,
  paused_reason text,                           -- non-null when admin paused
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (plugin_id, queue_name)
);

-- ─── plugin_jobs — one row per enqueued job ──────────────────────────────
create table if not exists plugin_jobs (
  id text primary key,                          -- nanoid
  plugin_id text not null references installed_plugins(id) on delete cascade,
  queue_name text not null,
  state text not null,                          -- pending|running|succeeded|failed|cancelled|dead
  attempt integer not null default 0,
  max_attempts integer not null,
  priority integer not null default 50,
  payload_json jsonb not null,
  checkpoint_json jsonb,                        -- handler-set, persisted at each checkpoint
  result_json jsonb,                            -- populated on success
  progress real not null default 0,             -- 0..1
  progress_message text,
  last_error text,
  enqueued_at timestamptz not null,
  run_after timestamptz not null,               -- next attempt time
  started_at timestamptz,
  finished_at timestamptz,
  running_token text,                           -- claim token, mirrors plugin_schedules
  lock_until timestamptz,                       -- claim auto-expiry
  unique_key text,                              -- enqueue-time dedupe
  updated_at timestamptz not null default now()
);

create index if not exists plugin_jobs_dispatch_idx
  on plugin_jobs (plugin_id, queue_name, state, run_after);

create index if not exists plugin_jobs_state_idx
  on plugin_jobs (state, run_after);

-- Partial unique index — re-enqueueing while a job is pending or running
-- with the same unique_key is a no-op (the enqueue handler does a
-- pre-flight SELECT under the same predicate).
create unique index if not exists plugin_jobs_unique_active_idx
  on plugin_jobs (plugin_id, queue_name, unique_key)
  where unique_key is not null and state in ('pending', 'running');
```

`*_json` column naming is required by the SQLite adapter's auto-parse convention (gated by `db-json-column-naming.test.ts`). The partial unique index is supported in both Postgres and SQLite (3.8+) — the `where` clause syntax is identical.

---

## Host wiring

### New RPC targets

Added to `server/plugins/protocol/targets.ts`'s `ALLOWED_API_TARGETS`:

```
cms.queue.declare        Plugin announces a queue + its static config (define-time)
cms.queue.enqueue        Plugin pushes a job
cms.queue.cancel         Plugin cancels a job
cms.queue.status         Plugin reads job state
cms.queue.list           Plugin lists jobs
cms.queue.requeue        Plugin requeues a DLQ job
cms.queue.checkpoint     Handler-side: persist state + reset budget mid-job
cms.queue.progress       Handler-side: update progress %, message
```

`cms.queue.checkpoint` and `cms.queue.progress` are reachable only during handler execution — the host validates `running_token` matches the in-flight dispatch's token before applying. Other targets call from any plugin context. The architecture test `plugin-sandbox-invariants.test.ts` locks the new list.

### Handler dispatcher

`server/plugins/host/handlers/queue.ts` (new). Per-target functions mirror the schedule handler pattern (`handlers/schedule.ts`). Each calls `assertHostPluginPermission(entry, 'cms.queue')` and delegates to a new repository file `server/repositories/pluginJobs.ts`. `apiDispatch.ts` gets 8 new case statements.

### The tick loop

`server/plugins/queueScheduler.ts` (new — keeping schedules and queues in separate files since they have different selection predicates):

```ts
const QUEUE_TICK_INTERVAL_MS = 1_000      // 10x faster than scheduler (10s)
const QUEUE_TICK_BATCH_LIMIT = 100
const QUEUE_HISTORY_TRIM_INTERVAL_MS = 5 * 60 * 1000

export function startQueueDispatcher(db: DbClient): void {
  if (queueTimer !== null) return
  queueTimer = setInterval(() => {
    void tickQueueDispatcher(db).catch((err) => {
      console.error('[plugin-queue] tick failed:', err)
    })
  }, QUEUE_TICK_INTERVAL_MS)
}

export async function tickQueueDispatcher(db: DbClient): Promise<void> {
  const leader = await tryAcquireQueueLeader(db)       // separate advisory lock from the scheduler
  if (!leader) return
  try {
    const claimable = await selectDueJobsWithConcurrencyCap(db, new Date().toISOString(), QUEUE_TICK_BATCH_LIMIT)
    for (const job of claimable) {
      await dispatchOneJob(db, job)
    }
    if (Date.now() - lastJobHistoryTrimAt > QUEUE_HISTORY_TRIM_INTERVAL_MS) {
      lastJobHistoryTrimAt = Date.now()
      await trimJobHistory(db).catch((err) => console.error('[plugin-queue] history trim failed:', err))
    }
  } finally {
    await releaseLeader(db, leader)
  }
}
```

`selectDueJobsWithConcurrencyCap` is the only query that's meaningfully different from the scheduler's `selectDueSchedules`:

```ts
// server/repositories/pluginJobs.ts (excerpt)
//
// For each queue, return at most (concurrency - currently_running) pending jobs
// whose run_after <= now, ordered by (priority desc, enqueued_at asc).
//
// Dialect-naive SQL — no DISTINCT ON, no window functions. Two-step approach:
//   1) Read every queue's (concurrency, currently_running) counts.
//   2) For each queue, read its allotment of pending jobs.
//
// At <50 active queues per host this is ~50 small reads per tick — well within
// the 1s tick budget. If we ever hit hundreds of queues we can introduce a
// CTE / lateral, but premature optimisation is wrong here.
export async function selectDueJobsWithConcurrencyCap(
  db: DbClient,
  nowIso: string,
  totalBatchLimit: number,
): Promise<PluginJob[]> { /* ... */ }
```

This is the part where the scheduler-pattern needs new code. Everything else (claim, fire, record outcome, advance state) maps 1-to-1.

### Firing one job

```ts
async function dispatchOneJob(db: DbClient, job: PluginJob): Promise<void> {
  const token = nanoid()
  const lockUntilIso = new Date(Date.now() + job.perJobMaxDurationMs * 2).toISOString()
  const claimed = await tryClaimJob(db, job.id, token, lockUntilIso)
  if (!claimed) return

  // Pre-flight: bump attempt + record start.
  await markJobRunning(db, job.id, { attempt: job.attempt + 1, startedAtIso: new Date().toISOString() })

  let outcome: { status: 'ok' | 'error' | 'cancelled' | 'timeout'
                 error?: string; result?: unknown; durationMs: number }
  try {
    const result = await runQueueJobInWorker({
      pluginId: job.pluginId,
      jobId: job.id,
      perJobMaxDurationMs: job.perJobMaxDurationMs,
    })
    outcome = { status: result.status, error: result.error, result: result.result, durationMs: result.durationMs }
  } catch (err) {
    outcome = { status: 'error', error: err instanceof Error ? err.message : String(err), durationMs: 0 }
  }

  await recordJobOutcome(db, job, token, outcome)
}
```

`recordJobOutcome` is the one place that distinguishes from the scheduler:

```ts
function recordJobOutcome(db, job, token, outcome) {
  if (outcome.status === 'ok') {
    return setJobSucceeded(db, job.id, token, outcome.result, finishedIso)
  }
  if (outcome.status === 'cancelled') {
    return setJobCancelled(db, job.id, token, finishedIso)
  }
  // 'error' or 'timeout' — increment attempt; compute backoff; either retry or DLQ.
  const nextAttempt = job.attempt + 1
  if (nextAttempt >= job.maxAttempts) {
    return setJobDead(db, job.id, token, outcome.error, finishedIso)
  }
  const delayMs = computeBackoff(job.backoff, nextAttempt)
  const nextRunAt = new Date(Date.now() + delayMs).toISOString()
  return setJobPendingForRetry(db, job.id, token, outcome.error, nextRunAt, finishedIso)
}
```

### `runQueueJobInWorker`

In `server/plugins/host/rpc.ts`:

```ts
export async function runQueueJobInWorker(args: {
  pluginId: string
  jobId: string
  perJobMaxDurationMs: number
}): Promise<{ status: 'ok' | 'error' | 'timeout' | 'cancelled'; error?: string; result?: unknown; durationMs: number }> {
  const result = await requestFromWorker(
    args.pluginId,
    { kind: 'run-queue-job', correlationId: nanoid(), pluginId: args.pluginId, jobId: args.jobId,
      perJobMaxDurationMs: args.perJobMaxDurationMs },
    'queue-job-result',
  )
  return result
}
```

New `RunQueueJobRequest` + `QueueJobResult` message kinds added to `server/plugins/protocol/messages.ts` mirroring the schedule shapes.

---

## VM bootstrap changes

In `server/plugins/quickjs/bootstrap/api.ts`, the existing `cms.schedule` block gets a sibling `cms.queue` block. The `__runQueueJob(jobId)` runner mirrors `__runSchedule` but threads payload + ctx + abort.

```js
// New runner — invoked by the host via vm.runQueueJob(jobId, perJobMaxDurationMs).
globalThis.__runQueueJob = async function __runQueueJob(jobId) {
  const job = globalThis.__queue_dispatching && globalThis.__queue_dispatching[jobId];
  if (!job) {
    __log('warn', 'no handler dispatch context for job "' + jobId + '"');
    return JSON.stringify({ status: 'error', error: 'dispatch-context-missing', durationMs: 0 });
  }
  const handler = globalThis.__plugin_handlers.queues[job.queueName];
  if (typeof handler !== 'function') {
    return JSON.stringify({ status: 'error', error: 'handler-not-registered', durationMs: 0 });
  }
  const controller = new AbortController();
  globalThis.__queue_abort_controllers[jobId] = controller;
  const startedAtMs = Date.now();
  try {
    const result = await handler(
      { id: jobId, payload: job.payload, attempt: job.attempt, checkpointState: job.checkpointState,
        enqueuedAt: job.enqueuedAt },
      {
        progress: async function (fraction, message) {
          await __hostCall('cms.queue.progress', [{ jobId: jobId, fraction: Number(fraction), message: message ?? null }]);
        },
        checkpoint: async function (state) {
          await __hostCall('cms.queue.checkpoint', [{ jobId: jobId, state: state }]);
          // The host has reset our wall-clock budget — eval continues under the new deadline.
        },
        signal: controller.signal,
      },
    );
    return JSON.stringify({ status: 'ok', result: result ?? null, durationMs: Date.now() - startedAtMs });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return JSON.stringify({ status: 'cancelled', error: err.message, durationMs: Date.now() - startedAtMs });
    }
    return JSON.stringify({ status: 'error', error: String(err && err.message || err),
                            durationMs: Date.now() - startedAtMs });
  } finally {
    delete globalThis.__queue_abort_controllers[jobId];
  }
};

// Define-time API — collected in __plugin_handlers.queues, declared to host.
function defineQueue(queueName, config) {
  assertPermission('cms.queue');
  if (typeof config.handler !== 'function') throw new TypeError("define: 'handler' is required");
  globalThis.__plugin_handlers.queues[String(queueName)] = config.handler;
  return call('cms.queue.declare', [{
    queueName: String(queueName),
    concurrency: Math.min(Math.max(1, Number(config.concurrency || 1)), 16),
    maxAttempts: Math.min(Math.max(1, Number(config.maxAttempts || 5)), 20),
    backoff: normalizeBackoff(config.backoff),
    perJobMaxDurationMs: clampDuration(config.perJobMaxDurationMs, 60_000, 60 * 60 * 1000),
    historyRetention: normalizeRetention(config.historyRetention),
  }]);
}

// Enqueue, cancel, status, list, requeue — thin host-call wrappers
// gated by assertPermission('cms.queue'). Each marshals its args + returns the host reply.
function enqueueJob(queueName, options) { /* ... */ }
// ... etc.

const queueApi = {
  define: defineQueue,
  enqueue: enqueueJob,
  cancel: cancelJob,
  status: jobStatus,
  list: listJobs,
  requeue: requeueJob,
};
```

The dispatch-context wiring is handled in `pluginWorker.ts`:

```ts
// server/plugins/pluginWorker.ts (new handler)
async function handleRunQueueJob(msg: RunQueueJobRequest): Promise<void> {
  const vm = vmsByPluginId.get(msg.pluginId)
  if (!vm) { /* send error */ return }
  const job = await fetchJobDispatchContext(msg.pluginId, msg.jobId)  // host-side; reads plugin_jobs by id
  try {
    await vm.setQueueDispatchContext(msg.jobId, job)
    const resultJson = await vm.runQueueJob(msg.jobId, msg.perJobMaxDurationMs)
    const parsed = JSON.parse(resultJson) as QueueJobOutcome
    send({ kind: 'queue-job-result', correlationId: msg.correlationId, ok: true, ...parsed })
  } catch (err) {
    send({ kind: 'queue-job-result', correlationId: msg.correlationId, ok: false,
           status: 'error', error: err instanceof Error ? err.message : String(err), durationMs: 0 })
  } finally {
    await vm.clearQueueDispatchContext(msg.jobId)
  }
}
```

`vm.runQueueJob` evaluates `__runQueueJob(jobId)` under `withDeadline(ctx, perJobMaxDurationMs)`. Each `checkpoint` host-call calls back into the worker via the existing api-call pump, the host writes `checkpoint_json + lock_until = now + perJobMaxDurationMs`, and the bootstrap's `checkpoint` await resolves — control returns to the handler with the deadline implicitly reset by the host writing a new `lock_until`. The VM eval loop continues naturally; no explicit deadline reset call is needed because the eval is still under the original `withDeadline(ctx, perJobMaxDurationMs)` call — the deadline is a budget for THIS attempt, NOT a per-checkpoint timer. Long-running handlers that checkpoint every ~10 s stay well under the per-attempt budget.

For handlers genuinely longer than `perJobMaxDurationMs` (an hours-long indexer), the handler **must** call `checkpoint` and **then return** at each chunk boundary — the host re-enqueues the same job with `attempt = attempt` (NOT bumped, since the chunk completed normally), reading `checkpointState` to resume. This is the chunked-execution pattern; the queue makes it cheap.

---

## Worked examples

### 9.1 Newsletter — broadcast send per-recipient

```ts
// examples/plugins/newsletter/server/queue.ts (new — replaces big chunks of broadcasts.ts)
export function registerQueues(api: ServerPluginApi) {
  api.cms.queue.define('broadcast-email', {
    concurrency: 10,
    maxAttempts: 5,
    backoff: { kind: 'exponential', baseMs: 2000, maxMs: 60_000, jitter: 0.2 },
    perJobMaxDurationMs: 30_000,

    handler: async ({ payload }, { signal }) => {
      const { broadcastId, subscriberId } = payload as { broadcastId: string; subscriberId: string }
      if (signal.aborted) throw new Error('aborted')

      const broadcast = await getBroadcast(api, broadcastId)
      const sub = await getSubscriber(api, subscriberId)
      const rendered = renderBroadcastEmail(broadcast, sub)

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${api.cms.settings.get('resendApiKey')}`,
                   'content-type': 'application/json' },
        body: JSON.stringify(rendered),
        signal,
      })
      if (res.status === 429) {
        // Resend rate-limit. Throw with a typed message — the queue's
        // exponential backoff handles the next retry.
        throw new Error('resend-rate-limited')
      }
      if (!res.ok) {
        throw new Error(`resend-${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const data = await res.json() as { id: string }
      return { resendId: data.id, sentAt: new Date().toISOString() }
    },
  })
}

// Replaces the loop in executeSend(...):
async function executeSend(broadcastId, api) {
  const broadcast = await getBroadcast(api, broadcastId)
  const targets = await listTargetSubscribers(api, broadcast)
  await broadcasts.update(broadcastId, { status: 'sending', targetCount: targets.length })
  for (const sub of targets) {
    await api.cms.queue.enqueue('broadcast-email', {
      payload: { broadcastId, subscriberId: sub.id },
      uniqueKey: `${broadcastId}:${sub.id}`,        // safe to re-call this whole function
      priority: 70,
    })
  }
  return { ok: true, queued: targets.length }
}
```

50k recipients = 50k jobs queued instantly. Concurrency 10 means 10 in flight at once. Per-job timeout 30 s. Rate-limit (429) → exponential backoff. Permanent fail (4xx other than 429) → 5 attempts then DLQ. Admin's Plugins page shows "Newsletter: broadcast-email queue: 43,212 pending, 10 running, 6,728 succeeded, 50 dead." Zero hand-rolled retry code.

### 9.2 Embeddings indexer — checkpointed long job

```ts
api.cms.queue.define('rebuild-embeddings', {
  concurrency: 1,
  maxAttempts: 3,
  perJobMaxDurationMs: 60 * 60 * 1000,    // 60 min per attempt
  handler: async ({ payload, checkpointState }, { progress, checkpoint, signal }) => {
    const pageIds = (payload as { pageIds: string[] }).pageIds
    const startIdx = (checkpointState as { idx?: number } | null)?.idx ?? 0

    for (let i = startIdx; i < pageIds.length; i++) {
      if (signal.aborted) throw new Error('aborted')
      const page = await api.cms.content.table('pages').get(pageIds[i])
      const embedding = await embedPage(page)
      await storeEmbedding(api, pageIds[i], embedding)

      if (i % 50 === 49) {
        await progress(i / pageIds.length, `Indexed ${i + 1} / ${pageIds.length} pages`)
        await checkpoint({ idx: i + 1 })
      }
    }
    return { indexed: pageIds.length }
  },
})

// Trigger:
api.cms.queue.enqueue('rebuild-embeddings', {
  payload: { pageIds: allPageIds },
  uniqueKey: 'rebuild-embeddings:singleton',     // one rebuild at a time
})
```

If the worker crashes at index 7,432 of 10,000, the next attempt reads `checkpointState = { idx: 7432 }` and resumes from there. The progress bar shows continuous progress to the operator.

### 9.3 Importer — bulk-enqueue with per-row retries

Pairs naturally with the A.2 plan (`api.cms.content.*`):

```ts
api.cms.routes.post('/import-wp', 'plugins.configure', async (ctx) => {
  const { wxr } = await ctx.req.json()
  const posts = parseWxr(wxr)
  let queued = 0
  for (const p of posts) {
    await api.cms.queue.enqueue('import-post', {
      payload: { post: p },
      uniqueKey: `wp:${p.guid}`,
    })
    queued++
  }
  return { ok: true, queued }
})

api.cms.queue.define('import-post', {
  concurrency: 4,
  maxAttempts: 3,
  handler: async ({ payload }) => {
    const p = (payload as { post: WxrPost }).post
    await api.cms.content.table('posts').create({
      slug: p.slug,
      cells: { title: p.title, body: htmlToNodeTree(p.body), publishedAt: p.date },
    })
  },
})
```

10k posts: 10k jobs. Concurrency 4. Any individual post that fails (e.g. malformed HTML) retries 3× then lands in DLQ — the other 9,999 keep moving. Admin sees an import-post DLQ with 12 rows; clicks "Requeue" on each after a fix.

---

## Rollout plan — one change set

1. **Migration.** Add the two tables to `migrations-pg.ts` and `migrations-sqlite.ts` with id `004_plugin_queues` (next sequential after `003_page_version_snapshot`). Identical IDs in both files; gated by `migration-parity.test.ts`.
2. **Repository.** `server/repositories/pluginJobs.ts` and `server/repositories/pluginQueues.ts` (new). Mirror the shape of `pluginSchedules.ts` — same dialect-naive style, same mapping helpers. Plus the queue-history trim function.
3. **Backoff math.** New pure function `computeBackoff(policy, attempt)` in `server/plugins/backoff.ts`. Pure; unit-testable.
4. **Tick loop.** `server/plugins/queueScheduler.ts` (new). Reuses `tryAcquireLeader / releaseLeader` from `scheduler.ts` but with a different advisory-lock key so the queue dispatcher and schedule tick are decoupled. Called from `runtime.ts:activateInstalledServerPlugins` alongside `startScheduler`.
5. **RPC targets.** Add 8 new targets to `ALLOWED_API_TARGETS` in `server/plugins/protocol/targets.ts`. Lock in `plugin-sandbox-invariants.test.ts`.
6. **Protocol schemas.** Add `RunQueueJobRequest` / `QueueJobResult` to `server/plugins/protocol/messages.ts`. Add TypeBox schemas to `server/plugins/protocol/schemas/queue.ts` for the 8 new API-call args.
7. **Host handlers.** `server/plugins/host/handlers/queue.ts` (new). One function per target. Wire into `server/plugins/host/apiDispatch.ts`.
8. **VM bootstrap.** Append the `cms.queue` block to `server/plugins/quickjs/bootstrap/api.ts`. Add `__runQueueJob`, `__queue_dispatching`, `__queue_abort_controllers` plus the `defineQueue / enqueueJob / cancelJob / jobStatus / listJobs / requeueJob` helpers. Add `vm.setQueueDispatchContext` / `vm.clearQueueDispatchContext` / `vm.runQueueJob` to `server/plugins/quickjs/vm.ts`.
9. **Worker dispatch.** `pluginWorker.ts` gets a `handleRunQueueJob` handler. The host's `recordJobOutcome` either bumps `attempt + run_after` (retry) or sets `state='dead'` (DLQ).
10. **SDK types.** New `src/core/plugin-sdk/types/queue.ts` with `QueueDefinition`, `JobStatus`, `JobStatusSchema`, `ListJobsOptions`. Export from the SDK barrel.
11. **Permission.** Add `cms.queue` to `PLUGIN_PERMISSION_VALUES`, `PLUGIN_CAPABILITIES`, and the `permissions` alias.
12. **Newsletter migration.** Replace the relevant chunks of `examples/plugins/newsletter/server/broadcasts.ts` with the per-recipient queue handler (§9.1). The 5-min scheduled "send-scheduled" loop stays — but it `enqueue`s into the new queue instead of calling `executeSend(broadcastId, ...)` directly. Update the manifest's `permissions` to include `cms.queue`.
13. **Crash-recovery wiring.** When `crashRecovery.ts` tears down a worker, every job whose `lock_until > now` and whose `running_token` was minted by that worker is released. The host writes a single SQL UPDATE: `update plugin_jobs set state='pending', running_token=null, lock_until=null where plugin_id=$1 and state='running'`. Next tick re-fires.
14. **Admin UI.** A "Queues" tab under each plugin's row on the Plugins page. Shows the queue's concurrency, pending/running/dead counts, recent jobs with progress bars, "Requeue" + "Cancel" buttons per job, "Pause queue" button at the queue level. Mostly host UI work; the data already comes from the repository. (Sketch only — full admin design is a follow-up issue, but `cms.queue.status` + `.list` make the data trivially available.)
15. **Docs.** Update `docs/features/plugin-system.md` (new permission, new surface, cookbook entry). Add a "Choosing schedule vs queue" subsection clarifying the trade-off. Update the newsletter plugin's README.
16. **CLI.** `bun pb-plugin init --kind=background-worker` scaffold pre-declares `cms.queue` + a simple `define`/`enqueue` example.

One PR. `bun test && bun run build && bun run lint` must pass.

---

## Gate tests

| Test | Change |
|---|---|
| `plugin-sandbox-invariants.test.ts` | Lock the new `ALLOWED_API_TARGETS` (8 added). |
| `plugin-schedule-invariants.test.ts` | Renamed → `plugin-cadence-invariants.test.ts` to cover both schedules and queues (claim-then-fire-then-record contract is shared). Existing assertions stay verbatim; new assertions cover the queue tick. |
| `migration-parity.test.ts` | Picks up `004_plugin_queues` automatically. |
| `db-postgres-isms.test.ts` | Existing — applies to `pluginJobs.ts` and `pluginQueues.ts` for free. |
| `db-json-column-naming.test.ts` | Existing — gates `payload_json`, `checkpoint_json`, `result_json`, `backoff_json`, `history_retention_json`. |
| New: `plugin-queue-dedupe.test.ts` | Enqueueing twice with the same `uniqueKey` while a job is pending → returns the same id, only one row in `plugin_jobs`. |
| New: `plugin-queue-backoff.test.ts` | `computeBackoff` produces the expected sequence for each policy; jitter is bounded by the declared fraction. |
| New: `plugin-queue-checkpoint-reset.test.ts` | A handler that calls `checkpoint()` mid-execution gets `lock_until` extended; the next tick does not re-claim the still-running job. |
| New: `plugin-queue-dlq.test.ts` | After `maxAttempts` failures, the job is `state='dead'`; the queue stays enabled; siblings keep dispatching. |
| New: `plugin-queue-concurrency-cap.test.ts` | Concurrency=2; 100 jobs queued; never more than 2 in `state='running'` per queue at any one time. |

---

## Deferred questions

These do not block the change.

1. **Cron-style cadence on enqueue.** Today `cms.schedule` handles cadence; `cms.queue.enqueue(..., { delayMs })` handles a one-shot future fire. If a plugin wants "enqueue this same job daily at 09:00 UTC" it can do that via a schedule that calls enqueue. The composition is explicit. A future `enqueueRecurring(...)` builder is reasonable but not in v1.
2. **Per-job memory cap.** Queues do not raise the 64 MB VM ceiling. A handler that needs more memory either chunks (via checkpoint) or fails. Memory cap is its own plan.
3. **Multi-host scale-out within a queue.** Per-queue concurrency is enforced across the cluster via SQL — the host's `SELECT count(*) WHERE state='running'` is global. Two HA hosts each running 10 concurrent jobs of a `concurrency: 16` queue will respect the cap (the second host's claim attempts fail when the count is already 16). Tested via `plugin-queue-concurrency-cap.test.ts` with a simulated two-leader race.
4. **Visibility timeouts vs `lock_until`.** Today `lock_until = now + perJobMaxDurationMs * 2`. If the worker hangs, the claim expires and the next tick re-fires — but with `attempt + 1` because the host didn't get to record success. This is the standard "at-least-once delivery" semantics every queue gives. Plugins handle it via idempotency keys (using `uniqueKey` for enqueue-side dedupe + their own idempotent handler logic).
5. **Job result retention.** Successful job rows stay in `plugin_jobs` with `state='succeeded'` and `result_json` populated for `historyRetention` time. After that the row is hard-deleted. The plugin can read its own succeeded results during the retention window via `.status(jobId)` — useful for "did this email actually send?" lookups from the admin.
6. **Per-job observability.** Each `progress()` call writes to `plugin_jobs.progress + progress_message`. The admin's Queues tab polls every 2s. No event-bus push needed in v1 — the SSE plan (separate) can wire this up later for live updates.
7. **Why not `bullmq` / `pg-boss` / external queue?** Both would require adding a runtime dependency, neither runs cleanly inside the QuickJS sandbox (handlers must marshal across the worker boundary anyway), and both miss the per-job VM-deadline reset that `checkpoint()` provides. The scheduler pattern proves a small in-tree implementation works and matches the dialect-naive rules.
8. **Per-plugin total job budget.** No cap in v1. A misbehaving plugin can enqueue millions of jobs and consume disk. Future: a per-plugin `installed_plugins.max_pending_jobs` limit enforced at enqueue time; the queue tick refuses new enqueues past the cap and surfaces it on the admin.

---

## Related

- `docs/features/plugin-system.md` — feature doc that gains a new permission row + cookbook entry when this ships
- `docs/plans/2026-05-30-plugin-cms-content-access.md` — sibling plan; `api.cms.queue` composes naturally with `api.cms.content` (see §9.3)
- `docs/plans/2026-05-30-plugin-binary-streaming-io.md` — sibling plan; queue handlers can return a streaming response indirectly (queue a job; the admin polls; the job's `result_json` carries the final state) but the queue itself doesn't stream
- `CLAUDE.md` — the agent rule book; the "scheduled jobs" section gets a sibling "background queues" paragraph
- Source-of-truth files (existing, modified or referenced):
  - `server/plugins/scheduler.ts` — the template
  - `server/repositories/pluginSchedules.ts` — pattern for the new `pluginJobs.ts` / `pluginQueues.ts`
  - `server/plugins/host/rpc.ts` — `runScheduleInWorker` precedent
  - `server/plugins/host/apiDispatch.ts` — RPC dispatcher
  - `server/plugins/host/handlers/schedule.ts` — handler pattern
  - `server/plugins/protocol/messages.ts` — wire types
  - `server/plugins/protocol/targets.ts` — `ALLOWED_API_TARGETS`
  - `server/plugins/quickjs/bootstrap/api.ts` — VM-side `cms.schedule` block being mirrored
  - `server/plugins/quickjs/vm.ts` — `runSchedule` precedent
  - `server/plugins/quickjs/eval.ts` — `withDeadline` reused
  - `server/plugins/quickjs/bootstrap/polyfills.ts:229-331` — `AbortController` reused
  - `server/db/migrations-pg.ts` + `migrations-sqlite.ts` — where `004_plugin_queues` lands
  - `examples/plugins/newsletter/server/broadcasts.ts` — the migration target + canonical existing pain
- Gate tests:
  - `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`
  - `src/__tests__/architecture/plugin-schedule-invariants.test.ts` → renamed `plugin-cadence-invariants.test.ts`
  - `src/__tests__/architecture/migration-parity.test.ts`
  - `src/__tests__/architecture/db-postgres-isms.test.ts`
  - `src/__tests__/architecture/db-json-column-naming.test.ts`
