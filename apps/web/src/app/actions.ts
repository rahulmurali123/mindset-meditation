'use server';

import { deleteAudio } from '@/lib/audio-storage';
import { PLATFORMS, type PlatformLinks, sanitizePlatformUrl } from '@/lib/platforms';
import { BUCKETS, TRACK_LIMITS, slugify, uniqueSlug } from '@/lib/podcast';
import { generateEpisodeMetadata } from '@/lib/seo/generate';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { PodcastClient } from '@/lib/supabase/types';
// Server Actions — run as the signed-in user; RLS enforces authorization.
import { revalidatePath } from 'next/cache';
import { checkAdmin } from '@/lib/admin-guard';
import { rateLimit } from '@/lib/rate-limit';
import { isUuid } from '@/lib/utils';

/**
 * Server actions are public HTTP endpoints: anything can POST any JSON at
 * them, whatever the TypeScript signature says. These coerce instead of
 * trusting — `.trim()` on a missing field used to throw an unhandled TypeError.
 */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Audio keys minted by /api/admin/upload-url: "r2:podcasts/…" or "sb:podcasts/…". */
const AUDIO_PATH_RE = /^(r2|sb):podcasts\/[\w.-]+$/;
/** Cover keys minted by uploadCover(): "covers/…" or "playlists/…". */
const COVER_PATH_RE = /^(covers|playlists)\/[\w.-]+$/;

/**
 * The public URL for an uploaded cover, rebuilt here from its storage key
 * instead of trusting the URL the browser sent. The stored URL is rendered on
 * every public page and in the RSS feed, so accepting it verbatim let any
 * admin session (or a stolen one) point artwork at an arbitrary host.
 */
function coverFromPath(path: unknown): { url: string; path: string } | null {
  if (typeof path !== 'string' || !COVER_PATH_RE.test(path)) return null;
  const url = createAdminClient().storage.from(BUCKETS.thumbnails).getPublicUrl(path).data
    .publicUrl;
  return { url, path };
}

/** Only an inline image the cover canvas produced, and never a huge one. */
function cleanBlurDataUrl(value: unknown): string | null {
  return typeof value === 'string' &&
    /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value) &&
    value.length <= 20_000
    ? value
    : null;
}

function cleanKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim().slice(0, 60))
    .filter(Boolean)
    // 25 is what buildKeywords() produces; a lower cap here trimmed every
    // generated list that passed back through the edit form.
    .slice(0, 25);
}

function cleanFileSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

/**
 * Keeps only known platform ids holding valid http(s) URLs — without the
 * protocol check an admin could store a `javascript:` URL that then runs for
 * every visitor who clicks that platform button — plus the names of links
 * that were refused.
 */
function platformLinksWithRejects(input: PlatformLinks | undefined): {
  links: PlatformLinks;
  rejected: string[];
} {
  const links: PlatformLinks = {};
  const rejected: string[] = [];
  if (!input || typeof input !== 'object') return { links, rejected };
  for (const { id, label } of PLATFORMS) {
    const raw = input[id];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const url = sanitizePlatformUrl(raw);
    if (url) links[id] = url;
    else rejected.push(label);
  }
  return { links, rejected };
}

/**
 * Text for links a save dropped, so "Saved" does not claim the listener will
 * be sent somewhere they will not.
 */
function rejectedLinksWarning(rejected: string[]): string | undefined {
  return rejected.length
    ? `Not saved — not a valid web address: ${rejected.join(', ')} link. Paste the full https:// link.`
    : undefined;
}

/**
 * Inserts a row under a slug derived from its title, resolving collisions.
 *
 * Both `tracks.slug` and `playlists.slug` carry a unique constraint, and
 * `slugify` is deterministic — so two titles that reduce to the same stem
 * ("Sleep & Calm" and "Sleep Calm") would otherwise fail with a raw Postgres
 * error. Shared by episodes and playlists because the requirement is identical.
 *
 * Two steps, because neither alone is sufficient: a prefix query picks the next
 * free suffix (`-2`, `-3`) so the common case is one round trip, and the retry
 * on the unique-violation closes the race where two concurrent inserts resolve
 * to the same candidate between the query and the write.
 *
 * The existence check runs on the service-role client, not the caller's. Both
 * `tracks_slug_key` and `playlists_slug_lower_key` are plain unique indexes —
 * neither excludes soft-deleted rows, so a deleted row still occupies its
 * slug. `playlists_select`'s RLS hides soft-deleted rows from every caller,
 * admin included (deliberately — see migration 031), so a normal, RLS-checked
 * SELECT here is blind to exactly the rows that can still collide. That blind
 * spot meant every retry re-ran the same query, got the same incomplete
 * answer, and proposed the same doomed bare slug three times in a row — an
 * admin recreating a playlist under a previously-deleted title always hit
 * "Could not find a free URL for that title" instead of just getting `-2`.
 * Every call site already passed `requireAdmin()` before reaching here.
 */
