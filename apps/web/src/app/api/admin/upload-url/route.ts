import { ADMIN_DENIAL_RESPONSE, checkAdmin } from '@/lib/admin-guard';
import { AUDIO_BUCKET, audioBackend, encodeAudioPath } from '@/lib/audio-storage';
import { MAX_AUDIO_BYTES } from '@/lib/podcast';
import {
  MULTIPART_THRESHOLD,
  PART_SIZE,
  abortMultipart,
  completeMultipart,
  presignPutUrl,
  startMultipart,
} from '@/lib/r2';
// Tells the admin's browser where to put an audio file and how.
//  - R2 configured, large file → a multipart upload: many presigned part URLs
//                                the browser uploads in parallel
//  - R2 configured, small file → a single short-lived presigned PUT
//  - otherwise                 → the private Supabase Storage bucket, uploaded
//                                with the caller's own session (RLS allows it)
// Admin-gated either way.
import { type NextRequest, NextResponse } from 'next/server';

/** Object keys are minted here, never taken from the client. */
function newKey(filename: unknown): string {
  const ext =
    String(filename || '')
      .split('.')
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, '') || 'mp3';
  return `podcasts/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

/**
 * MIME types the private podcast-audio Supabase bucket accepts — its
 * allowed_mime_types in fullschema.sql. R2 takes anything, so this only gates
 * the Supabase fallback, where an .m4a or .wav used to transfer in full and
 * then fail with "mime type … is not supported".
 */
const SUPABASE_AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/wav',
  'audio/aac',
  'audio/flac',
]);

const AUDIO_CONTAINER_TYPES = new Set(['video/webm', 'video/mp4']);

function fail(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const admin = await checkAdmin();
  if (!admin.ok) {
    const denial = ADMIN_DENIAL_RESPONSE[admin.reason ?? 'unauthenticated'];
    return NextResponse.json({ error: denial.error }, { status: denial.status });
  }

  const body = await req.json().catch(() => null);
  if (!body) return fail('Malformed request', 400);

  const action: string = body.action ?? 'start';
  const backend = audioBackend();

  // ---- finish or clean up an in-flight multipart upload ----
  if (action === 'complete' || action === 'abort') {
    const { key, uploadId } = body;
    if (typeof key !== 'string' || typeof uploadId !== 'string') {
      return fail('key and uploadId are required', 400);
    }
    // Keys are minted by this route and always live under podcasts/. Without
    // this an admin-authenticated caller could complete or abort an upload
    // anywhere in the bucket.
    if (!key.startsWith('podcasts/') || key.includes('..')) {
      return fail('Invalid key', 400);
    }

    try {
      if (action === 'abort') {
        await abortMultipart(key, uploadId);
        return NextResponse.json({ ok: true });
      }
      // No parts manifest from the client: completeMultipart asks R2 which
      // parts it is holding, which works whether or not the bucket exposes the
      // ETag header to the browser. The client sends only the expected *count*,
      // which is checked against R2's own list so a short upload fails here
      // rather than publishing a truncated episode.
      const expected = Number(body.expectedParts);
      await completeMultipart(
        key,
        uploadId,
        Number.isInteger(expected) && expected > 0 ? expected : undefined,
      );
      return NextResponse.json({ ok: true, audioPath: encodeAudioPath('r2', key) });
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'Could not finalise the upload');
    }
  }

  // ---- start a new upload ----
  const key = newKey(body.filename);
  const contentType: string = body.contentType || 'audio/mpeg';
  const size = Number(body.size) || 0;

  // Refused before a single byte moves, rather than after the whole transfer.
  if (size > MAX_AUDIO_BYTES) {
    return fail(
      `That file is ${Math.round(size / 1024 / 1024)} MB — the limit is ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`,
      413,
    );
  }
  // Browsers label recorder output (.webm, .mp4) as video/*, though it is the
  // audio track that plays. R2 stores either; Supabase is narrowed below.
  if (!contentType.startsWith('audio/') && !AUDIO_CONTAINER_TYPES.has(contentType)) {
    return fail('That file is not audio.', 415);
  }

  if (backend !== 'r2') {
    if (!SUPABASE_AUDIO_TYPES.has(contentType)) {
      return fail(
        `This server stores audio in Supabase Storage, which accepts MP3, OGG, WAV, AAC and FLAC — not ${contentType}. Export the episode as MP3, or configure Cloudflare R2.`,
        415,
      );
    }
    return NextResponse.json({
      backend,
      mode: 'single',
      bucket: AUDIO_BUCKET,
      key,
      audioPath: encodeAudioPath('supabase', key),
    });
  }

  try {
    // Below the threshold the multipart handshake costs more than it saves.
    if (size > MULTIPART_THRESHOLD) {
      const partCount = Math.ceil(size / PART_SIZE);
      const { uploadId, partUrls, partSize } = await startMultipart(key, contentType, partCount);
      return NextResponse.json({
        backend,
        mode: 'multipart',
        key,
        uploadId,
        partUrls,
        partSize,
        audioPath: encodeAudioPath('r2', key),
      });
    }

    const url = await presignPutUrl(key, contentType);
    return NextResponse.json({
      backend,
      mode: 'single',
      url,
      key,
      audioPath: encodeAudioPath('r2', key),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not sign the upload URL');
  }
}
