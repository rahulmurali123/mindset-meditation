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