async function insertWithUniqueSlug<T extends { id: string; slug: string }>(
  supabase: PodcastClient,
  table: 'tracks' | 'playlists',
  title: string,
  row: Record<string, unknown>,
  select = 'id, slug',
): Promise<{ data: T | null; error: string | null }> {
  const base = slugify(title);
  const admin = createAdminClient();

  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: existing, error: lookupError } = await admin
      .from(table)
      .select('slug')
      .like('slug', `${base}%`);
    // Treating a failed lookup as "no collisions" proposes the same taken slug
    // on every attempt and ends in a misleading "no free URL" message.
    if (lookupError) return { data: null, error: schemaHint(lookupError.message) };

    const slug = uniqueSlug(
      title,
      ((existing ?? []) as Array<{ slug: string }>).map((r) => r.slug),
    );

    const { data, error } = await supabase
      .from(table)
      .insert({ ...row, slug })
      .select(select)
      .single();

    if (!error) return { data: data as unknown as T, error: null };
    // 23505 = unique_violation. Anything else is a real failure — report it.
    if (!error.message.includes('duplicate key') && error.code !== '23505') {
      return { data: null, error: error.message };
    }
  }
  return { data: null, error: 'Could not find a free URL for that title — try a different one' };
}

/**
 * Whether the signed-in listener has saved this episode.
 *
 * The player and the homepage card both used to initialise their heart to
 * "not saved" and never check — so opening an episode you had already saved
 * showed an empty heart, and the first press *removed* it from your library.
 * Returns false for signed-out visitors, who have no library.
 */
export async function isSaved(trackId: string): Promise<boolean> {
  if (!isUuid(trackId)) return false;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data } = await supabase
    .from('favorites')
    .select('id')
    .eq('user_id', user.id)
    .eq('track_id', trackId)
    .maybeSingle();
  return Boolean(data);
}

export async function toggleSave(trackId: string) {
  if (!isUuid(trackId)) return { error: 'Episode not found' };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Please sign in' };
  if (rateLimit('save', user.id, 60, 60_000).limited) {
    return { error: 'Slow down a little and try again.' };
  }

  const { data: existing } = await supabase
    .from('favorites')
    .select('id')
    .eq('track_id', trackId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase.from('favorites').delete().eq('id', existing.id);
    if (error) return { error: 'Could not update your library. Try again.' };
    return { saved: false };
  }
  const { error } = await supabase
    .from('favorites')
    .insert({ track_id: trackId, user_id: user.id });
  // 23505: a double-click raced the first insert — it is saved either way.
  if (error && error.code !== '23505') {
    return { error: 'Could not save that episode. Try again.' };
  }
  return { saved: true };
}

export async function addComment(trackId: string, body: string, parentId?: string | null) {
  if (!isUuid(trackId)) return { error: 'Episode not found' };
  if (parentId != null && !isUuid(parentId)) return { error: 'That comment no longer exists' };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'Please sign in' };

  const text = str(body);
  if (!text) return { error: 'Comment is empty' };
  if (text.length > 2000) return { error: 'Comment is too long' };

  // Any signed-up account can post, and sign-up is instant, so a flood is one
  // script away. Generous enough that no real listener will ever see it.
  if (
    rateLimit('comment', user.id, 5, 60_000).limited ||
    rateLimit('comment-day', user.id, 100, 24 * 60 * 60_000).limited
  ) {
    return { error: 'You are commenting very quickly — please wait a minute.' };
  }

  const { data, error } = await supabase
    .from('comments')
    .insert({ track_id: trackId, user_id: user.id, body: text, parent_id: parentId ?? null })
    .select('id, body, created_at, user_id, parent_id')
    .single();
  if (error) {
    // The database enforces the same limit (migration 039), across instances.
    if (error.message.includes('comment_rate_limited')) {
      return { error: 'You are commenting very quickly — please wait a minute.' };
    }
    console.error('[comments] insert failed:', error.code, error.message);
    // RLS refuses comments on drafts and the parent trigger refuses bad threads;
    // neither message is meant for a listener.
    return { error: 'Could not post that comment. Reload the page and try again.' };
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, username')
    .eq('id', user.id)
    .maybeSingle();

  // Whether the author is staff decides the "Host" badge on the thread.
  const { data: role } = await supabase.rpc('get_user_role', { p_user_id: user.id });

  return {
    comment: {
      ...data,
      author: profile?.full_name || profile?.username || 'You',
      mine: true,
      isAdmin: role === 'admin' || role === 'super_admin',
    },
  };
}

export async function deleteComment(id: string) {
  if (!isUuid(id)) return { error: 'Comment not found' };
  const supabase = await createClient();
  // RLS (comments_delete_own) already restricts this to the author or an
  // admin — a mismatched id just deletes zero rows, no error. This explicit
  // check exists so a caller gets an honest "not authorized" instead of a
  // silent no-op, and so the guarantee doesn't rest on RLS alone.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: 'You must be signed in.' };

  const { data: comment } = await supabase
    .from('comments')
    .select('user_id')
    .eq('id', id)
    .maybeSingle();
  if (!comment) return { error: 'Comment not found' };

  if (comment.user_id !== user.id) {
    const gate = await checkAdmin();
    if (!gate.ok) return { error: 'Not authorized to delete this comment' };
  }

  const { data: removed, error } = await supabase
    .from('comments')
    .delete()
    .eq('id', id)
    .select('id');
  if (error) return { error: 'Could not delete that comment. Try again.' };
  // RLS turns a refused delete into zero rows rather than an error.
  if (!removed?.length) return { error: 'Not authorized to delete this comment' };
  return { ok: true };
}

