/**
 * Forms Builder — spam protection helpers.
 *
 * Three independent layers:
 *   1. `honeypotFailed`  — any `_hp_*` field with a non-empty value → bot.
 *   2. `consume`         — in-memory sliding-window IP rate limiter.
 *   3. `verifyTurnstile` — Cloudflare Turnstile token verification.
 *
 * All run inside the QuickJS sandbox — no Node/Bun APIs used.
 */

// ---------------------------------------------------------------------------
// Honeypot
// ---------------------------------------------------------------------------

/**
 * Returns true if ANY field whose name begins with `_hp_` is non-empty.
 * A non-empty honeypot means a bot filled the hidden field.
 */
export function honeypotFailed(body: Record<string, unknown>): boolean {
  for (const key of Object.keys(body)) {
    if (key.startsWith('_hp_')) {
      const val = body[key]
      if (val !== '' && val !== null && val !== undefined) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// In-memory sliding-window rate limiter
// ---------------------------------------------------------------------------

// Map<ipHash, timestamp[]> — timestamps of requests within the window.
const _windows = new Map<string, number[]>()
const WINDOW_MS = 60_000

/**
 * Returns true if the given `ipHash` is WITHIN the rate limit (i.e. allowed).
 * Returns false if the limit has been exceeded and the request should be blocked.
 *
 * `limit` is the max number of submissions allowed per WINDOW_MS.
 */
export function consume(ipHash: string, limit: number): boolean {
  const now = Date.now()
  const cutoff = now - WINDOW_MS
  const timestamps = (_windows.get(ipHash) ?? []).filter((t) => t > cutoff)
  if (timestamps.length >= limit) return false
  timestamps.push(now)
  _windows.set(ipHash, timestamps)
  return true
}

// ---------------------------------------------------------------------------
// Turnstile verification
// ---------------------------------------------------------------------------

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * Verifies a Cloudflare Turnstile `cf-turnstile-response` token against the
 * server-side secret. Returns `true` if the challenge passed.
 *
 * Requires `network.outbound` permission and `challenges.cloudflare.com` in
 * `networkAllowedHosts`.
 */
export async function verifyTurnstile(token: string, secret: string): Promise<boolean> {
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`,
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch (_err) {
    // Network failure or timeout — treat as unverified to fail safe
    return false
  }
}
