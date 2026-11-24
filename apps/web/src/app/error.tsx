'use client';

// Shown when a page fails to render — in practice, when Supabase cannot be
// reached. Pages now throw on a failed catalogue read instead of rendering an
// empty one (see throwIfUnavailable in lib/supabase/errors.ts), so without this
// file a visitor got Next's bare "Application error" screen.
//
// Deliberately self-contained: the navbar and footer read the same backend that
// just failed, so they are not rendered here.
import Link from 'next/link';
import { useEffect } from 'react';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[page error]', error.digest ?? '', error.message);
  }, [error]);

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="glass-card rounded-3xl p-8 sm:p-10 max-w-md w-full text-center">
        <h1 className="text-2xl font-bold text-foreground mb-2">Taking a short pause</h1>
        <p className="text-foreground/70 text-sm leading-relaxed mb-6">
          We could not load this page just now. Breathe in, breathe out, and try again in a
          moment.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button
            type="button"
            onClick={reset}
            className="px-5 py-2.5 text-sm font-bold bg-primary text-white rounded-full hover:bg-primary/90 transition-colors"
          >
            Try again
          </button>
          <Link
            href="/"
            className="px-5 py-2.5 text-sm font-bold rounded-full border border-border text-foreground hover:border-primary transition-colors"
          >
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}