// ---- Admin ----

/**
 * PostgREST reports a column the code expects but the database lacks as
 * "Could not find the 'x' column … in the schema cache", which reads like a
 * caching glitch. It almost always means the database is a migration behind
 * the app, so say that instead of leaving the admin to guess.
 */
/** Keeps a meta description inside tracks_meta_description_check. */
function clampMeta(text: string): string {
  return text.length > TRACK_LIMITS.metaDescription
    ? text.slice(0, TRACK_LIMITS.metaDescription).trimEnd()
    : text;
}

function schemaHint(message: string): string {
  if (/invalid schema/i.test(message)) {
    return `${message}\n\nSupabase is not exposing the "podcast" schema. Supabase Dashboard → Project Settings → Data API → Exposed schemas: add "podcast" and save.`;
  }
  const behind = /schema cache|could not find the|does not exist/i.test(message);
  return behind
    ? `${message}\n\nThe database looks a migration behind the app. Check its version with \`SELECT version FROM podcast.schema_migrations ORDER BY version DESC LIMIT 1\` and apply the pending file — see migrations/README.md.`
    : message;
}

/**
 * The two files nothing on the site links to, but which every crawler polls:
 * /sitemap.xml (Google) and /feed.xml (Apple/Spotify and podcast directories).
 *
 * Both are ISR'd with `revalidate = 3600`. Without an explicit purge a freshly
 * published episode is live on the site immediately but stays missing from the
 * sitemap and the feed for up to an hour — so the crawler that happens to visit
 * in that window sees nothing new. Every mutation that changes what is public
 * calls this, which is what makes "publish → Google discovers the URL" actually
 * hold rather than hold-eventually.
 */
function revalidateDiscovery() {
  revalidatePath('/sitemap.xml');
  revalidatePath('/feed.xml');
}

/**
 * Every cached surface an episode appears on.
 *
 * `/` and `/episodes` are both prerendered with `revalidate = 300`, so anything
 * missed here keeps serving the old catalogue for five minutes. `/episodes` was
 * the gap: creating, deleting or unpublishing an episode revalidated the
 * homepage but never the "View all" page behind it, so a deleted episode was
 * still listed there — the delete looked broken when it had actually worked.
 */
function revalidateEpisode(slug?: string | null, playlistSlugs: string[] = []) {
  revalidatePath('/');
  revalidatePath('/episodes');
  // Playlist cards show episode counts and running time, which only count
  // published episodes (migration 038) — so publishing, unpublishing or
  // deleting one changes them too.
  revalidatePath('/playlists');
  revalidatePath('/admin/playlists');
  if (slug) revalidatePath(`/podcast/${slug}`);
  for (const playlistSlug of new Set(playlistSlugs)) {
    revalidatePath(`/playlist/${playlistSlug}`);
  }
  revalidateDiscovery();
}

/**
 * Slugs of the playlists an episode appears on, so their pages can be purged.
 * Must be read before a delete — the join rows cascade away with the track.
 */
async function playlistSlugsForTrack(supabase: PodcastClient, id: string): Promise<string[]> {
  const { data } = await supabase
    .from('playlist_tracks')
    .select('playlists(slug)')
    .eq('track_id', id);

  // PostgREST returns a single object for a many-to-one embed, but the
  // generated types model every embed as an array. Accept both rather than
  // asserting one and breaking whenever the types are regenerated.
  type Embedded = { playlists: { slug: string | null } | Array<{ slug: string | null }> | null };

  return ((data ?? []) as unknown as Embedded[])
    .flatMap((row) => (Array.isArray(row.playlists) ? row.playlists : [row.playlists]))
    .map((playlist) => playlist?.slug)
    .filter((slug): slug is string => Boolean(slug));
}

/** Playlists are how listeners browse, so every change touches these three. */
function revalidatePlaylist(slug?: string | null) {
  revalidatePath('/');
  revalidatePath('/playlists');
  if (slug) revalidatePath(`/playlist/${slug}`);
  // Playlists are sitemap entries in their own right.
  revalidateDiscovery();
}

/**
 * Every `admin*` action below starts with this.
 *
 * A Server Action is addressable by its generated ID, not by which page happens
 * to import it — so "this action is only referenced from /admin" is not an
 * access control. Row-level security covers the `tracks` writes (see
 * `tracks_insert_admin` / `tracks_update_admin` / `tracks_delete_admin` in
 * fullschema.sql) and, since migration 037, the playlist writes too — before
 * that, `playlists_insert_own` let any signed-in listener publish a public
 * playlist. This guard is the app-side half; neither layer relies on the other.
 * It is also the only thing enforcing the verification-code second factor,
 * which the database knows nothing about.
 *
 * Returns an error string to hand straight back to the caller, or the caller's
 * id when they are a verified admin. `checkAdmin` is React-cached, so an action
 * that needs the id gets it from here rather than paying for a second
 * `auth.getUser()` round-trip.
 */
