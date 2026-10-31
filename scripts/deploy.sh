#!/usr/bin/env bash
# =============================================================================
# The Mindset Meditation — build and (re)start production on the VPS
# =============================================================================
# Run on the server, from anywhere inside the checkout:
#
#   ./scripts/deploy.sh
#
# What it does, in order — and stops at the first failure:
#   1. preflight: Node ≥ 22, pnpm, an env file, a clean working tree
#   2. git pull --ff-only on $BRANCH
#   3. pnpm install --frozen-lockfile
#   4. build into a SEPARATE dist dir, so the live site keeps serving while it
#      builds (building straight into .next deletes the running server's files)
#   5. copy public/ and static/ beside server.js — Next does not do this
#   6. swap the new standalone tree in, keeping the previous one for rollback
#   7. restart the systemd unit and poll /api/health
#        - no answer at all → the new build is broken: roll back automatically
#        - answers 503      → the build runs, but a dependency (Supabase schema
#                             exposure, keys, admin code) is misconfigured: the
#                             new build stays, the failing checks are printed
#
# Never touches Vercel. Settings, all optional:
#   BRANCH=main  SERVICE=mindset  PORT=… (else the env file's PORT, the unit's, or 3100)
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

BRANCH=${BRANCH:-main}
SERVICE=${SERVICE:-mindset}
APP=apps/web
DIST=.next-release                 # build output, beside the live .next
LIVE=$APP/.next/standalone         # what systemd runs (see DEPLOY.md)
PREV=$APP/.next/standalone.prev    # the previous release, for rollback
# Files `next build` rewrites for its dist dir. Restored after every build so
# the next `git pull --ff-only` is not refused over a "local change".
GENERATED=("$APP/next-env.d.ts" "$APP/tsconfig.json")

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

have_unit() {
  command -v systemctl >/dev/null 2>&1 && systemctl cat "$SERVICE" >/dev/null 2>&1
}

# Root needs no sudo; anyone else needs it for chown/restart and to remove a
# previous release, which the service user owns once it has run.
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

# ---- 1. preflight -----------------------------------------------------------
say "Preflight"
command -v node >/dev/null || die "node is not installed"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "Node $(node -v) found; 22 or newer is required (the locked @supabase/* packages need it)"
command -v pnpm >/dev/null || die "pnpm is not installed: corepack enable && corepack prepare pnpm@9.15.4 --activate"
command -v curl >/dev/null || die "curl is not installed (needed for the health check)"

ENV_FILE=""
for candidate in .env.production .env; do
  if [ -f "$candidate" ]; then ENV_FILE=$candidate; break; fi
done
[ -n "$ENV_FILE" ] || die "No .env.production or .env at $ROOT — the build needs NEXT_PUBLIC_* values (see DEPLOY.md §2)"
for key in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY NEXT_PUBLIC_APP_URL; do
  grep -Eq "^${key}=.+" "$ENV_FILE" || [ -n "${!key:-}" ] || die "$key is missing from $ENV_FILE — it is baked in at build time"
done

if [ -f .env.local ]; then
  warn ".env.local exists at $ROOT. It outranks $ENV_FILE when building, but systemd"
  warn "reads only its EnvironmentFile — so the build and the running server can disagree."
fi

git checkout -- "${GENERATED[@]}" 2>/dev/null || true
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no
  die "The checkout has local edits (above). Commit them or discard them, then re-run."
fi

# Port the service really listens on. systemd lets EnvironmentFile= override
# Environment=, so the env file is consulted first.
if [ -z "${PORT:-}" ]; then
  PORT=$(sed -n 's/^PORT=//p' "$ENV_FILE" | tr -d "\"'" | tail -n1)
fi
if [ -z "${PORT:-}" ] && have_unit; then
  PORT=$(systemctl show -p Environment --value "$SERVICE" | tr ' ' '\n' | sed -n 's/^PORT=//p' | tail -n1)
fi
PORT=${PORT:-3100}

RUN_AS=""
if have_unit; then
  RUN_AS=$(systemctl show -p User --value "$SERVICE")
  # Ask for the sudo password now, not halfway through swapping releases.
  if [ -n "$SUDO" ]; then
    sudo -v || die "This deploy needs sudo (chown and systemctl restart)."
  fi
fi

# ---- 2. pull ------------------------------------------------------------------
say "Updating $BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
echo "at $(git log -1 --format='%h %s')"

# ---- 3. install -----------------------------------------------------------------
say "Installing dependencies"
pnpm install --frozen-lockfile

