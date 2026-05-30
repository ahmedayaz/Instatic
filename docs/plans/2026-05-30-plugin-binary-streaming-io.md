# Plugin binary and streaming I/O

A plan to make plugin route handlers, the gated outbound `fetch`, and the host bridge binary-clean and stream-capable — so plugins can verify raw-body webhook signatures, accept file uploads, stream AI / LLM responses to admin users via SSE, and integrate with binary protocols (PDF generation, image processing, protobuf services).

This is a plan, not a doc. It describes work that has not been built. When it ships, the lasting parts move into `docs/features/plugin-system.md`; this file is deleted.

---

## TL;DR

- **The gap.** Today's route + fetch bridge is text-only. `SerializedRequest.body` and `SerializedResponse.body` are typed `string`; `performGatedFetch` calls `response.text()`; the VM-side `fetch` shim reconstructs `arrayBuffer()` via `result.body.charCodeAt(i) & 0xff`, which is **lossy** for any non-ASCII bytes. Plugins cannot verify raw-body signatures, cannot accept binary uploads, cannot pipe binary fetch responses, and cannot stream anything.
- **The fix is a tagged-union over the wire.** `SerializedRequest.body` and `SerializedResponse.body` become `BinarySafeBody`: `{ kind: 'text'; text } | { kind: 'binary'; bytesBase64 } | { kind: 'stream'; streamId }`. Plugins opt into binary via `ctx.req.bytes()` and `responseType: 'binary'` on `fetch(...)`; the default text path stays a one-byte-clean string for back-compat-shaped JSON bodies.
- **Streaming for routes: server-sent events first.** Plugin route handlers can return `respond.stream(asyncIterable, { type: 'event-stream' | 'octet-stream' | 'text/html' })`. The host materialises a `ReadableStream` from the worker. SSE is the priority — that's what LLM streaming, live analytics, and job progress all need.
- **Streaming for fetch.** Outbound `fetch` exposes `res.body` as a `ReadableStream` when the plugin requests it (`responseType: 'stream'`). The host streams upstream → VM in 256 KB base64 chunks (same chunk size as the existing media `readStream` design).
- **Three deadline modes**, decoupled from the current 5 s eval ceiling. Routes and fetches stay at 5 s for their *initial* call. The new `respond.stream(...)` and `responseType: 'stream'` modes shift the budget to a configurable `streamMaxDurationMs` (default 60 s, host-capped at 5 min) and per-chunk idle deadline (default 30 s), with the worker keeping the VM alive between chunks via the existing `__hostSleep` pump.
- **WebSockets are out of scope** for this plan. SSE covers the AI-streaming / progress-streaming / live-feed use cases at one tenth the protocol cost. True bidirectional is a separate plan.
- **The crypto bridge proves the pattern.** Base64 already crosses the VM↔host boundary today for `crypto.digest` / `crypto.signHmac`. The same wire format is reused; only the call sites grow.
- **One PR.** Protocol type changes + host bridge updates + VM bootstrap + bootstrap of `respond` helper + corrected `arrayBuffer()` + new RPC targets for streaming. In-repo plugins (analytics, forms-builder) gain nothing; they're already text-clean.

---

## Why this is a plan

Three concrete failures in the current code.

### 1. The fetch shim corrupts binary responses

The VM-side `fetch` polyfill in `server/plugins/quickjs/bootstrap/fetch.ts:38-43`:

```js
arrayBuffer: async function () {
  const buf = new Uint8Array(result.body.length);
  for (let i = 0; i < result.body.length; i++)
    buf[i] = result.body.charCodeAt(i) & 0xff;
  return buf.buffer;
},
```

`result.body` arrives as a UTF-8-decoded string (`server/plugins/host/network.ts:84` — `const body = await response.text()`). Worked examples of what this means:

| Upstream bytes | After `text()` decode | After `charCodeAt(i) & 0xff` |
|---|---|---|
| `0x41` (`'A'`) | `"A"` (U+0041) | `0x41` ✓ |
| `0xC3 0xA9` (UTF-8 `é`) | `"é"` (one code unit U+00E9) | `0xE9` — **one byte**, original was **two** ✗ |
| `0xFF` (invalid UTF-8) | U+FFFD replacement | `0xFD` ✗ |
| `0xE2 0x82 0xAC` (UTF-8 `€`) | `"€"` (U+20AC) | `0xAC` — one byte, original was three ✗ |
| Any random 1 MB PNG | mostly U+FFFD garbage | mostly `0xFD` ✗ |

A plugin that does `const png = await (await fetch('https://example.com/icon.png')).arrayBuffer()` gets garbage and cannot recover. The same failure mode applies to any binary upstream (`application/octet-stream`, `image/*`, `application/pdf`, `application/protobuf`).

### 2. Route bodies are text-typed and stripped at the host

`SerializedRequest.body: string` in `server/plugins/protocol/messages.ts:22`. The host's runtime forwarder at `server/plugins/host/rpc.ts:190`:

```ts
const bodyText = args.method !== 'GET' ? await args.request.text() : ''
```

Three things this breaks:

- **Stripe-style webhook signature verification.** Stripe's webhook signature is computed over the **raw request body**, byte-for-byte. JSON is ASCII so the round-trip via `text()` is lossless *today*, but it is brittle: any future webhook provider that signs over UTF-8 with surrogate pairs, BOM, or any non-canonicalised whitespace would break silently. The plugin has no way to reach the actual upstream bytes.
- **Plugins receiving binary uploads.** A plugin route that accepts a PDF upload (`POST /admin/api/cms/plugins/acme.invoices/runtime/upload`) gets a mangled body if the client posts `Content-Type: application/pdf`.
- **Plugins receiving protobuf.** Same as above for `application/x-protobuf`.

