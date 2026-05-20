# Newsletter

Email newsletter plugin for Page Builder, powered by [Resend](https://resend.com). Drop a subscribe form on any page, manage subscriber lists, compose and send broadcasts, and track opens and clicks via webhooks.

## What it does

| Capability | What this plugin does |
|---|---|
| `cms.storage` | Stores subscribers, lists, broadcasts, and delivery records |
| `cms.routes` | Public subscribe/confirm/unsubscribe/preferences endpoints; admin CRUD + CSV export |
| `cms.hooks` | Emits `newsletter.subscribed`, `newsletter.confirmed`, `newsletter.unsubscribed`, `newsletter.broadcast.sent` |
| `cms.schedule` | Every 5 minutes: dispatches any broadcasts whose `scheduledAt` has passed |
| `network.outbound` | Sends emails via `api.resend.com` (single and batch) |
| `admin.navigation` | Adds a **Newsletter** tab to the admin shell with Overview, Subscribers, Lists, and Broadcasts sections |
| `modules.register` | Two canvas modules: `subscribe-form` and `preferences-link` |

## Build

```bash
bun run pb-plugin build examples/plugins/newsletter
```

Produces `examples/plugins/newsletter.plugin.zip`.

## Install

1. Upload `newsletter.plugin.zip` from `/admin/plugins`.
2. Approve the requested permissions.
3. Open **Settings** on the plugin card and fill in:
   - **Resend API Key** — from [resend.com/api-keys](https://resend.com/api-keys)
   - **Resend Webhook Secret** — from your Resend webhook endpoint (see below)
   - **From address** — a verified sender address in Resend
   - **From name** — display name shown to recipients
   - **Site URL** — your site's public base URL (e.g. `https://example.com`)

## Configure Resend

### API key

Create a key at [resend.com/api-keys](https://resend.com/api-keys) with **Sending access** for your domain.

### Verified sender

Verify a domain or email at [resend.com/domains](https://resend.com/domains). The **From address** in settings must use a verified domain.

### Webhooks

Register a webhook in the [Resend dashboard](https://resend.com/webhooks):

- **Endpoint URL:** `https://your-site.com/admin/api/cms/plugins/pagebuilder.newsletter/runtime/webhooks/resend`
- **Events:** `email.bounced`, `email.complained`, `email.opened`, `email.clicked`

Copy the **Signing secret** (starts with `whsec_`) and paste it into the plugin's **Resend Webhook Secret** setting.

## Usage

### 1 — Drop a subscribe form

In the page builder, find **Newsletter Subscribe Form** in the module library. Drop it onto any page. Configure props:

- **List IDs** — comma-separated list IDs to subscribe to (leave blank to use the default list)
- **Success URL** — where to redirect after a successful subscription
- **Show name field** — toggle the optional name input
- **Double opt-in** — controlled by the plugin's global setting, not per-form

The form submits via GET to the plugin's public `/subscribe` endpoint. No JavaScript required.

### 2 — Create lists

Go to **Newsletter → Lists** in the admin and create lists to segment your subscribers (e.g. "Weekly Digest", "Product Updates"). A **General** list is seeded automatically on first install.

### 3 — Compose and send a broadcast

Go to **Newsletter → Broadcasts → New broadcast**:

1. Enter a subject line.
2. Select one or more lists (or leave empty to send to all confirmed subscribers).
3. Write the HTML body in the editor. Use `{{preferences_url}}` and `{{unsubscribe_url}}` as placeholders — the plugin substitutes them per-subscriber at send time.
4. Optionally write a plain-text fallback body.
5. Click **Send preview…** to send a test to your own address.
6. Click **Save draft** to persist without sending.
7. Set a **Schedule** date/time and click **Schedule** — the 5-minute job will dispatch it when the time arrives.
8. Or click **Send now** to send immediately.

### 4 — Export subscribers

Go to **Newsletter → Subscribers** and click **Export CSV** to download all subscribers as a CSV file.

## Canvas modules

### `pagebuilder.newsletter.subscribe-form`

A semantic HTML subscribe form. Works without JavaScript. Submits via GET to the plugin's public `/subscribe` endpoint.

Props: `listIds`, `successUrl`, `consentLabel`, `submitLabel`, `emailPlaceholder`, `namePlaceholder`, `showNameField`.

### `pagebuilder.newsletter.preferences-link`

Renders an anchor tag with the `{{preferences_url}}` placeholder. Place this inside a broadcast HTML body — the plugin substitutes the actual subscriber-specific URL at send time.

Props: `label`.

## Permissions

| Permission | Why |
|---|---|
| `cms.storage` | Read and write subscriber, list, broadcast, and delivery records |
| `cms.routes` | Register public subscribe/confirm/unsubscribe/preferences routes and admin API endpoints |
| `cms.hooks` | Emit subscription and broadcast events; listen to `settings.changed` |
| `cms.schedule` | Dispatch scheduled broadcasts every 5 minutes |
| `network.outbound` | Send emails via Resend API (`api.resend.com`) |
| `admin.navigation` | Add the Newsletter admin page |
| `modules.register` | Register the subscribe-form and preferences-link canvas modules |

## Hooks emitted

| Event | Payload |
|---|---|
| `newsletter.subscribed` | `{ subscriberId, email, listIds, source }` |
| `newsletter.confirmed` | `{ subscriberId, email }` |
| `newsletter.unsubscribed` | `{ subscriberId, email, reason: 'user' \| 'bounced' \| 'complained' }` |
| `newsletter.broadcast.sent` | `{ broadcastId, recipientCount, listIds }` |

## Webhooks

Resend sends POST webhooks to the plugin's `/webhooks/resend` endpoint for the following events:

| Event | Action |
|---|---|
| `email.bounced` | Mark subscriber as `bounced`; set `delivery.bounced = true` |
| `email.complained` | Mark subscriber as `unsubscribed`; emit `newsletter.unsubscribed` |
| `email.opened` | Set `delivery.openedAt`; increment `broadcast.openCount` |
| `email.clicked` | Set `delivery.clickedAt`; increment `broadcast.clickCount` |

Webhook payloads are verified using HMAC-SHA256 (Svix format) with the `resendWebhookSecret` setting.

## File layout

```
examples/plugins/newsletter/
├── pb-plugin.config.ts          ← manifest: id, permissions, settings, resources, modules
├── tsconfig.json
├── icon.svg
├── README.md (this file)
├── server/
│   ├── index.ts                 ← lifecycle: install, activate, uninstall
│   ├── subscribe.ts             ← subscribe/confirm/unsubscribe/preferences + admin subscriber/list routes
│   ├── broadcasts.ts            ← broadcast CRUD, on-demand send, scheduled-send worker
│   ├── webhooks.ts              ← Resend webhook handler
│   ├── resend.ts                ← Resend API client + HMAC-SHA256 + token generation
│   ├── templates.ts             ← email HTML templates + inline confirmation pages
│   └── csv.ts                   ← RFC 4180 CSV export helper
├── modules/
│   ├── subscribeForm.ts         ← pagebuilder.newsletter.subscribe-form canvas module
│   └── preferencesLink.ts       ← pagebuilder.newsletter.preferences-link canvas module
└── admin/
    ├── dashboard.tsx            ← admin entry point with tab navigation
    └── sections/
        ├── Stats.tsx            ← Overview tab — subscriber + broadcast + engagement stats
        ├── Subscribers.tsx      ← Subscribers tab — paginated table, filters, CSV export, add modal
        ├── Lists.tsx            ← Lists tab — create/edit/delete mailing lists
        ├── Broadcasts.tsx       ← Broadcasts tab — list view + send/schedule actions
        └── BroadcastComposer.tsx ← Broadcast editor with HTML body + live preview iframe
```

## Sandbox constraints

All server code runs inside the QuickJS-WASM sandbox:

- No `node:`, `bun:`, `require()`, or `process.binding` — build-time error + install-time scan.
- `TextEncoder` / `TextDecoder` are absent — the plugin includes its own `utf8()` encoder.
- `crypto.subtle` is available for HMAC-SHA256 (webhook verification, token generation).
- Outbound `fetch` is gated to `api.resend.com` — any other host is rejected by the host bridge even if `network.outbound` is granted.
- `Math.random()` is used for token generation (no `crypto.getRandomValues` in QuickJS). Tokens are used for email confirmation and unsubscribe links — this is acceptable for this use case.
