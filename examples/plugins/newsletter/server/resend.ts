/**
 * Resend API client + HMAC-SHA256 webhook verification.
 *
 * Runs inside the QuickJS-WASM sandbox — no Node/Bun globals. Crypto comes
 * from the sandbox's `crypto.subtle` bridge. `TextEncoder` is absent in
 * QuickJS, so `utf8()` encodes strings by hand (same pattern as s3-storage).
 */

// ---------------------------------------------------------------------------
// Byte utilities
// ---------------------------------------------------------------------------

/** UTF-8 encode a string — QuickJS has no TextEncoder. */
function utf8(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(++i)
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (next & 0x3ff))
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      )
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return new Uint8Array(out)
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

/** Decode a base64 string to bytes without relying on `atob`. */
function base64ToBytes(b64: string): Uint8Array {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = b64.replace(/=+$/, '').replace(/[^A-Za-z0-9+/]/g, '')
  const output: number[] = []
  let acc = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    const val = table.indexOf(clean[i])
    if (val < 0) continue
    acc = (acc << 6) | val
    bits += 6
    if (bits >= 8) {
      bits -= 8
      output.push((acc >> bits) & 0xff)
    }
  }
  return new Uint8Array(output)
}

async function hmacSha256(key: string | Uint8Array, data: string): Promise<string> {
  const keyBytes = typeof key === 'string' ? utf8(key) : key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign({ name: 'HMAC' }, cryptoKey, utf8(data))
  return bytesToHex(new Uint8Array(sig))
}

// ---------------------------------------------------------------------------
// Token generation (Math.random — no crypto.getRandomValues in QuickJS)
// ---------------------------------------------------------------------------

export function generateToken(): string {
  const t = Date.now().toString(36)
  const r1 = Math.floor(Math.random() * 0xffffffff).toString(36).padStart(7, '0')
  const r2 = Math.floor(Math.random() * 0xffffffff).toString(36).padStart(7, '0')
  const r3 = Math.floor(Math.random() * 0xffffffff).toString(36).padStart(7, '0')
  return `${t}${r1}${r2}${r3}`
}

// ---------------------------------------------------------------------------
// Resend API — single email
// ---------------------------------------------------------------------------

export interface SendEmailParams {
  to: string
  subject: string
  html: string
  text?: string
  from: string
}

export interface ResendEmailResult {
  id: string
}

export async function sendEmail(
  params: SendEmailParams,
  apiKey: string,
): Promise<ResendEmailResult> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: params.from,
      to: [params.to],
      subject: params.subject,
      html: params.html,
      ...(params.text ? { text: params.text } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Resend API error ${res.status}: ${body}`)
  }
  return (await res.json()) as ResendEmailResult
}

// ---------------------------------------------------------------------------
// Resend API — batch emails (up to 100 per request; we chunk at 50)
// ---------------------------------------------------------------------------

export interface BatchMessage {
  to: string
  subject: string
  html: string
  text?: string
  from: string
}

export interface BatchResult {
  data: Array<{ id: string }>
}

export async function sendBatch(messages: BatchMessage[], apiKey: string): Promise<BatchResult> {
  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      messages.map((m) => ({
        from: m.from,
        to: [m.to],
        subject: m.subject,
        html: m.html,
        ...(m.text ? { text: m.text } : {}),
      })),
    ),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Resend batch API error ${res.status}: ${body}`)
  }
  return (await res.json()) as BatchResult
}

// ---------------------------------------------------------------------------
// Webhook signature verification (Svix / Resend)
//
// Resend routes webhooks via Svix. The signed content is:
//   "<svix-id>.<svix-timestamp>.<rawBody>"
// The signing secret starts with "whsec_" and is base64-encoded.
// ---------------------------------------------------------------------------

export async function verifyWebhookSignature(
  rawBody: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  secret: string,
): Promise<boolean> {
  const secretBase64 = secret.startsWith('whsec_') ? secret.slice(6) : secret
  const secretBytes = base64ToBytes(secretBase64)
  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`
  const expected = await hmacSha256(secretBytes, toSign)

  // svixSignature may be "v1,<hex1> v1,<hex2>" — any match is a pass.
  const sigs = svixSignature.split(' ')
  for (const sig of sigs) {
    const [, hex] = sig.split(',')
    if (hex === expected) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export const __testing = { utf8, bytesToHex, base64ToBytes, hmacSha256, generateToken }