Multipart is handled today by re-parsing `bodyText` into a fake `Request` (`rpc.ts:217-242`) — file parts become `File` objects but their bytes are still sourced from the UTF-8-decoded string. Text-only files survive; binary files do not.

### 3. There is no way to stream

`RouteResult.response` is a single `SerializedResponse` value (`messages.ts:265`). The plugin handler returns once and the worker posts one message back. A plugin trying to stream an LLM response back to the admin UI has two options today, both bad:

- **Buffer the whole response** in memory and return it as a single string — only works for short responses and blocks for the full duration. LLM responses commonly take 10–60 s and exceed the 5 s eval ceiling.
- **Use polling.** Plugin route returns immediately, kicks off a background fetch, writes deltas into `cms.storage`. Admin UI polls `/runtime/poll`. Two HTTP round-trips per token, terrible.

Same gap on the outbound side: `performGatedFetch` awaits `response.text()` — there is no chunk-by-chunk read of an upstream SSE stream from an LLM provider.

### What we leverage

| Concern | Lives in | Already does |
|---|---|---|
| Base64 wire format across the QuickJS bridge | `server/plugins/host/network.ts:103-128` (`bytesToBase64`, `base64ToFreshArrayBuffer`) + `server/plugins/quickjs/bootstrap/crypto.ts:30-106` (VM-side codec) | Battle-tested for `crypto.digest` / `crypto.signHmac`. Reused unchanged. |
| Structured-clone host↔worker transport | `Bun.Worker.postMessage` in `server/plugins/host/workerPool.ts:47` | `Uint8Array` / `ArrayBuffer` already survive the host↔worker boundary losslessly. The protocol just doesn't type them. |
| AbortController + AbortSignal in the VM | `server/plugins/quickjs/bootstrap/polyfills.ts:229-331` + `bootstrap/fetch.ts:78-95` | Plugin code threads `AbortSignal` into `fetch(...)`; firing aborts both the in-VM promise and the upstream host fetch. Stream cancellation reuses this. |
| In-flight outbound fetch registry | `HostPluginRecord.inflightFetches: Map<string, AbortController>` | Each in-flight has a controller the host can cancel. Streams piggyback. |
| Chunked-base64 binary transport over the VM bridge | `MediaStorageAdapter.readStream`'s 256 KB chunk-size policy (`src/core/plugin-sdk/types/media.ts:177-179`) | The contract is already established: bytes cross the VM in ≤256 KB base64 chunks. The new stream RPC uses the same chunk size. |
| `__hostSleep` pump for wall-clock waits | `server/plugins/quickjs/bootstrap/timers.ts:10-53` | Streaming chunks are delivered as a sequence of resolved promises — same pump used for `setTimeout`. |
| Deadline interrupt | `server/plugins/quickjs/eval.ts:21-27` (`withDeadline`) | Already supports per-call timeouts (currently used to give scheduled jobs a higher budget). Streaming reuses the same primitive with a different default + per-chunk idle reset. |

The Bun host, the worker IPC layer, the QuickJS deadline, and the abort surface already do everything required. The plan adds three things: typed binary on the wire, a streaming response variant on the wire, and the corresponding ergonomic helpers in the SDK.

---

## Goals and non-goals

### Goals

- **Binary route bodies in.** `ctx.req.bytes(): Promise<Uint8Array>` returns the raw upstream bytes losslessly. `ctx.req.text()` and `ctx.req.json()` remain available for the ASCII / JSON cases.
- **Binary route bodies out.** Plugin returns `respond.bytes(uint8array, { status, headers })` for a single-shot binary response.
- **Streaming route bodies out.** Plugin returns `respond.stream(asyncIterable, { type, status, headers })` for SSE / chunked HTML / chunked octet-stream.
- **Binary fetch responses in.** `await res.bytes()` returns lossless `Uint8Array`; `await res.arrayBuffer()` is **fixed** to be lossless (no more `charCodeAt & 0xff`).
- **Streaming fetch responses in.** `res.body` is a `ReadableStream<Uint8Array>` when the plugin opts in (`responseType: 'stream'`).
- **Two new deadlines.** `streamMaxDurationMs` (default 60 s, host max 5 min) governs a full stream lifetime. `streamIdleMs` (default 30 s) aborts when no chunk arrives in time.
- **Lossless `text()` path.** The default text path stays string-based (back-compat-shaped) but uses the same binary-safe wire format internally so accidental binary bodies don't get silently mangled — they just produce a `MalformedTextBodyError` the plugin can catch.
- **Fix the `arrayBuffer()` polyfill.** The fix lands even on the non-stream path because the current implementation is incorrect.

### Non-goals

- **WebSockets** — full bidirectional. Separate plan; SSE covers 80% of streaming use cases at 10% of the protocol surface.
- **Streaming request bodies in.** A plugin receiving a 5 GB upload as an async iterator is possible in principle but adds back-pressure and chunk-acknowledgement complexity for a use case (resumable uploads) the media subsystem already covers via signed PUTs.
- **Streaming request bodies out.** `fetch` outbound with a streamed request body — not needed for any documented use case; defer.
- **Per-plugin memory cap increase.** Streaming is the workaround for the 64 MB heap ceiling, not a substitute for adjusting it. Separate plan.
- **A binary `console` / `log` shape.** Logs stay UTF-8 text via `__log`.

