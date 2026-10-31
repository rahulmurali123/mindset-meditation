// Minimal .env loader (no dependency). Loads the repo-root env files into
// process.env without overwriting values already present in the environment.
//
// Same files and precedence as loadRootEnv() in apps/web/next.config.ts —
// real environment, then .env.local, .env.production, .env. They used to read
// only .env, and stopped with "Missing … in .env" on a checkout configured
// through .env.local or a server configured through .env.production.
//
// One difference: next.config.ts reads .env.production only for production
// builds, while these scripts always consider it, because they are run by hand
// on the server where NODE_ENV is usually unset. On a laptop holding both a
// .env.production and a .env, that means a script can target production while
// `pnpm dev` does not — so callers print which files and project they loaded
// (describeEnv) before changing anything.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FILES = ['.env.local', '.env.production', '.env'];

/** Loads every root env file that exists; returns the names it read. */
export function loadEnv(files = FILES.map((name) => join(here, '..', name))) {
  const loaded = [];
  // Keys a higher-precedence file already set; lower files never override them.
  const fromEarlierFile = new Set();

  for (const file of files) {
    if (!existsSync(file)) continue;
    loaded.push(file);
    const fromThisFile = new Set();
    const seen = new Set();

    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }

      if (seen.has(key)) {
        console.warn(`[env] "${key}" is defined more than once; using the last non-empty value.`);
      }
      seen.add(key);

      // A blank value provides nothing: it must not erase a value already found,
      // nor stop a lower-precedence file supplying the real one.
      if (val === '') continue;
      if (fromEarlierFile.has(key)) continue; // a higher-precedence file set it
      if (key in process.env && !fromThisFile.has(key)) continue; // real env wins

      process.env[key] = val;
      fromThisFile.add(key);
    }

    for (const key of fromThisFile) fromEarlierFile.add(key);
  }
  return loaded;
}

/** One line naming the env files read and the Supabase project they point at. */
export function describeEnv(loaded) {
  const files = loaded.length ? loaded.map((f) => f.split('/').pop()).join(', ') : 'none';
  let project = 'unset';
  try {
    project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').host || 'unset';
  } catch {}
  return `env files: ${files} · Supabase project: ${project}`;
}
