import { ManageList, type ManageRow } from '@/components/admin/manage-list';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Every episode, whichever playlist it is (or is not) in.
 *
 * The playlist pages used to be the only route to an episode's edit screen. An
 * episode whose playlist was deleted, or whose playlist link failed at upload,
 * stayed live on the site, the RSS feed and the sitemap — and could no longer
 * be edited, unpublished or deleted from the admin at all.
 */
export default async function AdminEpisodesPage() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('tracks')
    .select(
      'id, title, status, duration_seconds, play_count, created_at, playlist_tracks(playlists(title, deleted_at))',
    )
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1000);

  type Row = Omit<ManageRow, 'playlists'> & {
    playlist_tracks: Array<{
      playlists:
        | { title: string; deleted_at: string | null }
        | Array<{ title: string; deleted_at: string | null }>
        | null;
    }> | null;
  };

  const rows: ManageRow[] = ((data ?? []) as unknown as Row[]).map(({ playlist_tracks, ...t }) => ({
    ...t,
    playlists: (playlist_tracks ?? [])
      .flatMap((pt) => (Array.isArray(pt.playlists) ? pt.playlists : [pt.playlists]))
      .filter((p): p is { title: string; deleted_at: string | null } => Boolean(p && !p.deleted_at))
      .map((p) => p.title),
  }));
  const unassigned = rows.filter((r) => (r.playlists?.length ?? 0) === 0).length;

  return (
    <div>
      <h1 className="text-2xl font-black text-foreground mb-1">All episodes</h1>
      <p className="text-sm text-muted-foreground mb-8">
        Every episode on the site, including ones that are not in any playlist.
        {unassigned > 0 &&
          ` ${unassigned} ${unassigned === 1 ? 'is' : 'are'} not in a playlist — open one and pick a playlist to file it.`}
      </p>
      {error ? (
        <p className="text-sm text-destructive">Could not load episodes: {error.message}</p>
      ) : (
        <ManageList rows={rows} />
      )}
    </div>
  );
}
