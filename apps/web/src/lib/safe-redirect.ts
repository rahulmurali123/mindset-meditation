/**
 * Only same-origin relative paths may be redirected to.
 *
 * Without this, a link like `/auth/login?redirect=https://evil.com` would bounce
 * a freshly signed-in admin straight to an attacker's site — a ready-made
 * phishing hop that borrows this site's credibility. `//evil.com` is rejected
 * too: browsers read a protocol-relative URL as an absolute one.
 *
 * `fallback` is where to go when the target is missing or rejected.
 */
export function safeRedirect(target: string | null | undefined, fallback = '/'): string {
  if (!target || !target.startsWith('/') || target.startsWith('//')) return fallback;
  // Browsers read a backslash as "/" in a URL, so "/\evil.com" is "//evil.com"
  // by the time it is followed. The URL parser also strips tabs and newlines,
  // so "/<tab>/evil.com" collapses the same way.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
  if (/[\\\s\u0000-\u001f\u007f]/.test(target)) return fallback;
  return target;
}
