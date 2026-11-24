// Heartbeat from the player: how far into an episode a listener has actually
// got. Feeds the retention figure on the admin analytics dashboard.
import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { isUuid } from '@/lib/utils';

/** Progress for a play older than this is ignored — no real session runs that long. */
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  let body: { eventId?: string; listenedSeconds?: number };
  try {
    body = (await req.json()) ?? {};
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const { eventId, listenedSeconds } = body;
  if (!isUuid(eventId) || typeof listenedSeconds !== 'number' || !Number.isFinite(listenedSeconds)) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  // The row is addressed by an unguessable UUID handed out at play time, but
  // any visitor can get one, so the value is bounded by the event itself: never
  // more than the episode's length (an 86,400 here used to count as a full day
  // of listening), and only while the play is recent.
  const admin = createAdminClient();
  const { data: event } = await admin
    .from('play_events')
    .select('duration_seconds, created_at')
    .eq('id', eventId)
    .maybeSingle();
  if (!event || Date.now() - new Date(event.created_at).getTime() > MAX_EVENT_AGE_MS) {
    return NextResponse.json({ ok: true });
  }
  const cap = event.duration_seconds > 0 ? event.duration_seconds : 86_400;
  const seconds = Math.max(0, Math.min(Math.round(listenedSeconds), cap));

  // Only ever forward, so a late or reordered beacon cannot shrink a listen
  // already recorded.
  const { error } = await admin
    .from('play_events')
    .update({ listened_seconds: seconds })
    .eq('id', eventId)
    .lt('listened_seconds', seconds);

  // Logged, not echoed: this route is public and the raw text is Postgres's.
  if (error) {
    console.error('[play-progress] update failed:', error.message);
    return NextResponse.json({ error: 'Could not record progress' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
