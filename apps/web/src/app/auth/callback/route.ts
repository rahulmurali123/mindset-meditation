// Supabase's standard "code" callback (PKCE), handled on the server.
//
// Nothing in the app links here today — sign-in, sign-up and password recovery
// all run through server actions and /auth/reset-password — but Supabase's
// dashboard redirect settings may still point at it. It used to be a client
// page that built a second, unmanaged auth client, never unsubscribed its
// listener, spun forever when there was no code, and sent failures to a query
// parameter the login page never read. Now it exchanges the code with the
// shared cookie-backed server client and redirects either way.
import { type NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { publicUrl } from '@/lib/public-origin';
import { safeRedirect } from '@/lib/safe-redirect';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const next = safeRedirect(request.nextUrl.searchParams.get('next'), '/');

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(publicUrl(request.headers, next));
    console.error('[auth/callback] code exchange failed:', error.message);
  }

  return NextResponse.redirect(
    // A code, not text: the login page maps it to its own message, so the URL
    // cannot be used to put arbitrary words on our sign-in screen.
    publicUrl(request.headers, '/auth/login', { error: 'link_expired' }),
  );
}
