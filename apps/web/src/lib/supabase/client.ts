// Browser (client-component) Supabase client.
// One shared instance per browser tab. Respects RLS as the signed-in user.
import { createBrowserClient } from '@supabase/ssr';
// All app tables live in the dedicated "podcast" schema.
import type { PodcastClient, PodcastDatabase } from '@/lib/supabase/types';
import { SESSION_ONLY_COOKIE, type CookieOptions, applySessionOnly } from '@/lib/supabase/cookie-options';

export type { PodcastClient };

let browserClient: PodcastClient | undefined;

function readCookies(): Array<{ name: string; value: string }> {
  // Client components are also rendered on the server, where there is no
  // document and no session to read.
  if (typeof document === 'undefined' || !document.cookie) return [];
  return document.cookie.split('; ').map((pair) => {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    const raw = eq === -1 ? '' : pair.slice(eq + 1);
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      /* keep the raw value */
    }
    return { name, value };
  });
}

function writeCookie(name: string, value: string, options: CookieOptions) {
  if (typeof document === 'undefined') return;
  const o = (options ?? {}) as Record<string, unknown>;
  let cookie = `${name}=${encodeURIComponent(value)}; Path=${(o.path as string) ?? '/'}`;
  if (typeof o.maxAge === 'number') cookie += `; Max-Age=${Math.floor(o.maxAge)}`;
  if (o.expires) cookie += `; Expires=${new Date(o.expires as string | number | Date).toUTCString()}`;
  if (o.domain) cookie += `; Domain=${o.domain as string}`;
  if (o.sameSite) cookie += `; SameSite=${o.sameSite === true ? 'Strict' : String(o.sameSite)}`;
  if (o.secure) cookie += '; Secure';
  document.cookie = cookie;
}

/**
 * The browser refreshes the session on its own (autoRefreshToken), and
 * @supabase/ssr's built-in document.cookie writer always stamps a 400-day
 * Max-Age — ignoring `cookieOptions`. Left alone it undid an unticked
 * "Remember me" about an hour after sign-in, at the first refresh. So the
 * browser gets the same rule as the server writers (lib/supabase/server.ts,
 * middleware.ts): with the marker cookie present, auth cookies are session
 * cookies.
 */
export function createClient(): PodcastClient {
  if (browserClient) return browserClient;
  browserClient = createBrowserClient<PodcastDatabase, 'podcast'>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: 'podcast' },
      cookies: {
        getAll: readCookies,
        setAll(cookies: Array<{ name: string; value: string; options?: CookieOptions }>) {
          const sessionOnly = readCookies().some(
            (c) => c.name === SESSION_ONLY_COOKIE && c.value === '1',
          );
          for (const { name, value, options } of cookies) {
            // A removal (maxAge 0) must keep its lifetime, or it would not delete.
            const removal = (options as { maxAge?: number } | undefined)?.maxAge === 0;
            writeCookie(name, value, removal ? options : applySessionOnly(options, sessionOnly));
          }
        },
      },
    },
  );
  return browserClient;
}
