'use client';

// The footer's "Account" column.
//
// The footer itself is a server component rendered into ISR-cached pages, so it
// cannot know who is looking at it — it always offered "Sign in / Create
// account", even to a signed-in listener. Only this column reads the session,
// from the AuthProvider the navbar already uses, so the cached HTML stays
// shareable and nothing else in the footer becomes dynamic.
import Link from 'next/link';
import { useAuth } from '@/components/providers/auth-provider';

const LINK = 'text-sm text-foreground/60 hover:text-primary transition-colors duration-300';

const SIGNED_OUT: Array<{ href: string; label: string }> = [
  { href: '/auth/login', label: 'Sign in' },
  { href: '/auth/register', label: 'Create account' },
];

export function FooterAccountLinks() {
  const { user, loading, signOut } = useAuth();

  // Same signed-out links while the session resolves: that is what the cached
  // HTML holds, so there is no flash for the (more common) signed-out visitor.
  if (loading || !user) {
    return (
      <ul className="space-y-2.5">
        {SIGNED_OUT.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className={LINK}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  const isAdmin = user.role === 'admin' || user.role === 'super_admin';

  return (
    <ul className="space-y-2.5">
      {/* "Your library" is already in the Listen column beside this one. */}
      {isAdmin && (
        <li>
          <Link href="/admin" className={LINK}>
            Admin dashboard
          </Link>
        </li>
      )}
      <li>
        <button type="button" onClick={() => void signOut()} className={LINK}>
          Sign out
        </button>
      </li>
    </ul>
  );
}
