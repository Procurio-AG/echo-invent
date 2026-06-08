#!/usr/bin/env bash
# db-switch.sh — flip the 2 DB keys (DATABASE_URL + DIRECT_URL) between the
# local Docker Postgres and Supabase, without touching any application code.
#
#   ./scripts/db-switch.sh local       # use Docker Postgres
#   ./scripts/db-switch.sh supabase    # use Supabase (cloud)
#   ./scripts/db-switch.sh status      # show which profile .env is on
#
# How it works: the active .env IS the abstraction boundary. This script just
# swaps two profile files into place:
#   .env.local-db   <- local Docker creds (from .env.local-db.example)
#   .env.supabase   <- your real Supabase creds (auto-seeded from .env once)
# Both profile files stay out of git (see .git/info/exclude).
set -euo pipefail

cd "$(dirname "$0")/.."

LOCAL_PROFILE=".env.local-db"
CLOUD_PROFILE=".env.supabase"

current_mode() {
  [ -f .env ] || { echo "none"; return; }
  if grep -q "localhost:5432" .env; then echo "local";
  elif grep -q "supabase.com" .env; then echo "supabase";
  else echo "unknown"; fi
}

case "${1:-}" in
  local)
    # Seed local profile from the committed example if it's missing.
    [ -f "$LOCAL_PROFILE" ] || cp .env.local-db.example "$LOCAL_PROFILE"
    # Preserve current Supabase creds before overwriting .env.
    if [ ! -f "$CLOUD_PROFILE" ] && [ "$(current_mode)" = "supabase" ]; then
      cp .env "$CLOUD_PROFILE"
      echo "Saved current Supabase creds -> $CLOUD_PROFILE"
    fi
    cp "$LOCAL_PROFILE" .env
    echo "Switched .env -> LOCAL Docker Postgres (localhost:5432)"
    echo "Next: docker compose up -d && npx prisma migrate deploy"
    ;;
  supabase)
    if [ ! -f "$CLOUD_PROFILE" ]; then
      echo "ERROR: $CLOUD_PROFILE not found. Paste your Supabase URLs into it first." >&2
      exit 1
    fi
    cp "$CLOUD_PROFILE" .env
    echo "Switched .env -> SUPABASE (cloud)"
    ;;
  status)
    echo "Active DB profile: $(current_mode)"
    ;;
  *)
    echo "usage: $0 {local|supabase|status}" >&2
    exit 1
    ;;
esac
