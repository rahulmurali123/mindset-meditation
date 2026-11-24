// The database half of the admin second factor (migration 038).
//
// The signed mm_admin_verified cookie only ever protected the Next.js UI: the
// database's is_admin() checked the role alone, so a leaked admin password was
// enough to get a token from Supabase Auth and edit content through PostgREST
// directly. Now a passed verification is also recorded in
// podcast.admin_sessions, keyed by the Supabase session it belongs to, and
// is_admin() requires that row. Server-only: it uses the service role.
import { createAdminClient } from '@/lib/supabase/admin';
import { logSupabaseError } from '@/lib/supabase/errors';

/**
 * The `session_id` claim of a Supabase access token.
 *
 * Read without verifying the signature, which is safe only because every
 * caller has just validated this same token with auth.getUser() — the claim is
 * used to name the session, never to authenticate it.
 */
export function sessionIdFromToken(accessToken: string | undefined | null): string | null {
  const payload = accessToken?.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      session_id?: unknown;
    };
    return typeof json.session_id === 'string' ? json.session_id : null;
  } catch {
    return null;
  }
}

/** Records that this session passed the code, for as long as the cookie lasts. */
export async function recordAdminSession(
  userId: string,
  sessionId: string,
  ttlSeconds: number,
): Promise<boolean> {
  const admin = createAdminClient();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const { error } = await admin
    .from('admin_sessions')
    .upsert({ session_id: sessionId, user_id: userId, expires_at: expiresAt });
  if (error) {
    // Migration 038 not applied yet: nothing to record, and is_admin() does
    // not ask for it either. Reporting failure here would lock the admin out
    // of a deploy that simply ran ahead of its migration.
    if (error.code === 'PGRST205' || error.code === '42P01') return true;
    logSupabaseError('admin-session', error);
    return false;
  }
  // Housekeeping: expired rows grant nothing, so they only take up space.
  await admin
    .from('admin_sessions')
    .delete()
    .lt('expires_at', new Date().toISOString());
  return true;
}

/**
 * Whether the database will treat this session as admin.
 *
 * 'missing-table' when migration 038 has not been applied yet: the app then
 * falls back to the cookie alone, exactly as before, so deploying the code
 * first does not lock the admin out.
 */
export async function adminSessionLive(
  userId: string,
  sessionId: string | null,
): Promise<boolean | 'missing-table' | 'unavailable'> {
  if (!sessionId) return false;
  const { data, error } = await createAdminClient()
    .from('admin_sessions')
    .select('session_id')
    .eq('session_id', sessionId)
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') return 'missing-table';
    logSupabaseError('admin-session', error);
    return 'unavailable';
  }
  return Boolean(data);
}

/** Ends this session's admin rights in the database. Best-effort. */
export async function forgetAdminSession(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  const { error } = await createAdminClient()
    .from('admin_sessions')
    .delete()
    .eq('session_id', sessionId);
  if (error && error.code !== 'PGRST205' && error.code !== '42P01') {
    logSupabaseError('admin-session', error);
  }
}
