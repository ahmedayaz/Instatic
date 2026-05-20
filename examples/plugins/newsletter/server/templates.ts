/**
 * Email HTML templates — inline styles only, table-based layout for maximum
 * email client compatibility. No external CSS, no web fonts, no images.
 */

const BODY_STYLE =
  'margin:0;padding:0;background:#f5f5f5;font-family:Georgia,serif;color:#222;'
const CONTAINER_STYLE =
  'max-width:600px;margin:32px auto;background:#fff;border:1px solid #ddd;border-radius:4px;overflow:hidden;'
const HEADER_STYLE = 'background:#111;padding:24px 32px;'
const HEADER_TEXT_STYLE = 'margin:0;font-size:20px;color:#fff;font-family:Arial,sans-serif;'
const CONTENT_STYLE = 'padding:32px;line-height:1.6;'
const FOOTER_STYLE =
  'padding:20px 32px;border-top:1px solid #eee;font-size:12px;color:#999;font-family:Arial,sans-serif;line-height:1.5;'
const BUTTON_STYLE =
  'display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:4px;font-family:Arial,sans-serif;font-size:14px;font-weight:600;margin:16px 0;'
const LINK_STYLE = 'color:#555;text-decoration:underline;'

function layout(siteName: string, headingText: string, body: string, footer: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(headingText)}</title>
</head>
<body style="${BODY_STYLE}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td>
<div style="${CONTAINER_STYLE}">
  <div style="${HEADER_STYLE}">
    <h1 style="${HEADER_TEXT_STYLE}">${esc(siteName)}</h1>
  </div>
  <div style="${CONTENT_STYLE}">${body}</div>
  <div style="${FOOTER_STYLE}">${footer}</div>
</div>
</td></tr>
</table>
</body>
</html>`
}

/** HTML-escape — prevent XSS in injected values. */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Double opt-in confirmation email
// ---------------------------------------------------------------------------

export interface OptInEmailParams {
  siteName: string
  confirmUrl: string
  subject: string
  /** Raw HTML body from settings (may contain {{confirm_url}} placeholder). */
  optInBody: string
}

export interface RenderedEmail {
  html: string
  text: string
}

export function renderOptInEmail(params: OptInEmailParams): RenderedEmail {
  const { siteName, confirmUrl, optInBody } = params

  // Substitute {{confirm_url}} placeholder in the operator-configured body.
  const processedBody = optInBody.replace(/\{\{confirm_url\}\}/g, confirmUrl)

  const htmlBody = processedBody.includes('<') ? processedBody : `<p>${esc(processedBody)}</p>`

  const html = layout(
    siteName,
    params.subject,
    `
    ${htmlBody}
    <p><a href="${confirmUrl}" style="${BUTTON_STYLE}">Confirm my subscription</a></p>
    <p style="font-size:13px;color:#888;">Or copy and paste this link into your browser:<br>
    <a href="${confirmUrl}" style="${LINK_STYLE}">${esc(confirmUrl)}</a></p>
    `,
    `You're receiving this because someone subscribed using your email address.
     If you didn't request this, you can safely ignore this email.`,
  )

  const text = [
    `${siteName} — Please confirm your subscription`,
    '',
    processedBody.replace(/<[^>]+>/g, ''),
    '',
    `Confirm here: ${confirmUrl}`,
    '',
    "If you didn't request this, ignore this email.",
  ].join('\n')

  return { html, text }
}

// ---------------------------------------------------------------------------
// Broadcast email
// ---------------------------------------------------------------------------

export interface BroadcastEmailParams {
  siteName: string
  subject: string
  /** Raw HTML body from the broadcast record. May contain placeholders. */
  htmlBody: string
  plainBody: string
  preferencesUrl: string
  unsubscribeUrl: string
}

