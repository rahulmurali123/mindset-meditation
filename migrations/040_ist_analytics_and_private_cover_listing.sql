-- =============================================================================
-- 040 — analytics days in India time; cover art no longer listable
-- =============================================================================
-- 1. The dashboard's "today", "yesterday" and daily chart buckets were cut at
--    UTC midnight, i.e. 05:30 in India — plays at 02:00 IST landed on the
--    previous day. Pinning the functions' own timezone makes DATE_TRUNC('day',
--    NOW()) and the ::DATE buckets follow India time with no query changes.
--    The ranges (last 7/30/90 days) are rolling windows and are unaffected.
-- 2. The public-read SELECT policies on the cover buckets also allowed the
--    Storage *list* endpoint, so anyone could enumerate covers/* — including
--    artwork of unpublished drafts. Public buckets serve /object/public/ URLs
--    without consulting RLS, so every page, the feed and next/image keep
--    working; only listing (and API reads) become admin-only.
-- =============================================================================

-- 1 ---------------------------------------------------------------------------
ALTER FUNCTION podcast.get_admin_dashboard(integer)  SET timezone = 'Asia/Kolkata';
ALTER FUNCTION podcast.get_admin_timeseries(integer) SET timezone = 'Asia/Kolkata';
ALTER FUNCTION podcast.get_play_analytics(integer)   SET timezone = 'Asia/Kolkata';
ALTER FUNCTION podcast.get_play_timeseries(integer)  SET timezone = 'Asia/Kolkata';

-- 2 ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "podcast_thumbnails_public_read" ON storage.objects;
DROP POLICY IF EXISTS "podcast_thumbnails_admin_read" ON storage.objects;
CREATE POLICY "podcast_thumbnails_admin_read" ON storage.objects
    AS PERMISSIVE
    FOR SELECT TO authenticated
    USING (((bucket_id = 'podcast-thumbnails'::text) AND podcast.is_admin()));

DROP POLICY IF EXISTS "podcast_images_public_read" ON storage.objects;
DROP POLICY IF EXISTS "podcast_images_admin_read" ON storage.objects;
CREATE POLICY "podcast_images_admin_read" ON storage.objects
    AS PERMISSIVE
    FOR SELECT TO authenticated
    USING (((bucket_id = 'podcast-images'::text) AND podcast.is_admin()));

INSERT INTO podcast.schema_migrations (version)
VALUES ('040_ist_analytics_and_private_cover_listing')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