---

## Wire protocol — the type changes

### `SerializedRequest.body` and `SerializedResponse.body` become tagged unions

In `server/plugins/protocol/messages.ts`:

```ts
/**
 * Binary-safe body envelope. Crosses host↔worker via postMessage and
 * worker↔VM via JSON. Three variants by chunking semantics:
 *
 *   • text     — one UTF-8 string; the default for application/json, form
 *                 bodies, etc. Subject to lossy decoding for binary
 *                 upstreams — see `text` semantics below.
 *   • binary   — one base64-encoded byte array; lossless. Used when the
 *                 client opted into bytes via ctx.req.bytes() or fetch()'s
 *                 `responseType: 'binary'`.
 *   • stream   — host-minted stream id; bytes flow via separate
 *                 chunk-message kinds keyed by streamId.
 */
export type BinarySafeBody =
  | { kind: 'text'; text: string }
  | { kind: 'binary'; bytesBase64: string }
  | { kind: 'stream'; streamId: string }

export interface SerializedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: BinarySafeBody
  /**
   * When body.kind is 'binary' or 'stream', this captures the upstream
   * content-length when known. Plugins can early-reject oversized payloads
   * without draining.
   */
  contentLength?: number
}

export type SerializedResponse =
  | { kind: 'json'; value: unknown }
  | { kind: 'response'; status: number; headers: Record<string, string>; body: BinarySafeBody }
```