# ---- 4. build -------------------------------------------------------------------
say "Building (the live site keeps running)"
$SUDO rm -rf "${APP:?}/$DIST"
if ! NODE_ENV=production NEXT_DIST_DIR=$DIST pnpm --filter @mindset/web build; then
  git checkout -- "${GENERATED[@]}" 2>/dev/null || true
  die "Build failed — nothing was changed on the live site"
fi
git checkout -- "${GENERATED[@]}" 2>/dev/null || true

# ---- 5. assemble ----------------------------------------------------------------
say "Assembling the standalone server"
OUT=$APP/$DIST/standalone
[ -f "$OUT/$APP/server.js" ] || die "Build produced no $OUT/$APP/server.js — is output: 'standalone' still set?"
cp -R "$APP/public" "$OUT/$APP/public"
cp -R "$APP/$DIST/static" "$OUT/$APP/$DIST/static"
# Runtime secrets for a server started outside systemd. Under systemd,
# EnvironmentFile= already provides them and takes precedence.
cp "$ENV_FILE" "$OUT/$APP/$(basename "$ENV_FILE")"
chmod 600 "$OUT/$APP/$(basename "$ENV_FILE")"
# The server writes regenerated (ISR) pages into its own tree, so it must own
# it. Done before the swap so nothing slow sits between swap and restart.
if [ -n "$RUN_AS" ] && [ "$RUN_AS" != "$(id -un)" ]; then
  $SUDO chown -R "$RUN_AS": "$OUT"
fi

# ---- 6. swap --------------------------------------------------------------------
say "Swapping the new release in"
mkdir -p "$APP/.next"
$SUDO rm -rf "$PREV"
[ -d "$LIVE" ] && mv "$LIVE" "$PREV"
mv "$OUT" "$LIVE"
$SUDO rm -rf "${APP:?}/$DIST"

# ---- 7. restart + health ----------------------------------------------------------
restart() {
  $SUDO systemctl restart "$SERVICE"
}

# Prints the health body; returns 0 healthy, 1 up but unhealthy, 2 not running.
# Only "connection refused" on every attempt counts as not running: a slow
# answer means the server is up and a dependency is hanging — rolling back a
# good build for that would blame the wrong thing.
probe() {
  local out code rc answered=0
  for _ in $(seq 1 30); do
    set +e
    out=$(curl -s -m 15 -w '\n%{http_code}' "http://127.0.0.1:$PORT/api/health")
    rc=$?
    set -e
    code=${out##*$'\n'}
    if [ "$rc" -eq 0 ] && [ "$code" = "200" ]; then echo "${out%$'\n'*}"; return 0; fi
    if [ "$rc" -eq 0 ] && [ "$code" = "503" ]; then echo "${out%$'\n'*}"; return 1; fi
    [ "$rc" -ne 7 ] && answered=1   # 7 = connection refused; anything else reached it
    sleep 2
  done
  [ "$answered" -eq 1 ] && { echo "(no health answer within 15 s)"; return 1; }
  return 2
}

if ! have_unit; then
  warn "No systemd unit named '$SERVICE' (set SERVICE=…), so nothing was restarted."
  warn "Restart your process manager now — the server is $ROOT/$LIVE/$APP/server.js —"
  warn "then check: curl -s http://127.0.0.1:$PORT/api/health"
  exit 1
fi

say "Restarting $SERVICE"
restart

say "Checking http://127.0.0.1:$PORT/api/health"
set +e
HEALTH=$(probe)
STATUS=$?
set -e

case $STATUS in
  0)
    echo "$HEALTH"
    say "Deployed $(git log -1 --format='%h') — healthy"
    ;;
  1)
    echo "$HEALTH"
    warn "The new build is running, but a dependency check failed (false above)."
    warn "  schema: false      → Supabase Dashboard → Project Settings → Data API → Exposed schemas: add \"podcast\""
    warn "  serviceRole: false → SUPABASE_SERVICE_ROLE_KEY missing or from another project"
    warn "  adminCode: false   → ADMIN_VERIFICATION_CODE is not set"
    warn "  details: sudo journalctl -u $SERVICE -n 100"
    exit 1
    ;;
  *)
    warn "The new build did not answer on port $PORT — rolling back."
    if [ -d "$PREV" ]; then
      $SUDO rm -rf "$LIVE.failed"
      mv "$LIVE" "$LIVE.failed"
      mv "$PREV" "$LIVE"
      restart
      die "Rolled back to the previous release. The failed build is in $LIVE.failed; logs: sudo journalctl -u $SERVICE -n 100"
    fi
    die "No previous release to roll back to. Logs: sudo journalctl -u $SERVICE -n 100"
    ;;
esac