type AdminGate = { error: string; userId?: never } | { error?: never; userId: string };

async function requireAdmin(): Promise<AdminGate> {
  const admin = await checkAdmin();
  if (admin.ok && admin.userId) return { userId: admin.userId };
  if (admin.reason === 'unauthenticated') return { error: 'Please sign in' };
  if (admin.reason === 'unavailable') {
    return { error: 'The database could not be reached. Please try again in a moment.' };
  }
  return { error: 'Not authorised' };
}

export interface PlaylistInput {
  title: string;
  description?: string;
  /** Only set when a new cover was uploaded. */
  coverUrl?: string | null;
  coverPath?: string | null;
  isPublic?: boolean;
}

export async function adminCreatePlaylist(input: PlaylistInput) {
  const gate = await requireAdmin();
  if (gate.error) return { error: gate.error };
  const supabase = await createClient();

  const title = str(input?.title);
  if (!title) return { error: 'Playlist name is required' };
  if (title.length > 200) return { error: 'Playlist name is too long' };
  const description = str(input.description);
  if (description.length > 1000) return { error: 'Description must be at most 1000 characters' };
  const cover = input.coverUrl ? coverFromPath(input.coverPath) : null;

  const { data: existing } = await supabase
    .from('playlists')
    .select('id')
    .eq('title', title)
    .is('deleted_at', null)
    .maybeSingle();
  if (existing) return { error: 'A playlist with that name already exists' };

  const { data, error } = await insertWithUniqueSlug<{ id: string; title: string; slug: string }>(
    supabase,
    'playlists',
    title,
    {
      user_id: gate.userId,
      title,
      description: description || null,
      thumbnail_url: cover?.url ?? null,
      thumbnail_path: cover?.path ?? null,
      is_public: typeof input.isPublic === 'boolean' ? input.isPublic : true,
    },
    'id, title, slug',
  );

  if (error) return { error: schemaHint(error) };
  if (!data) return { error: 'Could not save the playlist' };
  revalidatePlaylist(data.slug);
  return { playlist: data };
}

export async function adminUpdatePlaylist(input: PlaylistInput & { id: string }) {
  const gate = await requireAdmin();
  if (gate.error) return { error: gate.error };
  const supabase = await createClient();

  if (!isUuid(input?.id)) return { error: 'Playlist not found' };
  const title = str(input.title);
  if (!title) return { error: 'Playlist name is required' };
  if (title.length > 200) return { error: 'Playlist name is too long' };
  const description = str(input.description);
  if (description.length > 1000) return { error: 'Description must be at most 1000 characters' };

  // biome-ignore lint/suspicious/noExplicitAny: partial update over an untyped row
  const patch: Record<string, any> = {
    title,
    description: description || null,
  };
  if (typeof input.isPublic === 'boolean') patch.is_public = input.isPublic;
  // Only replace the artwork when a new file was actually uploaded — otherwise
  // saving the title would silently wipe the existing cover.
  const cover = input.coverUrl ? coverFromPath(input.coverPath) : null;
  let previousCover: string | null = null;
  if (cover) {
    patch.thumbnail_url = cover.url;
    patch.thumbnail_path = cover.path;
    const { data: before } = await supabase
      .from('playlists')
      .select('thumbnail_path')
      .eq('id', input.id)
      .maybeSingle();
    previousCover = (before as { thumbnail_path: string | null } | null)?.thumbnail_path ?? null;
  }

  const { data, error } = await supabase
    .from('playlists')
    .update(patch)
    .eq('id', input.id)
    .select('id, title, slug')
    .single();

  if (error) return { error: schemaHint(error.message) };

  // The replaced artwork belongs to nothing now — every cover swap used to
  // leave the old image in the public bucket for good. Only after the update
  // succeeded, so a failed save keeps its cover.
  const leftovers =
    previousCover && previousCover !== cover?.path
      ? await removeStoredFiles(null, previousCover)
      : [];

  revalidatePlaylist(data.slug);
  return leftovers.length
    ? { playlist: data, warning: `Saved, but could not remove the old ${leftovers.join(' and ')}.` }
    : { playlist: data };
}

