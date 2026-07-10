#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi

  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

detect_host_ip() {
  if command -v ip >/dev/null 2>&1; then
    ip route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }'
    return
  fi

  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk '{ print $1 }'
  fi
}

ensure_runtime_env() {
  local env_file="$1"

  if [ -f "$env_file" ]; then
    return
  fi

  mkdir -p "$(dirname "$env_file")"
  chmod 700 "$(dirname "$env_file")"

  cat >"$env_file" <<EOF
INITIAL_PASSWORD=123456
JWT_SECRET=$(random_hex)
API_KEY_SECRET=$(random_hex)
MACHINE_ID_SALT=$(random_hex)
ENABLE_REQUEST_LOGS=false
OBSERVABILITY_ENABLED=true
AUTH_COOKIE_SECURE=false
REQUIRE_API_KEY=false
EOF

  chmod 600 "$env_file"
}

RUN_ENV="$ROOT/.run/docker.env"
ensure_runtime_env "$RUN_ENV"

set -a
. "$RUN_ENV"
set +a

PORT="${PORT:-20128}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"
PUBLIC_HOST="${PUBLIC_HOST:-$(detect_host_ip)}"
PUBLIC_HOST="${PUBLIC_HOST:-localhost}"
PUBLIC_URL="${PUBLIC_URL:-http://${PUBLIC_HOST}:${PORT}}"
CONTAINER_NAME="${CONTAINER_NAME:-9router}"
HOST_DATA_DIR="${HOST_DATA_DIR:-$ROOT/data}"
IMAGE_NAME="${IMAGE_NAME:-9router:local}"
BUILD_NODE_IMAGE="${BUILD_NODE_IMAGE:-node:22-bookworm-slim}"

export PORT BIND_HOST CONTAINER_NAME HOST_DATA_DIR IMAGE_NAME
export BASE_URL="${BASE_URL:-$PUBLIC_URL}"
export NEXT_PUBLIC_BASE_URL="${NEXT_PUBLIC_BASE_URL:-$PUBLIC_URL}"

echo "[1/4] Building Docker image..."
docker build --build-arg NODE_IMAGE="$BUILD_NODE_IMAGE" -t "$IMAGE_NAME" "$ROOT"

echo "[2/4] Stopping legacy bare 9router process if present..."
current_uid="$(id -u)"
pids="$(ps -eo pid=,uid=,args= | awk -v uid="$current_uid" -v root="$ROOT" '($2 == uid) && (index($0, root "/.next/standalone") || index($0, root "/.next/standalone/server.js")) {print $1}')"
if [ -n "$pids" ]; then
  kill $pids 2>/dev/null || true
  sleep 1
fi

echo "[3/4] Recreating Docker Compose service..."
docker compose --env-file "$RUN_ENV" -f "$ROOT/compose.yaml" up -d --force-recreate

echo "[4/4] Waiting for health check..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
    echo "9router is healthy: $PUBLIC_URL"
    docker compose --env-file "$RUN_ENV" -f "$ROOT/compose.yaml" ps
    exit 0
  fi
  sleep 2
done

echo "9router did not become healthy in time. Recent logs:" >&2
docker logs --tail=80 "$CONTAINER_NAME" >&2 || true
exit 1
