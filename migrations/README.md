# migrations/

`fullschema.sql` at the repo root is the source of truth for the database. This
directory holds **one-time upgrade scripts** for a database that already exists
and is behind — nothing more. There is no migration runner.

## Which file do I run?

| Situation | Run |
|---|---|
| Brand-new Supabase project | `fullschema.sql` — it already contains everything |
| Existing database, behind by one version | the matching `NNN_*.sql` here |
| Not sure what state you are in | `fullschema.sql` — it is idempotent and converges |
| You changed the schema | Edit `fullschema.sql`, then add a delta file here for anyone already deployed |

Check where a database currently is:

```sql
SELECT version FROM podcast.schema_migrations ORDER BY version DESC LIMIT 1;
```

## The rule that keeps these honest

**Every statement in a file here must also appear in `fullschema.sql`.** The two
are not alternatives — a fresh install runs `fullschema.sql` only, and an
existing database runs the delta only, and both must end up at the same schema.
When they disagree, a bug appears on exactly one of those two paths and is
invisible on the other.

## Files

| Version | What it does |
|---|---|
| `030_seo_metadata_and_search.sql` | Generated SEO columns (`excerpt`, `meta_description`, `keywords`, `published_at`, `file_size_bytes`, `bitrate_kbps`, `blur_data_url`), `search_vector` + GIN indexes on tracks and playlists, the ranked `search_tracks` RPC, and fixes for three functions that referenced tables this schema never creates — including `is_super_admin()`, which was live in an RLS policy and made every profile delete fail. |

| `031_playlist_soft_delete_policy.sql` | Rebuilds the four `podcast.playlists` RLS policies to match `fullschema.sql`. The live UPDATE policy carried `deleted_at IS NULL` in its WITH CHECK, so an admin pressing Delete got "new row violates row-level security policy" — soft-delete was blocked by the policy meant to permit it. Policies had not been touched since 010, so the delta path had drifted from a fresh install. |
| `032_verify_playlist_delete_policy.sql` | The same fix as 031, reapplied unconditionally — the version row for 031 was present yet the same delete still failed, so this stops trusting `schema_migrations` as proof and rebuilds the four policies again. Includes a self-test: it performs the exact failing operation (`SET ROLE authenticated` + a real admin's JWT claims, then the soft-delete) inside a transaction that always rolls back, so the SQL editor itself reports pass or fail rather than the app. Not a schema change — the self-test writes nothing durable, so there is nothing here that needs to appear in `fullschema.sql` beyond the version marker. |
| `033_playlist_delete_via_rpc.sql` | The update policy was proven correct — verified in `pg_policies` character-for-character, and `auth.uid()`/`podcast.is_admin()` proven to resolve exactly right in the *same transaction* as a failing `UPDATE` — and it still rejected the soft-delete. Rather than keep changing SQL already shown to be right, this adds `podcast.delete_playlist(p_id)`, a `SECURITY DEFINER` function that performs the identical owner-or-admin check itself and updates as its own owner, bypassing table RLS for this one operation. `adminDeletePlaylist` now calls this RPC instead of a direct `.update()`. |
| `034_security_audit_hardening.sql` | A full RBAC/RLS audit found five gaps, none exploited by the app itself: `get_user_role`/`user_has_permission` (both `SECURITY DEFINER`) let any caller query an arbitrary user's role, enabling admin-account enumeration — both now require the caller to be asking about themselves or to already be an admin. The storage policy `podcast_audio_authenticated_read` let any authenticated user read any object in the private audio bucket directly, including unpublished drafts, bypassing the publish-status gate `/api/stream/[id]` enforces — replaced with an admin-only read policy, since nothing legitimate reads that bucket directly. `comments_update_own` and `playlist_tracks_manage_own` were missing a `WITH CHECK`, so a user could retarget their own comment or playlist entry onto an unpublished track — both now require the track to still be published. |

| `035_analytics_reach_and_dashboard.sql` | Adds request context to `play_events` (`country`, `referrer_host`, `device_type`, `browser`, `os`, `language`, all NULLable and populated forward-only by `/api/stream`) so the dashboard's Reach section has something real behind it — previously there was no column in the database that could answer where a listener came from. Adds four admin aggregates: `get_admin_dashboard`, `get_admin_timeseries`, `get_admin_track_stats` and `get_admin_reach`. The per-episode figures move into SQL because the page was fetching up to 10,000 `play_events` rows and reducing them in JS, which silently returns wrong retention once a window exceeds that cap. All four gate on `is_admin()` and are granted to `authenticated` only, not `anon`. |
| `036_hard_delete_tracks_keep_play_history.sql` | Makes `play_events.track_id` NULLable with `ON DELETE SET NULL` (was `NOT NULL` + `CASCADE`), so `adminDeletePodcast` can delete an episode for real without erasing its plays from the all-time analytics totals. Required by the current delete action. |
| `037_lock_down_public_writes.sql` | Closes paths reachable straight through PostgREST with the public anon key. `increment_play_count` (SECURITY DEFINER) was executable by anon, so anyone could inflate any episode's play count — now service-role only, called by `/api/stream` once per recorded play. `playlists_insert_own`/`_update_own`/`_delete_own` and `playlist_tracks_manage_own` let any free account publish a public playlist onto `/playlists`, the sitemap and the homepage artwork — every playlist write is now admin-only, as is `delete_playlist()`. Removes anon's INSERT/UPDATE/DELETE on every table and EXECUTE on the admin analytics RPCs, pins `search_path` on the eleven SECURITY DEFINER functions that lacked it, and adds NOT VALID shape checks on the two profile columns users may edit (`username`, `full_name`). Ends with the queries to verify it and to find any playlist a non-admin created before it ran. The app works on either side of it — deploy order does not matter. |
| `038_admin_second_factor_and_playlist_stats.sql` | Enforces the admin verification code **in the database**: `is_admin()` (and `is_super_admin()`) now also require a live row in the new service-role-only `podcast.admin_sessions` table, keyed by the JWT's `session_id`, which the app writes only after the code is accepted and deletes on sign-out. Before this, a leaked admin password alone was enough to edit or delete everything through PostgREST. The audio upload storage policy now uses `is_admin()` too. Also recomputes `playlists.track_count` / `total_duration_seconds` from **published** episodes on every membership change and every status/duration/delete change to a track, and backfills them. Admins are asked for the code once more after it runs. The app tolerates the table being absent, so code can deploy first. |
| `039_lock_down_engagement_writes.sql` | Closes the last PostgREST write paths a free account could abuse. `authenticated` held table-wide UPDATE on `favorites` and `comments` while the count triggers only follow INSERT/DELETE, so re-pointing a row's `track_id` inflated one episode's like/comment count and zeroed another's — UPDATE is revoked (the app never updates either). INSERT is narrowed to the columns the app sends, so `created_at` can't be forged. The comment rate limit (5/min, 100/day) is now also a trigger, since a direct `/rest/v1/comments` insert skipped the server action. `profiles.full_name`/`username` are no longer user-writable, so a listener can't rename themselves after the show. Run after 037 and 038. |
| `040_ist_analytics_and_private_cover_listing.sql` | Pins the dashboard functions' timezone to `Asia/Kolkata`, so "today", "yesterday" and the daily chart roll over at Indian midnight instead of 05:30. Replaces the public SELECT policies on the `podcast-thumbnails` / `podcast-images` buckets with admin-only ones: public URLs keep working (public buckets don't consult RLS for them), but anyone could previously list every cover, including unpublished drafts'. |

Anything numbered below 030 was folded into `fullschema.sql` and deleted; the
version list at the bottom of that file is the remaining record of them.