/** Soft delete, matching adminDeletePodcast — the episodes inside are kept. */
export async function adminDeletePlaylist(id: string) {
  const gate = await requireAdmin();
  if (gate.error) return { error: gate.error };
  if (!isUuid(id)) return { error: 'Playlist not found' };
  const supabase = await createClient();

  // Read the slug BEFORE the delete. Reading it back afterwards cannot work:
  // `playlists_select` requires `deleted_at IS NULL`, so the freshly deleted row
  // fails the select and the returned slug was always null — which meant
  // `/playlist/<slug>` never got purged and kept serving a deleted playlist
  // until its own revalidate window elapsed.
  const { data: existing } = await supabase
    .from('playlists')
    .select('slug')
    .eq('id', id)
    .maybeSingle();

  // An RPC, not a direct `.update()`. The obvious `UPDATE ... SET deleted_at`
  // was verified — policy text, and auth.uid()/is_admin() in the very same
  // transaction as the failing statement — to be correct and still rejected by
  // RLS on this table for reasons that don't trace back to anything in the
  // policy. podcast.delete_playlist() performs the identical owner-or-admin
  // check itself and updates as its own (RLS-exempt) owner. See migration 033.
  const { error } = await supabase.rpc('delete_playlist', { p_id: id });

  if (error) return { error: schemaHint(error.message) };
  revalidatePlaylist((existing as { slug: string | null } | null)?.slug);
  return { ok: true };
}

/**
 * Removes stored media, from whichever backend holds it. Never throws: returns
 * a description of anything left behind so the caller can surface it as a
 * warning rather than failing an operation that otherwise succeeded.
 */
async function removeStoredFiles(audioPath?: string | null, coverPath?: string | null) {
  const leftovers: string[] = [];

  if (audioPath) {
    const failed = await deleteAudio(audioPath);
    if (failed) leftovers.push(`audio (${failed})`);
  }

  if (coverPath) {
    const admin = createAdminClient();
    const { error } = await admin.storage.from(BUCKETS.thumbnails).remove([coverPath]);
    if (error) leftovers.push(`cover image (${error.message})`);
  }

  return leftovers;
}

/**
 * Deletes files the upload form put in storage for an episode that then failed
 * to save — otherwise every failed save left a full audio file billed in R2.
 *
 * Only paths the upload flow itself mints are accepted, and only while no
 * episode row refers to them, so this can't be pointed at a live episode.
 */
export async function adminDiscardUpload(input: {
  audioPath?: string | null;
  coverPath?: string | null;
}) {
  const gate = await requireAdmin();
  if (gate.error) return { error: gate.error };

  const audioPath =
    typeof input?.audioPath === 'string' && /^(r2|sb):podcasts\/[\w.-]+$/.test(input.audioPath)
      ? input.audioPath
      : null;
  const coverPath =
    // covers/ only: playlist artwork is referenced by playlists, which the
    // in-use check below does not look at.
    typeof input?.coverPath === 'string' && /^covers\/[\w.-]+$/.test(input.coverPath)
      ? input.coverPath
      : null;
  if (!audioPath && !coverPath) return { ok: true };

  const admin = createAdminClient();
  // Older rows store R2 keys bare ("podcasts/…"), which still mean R2 — check
  // that form too, or a legacy episode's audio would look unused.
  const filters = [
    audioPath ? `audio_path.eq."${audioPath}"` : null,
    audioPath?.startsWith('r2:') ? `audio_path.eq."${audioPath.slice(3)}"` : null,
    coverPath ? `thumbnail_path.eq."${coverPath}"` : null,
  ].filter(Boolean);
  const { data: inUse, error } = await admin
    .from('tracks')
    .select('id')
    .or(filters.join(','))
    .limit(1);
  if (error) return { error: error.message };
  if (inUse && inUse.length > 0) return { error: 'Those files belong to an existing episode' };

  await removeStoredFiles(audioPath, coverPath);
  return { ok: true };
}

interface CreatePodcastInput {
  title: string;
  channel?: string;
  description?: string;
  playlistId?: string | null;
  durationSeconds: number;
  audioPath: string;
  coverUrl?: string | null;
  coverPath?: string | null;
  /** Read from the File in the browser — there is no server-side ffmpeg. */
  fileSizeBytes?: number | null;
  /** Base64 LQIP produced by downscaling the cover on a canvas. */
  blurDataUrl?: string | null;
  /**
   * Optional admin overrides of the generated SEO copy. Blank/absent means
   * "use the generated value" — the upload form previews the generated text as
   * a placeholder and only sends these once someone types over it.
   */
  metaDescription?: string;
  keywords?: string[];
  /** Per-episode overrides of the show-wide platform links. */
  platformLinks?: PlatformLinks;
  publish: boolean;
}

