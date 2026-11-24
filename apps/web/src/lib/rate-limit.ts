// Fixed-window request throttling for the public, unauthenticated endpoints:
// sign-up, sign-in, password reset, the contact form, comments and play counts.
//
// In-process and per-instance, which matches the deployment (one standalone
// server behind nginx). Behind several instances this would need a shared
// store; until then it still blunts a script hammering one box.
//
// Each bucket prunes itself, so a stream of one-off keys (a different email on
// every request) can't grow the map without bound — the contact form's old
// Map<email, timestamps[]> never dropped a key.

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Map<string, Window>>();
const MAX_KEYS_PER_BUCKET = 10_000;

/** Drops expired windows, then — if still full — the oldest insertions. */
function prune(windows: Map<string, Window>, now: number) {
  for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
  const excess = windows.size - MAX_KEYS_PER_BUCKET + 1;
  if (excess <= 0) return;
  const oldest = [...windows.keys()].slice(0, excess);
  for (const k of oldest) windows.delete(k);
}

/**
 * Records one hit for `key` in `bucket` and reports whether it is over `limit`
 * within `windowMs`. Every call counts, including refused ones, so retrying
 * while limited does not shorten the wait.
 */
export function rateLimit(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number,
): { limited: boolean; retryAfterMs: number } {
  const now = Date.now();
  let windows = buckets.get(bucket);
  if (!windows) {
    windows = new Map();
    buckets.set(bucket, windows);
  }

  if (windows.size >= MAX_KEYS_PER_BUCKET) prune(windows, now);

  let w = windows.get(key);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + windowMs };
    windows.set(key, w);
  }
  w.count += 1;
  return { limited: w.count > limit, retryAfterMs: Math.max(0, w.resetAt - now) };
}

/** "3 minutes" / "1 minute" / "40 seconds", for a limited caller's message. */
export function waitText(ms: number): string {
  if (ms < 60_000) {
    const s = Math.max(1, Math.ceil(ms / 1000));
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  const m = Math.ceil(ms / 60_000);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/**
 * The caller's IP as nginx saw it.
 *
 * DEPLOY.md's proxy sets `X-Forwarded-For $proxy_add_x_forwarded_for`, which
 * APPENDS the real peer address to whatever the client sent. The first entry
 * is therefore client-controlled and the last one is not — reading the first
 * would let anyone pick a fresh "IP" per request and walk straight past every
 * limit here.
 *
 * X-Real-IP is only a fallback. It used to win outright, but DEPLOY.md's proxy
 * never sets it, and nginx forwards a client-sent header untouched — so any
 * script could send a random X-Real-IP per request and get a fresh bucket for
 * sign-up, sign-in, password reset, the contact form and play counting.
 */
export function clientIp(headers: Headers): string {
  const chain = headers.get('x-forwarded-for');
  if (chain) {
    const hops = chain
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return headers.get('x-real-ip')?.trim() || 'unknown';
}
