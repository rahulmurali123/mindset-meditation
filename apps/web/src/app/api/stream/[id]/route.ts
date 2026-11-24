// Streams a podcast's audio via a short-lived signed URL, from whichever
// backend it was uploaded to (see lib/audio-storage.ts), and records the play
// for analytics.
// RLS on the user's session decides visibility (non-admins only see published).
import { type NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { signAudioUrl } from '@/lib/audio-storage';
import { requestContext } from '@/lib/request-context';
import { publicOrigin } from '@/lib/public-origin';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { isUuid } from '@/lib/utils';

/** The player's per-browser listener id: a UUID from crypto.randomUUID(). */
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * A replay of the same episode by the same listener inside this window reuses
 * the open play event instead of counting a new play. Without it, reloading
 * /api/stream in a loop inflated play_count and the dashboard without limit.
 */
const DEDUPE_MS = 30 * 60 * 1000;

/**
 * Lifetime of the playback URL. The browser fetches audio in ranges as it
 * plays and seeks, and each range request is checked against the URL's
 * expiry — so a 1-hour URL broke a 3-hour episode an hour in. The player also
 * re-requests a URL (with ?refresh=1) when one is refused, for a listener who
 * pauses overnight.
 */
const URL_TTL_SECONDS = 6 * 60 * 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const supabase = await createClient();

  // Visibility enforced by RLS (published-only for non-admins).
  const { data: track } = await supabase
    .from('tracks')
    .select('id, audio_path, duration_seconds')
    .eq('id', id)
    .maybeSingle();

  if (!track?.audio_path) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const url = await signAudioUrl(track.audio_path, URL_TTL_SECONDS);
  if (!url) {
    return NextResponse.json({ error: 'Audio storage not configured' }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Record the play. Written with the service role because play_events has no
  // client-facing insert policy — that keeps the table un-spammable via PostgREST.
  //
  // Playback itself is never refused: past the limit or without a session id
  // the listener still gets the URL, the play just isn't counted.
  let eventId: string | null = null;
  const rawSid = req.nextUrl.searchParams.get('sid');
  const sessionId = rawSid && SESSION_ID_RE.test(rawSid) ? rawSid : null;
  // A refresh is the player replacing an expired URL mid-episode — the same
  // play, so nothing new is recorded.
  const refresh = req.nextUrl.searchParams.get('refresh') === '1';
  const overLimit = rateLimit('stream', clientIp(req.headers), 120, 10 * 60 * 1000).limited;

  if (sessionId && !overLimit && !refresh) {
    const admin = createAdminClient();

    const { data: recent } = await admin
      .from('play_events')
      .select('id')
      .eq('session_id', sessionId)
      .eq('track_id', id)
      .gte('created_at', new Date(Date.now() - DEDUPE_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recent?.id) {
      eventId = recent.id;
    } else {
      // Device/referrer/language, and country when a CDN supplies it. Recorded
      // here rather than sent from the client because a browser cannot be trusted
      // to report its own referrer, and because this route already holds the
      // headers — see lib/request-context.ts for what is deliberately not kept.
      // Not req.nextUrl.hostname: behind the proxy that is "localhost", which
      // stopped self-referrals being filtered out.
      const context = requestContext(
        req.headers,
        new URL(publicOrigin(req.headers)).hostname,
        req.nextUrl.searchParams.get('ref')?.slice(0, 500) ?? null,
      );
      const base = {
        track_id: id,
        user_id: user?.id ?? null,
        session_id: sessionId,
        duration_seconds: track.duration_seconds ?? 0,
      };

      const { data: event, error } = await admin
        .from('play_events')
        .insert({ ...base, ...context })
        .select('id')
        .single();

      if (error) {
        // The context columns arrive with migration 035. If the code is deployed
        // before that runs, PostgREST rejects the whole insert for unknown
        // columns and the play would go unrecorded. Retrying without them keeps
        // play tracking working on the old schema, so deploy order stops mattering.
        const { data: fallback } = await admin
          .from('play_events')
          .insert(base)
          .select('id')
          .single();
        eventId = fallback?.id ?? null;
      } else {
        eventId = event?.id ?? null;
      }

      // One count per recorded play. Called with the service role: migration
      // 037 revokes EXECUTE from anon/authenticated, because the function is
      // SECURITY DEFINER and anyone could otherwise call it straight through
      // PostgREST and set any episode's play count to whatever they liked.
      if (eventId) {
        const { error: countError } = await admin.rpc('increment_play_count', {
          p_track_id: id,
        });
        if (countError) console.error('[stream] increment_play_count failed:', countError.message);
      }
    }
  }

  return NextResponse.json({ url, eventId });
}