export async function adminCreatePodcast(input: CreatePodcastInput) {
  const gate = await requireAdmin();
  if (gate.error) return { error: gate.error };
  const supabase = await createClient();

  const title = str(input?.title);
  if (!title) return { error: 'Title is required' };
  if (title.length > TRACK_LIMITS.title) {
    return { error: `Title must be at most ${TRACK_LIMITS.title} characters` };
  }
  if (str(input.description).length > TRACK_LIMITS.description) {
    return { error: `Description must be at most ${TRACK_LIMITS.description} characters` };
  }
  // Only a key /api/admin/upload-url minted: anything else would make the
  // stream route sign a URL for an arbitrary object in the bucket.
  if (typeof input.audioPath !== 'string' || !AUDIO_PATH_RE.test(input.audioPath)) {
    return { error: 'Audio file is required' };
  }
  if (input.playlistId != null && input.playlistId !== '' && !isUuid(input.playlistId)) {
    return { error: 'That playlist no longer exists' };
  }
  // A 0 here would be clamped to 1 second and silently ship a broken episode;
  // the form blocks submission, and this is the server-side backstop.
  if (
    typeof input.durationSeconds !== 'number' ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds < 1 ||
    input.durationSeconds > 24 * 60 * 60
  ) {
    return { error: 'Could not read the audio duration — re-select the file and try again' };
  }
  const cover = input.coverUrl ? coverFromPath(input.coverPath) : null;
  const fileSizeBytes = cleanFileSize(input.fileSizeBytes);
  const keywords = cleanKeywords(input.keywords);
  const platformLinks = platformLinksWithRejects(input.platformLinks);
  const linkWarning = rejectedLinksWarning(platformLinks.rejected);

  // The playlist title feeds the generated copy, so fetch it before generating.
  let playlistTitle: string | null = null;
  let playlistSlug: string | null = null;
  if (input.playlistId) {
    const { data: pl } = await supabase
      .from('playlists')
      .select('title, slug')
      .eq('id', input.playlistId)
      .maybeSingle();
    playlistTitle = pl?.title ?? null;
    playlistSlug = (pl as { slug?: string | null } | null)?.slug ?? null;
  }
  const playlistSlugs = playlistSlug ? [playlistSlug] : [];

  const durationSeconds = Math.round(input.durationSeconds);
  const description = str(input.description) || null;
  const generated = generateEpisodeMetadata({
    title,
    playlistTitle,
    durationSeconds,
    description,
  });

  const row = {
    title,
    description,
    // short_description keeps its historical meaning (the card blurb) but is
    // now a sentence-boundary excerpt rather than a mid-word .slice(0, 300).
    short_description: generated.excerpt.slice(0, 300),
    excerpt: generated.excerpt,
    meta_description: clampMeta(str(input.metaDescription) || generated.metaDescription),
    keywords: keywords.length ? keywords : generated.keywords,
    duration_seconds: durationSeconds,
    audio_url: input.audioPath,
    audio_path: input.audioPath,
    thumbnail_url: cover?.url ?? null,
    thumbnail_path: cover?.path ?? null,
    blur_data_url: cover ? cleanBlurDataUrl(input.blurDataUrl) : null,
    file_size_bytes: fileSizeBytes,
    bitrate_kbps: fileSizeBytes ? Math.round((fileSizeBytes * 8) / durationSeconds / 1000) : null,
    instructor_name: str(input.channel).slice(0, 200) || null,
    platform_links: platformLinks.links,
    status: input.publish === true ? 'published' : 'draft',
    published_at: input.publish === true ? new Date().toISOString() : null,
  };

  const { data, error } = await insertWithUniqueSlug(supabase, 'tracks', title, row);
  if (error) return { error: schemaHint(error) };
  if (!data) return { error: 'Could not save the episode' };

  // Attach to a playlist, appending to the end. The trg_playlist_stats trigger
  // keeps track_count / total_duration_seconds in sync.
  if (input.playlistId) {
    const { count } = await supabase
      .from('playlist_tracks')
      .select('id', { count: 'exact', head: true })
      .eq('playlist_id', input.playlistId);

    const { error: linkError } = await supabase.from('playlist_tracks').insert({
      playlist_id: input.playlistId,
      track_id: data.id,
      position: count ?? 0,
    });
    // The episode itself saved fine — report the link failure without losing it.
    if (linkError) {
      revalidateEpisode(data.slug);
      return {
        podcast: data,
        warning: `Saved, but could not add to playlist: ${linkError.message}`,
      };
    }
    revalidatePath('/playlists');
  }

  revalidateEpisode(data.slug, playlistSlugs);
  return linkWarning ? { podcast: data, warning: linkWarning } : { podcast: data };
}

interface UpdatePodcastInput {
  id: string;
  title: string;
  channel?: string;
  description?: string;
  playlistId?: string | null;
  /** Only set when the admin replaced the audio file. */
  audioPath?: string | null;
  durationSeconds?: number | null;
  /** Only set when the admin replaced the cover. */
  coverUrl?: string | null;
  coverPath?: string | null;
  fileSizeBytes?: number | null;
  blurDataUrl?: string | null;
  /** Blank means "regenerate" — see CreatePodcastInput. */
  metaDescription?: string;
  keywords?: string[];
  /** Per-episode overrides of the show-wide platform links. */
  platformLinks?: PlatformLinks;
}

