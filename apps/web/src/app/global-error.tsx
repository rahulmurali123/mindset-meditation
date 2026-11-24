'use client';

// Last-resort error screen, used when the root layout itself fails or a cached
// page cannot be rebuilt (Supabase unreachable — see throwIfUnavailable). It
// replaces the whole document, so it carries its own <html>/<body> and inline
// styles: the app's stylesheet and theme cannot be assumed to have loaded.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: '#faf9fe',
          color: '#1e1b2e',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <main style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: 24, margin: '0 0 8px' }}>Taking a short pause</h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.75, margin: '0 0 24px' }}>
            The Mindset Meditation could not load this page just now. Breathe in, breathe out, and
            try again in a moment.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '10px 22px',
              borderRadius: 999,
              border: 0,
              background: '#7c3aed',
              color: '#fff',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