export function renderBroadcastEmail(params: BroadcastEmailParams): RenderedEmail {
  const { siteName, subject, htmlBody, plainBody, preferencesUrl, unsubscribeUrl } = params

  // Substitute placeholders in the body.
  const processedHtml = htmlBody
    .replace(/\{\{preferences_url\}\}/g, preferencesUrl)
    .replace(/\{\{unsubscribe_url\}\}/g, unsubscribeUrl)

  const footer = `
    <a href="${preferencesUrl}" style="${LINK_STYLE}">Manage preferences</a> &nbsp;·&nbsp;
    <a href="${unsubscribeUrl}" style="${LINK_STYLE}">Unsubscribe</a><br>
    You are receiving this email because you subscribed to ${esc(siteName)}.`

  const html = layout(siteName, subject, processedHtml, footer)

  const processedPlain = plainBody
    .replace(/\{\{preferences_url\}\}/g, preferencesUrl)
    .replace(/\{\{unsubscribe_url\}\}/g, unsubscribeUrl)

  const text = [
    processedPlain || plainBody.replace(/<[^>]+>/g, ''),
    '',
    '---',
    `Manage preferences: ${preferencesUrl}`,
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join('\n')

  return { html, text }
}

// ---------------------------------------------------------------------------
// Inline confirmation/unsubscribe page HTML (returned directly from routes)
// ---------------------------------------------------------------------------

export function renderConfirmPage(siteName: string, email: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Subscription confirmed</title>
<style>body{font-family:Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#222}
h1{font-size:1.5rem}p{color:#555}</style></head>
<body>
<h1>You&#39;re subscribed!</h1>
<p>Thank you for confirming your subscription to <strong>${esc(siteName)}</strong>.</p>
<p style="color:#888;font-size:13px">${esc(email)}</p>
</body></html>`
}

export function renderUnsubscribePage(siteName: string, email: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Unsubscribed</title>
<style>body{font-family:Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#222}
h1{font-size:1.5rem}p{color:#555}</style></head>
<body>
<h1>You&#39;ve been unsubscribed</h1>
<p>You have been removed from <strong>${esc(siteName)}</strong>&#39;s mailing list.</p>
<p style="color:#888;font-size:13px">${esc(email)}</p>
</body></html>`
}

export function renderPreferencesPage(
  siteName: string,
  email: string,
  token: string,
  runtimeBase: string,
  allLists: Array<{ id: string; name: string; description: string }>,
  subscribedListIds: string[],
): string {
  const saveUrl = `${runtimeBase}/preferences/${token}/save`
  const subscribedSet = new Set(subscribedListIds)

  const checkboxes = allLists
    .map(
      (list) =>
        `<label style="display:block;margin:8px 0;cursor:pointer">
      <input type="checkbox" name="listId" value="${esc(list.id)}"${subscribedSet.has(list.id) ? ' checked' : ''}>
      <strong>${esc(list.name)}</strong>
      ${list.description ? `<span style="color:#888;font-size:13px"> — ${esc(list.description)}</span>` : ''}
    </label>`,
    )
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Email preferences</title>
<style>body{font-family:Arial,sans-serif;max-width:480px;margin:60px auto;color:#222;padding:0 16px}
h1{font-size:1.4rem}p{color:#555}
.btn{display:inline-block;padding:10px 20px;background:#111;color:#fff;border:none;border-radius:4px;font-size:14px;cursor:pointer}</style>
</head>
<body>
<h1>Email preferences</h1>
<p>Managing subscriptions for <strong>${esc(email)}</strong> at <strong>${esc(siteName)}</strong>.</p>
<form method="GET" action="${saveUrl}">
  <input type="hidden" name="email" value="${esc(email)}">
  ${checkboxes || '<p style="color:#888">No mailing lists available.</p>'}
  <p><button type="submit" class="btn">Save preferences</button></p>
</form>
<p><a href="${runtimeBase}/unsubscribe?token=${encodeURIComponent(token)}" style="color:#888;font-size:13px">Unsubscribe from all emails</a></p>
</body></html>`
}

export function renderPreferencesSavedPage(siteName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Preferences saved</title>
<style>body{font-family:Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#222}</style>
</head>
<body>
<h1>Preferences saved</h1>
<p>Your email preferences for <strong>${esc(siteName)}</strong> have been updated.</p>
</body></html>`
}

export function renderAlreadySubscribedPage(siteName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Already subscribed</title>
<style>body{font-family:Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#222}</style>
</head>
<body>
<h1>Already subscribed</h1>
<p>That email address is already subscribed to <strong>${esc(siteName)}</strong>.</p>
</body></html>`
}

export function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Error</title>
<style>body{font-family:Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#222}</style>
</head>
<body>
<h1>Something went wrong</h1>
<p>${esc(message)}</p>
</body></html>`
}
