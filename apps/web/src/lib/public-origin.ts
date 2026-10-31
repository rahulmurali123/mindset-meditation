// The site's public origin, and the host a request actually arrived on.
//
// Behind a reverse proxy the standalone server builds `request.nextUrl` from its
// own bind address, so cloning it for a redirect sends the browser to
// https://localhost:3100/… — a dead URL. Redirects are built here instead, from
// the Host header nginx forwards.
//
// The Host header is client-controlled, so it is only trusted when it names
// this site. Anything else falls back to SITE_URL rather than becoming an open
// redirect to whatever host the request claimed.
//
// Edge-safe: no node: imports, nothing beyond NEXT_PUBLIC_* env.

export const SITE_URL = (
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://themindsetmeditation.com'
).replace(/\/$/, '');

const SITE = new URL(SITE_URL);
const APEX = SITE.hostname.replace(/^www\./, '');

function isLocal(name: string): boolean {
  return name === 'localhost' || name === '127.0.0.1';
}

function trustedHost(host: string): boolean {
  const name = host.split(':')[0].toLowerCase();
  if (name === APEX || name === `www.${APEX}`) return true;
  return process.env.NODE_ENV !== 'production' && isLocal(name);
}

/** The host the visitor used, when it is one of ours; otherwise null. */
export function requestHost(headers: Headers): string | null {
  const host = (headers.get('x-forwarded-host') ?? headers.get('host'))?.split(',')[0].trim();
  return host && trustedHost(host) ? host : null;
}

/** Origin the visitor is on (`https://www.example.com`), falling back to SITE_URL. */
export function publicOrigin(headers: Headers): string {
  const host = requestHost(headers);
  if (!host) return SITE_URL;
  // Our own domains always use SITE_URL's scheme. X-Forwarded-Proto can't be
  // trusted for this: when the proxy omits it, Next fills it in as "http"
  // from its own plain-HTTP listener, which would downgrade the redirect.
  if (!isLocal(host.split(':')[0].toLowerCase())) return `${SITE.protocol}//${host}`;
  const forwarded = headers.get('x-forwarded-proto')?.split(',')[0].trim();
  return `${forwarded === 'https' ? 'https' : 'http'}://${host}`;
}

/** Absolute URL for `pathname` on the visitor's own origin. */
export function publicUrl(
  headers: Headers,
  pathname: string,
  params?: Record<string, string>,
): URL {
  const url = new URL(pathname, publicOrigin(headers));
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url;
}