/** Edits an existing episode. RLS restricts track updates to admins/moderators. */
export async function adminUpdatePodcast(input: UpdatePodcastInput) {
  const gate = await requireAdmin();
  if (gate.error) return { error: gate.error };
  const supabase = await createClient();

  if (!isUuid(input?.id)) return { error: 'Episode not found' };
  const title = str(input.title);
  if (!title) return { error: 'Title is required' };
  if (title.length > TRACK_LIMITS.title) {
    return { error: `Title must be at most ${TRACK_LIMITS.title} characters` };
  }
  if (str(input.description).length > TRACK_LIMITS.description) {
    return { error: `Description must be at most ${TRACK_LIMITS.description} characters` };
  }
  if (input.audioPath != null && input.audioPath !== '') {
    if (typeof input.audioPath !== 'string' || !AUDIO_PATH_RE.test(input.audioPath)) {
      return { error: 'That audio upload is not valid — re-select the file and try again' };
    }
  }
  if (input.playlistId != null && input.playlistId !== '' && !isUuid(input.playlistId)) {
    return { error: 'That playlist no longer exists' };
  }
  const cover = input.coverUrl ? coverFromPath(input.coverPath) : null;
  const keywords = cleanKeywords(input.keywords);
  const newDuration =
    typeof input.durationSeconds === 'number' &&
    Number.isFinite(input.durationSeconds) &&
    input.durationSeconds > 0 &&
    input.durationSeconds <= 24 * 60 * 60
      ? input.durationSeconds
      : null;
  const fileSizeBytes = cleanFileSize(input.fileSizeBytes);

  // The generated copy is derived from title + playlist + duration, so it has
  // to be recomputed on edit or an episode keeps the description of its old
  // title. The slug is deliberately NOT regenerated — see below.
  const { data: current } = await supabase
    .from('tracks')
    .select('duration_seconds, published_at, status, audio_path, thumbnail_path')
    .eq('id', input.id)
    .maybeSingle();

  const existingTrack = (current ?? null) as {
    duration_seconds: number;
    published_at: string | null;
    status: string;
    audio_path: string | null;
    thumbnail_path: string | null;
  } | null;

  // Playlist pages the episode was on before this edit; a move must purge both
  // the old page and the new one.
  const previousPlaylistSlugs = await playlistSlugsForTrack(supabase, input.id);

  let playlistTitle: string | null = null;
  if (input.playlistId) {
    const { data: pl } = await supabase
      .from('playlists')
      .select('title')
      .eq('id', input.playlistId)
      .maybeSingle();
    playlistTitle = pl?.title ?? null;
  }

  if (!existingTrack) return { error: 'Episode not found' };

  const durationSeconds = newDuration
    ? Math.round(newDuration)
    : (existingTrack.duration_seconds ?? 1);

  const description = str(input.description) || null;
  const generated = generateEpisodeMetadata({
    title,
    playlistTitle,
    durationSeconds,
    description,
  });

  // biome-ignore lint/suspicious/noExplicitAny: partial update over an untyped row
  const patch: Record<string, any> = {
    title,
    description,
    short_description: generated.excerpt.slice(0, 300),
    excerpt: generated.excerpt,
    meta_description: clampMeta(str(input.metaDescription) || generated.metaDescription),
    keywords: keywords.length ? keywords : generated.keywords,
    instructor_name: str(input.channel).slice(0, 200) || null,
  };

  // NB: `slug` is intentionally absent. Renaming an episode must not change its
  // URL — inbound links, the sitemap Google already crawled, and any podcast
  // client that stored the page URL would all break.

  // Only overwrite media when a replacement was actually uploaded.
  if (input.audioPath) {
    patch.audio_path = input.audioPath;
    patch.audio_url = input.audioPath;
    if (newDuration) {
      patch.duration_seconds = Math.round(newDuration);
      if (fileSizeBytes) {
        patch.file_size_bytes = fileSizeBytes;
        patch.bitrate_kbps = Math.round((fileSizeBytes * 8) / Math.round(newDuration) / 1000);
      }
    }
  }
  if (cover) {
    patch.thumbnail_url = cover.url;
    patch.thumbnail_path = cover.path;
    patch.blur_data_url = cleanBlurDataUrl(input.blurDataUrl);
  }
  let updateLinkWarning: string | undefined;
  if (input.platformLinks) {
    const cleaned = platformLinksWithRejects(input.platformLinks);
    patch.platform_links = cleaned.links;
    updateLinkWarning = rejectedLinksWarning(cleaned.rejected);
  }

  const { data, error } = await supabase
    .from('tracks')
    .update(patch)
    .eq('id', input.id)
    .select('id, slug')
    .single();
  if (error) return { error: schemaHint(error.message) };

  // Move between playlists: drop the old membership, append to the new one.
  if (input.playlistId !== undefined) {
    const { data: current } = await supabase
      .from('playlist_tracks')
      .select('id, playlist_id')
      .eq('track_id', input.id);

    const existing = (current ?? []) as Array<{ id: string; playlist_id: string }>;
    const alreadyThere = existing.some((r) => r.playlist_id === input.playlistId);

    if (!alreadyThere) {
      for (const row of existing) {
        await supabase.from('playlist_tracks').delete().eq('id', row.id);
      }
      if (input.playlistId) {
        const { count } = await supabase
          .from('playlist_tracks')
          .select('id', { count: 'exact', head: true })
          .eq('playlist_id', input.playlistId);
        const { error: linkError } = await supabase.from('playlist_tracks').insert({
          playlist_id: input.playlistId,
          track_id: input.id,
          position: count ?? 0,
        });
        if (linkError) {
          revalidateEpisode(data.slug, previousPlaylistSlugs);
          return {
            podcast: data,
            warning: `Saved, but playlist move failed: ${linkError.message}`,
          };
        }
      }
    }
  }

  // The row now points at the replacement media, so the files it used to point
  // at belong to nothing. Removed only after the update succeeded — a failed
  // save must leave the episode playing its original audio.
  const replacedAudio =
    input.audioPath && existingTrack?.audio_path !== input.audioPath
      ? existingTrack?.audio_path
      : null;
  const replacedCover =
    cover && existingTrack?.thumbnail_path !== cover.path ? existingTrack?.thumbnail_path : null;
  const leftovers = await removeStoredFiles(replacedAudio, replacedCover);

  revalidatePath('/playlists');
  revalidateEpisode(data.slug, [
    ...previousPlaylistSlugs,
    ...(await playlistSlugsForTrack(supabase, input.id)),
  ]);
  const warnings = [
    updateLinkWarning,
    leftovers.length > 0
      ? `Saved, but could not remove the old ${leftovers.join(' and ')}.`
      : undefined,
  ].filter(Boolean);
  return warnings.length ? { podcast: data, warning: warnings.join(' ') } : { podcast: data };
}

