/**
 * In-memory sliding-window rate limiter for code-guessing endpoints (2FA).
 * Per-instance only — good enough while the app runs as a single App Hosting
 * container; revisit if we ever scale out.
 */

const buckets = new Map<string, number[]>();
const MAX_BUCKETS = 10_000;

/** Returns true when the call is allowed, false when the key is over budget. */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;

  const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return false;
  }

  hits.push(now);
  buckets.set(key, hits);

  if (buckets.size > MAX_BUCKETS) {
    for (const [k, v] of buckets) {
      if (v.every((t) => t <= cutoff)) buckets.delete(k);
    }
  }
  return true;
}
