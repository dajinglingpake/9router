#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-20128}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"

detect_host_ip() {
  if command -v ip >/dev/null 2>&1; then
    ip route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }'
    return
  fi

  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk '{ print $1 }'
  fi
}

cd "$ROOT"

mkdir -p "$ROOT/.next/standalone/.next"
cp -a "$ROOT/public" "$ROOT/.next/standalone/public"
cp -a "$ROOT/.next/static" "$ROOT/.next/standalone/.next/static"

if [ -f "$ROOT/.env" ]; then
  set -a
  . "$ROOT/.env"
  set +a
fi

PUBLIC_HOST="${PUBLIC_HOST:-$(detect_host_ip)}"
PUBLIC_HOST="${PUBLIC_HOST:-localhost}"
PUBLIC_URL="${PUBLIC_URL:-http://${PUBLIC_HOST}:${PORT}}"

cd "$ROOT/.next/standalone"
exec env \
  PORT="$PORT" \
  HOSTNAME="$BIND_HOST" \
  NODE_ENV=production \
  BASE_URL="${BASE_URL:-$PUBLIC_URL}" \
  NEXT_PUBLIC_BASE_URL="${NEXT_PUBLIC_BASE_URL:-$PUBLIC_URL}" \
  node server.js
