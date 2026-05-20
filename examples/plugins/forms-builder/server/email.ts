/**
 * Forms Builder — email delivery.
 *
 * Single `sendSubmissionEmail` function that dispatches to the configured
 * provider (Resend / Postmark / Mailgun). Retries once on 5xx. Any failure
 * after the retry throws so the caller can mark the submission as failed.
 *
 * Runs inside the QuickJS sandbox — no Node/Bun APIs, just `fetch`.
 */

export interface EmailSettings {
  provider: 'resend' | 'postmark' | 'mailgun'
  apiKey: string
  mailgunDomain?: string
  fromAddress: string
  defaultToAddress: string
  subjectTemplate: string
}

export interface SubmissionEmailData {
  formName: string
  formId: string
  pagePath: string
  submittedAt: string
  fields: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSubject(template: string, formName: string): string {
  return template.replace(/\{\{form_name\}\}/g, formName)
}

function buildPlainText(data: SubmissionEmailData): string {
  const lines: string[] = [
    `Form: ${data.formName} (${data.formId})`,
    `Page: ${data.pagePath}`,
    `Submitted: ${data.submittedAt}`,
    '',
    'Fields:',
  ]
  for (const [key, value] of Object.entries(data.fields)) {
    lines.push(`  ${key}: ${String(value ?? '')}`)
  }
  return lines.join('\n')
}

function buildHtml(data: SubmissionEmailData): string {
  const rows = Object.entries(data.fields)
    .map(([k, v]) => `<tr><td style="padding:4px 8px;font-weight:500;">${k}</td><td style="padding:4px 8px;">${String(v ?? '')}</td></tr>`)
    .join('')
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#222;max-width:600px;">
<h2 style="margin-bottom:4px;">New submission: ${data.formName}</h2>
<p style="margin:0 0 16px;color:#666;font-size:0.875rem;">Page: ${data.pagePath} — ${data.submittedAt}</p>
<table style="border-collapse:collapse;width:100%;">
  <tbody>${rows}</tbody>
</table>
</body></html>`
}

// ---------------------------------------------------------------------------
// Provider dispatch
// ---------------------------------------------------------------------------

async function sendResend(
  settings: EmailSettings,
  subject: string,
  text: string,
  htmlBody: string,
): Promise<Response> {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      from: settings.fromAddress,
      to: [settings.defaultToAddress],
      subject,
      text,
      html: htmlBody,
    }),
    signal: AbortSignal.timeout(10_000),
  })
}

async function sendPostmark(
  settings: EmailSettings,
  subject: string,
  text: string,
  htmlBody: string,
): Promise<Response> {
  return fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Postmark-Server-Token': settings.apiKey,
    },
    body: JSON.stringify({
      From: settings.fromAddress,
      To: settings.defaultToAddress,
      Subject: subject,
      TextBody: text,
      HtmlBody: htmlBody,
    }),
    signal: AbortSignal.timeout(10_000),
  })
}

async function sendMailgun(
  settings: EmailSettings,
  subject: string,
  text: string,
  htmlBody: string,
): Promise<Response> {
  const domain = settings.mailgunDomain ?? ''
  const body = new URLSearchParams({
    from: settings.fromAddress,
    to: settings.defaultToAddress,
    subject,
    text,
    html: htmlBody,
  })
  const credentials = btoa(`api:${settings.apiKey}`)
  return fetch(`https://api.mailgun.net/v3/${encodeURIComponent(domain)}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  })
}

async function dispatch(
  settings: EmailSettings,
  subject: string,
  text: string,
  htmlBody: string,
): Promise<Response> {
  switch (settings.provider) {
    case 'resend':
      return sendResend(settings, subject, text, htmlBody)
    case 'postmark':
      return sendPostmark(settings, subject, text, htmlBody)
    case 'mailgun':
      return sendMailgun(settings, subject, text, htmlBody)
    default:
      throw new Error(`[plugin:pagebuilder.forms] Unknown email provider: ${String(settings.provider)}`)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a submission notification email. Retries once (300ms gap) on 5xx
 * response. Throws on both attempts failing so the caller can mark the
 * submission as `failed`.
 */
export async function sendSubmissionEmail(
  data: SubmissionEmailData,
  settings: EmailSettings,
): Promise<void> {
  if (!settings.apiKey || !settings.fromAddress || !settings.defaultToAddress) {
    // Email not configured — skip silently rather than crashing the submission flow
    return
  }

  const subject = buildSubject(settings.subjectTemplate, data.formName)
  const text = buildPlainText(data)
  const htmlBody = buildHtml(data)

  let res: Response
  try {
    res = await dispatch(settings, subject, text, htmlBody)
  } catch (err) {
    throw new Error(
      `[plugin:pagebuilder.forms] Email send failed (${settings.provider}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  if (!res.ok && res.status >= 500) {
    // One retry with a short backoff
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    let retryRes: Response
    try {
      retryRes = await dispatch(settings, subject, text, htmlBody)
    } catch (err) {
      throw new Error(
        `[plugin:pagebuilder.forms] Email retry failed (${settings.provider}): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    if (!retryRes.ok) {
      throw new Error(
        `[plugin:pagebuilder.forms] Email delivery failed after retry (${settings.provider}): HTTP ${retryRes.status}`,
      )
    }
  } else if (!res.ok) {
    throw new Error(
      `[plugin:pagebuilder.forms] Email rejected by ${settings.provider}: HTTP ${res.status}`,
    )
  }
}
