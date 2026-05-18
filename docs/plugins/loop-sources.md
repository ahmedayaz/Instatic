# Loop entity sources

The `base.loop` module iterates a registered **loop entity source** and renders its child template per item. The CMS ships built-in sources (`content.entries`, `site.pages`, `site.media`); plugins can register more via the SDK.

## Concepts

| Concept | Description |
|---|---|
| `LoopEntitySource` | Registered backend that produces `LoopItem` rows for a loop. |
| `LoopItem`         | `{ id, fields }` — the unit a loop iterates. `fields` is read by `dynamicBindings`. |
| `LoopSourceField`  | Metadata describing a field's id, label, and format hint. |
| `filterSchema`     | `PropertySchema` of source-specific filter controls (Properties Panel). |
| `orderByOptions`   | Allowed `orderBy` values shown in the Properties Panel. |
| `entry stack`      | Publisher state: stack of `LoopItem` frames. Top resolves `currentEntry`; second-from-top resolves `parentEntry`. |

## Registering a custom source

Plugin loop sources register via `api.cms.loops.registerSource(...)` during `activate`. The plugin must declare `loops.register` in its manifest permissions.

Plugin source code runs inside the sandbox, so the `fetch(ctx)` body cannot reach the host's database directly. Use the SDK to source items:

- **From plugin-owned records:** `api.cms.storage.collection(...)`
- **From an external API:** `fetch(...)` (requires `network.outbound` permission + `networkAllowedHosts` allowlist)

### Example: source backed by plugin storage

```ts
export async function activate(api) {
  const products = api.cms.storage.collection('products')

  api.cms.loops.registerSource({
    id: 'acme.products',
    label: 'Acme products',
    filterSchema: {
      category: {
        type: 'select',
        label: 'Category',
        options: [
          { label: 'All', value: '' },
          { label: 'New arrivals', value: 'new' },
        ],
      },
    },
    orderByOptions: [
      { id: 'name', label: 'Name' },
      { id: 'price', label: 'Price' },
    ],
    fields: [
      { id: 'name', label: 'Name' },
      { id: 'price', label: 'Price' },
      { id: 'image', label: 'Image', format: 'media' },
      { id: 'permalink', label: 'Permalink', format: 'url' },
    ],
    async fetch(ctx) {
      const all = await products.list()
      const filtered = ctx.filters.category
        ? all.filter((r) => r.data.category === ctx.filters.category)
        : all
      const sorted = filtered.slice().sort((a, b) => {
        const key = ctx.orderBy === 'price' ? 'price' : 'name'
        const dir = ctx.direction === 'desc' ? -1 : 1
        return (a.data[key] > b.data[key] ? 1 : -1) * dir
      })
      const page = sorted.slice(ctx.offset, ctx.offset + ctx.limit)
      return {
        items: page.map((r) => ({
          id: r.id,
          fields: {
            name: r.data.name,
            price: r.data.price,
            image: r.data.image,
            permalink: `/products/${r.id}`,
          },
        })),
        totalItems: filtered.length,
      }
    },
    preview() {
      return [
        { id: 'sample-1', fields: { name: 'Sample 1', price: 19.99, image: '', permalink: '#' } },
        { id: 'sample-2', fields: { name: 'Sample 2', price: 29.99, image: '', permalink: '#' } },
      ]
    },
  })
}
```

### Example: source backed by an external API

```ts
// plugin.json manifests `network.outbound` + `networkAllowedHosts: ['api.shop.example.com']`
export async function activate(api) {
  api.cms.loops.registerSource({
    id: 'shop.products',
    label: 'Shop products',
    filterSchema: {},
    orderByOptions: [{ id: 'name', label: 'Name' }],
    fields: [
      { id: 'name', label: 'Name' },
      { id: 'price', label: 'Price' },
    ],
    async fetch(ctx) {
      const res = await fetch(`https://api.shop.example.com/products?limit=${ctx.limit}&offset=${ctx.offset}`)
      const body = await res.json()
      return {
        items: body.items.map((p) => ({ id: p.id, fields: { name: p.name, price: p.price } })),
        totalItems: body.total,
      }
    },
    preview() {
      return []
    },
  })
}
```

## What `ctx` contains

Inside a plugin source's `fetch(ctx)`:

| Field | Type | Notes |
|---|---|---|
| `ctx.filters` | `Record<string, unknown>` | Values validated against `filterSchema`. |
| `ctx.orderBy` | `string` | One of the `orderByOptions[].id` values. |
| `ctx.direction` | `'asc' \| 'desc'` | |
| `ctx.limit` | `number` | Hard cap from the loop instance; the source may clamp further. |
| `ctx.offset` | `number` | Page offset. |

Note: built-in (core) sources receive an additional `ctx.db` (Postgres or SQLite client) and `ctx.site` (full site document). These are NOT exposed to plugin sources — `ctx.db` is a function that doesn't cross the sandbox boundary, and direct SQL would be a sandbox escape. Plugin sources reach data through the SDK.

## Round-robin children

A loop with N child nodes renders iteration `i` with child `i mod N`. Two children alternate (1,2,1,2…); three cycle (1,2,3,1,2,3…). An empty children list renders nothing.

## Pagination

The loop has two pagination modes:

- `none` — render up to `limit` items.
- `infinite` — render `pageSize` items inline; the loop runtime appends subsequent pages on user click. Endpoint: `GET /_pb/loop/<loopId>?page=N&pagePath=<page>` returns `{ html, hasMore }`.

Numeric pagination (page numbers in the URL) is **not** part of the loop itself — it lives in the `base.pagination` module that pairs with a loop by id.
