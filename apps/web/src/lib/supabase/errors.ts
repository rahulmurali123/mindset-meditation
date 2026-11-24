// Turns a Supabase/PostgREST failure into (a) a log line that names the fix and
// (b) a message that is safe to show a visitor.
//
// The distinction matters because the auth flow used to read `data` and ignore
// `error`: when the podcast schema dropped off the Data API's exposed list,
// every username lookup "found nothing" and the login form told real users
// their password was wrong.

export const SERVICE_UNAVAILABLE = 'Sign-in is temporarily unavailable. Please try again shortly.';

interface SupabaseLikeError {
  code?: string;
  message?: string;
  status?: number;
}

/** What an operator needs to do about this error, for the server log. */
export function describeSupabaseError(error: SupabaseLikeError): string {
  const code = error.code ?? '';
  const message = error.message ?? '';

  if (code === 'PGRST106' || /invalid schema/i.test(message)) {
    return 'The "podcast" schema is not exposed by the Supabase Data API. Supabase Dashboard -> Project Settings -> Data API -> Exposed schemas: add "podcast" and save.';
  }
  if (code === 'PGRST205' || code === 'PGRST202' || code === '42P01' || code === '42883') {
    return `A table or function the app expects is missing (${code}): ${message}. Run fullschema.sql or the pending migrations/*.sql files.`;
  }
  if (/invalid api key|jwt|apikey/i.test(message) || error.status === 401) {
    return `Supabase rejected the API key: ${message}. Check NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY belong to the same project as NEXT_PUBLIC_SUPABASE_URL.`;
  }
  if (/rate limit/i.test(message) || error.status === 429) {
    return `Supabase rate limit reached: ${message}.`;
  }
  return `${code ? `${code}: ` : ''}${message || 'unknown Supabase error'}`;
}

/** Logs the operator-facing description under `scope`. */
export function logSupabaseError(scope: string, error: SupabaseLikeError): void {
  console.error(`[${scope}] ${describeSupabaseError(error)}`);
}

/**
 * For cached (ISR) pages and feeds: refuse to render a catalogue we could not
 * read.
 *
 * These pages used to ignore `error` and render the empty result. During an
 * outage that empty render then replaced the good cached copy — the homepage
 * said "no episodes", and /feed.xml went out with zero items to every podcast
 * directory polling it, which is how episodes get dropped from Apple/Spotify.
 * Throwing instead makes Next keep serving the last good version until a
 * revalidation succeeds.
 *
 * During `next build` it throws too, failing the build: a release built while
 * Supabase is unreachable would otherwise ship an empty catalogue, and
 * scripts/deploy.sh keeps the live release when the build fails. The one
 * exception is CI (CI=true), which builds against a placeholder project on
 * purpose and never deploys what it builds.
 */
export function throwIfUnavailable(scope: string, error: SupabaseLikeError | null): void {
  if (!error) return;
  logSupabaseError(scope, error);
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    if (process.env.CI === 'true') return;
    throw new Error(
      `[${scope}] Supabase could not be read during the build — refusing to bake an empty catalogue into this release. Check /api/health on the live site and the Supabase project, then build again.`,
    );
  }
  throw new Error(`[${scope}] catalogue unavailable — keeping the cached version`);
}
