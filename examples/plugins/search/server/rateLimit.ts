/**
 * IP-hash rate limiter — 60 requests per minute per client IP.
 *
 * Runs inside the QuickJS sandbox (no crypto.subtle.digest needed — we use
 * a simple DJB2 hash over the IP string, which is good enough for bucketing
 * without being a privacy-preserving hash). The bucket window resets every
 * minute on a rolling basis.
 *
 * Usage:
 *   const limiter = createRateLimiter({ maxPerMinute: 60 })
 *   const result = limiter.check(clientIp)
 *   if (result.limited) {
 *     // return 429 with result.retryAfterSeconds
 *   }
 */

export interface RateLimitResult {
  limited: boolean
  /** Seconds the caller should wait before retrying (only meaningful when limited=true). */
  retryAfterSeconds: number
}

interface Bucket {
  count: number
  windowStart: number // epoch ms of the window's opening
}

export interface RateLimiter {
  check(ip: string): RateLimitResult
}

export interface RateLimiterOptions {
  /** Max requests per 60-second window. Default: 60. */
  maxPerMinute?: number
}

/**
 * Non-cryptographic DJB2 hash — maps any string to a 32-bit unsigned integer.
 * Used purely as a bucket key so we don't store raw IPs.
 */
function djb2Hash(s: string): number {
  let hash = 5381
  for (let i = 0; i < s.length; i++) {
    // Bitwise ops wrap at 32 bits — that's intentional.
    hash = ((hash << 5) + hash) ^ s.charCodeAt(i)
  }
  return hash >>> 0 // ensure unsigned
}

const WINDOW_MS = 60_000 // 1 minute

/**
 * Create a rate limiter. The state lives in module scope so it persists across
 * multiple requests within one sandbox activation cycle.
 *
 * Buckets are pruned whenever a new request comes in from a different IP — the
 * map never grows beyond O(concurrent unique IPs) in a 2-minute window.
 */
export function createRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
  const max = opts.maxPerMinute ?? 60
  const buckets = new Map<number, Bucket>()
  let lastPruneAt = Date.now()

  function prune(now: number): void {
    // Only prune once per minute to avoid iterating on every request.
    if (now - lastPruneAt < WINDOW_MS) return
    lastPruneAt = now
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStart >= WINDOW_MS * 2) {
        buckets.delete(key)
      }
    }
  }

  function check(ip: string): RateLimitResult {
    const now = Date.now()
    prune(now)

    const key = djb2Hash(ip)
    const existing = buckets.get(key)

    if (!existing || now - existing.windowStart >= WINDOW_MS) {
      // New window.
      buckets.set(key, { count: 1, windowStart: now })
      return { limited: false, retryAfterSeconds: 0 }
    }

    existing.count++
    if (existing.count > max) {
      const windowEndsAt = existing.windowStart + WINDOW_MS
      const retryAfterSeconds = Math.ceil((windowEndsAt - now) / 1000)
      return { limited: true, retryAfterSeconds: Math.max(1, retryAfterSeconds) }
    }

    return { limited: false, retryAfterSeconds: 0 }
  }

  return { check }
}
