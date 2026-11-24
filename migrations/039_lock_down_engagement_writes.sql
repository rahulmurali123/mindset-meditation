-- =============================================================================
-- 039 — engagement writes: counts, comment flooding, impersonation
-- =============================================================================
-- Like 037, these are paths that skip the app and go straight to PostgREST
-- with the public anon key and a free account. Run AFTER 037 and 038.
--
-- 1. favorite_count / comment_count can be inflated without limit or driven to
--    zero. `authenticated` still held table-wide UPDATE on favorites and
--    comments (blanket GRANT), and the counter triggers fire only on INSERT and
--    DELETE. Insert a like on episode X (+1 on X), PATCH its track_id to Y (no
--    change), delete it (−1 on Y), repeat: X's heart count climbs forever and
--    any other episode can be zeroed. Nothing in the app ever UPDATEs either
--    table, so UPDATE is simply revoked.
-- 2. INSERT was table-wide too, so a client could choose `created_at` — a
--    future timestamp pinned a comment to the top of its thread and skewed the
--    analytics windows. INSERT is now granted only on the columns the app sends.
-- 3. The comment rate limit (5 a minute, 100 a day) lived only in the server
--    action, so inserting through /rest/v1/comments skipped it. The same limit
--    is now enforced by a trigger. The service role and admins are exempt.
-- 4. full_name and username were user-writable through PostgREST, so a
--    listener could rename themselves "The Mindset Meditation" and comment as
--    the show. There is no profile editor in the app — sign-up sets both, via
--    the service role — so only avatar_url stays user-writable.
-- =============================================================================

-- 1 + 2 -----------------------------------------------------------------------
REVOKE INSERT, UPDATE ON podcast.favorites FROM authenticated;
REVOKE INSERT, UPDATE ON podcast.comments  FROM authenticated;
GRANT INSERT (track_id, user_id)                  ON podcast.favorites TO authenticated;
GRANT INSERT (track_id, user_id, body, parent_id) ON podcast.comments  TO authenticated;

-- 3 ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS comments_user_created_idx
    ON podcast.comments USING btree (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION podcast.throttle_comments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, podcast
AS $$
BEGIN
    -- The service role (no auth.uid()) and admins are never throttled.
    IF auth.uid() IS NULL OR podcast.is_admin() THEN
        RETURN NEW;
    END IF;

    IF (SELECT count(*) FROM podcast.comments
         WHERE user_id = NEW.user_id AND created_at > now() - interval '1 minute') >= 5
       OR (SELECT count(*) FROM podcast.comments
         WHERE user_id = NEW.user_id AND created_at > now() - interval '1 day') >= 100
    THEN
        RAISE EXCEPTION 'comment_rate_limited' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION podcast.throttle_comments() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_throttle_comments ON podcast.comments;
CREATE TRIGGER trg_throttle_comments
    BEFORE INSERT ON podcast.comments
    FOR EACH ROW EXECUTE FUNCTION podcast.throttle_comments();

-- 4 ---------------------------------------------------------------------------
REVOKE UPDATE ON podcast.profiles FROM authenticated;
GRANT UPDATE (avatar_url, updated_at) ON podcast.profiles TO authenticated;

INSERT INTO podcast.schema_migrations (version)
VALUES ('039_lock_down_engagement_writes')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- Verify (expect: no UPDATE for authenticated on favorites/comments, and
-- column-level INSERT only):
--   SELECT table_name, privilege_type FROM information_schema.role_table_grants
--    WHERE grantee = 'authenticated' AND table_schema = 'podcast'
--      AND table_name IN ('favorites', 'comments', 'profiles');
