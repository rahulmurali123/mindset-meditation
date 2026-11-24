import { CommentModeration, type ModRow } from '@/components/admin/comment-moderation';
import { createClient } from '@/lib/supabase/server';
import { commentAuthorName, type CommentRow } from '@/lib/comments';

/** The moderation query also embeds the episode each comment belongs to. */
type ModCommentRow = CommentRow & {
  track?: { id: string; title: string; slug: string } | null;
};

export const dynamic = 'force-dynamic';

export default async function AdminCommentsPage() {
  const supabase = await createClient();

  // The admin RLS policy on comments already exposes every comment, including
  // those on unpublished episodes — see comments_select in fullschema.sql.
  const SELECT =
    'id, body, created_at, user_id, parent_id, track:tracks(id, title, slug), author:profiles(full_name, username, email)';
  const { data } = await supabase
    .from('comments')
    .select(SELECT)
    .order('created_at', { ascending: false })
    .limit(300);
  const recent = (data ?? []) as unknown as ModCommentRow[];

  // A reply only renders under its thread's root. When a new reply lands on an
  // older thread whose root is outside the newest 300, the root was missing
  // and the reply — possibly the one that needs removing — never showed up.
  const present = new Set(recent.map((c) => c.id));
  const missingRoots = [
    ...new Set(recent.map((c) => c.parent_id).filter((id): id is string => !!id && !present.has(id))),
  ];
  const { data: roots } = missingRoots.length
    ? await supabase.from('comments').select(SELECT).in('id', missingRoots)
    : { data: [] };

  const all = [...recent, ...((roots ?? []) as unknown as ModCommentRow[])];
  const rows: ModRow[] = all.map((c) => ({
    id: c.id,
    body: c.body,
    created_at: c.created_at,
    parent_id: c.parent_id ?? null,
    author: commentAuthorName(c.author),
    trackId: c.track?.id ?? '',
    trackTitle: c.track?.title ?? 'Unknown episode',
    trackSlug: c.track?.slug ?? '',
  }));

  return (
    <div>
      <h1 className="text-2xl font-black text-foreground mb-1">Comments</h1>
      <p className="text-sm text-muted-foreground mb-8">
        Every comment across all episodes. Reply as the host, or remove anything that
        doesn&apos;t belong.
      </p>
      <CommentModeration rows={rows} />
    </div>
  );
}
