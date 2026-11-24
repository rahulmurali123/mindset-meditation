-- =============================================================================
-- 038 — enforce the admin second factor in the database; honest playlist stats
-- =============================================================================
-- 1. The admin verification code only ever guarded the Next.js UI.
--    podcast.is_admin() — which every admin RLS policy relies on — checked
--    profiles.role and nothing else. So a leaked admin password was enough to
--    get a token straight from Supabase Auth with the public anon key and then
--    edit or delete every episode, comment and playlist through PostgREST,
--    without ever seeing /auth/verify.
--
--    Now the second factor is recorded per Supabase SESSION: when the code is
--    accepted, the app (service role) writes a row keyed by the JWT's
--    session_id claim, and is_admin() requires that row as well as the role.
--    A password-only session — from the login form or from the Auth API
--    directly — carries a session_id with no row, so it has no admin rights.
--    Signing out ends the session; the next sign-in is a new session_id and
--    needs the code again. Rows expire with the 12-hour cookie they mirror.
--
--    The audio upload policy used user_has_permission(), which reads the role
--    directly; it now uses is_admin() like every other admin storage policy.
--
-- 2. playlists.track_count / total_duration_seconds counted drafts and were
--    only recomputed when playlist_tracks rows were added or removed. A
--    playlist of three drafts showed "3 sessions" on a page listing none, and
--    replacing an episode's audio left the playlist's total duration stale.
--    Both are now recomputed from published episodes, on every change to
--    playlist_tracks and on every status/duration/delete change to a track.
--
-- Run AFTER deploying the app version that writes admin_sessions (or admins
-- will be asked for the verification code again — which is the point).
-- =============================================================================

-- 1 ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS podcast.admin_sessions (
    session_id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_user_idx ON podcast.admin_sessions (user_id);

-- Written and read only by the service role and by is_admin() (SECURITY
-- DEFINER). No client role may see or touch it.
ALTER TABLE podcast.admin_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON podcast.admin_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON podcast.admin_sessions TO service_role;

CREATE OR REPLACE FUNCTION podcast.admin_session_verified()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = pg_catalog, podcast
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM podcast.admin_sessions s
        WHERE s.user_id = auth.uid()
          AND s.session_id::text = COALESCE(auth.jwt() ->> 'session_id', '')
          AND s.expires_at > now()
    );
$function$;

CREATE OR REPLACE FUNCTION podcast.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path = pg_catalog, podcast
AS $function$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM podcast.profiles
        WHERE id = auth.uid() AND role IN ('admin', 'super_admin')
    ) AND podcast.admin_session_verified();
END;
$function$;

CREATE OR REPLACE FUNCTION podcast.is_super_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path = pg_catalog, podcast
AS $function$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM podcast.profiles p
        WHERE p.id = auth.uid() AND p.role = 'super_admin'
    ) AND podcast.admin_session_verified();
END;
$function$;

REVOKE EXECUTE ON FUNCTION podcast.admin_session_verified() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION podcast.admin_session_verified() TO authenticated, service_role;

DROP POLICY IF EXISTS "podcast_audio_admin_upload" ON storage.objects;
CREATE POLICY "podcast_audio_admin_upload" ON storage.objects
    AS PERMISSIVE
    FOR INSERT TO authenticated
    WITH CHECK (((bucket_id = 'podcast-audio'::text) AND podcast.is_admin()));

-- 2 ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION podcast.refresh_playlist_stats(p_playlist_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path = pg_catalog, podcast
AS $function$
    UPDATE podcast.playlists p
    SET track_count = s.n,
        total_duration_seconds = s.secs
    FROM (
        SELECT COUNT(t.id)::int AS n, COALESCE(SUM(t.duration_seconds), 0)::bigint AS secs
        FROM podcast.playlist_tracks pt
        JOIN podcast.tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = p_playlist_id
          AND t.status = 'published'
          AND t.deleted_at IS NULL
    ) s
    WHERE p.id = p_playlist_id
      AND (p.track_count IS DISTINCT FROM s.n OR p.total_duration_seconds IS DISTINCT FROM s.secs);
$function$;
REVOKE EXECUTE ON FUNCTION podcast.refresh_playlist_stats(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION podcast.update_playlist_stats()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, podcast
AS $function$
BEGIN
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        PERFORM podcast.refresh_playlist_stats(NEW.playlist_id);
    END IF;
    IF TG_OP IN ('DELETE', 'UPDATE') THEN
        PERFORM podcast.refresh_playlist_stats(OLD.playlist_id);
    END IF;
    RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_playlist_stats ON podcast.playlist_tracks;
CREATE TRIGGER trg_playlist_stats AFTER INSERT OR UPDATE OR DELETE ON podcast.playlist_tracks
    FOR EACH ROW EXECUTE FUNCTION podcast.update_playlist_stats();

CREATE OR REPLACE FUNCTION podcast.track_playlist_stats()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, podcast
AS $function$
DECLARE
    v_playlist uuid;
BEGIN
    FOR v_playlist IN
        SELECT playlist_id FROM podcast.playlist_tracks WHERE track_id = NEW.id
    LOOP
        PERFORM podcast.refresh_playlist_stats(v_playlist);
    END LOOP;
    RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_track_playlist_stats ON podcast.tracks;
CREATE TRIGGER trg_track_playlist_stats
    AFTER UPDATE OF status, duration_seconds, deleted_at ON podcast.tracks
    FOR EACH ROW EXECUTE FUNCTION podcast.track_playlist_stats();

-- Bring every existing playlist in line with the new rule.
SELECT podcast.refresh_playlist_stats(id) FROM podcast.playlists;

INSERT INTO podcast.schema_migrations (version)
VALUES ('038_admin_second_factor_and_playlist_stats')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
