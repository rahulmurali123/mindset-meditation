// Readiness probe for the deploy script and uptime monitors.
//
// Answers one question per dependency, as booleans only — no versions, keys,
// hostnames or error text, since this route is public. The server log carries
// the detail (see lib/supabase/errors.ts).
//
// It exists because the worst outage this app has had was invisible from the
// outside: the homepage kept serving its cached copy while the podcast schema
// had dropped off Supabase's Data API, so every sign-in and upload failed with
// a misleading message. `schema: false` here names that failure immediately.
import { NextResponse } from 'next/server';
import { verificationCode } from '@/lib/admin-verify';
import { smtpConfigured } from '@/lib/mailer';
import { r2Configured } from '@/lib/r2';
import { createAdminClient } from '@/lib/supabase/admin';
import { logSupabaseError } from '@/lib/supabase/errors';
import { createPublicClient } from '@/lib/supabase/public';

export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 5_000;
// The route is public and each run makes three Supabase calls, one with the
// service role. Reusing a recent answer keeps a burst of hits from turning
// into a burst of upstream requests, and is still fresh enough for a deploy
// script or an uptime monitor.
const CACHE_MS = 10_000;

type Health = { ok: boolean; checks: Record<string, boolean> };
let cached: { at: number; value: Health } | null = null;
let inFlight: Promise<Health> | null = null;

async function check(name: string, fn: () => Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.error(`[health] ${name} check threw:`, err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runChecks(): Promise<Health> {
  const [schema, serviceRole, auth] = await Promise.all([
    // The anon key reading a public table through the podcast schema: the exact
    // path every visitor's page load takes.
    check('schema', async () => {
      // A 1-row GET, not a HEAD count: HEAD responses carry no body, so a
      // failure came back without the PGRST106 code that names the fix.
      const { error } = await createPublicClient().from('tracks').select('id').limit(1);
      if (error) logSupabaseError('health', error);
      return !error;
    }),
    // The service-role key, which sign-up, username sign-in and playback use.
    check('serviceRole', async () => {
      const { error } = await createAdminClient().from('profiles').select('id').limit(1);
      if (error) logSupabaseError('health', error);
      return !error;
    }),
    check('auth', async () => {
      const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`, {
        headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '' },
        cache: 'no-store',
      });
      return res.ok;
    }),
  ]);

  const checks = {
    schema,
    serviceRole,
    auth,
    adminCode: verificationCode() !== null,
    // Configuration presence only. Without R2, audio falls back to Supabase
    // Storage, and without SMTP only password reset and the contact form stop
    // — neither takes the site down, so neither fails the probe.
    r2: r2Configured(),
    smtp: smtpConfigured(),
  };
  const ok = checks.schema && checks.serviceRole && checks.auth && checks.adminCode;
  return { ok, checks };
}

export async function GET() {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    inFlight ??= runChecks().finally(() => {
      inFlight = null;
    });
    cached = { at: Date.now(), value: await inFlight };
  }
  const { ok, checks } = cached.value;

  return NextResponse.json(
    { ok, checks },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
