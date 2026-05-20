# Forms Builder

A drag-and-drop form builder for Page Builder CMS. Drop canvas modules onto your pages to create contact forms, surveys, or any HTML form — submissions are stored, spam-filtered, and delivered by email.

---

## Overview

- **Canvas modules**: `Form`, `Text Input`, `Textarea`, `Select`, `Checkbox`, `Radio Group`, `Submit Button`, `Honeypot`
- **Spam protection**: honeypot field + in-memory IP rate limiting + optional Cloudflare Turnstile
- **Email delivery**: Resend, Postmark, or Mailgun — retry-once on 5xx
- **Admin dashboard**: submission list, 30-day chart, filters, per-submission drawer with resend action

---

## Install

1. Build the plugin zip from the repo root:
   ```sh
   bun run pb-plugin build examples/plugins/forms-builder
   ```
2. Go to **Admin → Plugins → Install** and upload `examples/plugins/forms-builder.plugin.zip`.
3. Activate the plugin.
4. Go to **Admin → Plugins → Forms Builder → Settings** and fill in your email provider details.

---

## Usage

### Building a form

1. Open the page editor and find **Forms** in the module library.
2. Drag a **Form** module onto the page canvas — this creates the `<form>` element.
   - Set **Form ID** to a unique slug (e.g. `contact`).
   - Set **Form Name** (shown in admin dashboard and email subject).
   - Optionally set a **Success Message** and/or **Redirect URL**.
3. Drop input modules inside the Form:
   - **Text Input** — `type` can be text / email / url / tel / number
   - **Textarea** — multi-line
   - **Select** — dropdown (configure options as `Label:value` pairs, one per line)
   - **Checkbox** — single checkbox
   - **Radio Group** — mutually exclusive choices
   - **Honeypot** — invisible anti-bot field (drop once per form, leave defaults)
4. Drop a **Submit Button** inside the Form.
5. Publish the page.

### Viewing submissions

Go to **Admin → Forms** to see all submissions. Use the filters to narrow by form or status. Click a row to open the full payload drawer. The **Resend Email** button re-fires the notification email.

---

## Settings Reference

| Setting | Description |
|---------|-------------|
| `provider` | Email provider: `resend` \| `postmark` \| `mailgun` (default: `resend`) |
| `apiKey` | API key for the selected provider |
| `mailgunDomain` | Sending domain (Mailgun only) |
| `fromAddress` | From address for notification emails |
| `defaultToAddress` | Email address that receives submission notifications |
| `subjectTemplate` | Email subject; use `{{form_name}}` for the form name |
| `rateLimit` | Max submissions per IP per minute (default: 5, range 1–60) |
| `enableTurnstile` | Enable Cloudflare Turnstile challenge verification |
| `turnstileSiteKey` | Public Turnstile site key |
| `turnstileSecretKey` | Secret Turnstile verification key |

---

## Email Providers

### Resend
Set `provider = resend` and `apiKey` to your Resend API key. `fromAddress` must be a verified sender domain.

### Postmark
Set `provider = postmark` and `apiKey` to your Postmark Server Token. Postmark validates `fromAddress` against your message stream settings.

### Mailgun
Set `provider = mailgun`, `apiKey` to your Mailgun API key, and `mailgunDomain` to your sending domain (e.g. `mg.example.com`).

---

## Security Notes

### Honeypot
Drop the **Honeypot** module into every form. It renders a hidden field (positioned off-screen at `left:-9999px`, with `tabindex="-1"` and `autocomplete="off"`). If the server receives a non-empty value for any `_hp_*` field it discards the submission silently with HTTP 204 — bots filling all fields never learn their submission was rejected.

### Rate Limiting
The server applies a sliding 60-second window per IP hash. Configure the window size via `rateLimit`. IPs are never stored in plaintext — only their SHA-256 hash.

### Cloudflare Turnstile
Set `enableTurnstile = true`, add the [Turnstile widget](https://developers.cloudflare.com/turnstile/) to your page theme, and configure both site and secret keys. The server verifies the `cf-turnstile-response` token with Cloudflare's API before accepting the submission.

---

## Troubleshooting

**Submissions show status `failed`** — Check the Settings to make sure `apiKey`, `fromAddress`, and `defaultToAddress` are set correctly. Open the submission drawer and read the error message. Use the **Resend Email** button to retry.

**All submissions immediately show 204** — The honeypot field is being filled (likely a bot, or your form autofill is touching hidden fields). Check your browser's autofill settings or remove the Honeypot module temporarily to test.

**Getting 429 errors during testing** — You're hitting the rate limit. Lower `rateLimit` is more restrictive; raise it for testing, lower it for production.

**Form redirects instead of showing success message** — Set `redirectUrl` to empty string in the Form module props if you want the in-page success message instead.