export async function adminSetStatus(id: string, status: 'draft' | 'published' | 'archived') {
  const gate = await requireAdmin();
  if (gate.error) return { error: gate.error };
  if (!isUuid(id)) return { error: 'Episode not found' };
  if (status !== 'draft' && status !== 'published' && status !== 'archived') {
    return { error: 'Unknown status' };
  }
  const supabase = await createClient();

  // The slug comes back on the same read as published_at — un-publishing has to
  // purge the episode's own page and /episodes, not just the homepage, or an
  // archived episode stays reachable and listed for its full cache window.
  const { data: current } = await supabase
    .from('tracks')
    .select('slug, published_at')
    .eq('id', id)
    .maybeSingle();
  const existing = current as { slug: string | null; published_at: string | null } | null;

  // published_at is stamped once, the first time an episode goes public, and
  // never moved after that — un-publishing and re-publishing must not restate
  // the episode as brand new in the RSS feed.
  // biome-ignore lint/suspicious/noExplicitAny: partial update over an untyped row
  const patch: Record<string, any> = { status };
  if (status === 'published' && !existing?.published_at) {
    patch.published_at = new Date().toISOString();
  }

  const playlistSlugs = await playlistSlugsForTrack(supabase, id);

  if (!existing) return { error: 'Episode not found' };
  const { error } = await supabase.from('tracks').update(patch).eq('id', id);
  if (error) return { error: error.message };
  revalidateEpisode(existing.slug, playlistSlugs);
  return { ok: true };
}

/**
 * Deletes an episode for real: the row, everything that cascades from it, and
 * both stored files.
 *
 * This used to only stamp `deleted_at`. That hid the episode but left the audio
 * object in R2 and the cover in Supabase Storage billed forever, and — because
 * `/episodes` and the episode's own page were never revalidated — a deleted
 * episode kept being served from the static cache for up to its five-minute
 * window, which is what made a delete look like it had not worked.
 *
 * Order matters: the row goes first. Deleting the files first would leave a
 * live episode pointing at missing audio if the DB delete then failed, and a
 * 404 for listeners is worse than an orphaned object for the admin.
 * `play_events` survives via ON DELETE SET NULL (migration 036), so all-time
 * analytics totals do not move.
 */
export async function adminDeletePodcast(id: string) {
  const gate = await requireAdmin();
  if (gate.error) return { error: gate.error };
  if (!isUuid(id)) return { error: 'Episode not found' };
  const supabase = await createClient();

  // Read the paths BEFORE the delete — afterwards the row is gone and with it
  // any way to find the files it owned.
  const { data: existing } = await supabase
    .from('tracks')
    .select('slug, audio_path, thumbnail_path')
    .eq('id', id)
    .maybeSingle();

  const track = existing as {
    slug: string | null;
    audio_path: string | null;
    thumbnail_path: string | null;
  } | null;

  // Which playlist pages showed this episode. Read before the delete too: the
  // join rows cascade away with the track.
  const playlistSlugs = await playlistSlugsForTrack(supabase, id);

  const { data: deleted, error } = await supabase
    .from('tracks')
    .delete()
    .eq('id', id)
    .select('id');
  if (error) return { error: error.message };
  // RLS turns a disallowed delete into "0 rows", not an error. Deleting the
  // files on that basis would leave a live episode with no audio.
  if (!deleted || deleted.length === 0) {
    return { error: 'That episode could not be deleted — it may already be gone.' };
  }

  // Files second, and never fatal: the episode is already gone from the site,
  // so failing here would report a delete that plainly did happen as an error.
  // A leftover file is reported as a warning instead of vanishing silently.
  const leftovers = await removeStoredFiles(track?.audio_path, track?.thumbnail_path);

  revalidateEpisode(track?.slug, playlistSlugs);

  return leftovers.length > 0
    ? { ok: true, warning: `Episode deleted, but could not remove its ${leftovers.join(' and ')}.` }
    : { ok: true };
}
