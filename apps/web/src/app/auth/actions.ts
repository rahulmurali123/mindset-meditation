'use server';

// Auth server actions. Sign-in runs here rather than in the browser so that a
// username can be resolved to its email without ever sending that email to the
// client (which would turn the login form into an email-harvesting endpoint).
import { cookies, headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  ADMIN_COOKIE,
  adminCookieOptions,
  codeMatches,
  issueToken,
  verificationCode,
} from '@/lib/admin-verify';
import { SESSION_ONLY_COOKIE } from '@/lib/supabase/cookie-options';
import { sendMail, smtpConfigured, passwordResetEmail, explainSmtpError } from '@/lib/mailer';
import { SITE_URL } from '@/lib/seo';
import { SERVICE_UNAVAILABLE, logSupabaseError } from '@/lib/supabase/errors';
import { clientIp, rateLimit, waitText } from '@/lib/rate-limit';
import { forgetAdminSession, recordAdminSession, sessionIdFromToken } from '@/lib/admin-session';

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Server actions are ordinary HTTP endpoints — anything can POST arbitrary
 * JSON at them, and these particular ones are reachable without a session. So
 * every field is coerced rather than trusted: reading `.trim()` off a missing
 * property throws an unhandled TypeError and 500s the endpoint.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Verification-code throttling, keyed by user id. In-process: it resets on
// deploy and is per-instance, which is fine for a single-server deployment.
// Behind several instances, move this to a table for a shared counter.
const MAX_CODE_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedAttempts = new Map<string, { count: number; at: number }>();

const HOUR = 60 * 60 * 1000;

/**
 * Per-IP and per-account throttles for the unauthenticated actions.
 *
 * Supabase rate-limits its own auth endpoints, but these actions call it with
 * the SERVICE ROLE (createUser, generateLink), which is exempt — so without a
 * limit here the sign-up form created accounts as fast as a script could post,
 * and "forgot password" would email any address on repeat through our own SMTP
 * account, burning its quota and its sender reputation.
 */
function throttled(
  scope: string,
  rules: Array<{ key: string; limit: number; windowMs: number }>,
): string | null {
  for (const rule of rules) {
    const { limited, retryAfterMs } = rateLimit(scope, rule.key, rule.limit, rule.windowMs);
    if (limited) return `Too many attempts. Please wait ${waitText(retryAfterMs)} and try again.`;
  }
  return null;
}

async function ipKey(): Promise<string> {
  return `ip:${clientIp(await headers())}`;
}

export interface AuthResult {
  error?: string;
  field?: 'username' | 'email' | 'password' | 'identifier' | 'code';
  ok?: boolean;
  /** Signup only: false when the account was created but auto sign-in failed. */
  signedIn?: boolean;
  /** True when the account is an admin and still owes the verification code. */
  needsAdminCode?: boolean;
}

