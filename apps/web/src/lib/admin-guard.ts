// The "is this caller an admin?" check, in one place.
//
// The admin layout and every /api/admin route were each repeating the same
// three steps — fetch the user, look up the role, verify the second-factor
// cookie — which meant three Supabase round-trips per admin page view and a
// 20-line preamble that had to stay in sync across files.
//
// React's cache() collapses repeat calls within a single request, so the layout
// and a route handler running in the same render share one result.
//
// Deliberately NOT in lib/admin-verify.ts: that module is imported by Edge
// middleware, and next/headers is not available there.
import { cache } from 'react';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import {
  ADMIN_COOKIE,
  adminCookieOptions,
  adminIsVerified,
  issueToken,
  tokenExpiresAt,
} from '@/lib/admin-verify';
import { logSupabaseError } from '@/lib/supabase/errors';
import { adminSessionLive, recordAdminSession, sessionIdFromToken } from '@/lib/admin-session';

export type AdminDenial = 'unauthenticated' | 'forbidden' | 'unverified' | 'unavailable';

export interface AdminCheck {
  ok: boolean;
  userId?: string;
  reason?: AdminDenial;
}

export const checkAdmin = cache(async (): Promise<AdminCheck> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'unauthenticated' };

  const { data: role, error: roleError } = await supabase.rpc('get_user_role', {
    p_user_id: user.id,
  });
  // An outage, not a verdict — see middleware.ts.
  if (roleError) {
    logSupabaseError('admin-guard', roleError);
    return { ok: false, userId: user.id, reason: 'unavailable' };
  }
  if (role !== 'admin' && role !== 'super_admin') {
    return { ok: false, userId: user.id, reason: 'forbidden' };
  }

  // Second factor, checked here rather than in middleware because the signing
  // key is a non-public env var and Next does not expose those to the Edge
  // runtime — see the note in middleware.ts.
  const store = await cookies();
  const verified = await adminIsVerified(store.get(ADMIN_COOKIE)?.value, user.id);
  if (!verified) return { ok: false, userId: user.id, reason: 'unverified' };

  // The cookie must also be backed by a verified session in the database —
  // otherwise RLS (is_admin(), migration 038) refuses every admin query and
  // the dashboard would load empty. This is the case for a cookie issued
  // before 038 was applied, so those admins are simply asked for the code again.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const live = await adminSessionLive(user.id, sessionIdFromToken(session?.access_token));
  if (live === 'unavailable') return { ok: false, userId: user.id, reason: 'unavailable' };
  if (live === false) return { ok: false, userId: user.id, reason: 'unverified' };

  return { ok: true, userId: user.id };
});

/** HTTP status + message for an API route to return on a denial. */
export const ADMIN_DENIAL_RESPONSE: Record<AdminDenial, { status: number; error: string }> = {
  unauthenticated: { status: 401, error: 'Unauthorized' },
  forbidden: { status: 403, error: 'Forbidden' },
  unverified: { status: 403, error: 'Admin verification required' },
  unavailable: { status: 503, error: 'Service unavailable' },
};

/**
 * Below this much remaining verification, starting an upload renews it.
 *
 * The code is good for 12 hours from when it was entered, and every step of
 * an upload — including the final "complete" after the last byte — is
 * admin-gated. A 3-hour episode started at hour 11 used to transfer in full
 * and then be refused at completion, discarding the whole file.
 */
const RENEW_BELOW_MS = 6 * 60 * 60 * 1000;

/**
 * Slides an already-verified admin's verification forward, so long work they
 * have just started cannot outlive it. Call only after checkAdmin() passed —
 * this never grants verification, it only extends one that is live.
 * Best-effort: on any failure the existing verification simply stands.
 */
export async function renewAdminVerification(userId: string): Promise<void> {
  const store = await cookies();
  const expires = tokenExpiresAt(store.get(ADMIN_COOKIE)?.value);
  if (expires !== null && expires - Date.now() > RENEW_BELOW_MS) return;

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const sessionId = sessionIdFromToken(session?.access_token);
  if (!sessionId) return;

  const token = await issueToken(userId);
  if (!(await recordAdminSession(userId, sessionId, token.maxAge))) return;
  store.set(ADMIN_COOKIE, token.value, adminCookieOptions(token.maxAge));
}
