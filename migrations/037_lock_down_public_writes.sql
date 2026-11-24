-- =============================================================================
-- 037 — lock down writes reachable straight through PostgREST
-- =============================================================================
-- The app's server actions all gate correctly. These are the paths that skip
-- the app entirely: the anon key is public (it ships in the browser bundle),
-- sign-up is instant, and PostgREST serves every table and function this
-- schema grants. Each item below was reachable with nothing but curl.
--
-- 1. podcast.increment_play_count(uuid) is SECURITY DEFINER and executable by
--    anon. `POST /rest/v1/rpc/increment_play_count` in a loop set any
--    episode's public play count to anything. Only /api/stream calls it, now
--    with the service role, once per recorded play. The admin analytics
--    RPCs also lose anon's EXECUTE (they already refused non-admins inside).
-- 2. playlists_insert_own let ANY signed-in listener insert a playlist with
--    is_public = true and any title, slug and thumbnail_url. Public playlists
--    are what /playlists, the sitemap and the homepage artwork (the newest
--    public playlist's cover) are built from — a free account could deface
--    the homepage. Listeners have no playlist feature at all; every playlist
--    write is now admin-only, as are playlist_tracks and delete_playlist().
-- 3. anon held INSERT/UPDATE/DELETE on every table. RLS refused them, but a
--    single permissive policy added later would have opened that table to the
--    whole internet. Nothing anonymous ever writes; the grants are removed.
--    play_events and schema_migrations lose them for `authenticated` too —
--    only the service role writes those.
-- 4. Eleven SECURITY DEFINER functions ran with the caller's search_path.
--    Every reference inside them is schema-qualified today, so this is
--    defence in depth rather than a live hole: pinned to pg_catalog, podcast.
-- 5. profiles columns a user may edit through PostgREST (username, full_name)
--    had no shape check, unlike the sign-up form. A username of
--    "<script>" or a 10 MB full_name could be written straight to the table.
--    NOT VALID: enforced for every new write, existing rows are not rechecked.
-- =============================================================================

-- 1 ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION podcast.increment_play_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION podcast.increment_play_count(uuid) TO service_role;

-- 2 ---------------------------------------------------------------------------
DROP POLICY IF EXISTS playlists_insert_own ON podcast.playlists;
DROP POLICY IF EXISTS playlists_insert_admin ON podcast.playlists;
CREATE POLICY playlists_insert_admin ON podcast.playlists
    AS PERMISSIVE
    FOR INSERT TO public
    WITH CHECK (((user_id = auth.uid()) AND podcast.is_admin()));

DROP POLICY IF EXISTS playlists_update_own ON podcast.playlists;
DROP POLICY IF EXISTS playlists_update_admin ON podcast.playlists;
CREATE POLICY playlists_update_admin ON podcast.playlists
    AS PERMISSIVE
    FOR UPDATE TO public
    USING (podcast.is_admin());

DROP POLICY IF EXISTS playlists_delete_own ON podcast.playlists;
DROP POLICY IF EXISTS playlists_delete_admin ON podcast.playlists;
CREATE POLICY playlists_delete_admin ON podcast.playlists
    AS PERMISSIVE
    FOR DELETE TO public
    USING (podcast.is_admin());

DROP POLICY IF EXISTS playlist_tracks_manage_own ON podcast.playlist_tracks;
DROP POLICY IF EXISTS playlist_tracks_manage_admin ON podcast.playlist_tracks;
CREATE POLICY playlist_tracks_manage_admin ON podcast.playlist_tracks
    AS PERMISSIVE
    FOR ALL TO public
    USING (podcast.is_admin())
    WITH CHECK (podcast.is_admin());

CREATE OR REPLACE FUNCTION podcast.delete_playlist(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, podcast
AS $function$
BEGIN
    IF NOT podcast.is_admin() THEN
        RAISE EXCEPTION 'Not authorized to delete this playlist' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM podcast.playlists WHERE id = p_id) THEN
        RAISE EXCEPTION 'Playlist not found' USING ERRCODE = 'P0002';
    END IF;

    UPDATE podcast.playlists SET deleted_at = now() WHERE id = p_id;
END;
$function$
;
REVOKE EXECUTE ON FUNCTION podcast.delete_playlist(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION podcast.delete_playlist(uuid) TO authenticated, service_role;

-- 3 ---------------------------------------------------------------------------
-- The admin analytics functions refuse non-admins themselves, but anon never
-- needs to reach them at all — and still could, through PUBLIC's default grant.
REVOKE EXECUTE ON FUNCTION podcast.get_admin_dashboard(integer)   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION podcast.get_admin_timeseries(integer)  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION podcast.get_admin_track_stats(integer) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION podcast.get_admin_reach(integer)       FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION podcast.get_play_analytics(integer)    FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION podcast.get_play_timeseries(integer)   FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA podcast FROM anon;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA podcast FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON podcast.play_events       FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON podcast.schema_migrations FROM authenticated;

-- 4 ---------------------------------------------------------------------------
ALTER FUNCTION podcast.get_play_analytics(integer)            SET search_path = pg_catalog, podcast;
ALTER FUNCTION podcast.get_play_timeseries(integer)           SET search_path = pg_catalog, podcast;
ALTER FUNCTION podcast.get_user_role(uuid)                    SET search_path = pg_catalog, podcast;
ALTER FUNCTION podcast.handle_new_user()                      SET search_path = pg_catalog, podcast;
ALTER FUNCTION podcast.increment_play_count(uuid)             SET search_path = pg_catalog, podcast;
ALTER FUNCTION podcast.is_admin()                             SET search_path = pg_catalog, podcast;
ALTER FUNCTION podcast.is_super_admin()                       SET search_path = pg_catalog, podcast;
ALTER FUNCTION podcast.update_comment_count()                 SET search_path = pg_catalog, podcast;
ALTER FUNCTION podcast.update_favorite_count()                SET search_path = pg_catalog, podcast;
ALTER FUNCTION podcast.update_playlist_stats()                SET search_path = pg_catalog, podcast;
ALTER FUNCTION podcast.user_has_permission(uuid, text)        SET search_path = pg_catalog, podcast;

-- 5 ---------------------------------------------------------------------------
ALTER TABLE podcast.profiles DROP CONSTRAINT IF EXISTS profiles_username_format_check;
ALTER TABLE podcast.profiles ADD  CONSTRAINT profiles_username_format_check
    CHECK (username IS NULL OR username ~ '^[a-z0-9_]{3,20}$') NOT VALID;
ALTER TABLE podcast.profiles DROP CONSTRAINT IF EXISTS profiles_full_name_length_check;
ALTER TABLE podcast.profiles ADD  CONSTRAINT profiles_full_name_length_check
    CHECK (full_name IS NULL OR length(full_name) <= 100) NOT VALID;

INSERT INTO podcast.schema_migrations (version)
VALUES ('037_lock_down_public_writes')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- Check afterwards — each should return the row shown:
--
--   SELECT has_function_privilege('anon', 'podcast.increment_play_count(uuid)', 'EXECUTE');  -- f
--   SELECT has_table_privilege('anon', 'podcast.tracks', 'INSERT');                         -- f
--   SELECT policyname FROM pg_policies WHERE schemaname = 'podcast' AND tablename = 'playlists' ORDER BY 1;
--     -- playlists_delete_admin, playlists_insert_admin, playlists_select, playlists_update_admin
--
-- And, since a listener could create public playlists until now, look for any
-- that an admin did not make:
--
--   SELECT pl.id, pl.title, pl.slug, pr.username, pr.role
--   FROM podcast.playlists pl JOIN podcast.profiles pr ON pr.id = pl.user_id
--   WHERE pl.deleted_at IS NULL AND pr.role NOT IN ('admin', 'super_admin');