export async function signUpAction(input: {
  username: string;
  email: string;
  password: string;
}): Promise<AuthResult> {
  const username = text(input?.username).toLowerCase();
  const email = text(input?.email).toLowerCase();
  const password = typeof input?.password === 'string' ? input.password : '';

  if (!USERNAME_RE.test(username)) {
    return {
      error: 'Username must be 3–20 characters, using only letters, numbers, or underscores.',
      field: 'username',
    };
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { error: 'Enter a valid email address.', field: 'email' };
  }
  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters.', field: 'password' };
  }
  // bcrypt, which Supabase hashes with, ignores everything past 72 bytes.
  if (new TextEncoder().encode(password).length > 72) {
    return { error: 'Password must be at most 72 characters.', field: 'password' };
  }

  // Lookups are cheap and a person may try several taken usernames in a row;
  // only an actual account creation (below) spends the tight 5-an-hour budget.
  // Charging every attempt locked people out after five taken names.
  const ip = await ipKey();
  const lookupsLimited = throttled('signup-check', [{ key: ip, limit: 40, windowMs: HOUR }]);
  if (lookupsLimited) return { error: lookupsLimited };

  const admin = createAdminClient();

  // Pre-check both fields so the user gets a precise message. Supabase itself
  // stays silent about existing emails to prevent enumeration, so without this
  // a duplicate signup looks like a success and goes nowhere.
  // eq, not ilike: "_" and "%" are LIKE wildcards, and usernames may contain
  // underscores — "sub_ash" would otherwise collide with "subhash". Both
  // columns are stored lowercased, so exact match is already case-insensitive.
  const [usernameLookup, emailLookup] = await Promise.all([
    admin.from('profiles').select('id').eq('username', username).maybeSingle(),
    admin.from('profiles').select('id').eq('email', email).maybeSingle(),
  ]);
  const lookupError = usernameLookup.error ?? emailLookup.error;
  if (lookupError) {
    logSupabaseError('auth/signup', lookupError);
    return { error: SERVICE_UNAVAILABLE };
  }
  const byUsername = usernameLookup.data;
  const byEmail = emailLookup.data;

  if (byUsername) {
    return { error: 'That username is already taken. Try another one.', field: 'username' };
  }
  if (byEmail) {
    return {
      error: 'An account with that email already exists. Sign in instead.',
      field: 'email',
    };
  }

  const limited = throttled('signup', [{ key: ip, limit: 5, windowMs: HOUR }]);
  if (limited) return { error: limited };

  // Created with the service role and `email_confirm: true`, which marks the
  // address as already verified. No confirmation email, no waiting — the user
  // signs up and is straight in. This also makes signup independent of the
  // Supabase dashboard's "Confirm email" toggle, so the behaviour is the same
  // on every environment.
  //
  // The on_auth_user_created_podcast trigger reads user_metadata.username to
  // build the profile row.
  const { error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, full_name: username },
  });

  if (createError) {
    const message = createError.message.toLowerCase();
    if (message.includes('already') || message.includes('registered')) {
      return {
        error: 'An account with that email already exists. Sign in instead.',
        field: 'email',
      };
    }
    logSupabaseError('auth/signup', createError);
    return { error: createError.message };
  }

  // Sign the new account in immediately so they land on the site, not a form.
  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

  // The account was created either way, so never report this as a failed
  // signup — just route them to the login form instead of a signed-out home.
  return { ok: true, signedIn: !signInError };
}

