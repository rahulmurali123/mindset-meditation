import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids arrive from the browser as untrusted strings. Checking the shape first
 * turns a malformed one into a clean "not found" instead of a Postgres 22P02
 * whose text was being echoed back to the caller.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * The show's home timezone. Dates are formatted in it on both server and
 * browser — pinned, not the runtime default, so hydration matches — and the
 * admin dashboard's days are cut on it too (migration 040). It used to be UTC,
 * so an episode published at 00:30 in India was dated the previous day.
 */
export const SITE_TIME_ZONE = 'Asia/Kolkata';

const SITE_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: SITE_TIME_ZONE,
});

/** "Nov 24, 2026" in the site's timezone; '' for a missing or bad date. */
export function formatSiteDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : SITE_DATE.format(d);
}