`text` stays the wire-default for `application/json`, `application/x-www-form-urlencoded`, and `multipart/form-data` (which the host's pre-parser already handles into `parsedBody`). The host elects `binary` when the request `Content-Type` is in a binary allowlist (`application/octet-stream`, `application/pdf`, `image/*`, `application/x-protobuf`, etc.) OR when the plugin's route declares `binary: true` at registration time.

### Two new message kinds for streams

```ts
// Worker → Main, sent for each chunk on an active stream
export interface StreamChunkEvent {
  kind: 'stream-chunk'
  streamId: string
  pluginId: string
  /** Sequential 0-based index; host validates monotonicity per stream. */
  sequence: number
  /** Base64-encoded chunk bytes. Empty string is legal for keep-alive. */
  bytesBase64: string
  /** When true, this is the last chunk; host closes the ReadableStream. */
  done: boolean
}

// Main → Worker, used for inbound streams (fetch response, request body)
export interface StreamChunkRequest {
  kind: 'stream-chunk-deliver'
  streamId: string
  sequence: number
  bytesBase64: string
  done: boolean
}

// Bidirectional — plugin aborts an inbound stream; host aborts an outbound stream.
export interface StreamAbortMessage {
  kind: 'stream-abort'
  streamId: string
  reason?: string
}
```

`streamId` is a per-plugin nanoid minted by whichever side originates the stream (`'sid_' + nanoid()`). Plugins cannot influence the id; the host's bookkeeping treats it as opaque.

### `RouteResult` for streamed responses

`RouteResult.response` keeps its existing union; the `'response'` variant now carries a `BinarySafeBody`. When the plugin streams, the worker:

1. Sends a single `route-result` with `response: { kind: 'response', status, headers, body: { kind: 'stream', streamId } }`.
2. Pumps subsequent `stream-chunk` events at the worker's pace.
3. Sends a `stream-chunk` with `done: true` to close.

The host materialises a `ReadableStream<Uint8Array>` keyed by `streamId` between steps 1 and 2, and returns the `Response` to the upstream HTTP client immediately on step 1 (so SSE clients receive headers right away).

---

## The host bridge — three call sites change

### 5.1 Inbound route body — `server/plugins/host/rpc.ts:runRouteInWorker`

The current code reads `bodyText = await args.request.text()` once. The new code branches:

```ts
function shouldUseBinaryBody(contentType: string, routeBinary: boolean): boolean {
  if (routeBinary) return true
  const lc = contentType.toLowerCase()
  return BINARY_CONTENT_TYPE_PREFIXES.some((p) => lc.startsWith(p))
}

const contentType = headers['content-type'] ?? ''
const routeBinary = route.binary === true   // see §6 — declared at registration

let body: BinarySafeBody
let parsedBody: Record<string, unknown> = {}

if (args.method === 'GET') {
  body = { kind: 'text', text: '' }
} else if (shouldUseBinaryBody(contentType, routeBinary)) {
  const bytes = new Uint8Array(await args.request.arrayBuffer())
  body = { kind: 'binary', bytesBase64: bytesToBase64(bytes) }
} else {
  const bodyText = await args.request.text()
  body = { kind: 'text', text: bodyText }
  parsedBody = parseTextBody(bodyText, contentType)
}
```

`BINARY_CONTENT_TYPE_PREFIXES` is a small allowlist: `'application/octet-stream'`, `'application/pdf'`, `'application/protobuf'`, `'application/x-protobuf'`, `'image/'`, `'video/'`, `'audio/'`, `'font/'`. Custom types not on the list need the route to declare `binary: true` at registration time. Plain forms and JSON stay text.

### 5.2 Outbound `fetch` response — `server/plugins/host/handlers/network.ts` + `host/network.ts`

`performGatedFetch` grows a `responseType` parameter:

```ts
export interface GatedFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string                              // text body (legacy + new default)
  bodyBytesBase64?: string                   // binary body (new)
  abortId?: string
  responseType?: 'text' | 'binary' | 'stream'  // new
}

export async function performGatedFetch(
  entry: HostPluginRecord,
  urlString: string,
  init: GatedFetchInit,
): Promise<SerializedNetworkResponse> { ... }

export type SerializedNetworkResponse =
  | { kind: 'text';   status: number; ok: boolean; headers: Record<string, string>; body: string }
  | { kind: 'binary'; status: number; ok: boolean; headers: Record<string, string>; bytesBase64: string }
  | { kind: 'stream'; status: number; ok: boolean; headers: Record<string, string>; streamId: string }
```

For `'binary'`: the host calls `response.arrayBuffer()`, base64-encodes, returns. Plugin's `bytes()` decodes losslessly.

For `'stream'`: the host registers a stream id, returns the `{ kind: 'stream', streamId, status, headers, ok }` envelope **immediately** after the upstream headers land, then iterates `response.body` (Bun's `ReadableStream`) and posts a `stream-chunk-deliver` message per chunk, base64-encoded, ≤256 KB. The plugin's `res.body.getReader()` reads from a worker-local queue fed by the IPC.

### 5.3 Route response — `server/plugins/pluginWorker.ts:serializeRouteResult`

Today (`pluginWorker.ts:320-335`):

```ts
function serializeRouteResult(value: unknown): SerializedResponse { ... body: string ... }
```

The function gains awareness of three new response shapes the plugin can return:

```ts
function serializeRouteResult(value: unknown): SerializedResponse {
  if (isStreamResponse(value)) {
    // Plugin returned { __response: true, stream: { kind: 'stream', streamId, ... } }
    // — the worker has already minted streamId and is pumping chunks via
    // stream-chunk events.
    return { kind: 'response', status: value.status, headers: value.headers,
             body: { kind: 'stream', streamId: value.stream.streamId } }
  }
  if (isBinaryResponse(value)) {
    // Plugin returned { __response: true, bytesBase64, status, headers }
    return { kind: 'response', status: value.status, headers: value.headers,
             body: { kind: 'binary', bytesBase64: value.bytesBase64 } }
  }
  if (isTextResponse(value)) {
    return { kind: 'response', status: value.status, headers: value.headers,
             body: { kind: 'text', text: value.body } }
  }
  return { kind: 'json', value: value === undefined ? { ok: true } : value }
}
```

The materialiser in `host/rpc.ts:271-279` learns to wrap the three body kinds:

```ts
function materializeResponse(response: SerializedResponse): Response {
  if (response.kind !== 'response') return Response.json(response.value)
  const { status, headers } = response
  switch (response.body.kind) {
    case 'text':   return new Response(response.body.text, { status, headers })
    case 'binary': return new Response(base64ToFreshArrayBuffer(response.body.bytesBase64), { status, headers })
    case 'stream': return new Response(createReadableStreamForId(response.body.streamId), { status, headers })
  }
}
```

`createReadableStreamForId` registers a host-side queue keyed by `streamId`. Inbound `stream-chunk` events from the worker (sequence-validated) push into the queue; `done: true` closes it; the upstream HTTP client's `Response.body` reads from the queue.

---

## 6. New API surface

### 6.1 Route handler context — binary in

`ctx.req` gains two methods:

```ts
ctx.req.bytes(): Promise<Uint8Array>      // raw bytes; throws on stream bodies
ctx.req.contentLength: number | undefined
```

`ctx.req.text()` continues to work for `kind: 'text'` bodies and throws `RequestBodyMismatchError` if the host classified the body as `binary` (the plugin asked for text but the body was binary). Plugins that want either-or check `ctx.req.contentType` and pick.

Route registration grows one optional flag:

```ts
api.cms.routes.post('/webhook/stripe', 'plugins.configure', handler, { binary: true })
```

`binary: true` forces the host's branch in §5.1 to elect `kind: 'binary'` regardless of content type — useful for Stripe (which sends `application/json` but signs over raw bytes) and for clients that send custom binary content types.

### 6.2 Route handler context — `respond` helper

A new `ctx.respond` namespace replaces the brittle `{ __response: true, ... }` discriminator:

```ts
ctx.respond: {
  json(value: unknown, init?: { status?: number; headers?: Record<string, string> }): RouteReturn
  text(body: string, init?: { status?: number; headers?: Record<string, string> }): RouteReturn
  bytes(body: Uint8Array, init?: { status?: number; headers?: Record<string, string> }): RouteReturn
  stream(
    source: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>,
    init?: { type?: 'event-stream' | 'octet-stream' | 'text/html' | string;
             status?: number; headers?: Record<string, string>;
             maxDurationMs?: number; idleMs?: number },
  ): RouteReturn
  /** SSE-shaped helper: emits `data: ...\n\n` framing per yielded value. */
  events(
    source: AsyncIterable<{ event?: string; data: unknown; id?: string }>,
    init?: { status?: number; headers?: Record<string, string>;
             maxDurationMs?: number; idleMs?: number },
  ): RouteReturn
}
```

The existing `{ __response: true, status, headers, body }` shape is **deleted** (pre-release rule). All in-repo plugins that use it migrate to `ctx.respond.text/json/bytes` in the same change. The `forms-builder` plugin currently returns plain JSON or a `__response` envelope for the success/error JSON; it switches to `ctx.respond.json({...})` with no behaviour change.

### 6.3 `fetch` — binary + streaming response

```ts
const res = await fetch('https://example.com/icon.png', {
  responseType: 'binary',   // new — default 'text'
})
const bytes = await res.bytes()       // Uint8Array, lossless
const buf = await res.arrayBuffer()   // ArrayBuffer, lossless (fixed)

// Streaming
const res = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  responseType: 'stream',   // new
  headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o', stream: true, messages: [...] }),
})
const reader = res.body.getReader()
while (true) {
  const { value, done } = await reader.read()
  if (done) break
  // value is Uint8Array of ≤256 KB
}
```

`responseType: 'text'` (the default) keeps the current behaviour — host calls `response.text()`, plugin gets `await res.text()`. This is what every shipped plugin uses today, so they all keep working with zero code changes once the `arrayBuffer()` polyfill is fixed.

### 6.4 Worked example — SSE-streamed LLM chat

```ts
// server/index.ts in an AI assistant plugin
api.cms.routes.post('/chat', 'plugins.configure', async (ctx) => {
  const { messages } = (await ctx.req.json()) as { messages: ChatMessage[] }
  const apiKey = api.cms.settings.get<string>('openaiKey') ?? ''

  return ctx.respond.events(
    (async function* () {
      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        responseType: 'stream',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', stream: true, messages }),
      })
      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          if (line === 'data: [DONE]') return
          const json = JSON.parse(line.slice(6))
          const delta = json.choices?.[0]?.delta?.content
          if (delta) yield { event: 'token', data: { delta } }
        }
      }
    })(),
    { maxDurationMs: 5 * 60 * 1000, idleMs: 30_000 },
  )
})
```

Admin UI consumes via the standard `EventSource` API — no plugin-host-hooks change needed beyond the existing `usePluginRoutes()` returning a path; the browser handles SSE natively.

Today this plugin **cannot exist**. After this plan: ~30 lines, no custom transport, native streaming end-to-end.

### 6.5 Worked example — Stripe webhook signature verification

```ts
api.cms.routes.public.post('/webhook/stripe', async (ctx) => {
  const sigHeader = ctx.req.headers.get('stripe-signature') ?? ''
  const rawBytes = await ctx.req.bytes()   // lossless, byte-exact

  const ok = await api.cms.webhooks.verify({   // future helper; for now, manual HMAC
    provider: 'stripe',
    secret: api.cms.settings.get<string>('stripeSigningSecret') ?? '',
    headers: { 'stripe-signature': sigHeader },
    body: rawBytes,
  })
  if (!ok) return ctx.respond.json({ error: 'invalid signature' }, { status: 401 })

  const event = JSON.parse(new TextDecoder().decode(rawBytes))
  // ... handle event
  return ctx.respond.json({ received: true })
}, { binary: true })
```

The `binary: true` flag at the bottom forces the host to elect `kind: 'binary'` even though Stripe sets `content-type: application/json`. Without it, the host's content-type heuristic would still text-encode, which round-trips losslessly for ASCII JSON today but is a footgun for any future provider with non-ASCII payloads.

---

## 7. Chunking, flow control, and deadlines

### 7.1 Chunk size

Fixed at **256 KB** of raw bytes per chunk — same as `MediaStorageAdapter.readStream`'s contract (`src/core/plugin-sdk/types/media.ts:177-179`). After base64 encoding the wire payload is ~341 KB per chunk, well within `postMessage` limits and well below the worker's 64 MB heap.

### 7.2 Back-pressure (inbound streams to the plugin)

Plugin's `reader.read()` returns one chunk at a time. The worker's queue is bounded at **8 chunks pending** (2 MB worst case). When the queue is full, the host pauses upstream consumption — for `fetch`-side streams, the host stops pulling from `response.body`'s reader until the queue drains. For routes, this case doesn't arise on the inbound side (the plugin receives the body whole via `bytes()`); only the outbound side streams.

### 7.3 Back-pressure (outbound streams from the plugin)

For `respond.stream(...)`, the plugin's async iterator yields one chunk per `await`; the worker base64-encodes and posts. The host materialises a `ReadableStream` whose internal queue is `{ highWaterMark: 8 }` (matching §7.2). When the upstream HTTP client reads slowly, the host's queue fills, the host stops draining stream-chunk events, the worker's `postMessage` calls slow down at the OS level, the plugin's `for await` naturally throttles. Standard ReadableStream back-pressure mechanics; no special handling required.

### 7.4 Two deadlines

Streams operate under **two** independent deadlines, both default-applied and per-stream-overridable:

- **`streamMaxDurationMs`** — total wall-clock lifetime from stream open to close. Default 60 s; host hard-cap 5 min. When it expires the host fires a `stream-abort` to the worker (`reason: 'max-duration'`) and closes the upstream HTTP response.
- **`streamIdleMs`** — maximum time between chunks before the stream is considered hung. Default 30 s. Resets every chunk. When it expires, same `stream-abort` (`reason: 'idle'`).

The existing 5 s `DEFAULT_EVAL_TIMEOUT_MS` still applies to the **initial** handler call (the call that returns the stream descriptor). Once the handler yields control to the streaming pump, the per-chunk pump is wrapped in fresh `withDeadline(ctx, streamIdleMs)` calls — same primitive as `eval.ts:21`, just with a longer budget and reset every chunk.

### 7.5 Worker keep-alive

The worker stays alive between chunks via the existing `__hostSleep` pump (`bootstrap/timers.ts`). Each `await reader.read()` is a host call that resolves when the next `stream-chunk-deliver` arrives. No new pump mechanism needed.

---

## 8. New RPC targets

Added to `server/plugins/protocol/targets.ts`'s `ALLOWED_API_TARGETS` (locked by `plugin-sandbox-invariants.test.ts`):

```
stream.open                  Plugin announces an outbound stream (response side)
stream.chunk                 Plugin emits one chunk on an outbound stream
stream.close                 Plugin closes an outbound stream
stream.abort                 Either side aborts a stream by id
```

`stream.open` is what the worker calls after the plugin's handler returns a `respond.stream(...)` result — the host records the streamId in `HostPluginRecord.outboundStreams: Map<string, StreamController>`, creates the upstream `ReadableStream`'s queue, and replies with success. `stream.chunk` and `stream.close` are pumped one per chunk; back-pressure is enforced by the host's queue `highWaterMark`.

Inbound streams (fetch response side) flow the other direction — the host pumps `stream-chunk-deliver` worker-bound messages without going through the api-call protocol. The plugin's only outbound action on an inbound stream is `stream.abort`.

The `network.fetch` schema in `server/plugins/protocol/schemas/network.ts` gets one new field:

```ts
export const NetworkFetchInitSchema = Type.Object({
  method:        Type.Optional(Type.String({ maxLength: 16 })),
  headers:       Type.Optional(Type.Record(Type.String(), Type.String())),
  body:          Type.Optional(Type.String()),
  bodyBase64:    Type.Optional(Type.String()),      // new — set when plugin passed Uint8Array body
  abortId:       Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_]+$' })),
  responseType:  Type.Optional(Type.Union([
    Type.Literal('text'), Type.Literal('binary'), Type.Literal('stream'),
  ])),
}, { additionalProperties: false })
```

---

## 9. VM bootstrap changes

### 9.1 Fix `arrayBuffer()` even on the non-stream path

`server/plugins/quickjs/bootstrap/fetch.ts:27-44` — the bug fix. The materialiser learns to branch on a new wire field `bodyKind`:

```js
function __materializeResponse(result) {
  function readBytes() {
    if (result.bodyKind === 'binary') return __base64ToBytes(result.bytesBase64);
    if (result.bodyKind === 'text')   return __utf8Encode(result.body);
    throw new Error('Streaming response — use res.body.getReader() instead of bytes()/arrayBuffer()');
  }
  return {
    status: result.status,
    ok: result.ok,
    headers: { /* unchanged */ },
    text: async function () {
      if (result.bodyKind === 'binary') return new TextDecoder().decode(__base64ToBytes(result.bytesBase64));
      return result.body;
    },
    json: async function () { return JSON.parse(await this.text()); },
    bytes: async function () { return readBytes(); },                                  // new
    arrayBuffer: async function () {
      const bytes = readBytes();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    body: result.bodyKind === 'stream' ? __makeStreamReader(result.streamId) : null,    // new
  };
}
```

`__base64ToBytes` and `__utf8Encode` already exist (`bootstrap/crypto.ts:30-106`). They're hoisted to a shared `bootstrap/codec.ts` so both `fetch` and `crypto` import the same implementations — one source of truth for the wire format.

### 9.2 The stream reader

New helper exposed as `__makeStreamReader(streamId)`:

```js
function __makeStreamReader(streamId) {
  const queue = [];                            // pending { value, done } objects
  const waiters = [];                          // pending Promise resolvers
  let aborted = false; let abortReason = null;

  // Registered globally so __deliverStreamChunk(streamId, b64, done) can find us.
  globalThis.__streamReaders[streamId] = {
    push: function (chunk) {
      if (aborted) return;
      const waiter = waiters.shift();
      if (waiter) waiter(chunk);
      else queue.push(chunk);
    },
    abort: function (reason) {
      aborted = true; abortReason = reason;
      while (waiters.length) waiters.shift()({ value: undefined, done: true, abort: reason });
    },
  };

  return {
    getReader: function () {
      return {
        read: async function () {
          if (aborted) {
            const err = new Error(abortReason || 'aborted'); err.name = 'AbortError'; throw err;
          }
          if (queue.length) return queue.shift();
          return new Promise(function (resolve) { waiters.push(resolve); });
        },
        cancel: async function () {
          aborted = true;
          await __hostCall('stream.abort', [{ streamId: streamId, reason: 'cancel' }]);
        },
      };
    },
  };
}

globalThis.__streamReaders = {};

globalThis.__deliverStreamChunk = function (streamId, base64, done) {
  const reader = globalThis.__streamReaders[streamId];
  if (!reader) return;
  if (done) {
    reader.push({ value: undefined, done: true });
    delete globalThis.__streamReaders[streamId];
    return;
  }
  reader.push({ value: __base64ToBytes(base64), done: false });
};

globalThis.__abortStreamReader = function (streamId, reason) {
  const reader = globalThis.__streamReaders[streamId];
  if (reader) reader.abort(reason);
};
```

`__deliverStreamChunk` is the entry point the host calls when a `stream-chunk-deliver` message arrives — the pluginWorker dispatches the message via `ctx.evalCode("__deliverStreamChunk(...)")`. Same flow as the existing `__hostCall` resolution mechanism.

### 9.3 Outbound `respond.stream(...)` plumbing

New `__buildRespond` factory bound to the route ctx, returning the helper from §6.2. When the plugin yields a chunk via the async iterator, the wrapper calls `__hostCall('stream.chunk', [{ streamId, sequence, bytesBase64, done }])`. The wrapper rejects the pending promise if the host fires `stream-abort` before the close — this is what makes a slow upstream client back-pressure the plugin.

The route-result envelope returned to the host is:

```js
{ __response: true, status: 200, headers: { 'content-type': 'text/event-stream' },
  stream: { streamId: 'sid_<...>' } }
```

The worker keeps the iterator alive in a per-route in-flight map until either the iterator returns or a host `stream-abort` arrives.

---

## 10. SSE framing helper

`ctx.respond.events(...)` wraps `respond.stream(...)` with SSE framing applied per yielded event. Implementation lives in `src/core/plugin-sdk/sse.ts` (new); shipped into every VM via the bootstrap concat:

```js
async function* __sseFrame(source) {
  const enc = new TextEncoder();
  for await (const event of source) {
    let frame = '';
    if (event.id !== undefined)    frame += 'id: '    + String(event.id) + '\n';
    if (event.event !== undefined) frame += 'event: ' + String(event.event) + '\n';
    const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
    for (const line of data.split('\n')) frame += 'data: ' + line + '\n';
    frame += '\n';
    yield enc.encode(frame);
  }
}
```

The host's response materialiser sets sensible defaults when the plugin passes `type: 'event-stream'`:

```
content-type: text/event-stream
cache-control: no-cache, no-transform
connection: keep-alive
x-accel-buffering: no
```

Plugin can override any header explicitly; otherwise SSE works out of the box.

---

## 11. Rollout plan — one change set

1. **Codec hoist.** Move `__utf8Encode` + `__base64ToBytes` + `__bytesToBase64` from `bootstrap/crypto.ts:30-106` into a new shared block `bootstrap/codec.ts` (string constant, concatenated by `bootstrap/index.ts`). No behaviour change.
2. **Protocol type changes.** Update `BinarySafeBody`, `SerializedRequest.body`, `SerializedResponse.body`, `NetworkFetchInitSchema.responseType`, add `StreamChunkEvent` / `StreamChunkRequest` / `StreamAbortMessage` to `server/plugins/protocol/messages.ts` and the matching TypeBox schemas in `server/plugins/protocol/schemas/`.
3. **Allowed targets.** Add `stream.open`, `stream.chunk`, `stream.close`, `stream.abort` to `ALLOWED_API_TARGETS` in `server/plugins/protocol/targets.ts`. Update gate test `plugin-sandbox-invariants.test.ts`.
4. **Host bridge — inbound route body.** Rewrite the body-read branch in `server/plugins/host/rpc.ts:runRouteInWorker` per §5.1. Keep `parsedBody` shape unchanged for back-compat with handler code that reads `ctx.body`.
5. **Host bridge — outbound route response.** Rewrite `materializeResponse` in `server/plugins/host/rpc.ts:271-279` per §5.3. Add `host/streams.ts` with the per-streamId `ReadableStream` queue + chunk-routing.
6. **Host bridge — fetch.** Extend `performGatedFetch` in `server/plugins/host/network.ts` with `responseType` branching per §5.2. Add streaming branch.
7. **Stream handlers.** Add `server/plugins/host/handlers/stream.ts` with `handleStreamOpen / handleStreamChunk / handleStreamClose / handleStreamAbort`. Wire into `server/plugins/host/apiDispatch.ts`.
8. **VM bootstrap — codec hoist + fetch shim fix.** Apply §9.1 verbatim. The `arrayBuffer()` bug fix lands here.
9. **VM bootstrap — stream reader.** Add `__makeStreamReader` + `__streamReaders` + `__deliverStreamChunk` + `__abortStreamReader` per §9.2.
10. **VM bootstrap — respond helper.** Add `ctx.respond.{json,text,bytes,stream,events}` per §6.2 + §10. Delete the `__response: true` discriminator path; the only legal returns from a handler are now (a) a plain JSON-serialisable value, or (b) one of `ctx.respond.*`'s results.
11. **SDK types.** Add `BinarySafeBody`, `RouteReturn`, the new `ServerPluginRouteContext.respond`, `ctx.req.bytes`, route options `{ binary: true }`, `fetch`'s `responseType`, to `src/core/plugin-sdk/types/routes.ts` and the type augmentation in `sandboxGlobals.ts`.
12. **Worker integration.** Update `server/plugins/pluginWorker.ts:serializeRouteResult` to detect `respond.*` results; update message dispatch to handle inbound `stream-chunk-deliver` / `stream-abort` events by calling `__deliverStreamChunk` / `__abortStreamReader` on the VM.
13. **Delete the `__response` shape.** Migrate `examples/plugins/forms-builder` to `ctx.respond.json(...)`. The forms-builder's plain-JSON returns are unchanged.
14. **Docs.** Update `docs/features/plugin-system.md` route + fetch sections. Add a cookbook entry for SSE-streamed LLM chat and binary webhook verification. Update `docs/features/agent.md` if the AI runtime starts using this path.
15. **CLI.** Add a `bun pb-plugin init --kind=webhook-receiver` scaffold that pre-declares `cms.routes.public` + a `binary: true` route. Add an `--kind=ai-assistant` scaffold pre-declaring `responseType: 'stream'` and `cms.respond.events`.

One PR. `bun test && bun run build && bun run lint` must pass.

---

## 12. Gate tests

| Test | Change |
|---|---|
| `plugin-sandbox-invariants.test.ts` | Lock the new `ALLOWED_API_TARGETS` (4 added). Lock the new `BinarySafeBody` discriminator literals (`'text' | 'binary' | 'stream'`). |
| `plugin-boot-resilience.test.ts` | Add case: streaming response from a route survives a 6 s idle (longer than `DEFAULT_EVAL_TIMEOUT_MS`) when `idleMs: 30_000` is configured. |
| `phase-g-bridge-security.test.ts` | Add case: a plugin without `network.outbound` cannot open an outbound stream via `fetch(..., { responseType: 'stream' })`. |
| `sandbox-crypto-bridge.test.ts` | Refactor reference: now that codec helpers are hoisted, point the test at `bootstrap/codec.ts` instead of `bootstrap/crypto.ts`. |
| New: `plugin-binary-io.test.ts` | Property test: every byte sequence in `[0, 256)^n` round-trips through `host → worker → VM → respond.bytes → host` byte-identical. Catches the kind of bug that exists today. |
| New: `plugin-stream-deadlines.test.ts` | Stream exceeds `streamIdleMs` → `stream-abort` fires; plugin's reader sees `AbortError`. Stream exceeds `streamMaxDurationMs` → same. |
| New: `plugin-stream-backpressure.test.ts` | Plugin yields chunks faster than the host's queue drains; queue caps at 8 chunks; no growth past 2 MB. |

---

## 13. Deferred questions

These do not block the change.

1. **WebSocket / bidirectional.** Defer to its own plan. Most "real-time" needs (AI streaming, progress, live counters, collaborative cursors at 1 Hz) are satisfied by SSE. True bidirectional needs (multi-user editing, voice) need a separate transport.
2. **Streaming request bodies in.** Defer. The 64 MB heap caps single-shot binary requests at ~50 MB practical. Anything larger today goes through the signed-PUT path via `MediaStorageAdapter`. Adding streaming-in requires chunk-acknowledgement back-pressure on the request side; not worth doing until a real plugin needs it.
3. **Streaming request bodies out (`fetch(..., { body: asyncIterable })`).** Defer.
4. **HTTP/2 server push.** Defer.
5. **Compression on the wire.** `stream-chunk` envelopes are base64'd JSON over postMessage. They are NOT gzip-compressed — the upstream HTTP-level compression already handled it; the bridge is one process boundary, gzip adds CPU for marginal benefit. Re-examine if profiling shows bridge throughput as the bottleneck.
6. **Per-plugin stream concurrency cap.** Defaults to 8 in-flight streams per plugin (worker memory budget = 8 streams × 8 queued chunks × 256 KB = 16 MB worst case). Host-cap, no manifest override in v1.
7. **Observability.** Streams open / close / abort events emit `[plugin:<id>] stream <id> <action>` log lines; admin's plugin-events panel surfaces them. No new metrics surface in v1.
8. **Why not `Transferable` `ArrayBuffer`s instead of base64?** `postMessage` supports transfer with `[arrayBuffer]` but the QuickJS bridge cannot consume them — base64 is needed for the worker↔VM hop anyway. Adding the transfer optimisation only for host↔worker saves one base64 round-trip but introduces a copy-vs-transfer policy decision per chunk. Defer; profile first.

---

## Related

- `docs/features/plugin-system.md` — feature doc that gains the binary + streaming route sections + a cookbook entry when this ships
- `docs/features/agent.md` — referenced if the AI runtime adopts plugin-hosted streaming for the in-canvas assistant
- `CLAUDE.md` — the `forbidden patterns` table references `{ raw: { status, headers, body } }`; remove the row in the same change
- Source-of-truth files (existing, modified):
  - `server/plugins/protocol/messages.ts` — wire types
  - `server/plugins/protocol/targets.ts` — `ALLOWED_API_TARGETS`
  - `server/plugins/protocol/schemas/network.ts` — fetch init schema
  - `server/plugins/host/network.ts` — `performGatedFetch`
  - `server/plugins/host/rpc.ts` — route forwarder + response materialiser
  - `server/plugins/host/apiDispatch.ts` — RPC dispatcher
  - `server/plugins/host/handlers/network.ts` — fetch handler
  - `server/plugins/pluginWorker.ts` — `serializeRouteResult`
  - `server/plugins/quickjs/bootstrap/fetch.ts` — VM fetch shim (the lossy `arrayBuffer()` lives here)
  - `server/plugins/quickjs/bootstrap/crypto.ts` — codec helpers being hoisted
  - `server/plugins/quickjs/bootstrap/timers.ts` — `__hostSleep` reused for stream pumping
  - `server/plugins/quickjs/bootstrap/polyfills.ts` — `AbortController` reused for stream cancellation
  - `server/plugins/quickjs/eval.ts` — `withDeadline` reused for `streamIdleMs`
  - `src/core/plugin-sdk/types/routes.ts` — `ServerPluginRouteContext` extension
  - `src/core/plugin-sdk/types/media.ts:177-179` — 256 KB chunk-size precedent
- Gate tests:
  - `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`
  - `src/__tests__/architecture/plugin-boot-resilience.test.ts`
  - `src/__tests__/architecture/phase-g-bridge-security.test.ts`
  - `src/__tests__/architecture/sandbox-crypto-bridge.test.ts`