export async function signInAction(input: {
  identifier: string;
  password: string;
  /** Unticked "Remember me" ends the session when the browser closes. */
  remember?: boolean;
}): Promise<AuthResult> {
  const identifier = text(input?.identifier);
  const password = typeof input?.password === 'string' ? input.password : '';

  if (!identifier) return { error: 'Enter your username or email.', field: 'identifier' };
  if (!password) return { error: 'Enter your password.', field: 'password' };
  if (identifier.length > 254) {
    return { error: 'Incorrect username/email or password.', field: 'identifier' };
  }

  // Per IP, and per account *from that IP*: a credential-stuffing run spreads
  // one password list across many addresses, a targeted guess spreads many
  // passwords across one account. The account limit used to be global, so
  // anyone who knew the admin's email could send a few junk sign-ins every 15
  // minutes and keep the real admin locked out with the right password.
  // Guessing spread over many IPs is left to Supabase Auth's own limits.
  const ip = await ipKey();
  const limited = throttled('signin', [
    { key: ip, limit: 30, windowMs: 15 * 60 * 1000 },
    { key: `id:${identifier.toLowerCase()}:${ip}`, limit: 10, windowMs: 15 * 60 * 1000 },
  ]);
  if (limited) return { error: limited };

  // Written before signInWithPassword so the auth cookies it is about to set
  // are already subject to it — see lib/supabase/cookie-options.ts.
  const store = await cookies();
  if (input?.remember === false) {
    // Readable by the browser on purpose: the browser client rewrites the auth
    // cookies itself on token refresh and has to know to keep them
    // session-only (lib/supabase/client.ts). It is a preference, not a secret.
    store.set(SESSION_ONLY_COOKIE, '1', {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
  } else {
    store.delete(SESSION_ONLY_COOKIE);
  }

  let email = identifier.toLowerCase();

  // Not an email? Then it's a username — look up the address it belongs to.
  if (!identifier.includes('@')) {
    const admin = createAdminClient();
    const { data: profile, error: lookupError } = await admin
      .from('profiles')
      .select('email')
      .eq('username', identifier.toLowerCase())
      .maybeSingle();

    // A failed lookup is not "no such user" — reporting it as a wrong password
    // sends people hunting for a typo during an outage.
    if (lookupError) {
      logSupabaseError('auth/signin', lookupError);
      return { error: SERVICE_UNAVAILABLE };
    }

    // Deliberately the same message as a bad password, so this can't be used to
    // discover which usernames exist.
    if (!profile?.email) {
      return { error: 'Incorrect username/email or password.', field: 'identifier' };
    }
    email = profile.email;
  }

  const supabase = await createClient();
  let { data, error } = await supabase.auth.signInWithPassword({ email, password });

  // Retry without surrounding whitespace.
  //
  // The identifier is trimmed above but the password deliberately is not —
  // a password may legitimately contain spaces. In practice, though, leading
  // or trailing whitespace comes from a paste that grabbed one character too
  // many, or a phone keyboard adding a space after autofill, and the result is
  // an "incorrect password" the user cannot see the cause of.
  //
  // Trying the exact string first keeps genuine space-bearing passwords
  // working; the retry only happens when trimming would actually change the
  // string, so it costs nothing in the normal case.
  const trimmed = password.trim();
  if (error && trimmed && trimmed !== password) {
    ({ data, error } = await supabase.auth.signInWithPassword({ email, password: trimmed }));
  }

  if (error) {
    const message = error.message.toLowerCase();
    if (message.includes('not confirmed')) {
      return {
        error:
          'This account has not been verified. Use "Forgot password" to get a sign-in link by email.',
        field: 'identifier',
      };
    }
    if (message.includes('invalid login credentials')) {
      return { error: 'Incorrect username/email or password.', field: 'password' };
    }
    logSupabaseError('auth/signin', error);
    return { error: error.message };
  }

  // Admins owe a second factor. The password alone must not reach /admin.
  const userId = data.user?.id;
  if (userId) {
    const { data: role, error: roleError } = await supabase.rpc('get_user_role', {
      p_user_id: userId,
    });
    // Without the role we can't tell an admin from a listener. Signing the
    // admin in as a listener is what made /admin look permanently locked.
    if (roleError) {
      logSupabaseError('auth/signin', roleError);
      // Local: a transient lookup failure must not end this admin's sessions
      // on every other device.
      await supabase.auth.signOut({ scope: 'local' });
      return { error: SERVICE_UNAVAILABLE };
    }
    if (role === 'admin' || role === 'super_admin') {
      return { ok: true, needsAdminCode: true };
    }
  }

  return { ok: true };
}

/**
 * Second step of admin sign-in. Compares the entered code against
 * ADMIN_VERIFICATION_CODE server-side and, on success, sets a signed HttpOnly
 * cookie that middleware checks before serving anything under /admin.
 */
export async function verifyAdminCodeAction(input: { code: string }): Promise<AuthResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Session expired — sign in again.', field: 'code' };

  const { data: role, error: roleError } = await supabase.rpc('get_user_role', {
    p_user_id: user.id,
  });
  if (roleError) {
    logSupabaseError('auth/verify', roleError);
    return { error: SERVICE_UNAVAILABLE, field: 'code' };
  }
  if (role !== 'admin' && role !== 'super_admin') {
    return { error: 'This account is not an administrator.', field: 'code' };
  }

  // Fail closed: with no code configured, admin access stays shut rather than
  // silently falling back to password-only.
  if (!verificationCode()) {
    return {
      error: 'Admin verification is not configured. Set ADMIN_VERIFICATION_CODE in .env.',
      field: 'code',
    };
  }

  // Lock the account out after repeated wrong codes. Without this a short
  // numeric code is trivially brute-forced by anyone holding the password.
  const attempt = failedAttempts.get(user.id);
  if (attempt && attempt.count >= MAX_CODE_ATTEMPTS) {
    const waited = Date.now() - attempt.at;
    if (waited < LOCKOUT_MS) {
      const minutes = Math.ceil((LOCKOUT_MS - waited) / 60_000);
      return {
        error: `Too many incorrect codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        field: 'code',
      };
    }
    failedAttempts.delete(user.id);
  }

  const code = text(input?.code);
  if (!code || !(await codeMatches(code))) {
    const prev = failedAttempts.get(user.id);
    failedAttempts.set(user.id, { count: (prev?.count ?? 0) + 1, at: Date.now() });
    // Also slow each individual guess.
    await new Promise((resolve) => setTimeout(resolve, 700));
    return { error: 'Incorrect verification code.', field: 'code' };
  }

  failedAttempts.delete(user.id);

  const token = await issueToken(user.id);

  // The database half of the second factor: is_admin() only honours sessions
  // recorded here (migration 038). Without this row the admin UI would load
  // but every admin read and write would be refused by RLS.
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const sessionId = sessionIdFromToken(session?.access_token);
  if (!sessionId || !(await recordAdminSession(user.id, sessionId, token.maxAge))) {
    return { error: SERVICE_UNAVAILABLE, field: 'code' };
  }

  const store = await cookies();
  store.set(ADMIN_COOKIE, token.value, adminCookieOptions(token.maxAge));

  return { ok: true };
}

/**
 * Step one of password recovery.
 *
 * The link is minted here with the service role and emailed over our own SMTP
 * rather than going through Supabase's built-in sender, which only delivers to
 * members of the project team and caps out at a couple of messages an hour —
 * for a real user it simply never arrives.
 *
 * generateLink also hands back the raw `hashed_token`, so the email can point
 * straight at our own /auth/reset-password instead of bouncing through
 * Supabase's verify endpoint. That removes the PKCE code verifier from the
 * picture entirely, which is what otherwise forces the link to be opened in
 * the exact browser that requested it.
 */
const RESET_UNAVAILABLE =
  "We couldn't send the reset email right now. Please try again in a few minutes, or use the contact form if it keeps happening.";

export async function requestPasswordResetAction(input: {
  email: string;
}): Promise<AuthResult & { deliveryFailed?: boolean }> {
  const email = text(input?.email).toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { error: 'Enter a valid email address.', field: 'email' };
  }

  const limited = throttled('reset', [
    { key: await ipKey(), limit: 10, windowMs: HOUR },
    { key: `email:${email}`, limit: 3, windowMs: HOUR },
  ]);
  if (limited) return { error: limited, field: 'email' };

  // Server set-up details go to the log, never to this public form: a
  // visitor has no use for env var names, and the provider's own error text
  // can name the owner's inbox.
  if (!smtpConfigured()) {
    console.error(
      '[auth] password reset requested but SMTP is not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM (see SETUP.md).',
    );
    return { error: RESET_UNAVAILABLE, deliveryFailed: true };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email,
    options: { redirectTo: `${SITE_URL}/auth/reset-password` },
  });

  // No such account. Reported as success on purpose: a distinct response here
  // would turn this form into a way to test which addresses are registered.
  // Any other failure is still logged, so a misconfigured server is visible to
  // whoever reads the logs rather than looking like a delivered email.
  if (error || !data?.properties?.hashed_token) {
    if (error && !/not found|no user/i.test(error.message)) {
      logSupabaseError('auth/reset', error);
    }
    return { ok: true };
  }

  const link = `${SITE_URL}/auth/reset-password?token_hash=${encodeURIComponent(
    data.properties.hashed_token,
  )}&type=recovery`;

  try {
    await sendMail({ to: email, ...passwordResetEmail(link) });
  } catch (err) {
    // explainSmtpError maps the provider's response to the setting that needs
    // changing — for the server log. The visitor gets a neutral message: the
    // raw text exposed SMTP host and env names, and an error that only
    // registered addresses could trigger told anyone the account existed.
    console.error('[auth] password reset email failed to send:', explainSmtpError(err), err);
    return { error: RESET_UNAVAILABLE, deliveryFailed: true };
  }

  return { ok: true };
}

/**
 * Clears the admin second factor and the "remember me" marker — called on
 * sign-out, so the next sign-in starts from a clean slate and the code is
 * required again.
 */
export async function clearAdminVerification(): Promise<void> {
  // Revoke this session's admin rights in the database too, before the
  // session itself is signed out.
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  await forgetAdminSession(sessionIdFromToken(session?.access_token)).catch(() => {});

  const store = await cookies();
  store.delete(ADMIN_COOKIE);
  store.delete(SESSION_ONLY_COOKIE);
}
