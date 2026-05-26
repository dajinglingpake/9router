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

detect_node_image() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || true)"
    if [ -n "$major" ]; then
      printf "node:%s-bookworm-slim\n" "$major"
      return
    fi
  fi

  printf "node:24-bookworm-slim\n"
}

append_env_if_missing() {
  local env_file="$1"
  local key="$2"
  local value="$3"

  if grep -q "^${key}=" "$env_file" 2>/dev/null; then
    return
  fi

  printf "%s=%s\n" "$key" "$value" >>"$env_file"
}

env_file_value() {
  local env_file="$1"
  local key="$2"

  [ -f "$env_file" ] || return 0
  awk -F= -v key="$key" '
    $1 == key {
      val = substr($0, length(key) + 2)
      gsub(/^["'\'']|["'\'']$/, "", val)
      print val
      exit
    }
  ' "$env_file"
}

ensure_runtime_env() {
  local env_file="$1"

  mkdir -p "$(dirname "$env_file")"
  chmod 700 "$(dirname "$env_file")"

  touch "$env_file"

  chmod 600 "$env_file"
  append_env_if_missing "$env_file" "INITIAL_PASSWORD" "123456"
  append_env_if_missing "$env_file" "JWT_SECRET" "$(random_hex)"
  append_env_if_missing "$env_file" "API_KEY_SECRET" "$(random_hex)"
  append_env_if_missing "$env_file" "MACHINE_ID_SALT" "$(random_hex)"
  append_env_if_missing "$env_file" "ENABLE_REQUEST_LOGS" "false"
  append_env_if_missing "$env_file" "OBSERVABILITY_ENABLED" "true"
  append_env_if_missing "$env_file" "AUTH_COOKIE_SECURE" "false"
  append_env_if_missing "$env_file" "REQUIRE_API_KEY" "false"
}

run_node() {
  docker run --rm \
    -e HOST_UID="$(id -u)" \
    -e HOST_GID="$(id -g)" \
    -e HOME=/tmp \
    -e npm_config_cache=/tmp/.npm \
    -v "$ROOT:/workspace" \
    -w /workspace \
    "${NODE_IMAGE:-$(detect_node_image)}" \
    sh -lc "$*"
}

run_build_cmd() {
  local cmd="$1"

  if [ "${BUILD_IN_DOCKER:-false}" != "false" ]; then
    if docker image inspect "${NODE_IMAGE:-$(detect_node_image)}" >/dev/null 2>&1 || [ "${BUILD_IN_DOCKER:-auto}" = "true" ]; then
      run_node "$cmd"
      return
    fi
  fi

  if command -v npm >/dev/null 2>&1; then
    sh -lc "$cmd"
    return
  fi

  run_node "$cmd"
}

current_container_data_dir() {
  docker inspect "${CONTAINER_NAME:-9router}" \
    --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' \
    2>/dev/null || true
}

ensure_runtime_image() {
  if docker image inspect "$NODE_IMAGE" >/dev/null 2>&1; then
    return
  fi

  if command -v timeout >/dev/null 2>&1; then
    timeout "${DOCKER_PULL_TIMEOUT:-120}" docker pull "$NODE_IMAGE"
    return
  fi

  docker pull "$NODE_IMAGE"
}

legacy_pid() {
  local pid_file="$ROOT/.run/9router.pid"
  local pid cmd cwd

  [ -f "$pid_file" ] || return 0
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0

  cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  if [ "$cwd" = "$ROOT" ] && printf "%s" "$cmd" | grep -Eq 'next dev|next start|server\.js'; then
    printf "%s\n" "$pid"
  fi
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
STANDALONE_DIR="${STANDALONE_DIR:-$ROOT/.next/standalone}"
CURRENT_DATA_DIR="$(current_container_data_dir)"
DOTENV_DATA_DIR="$(env_file_value "$ROOT/.env" "DATA_DIR")"
HOST_DATA_DIR="${HOST_DATA_DIR:-${CURRENT_DATA_DIR:-${DATA_DIR:-${DOTENV_DATA_DIR:-$ROOT/data}}}}"
NODE_IMAGE="${NODE_IMAGE:-$(detect_node_image)}"

export PORT BIND_HOST CONTAINER_NAME STANDALONE_DIR HOST_DATA_DIR NODE_IMAGE
export BASE_URL="${BASE_URL:-$PUBLIC_URL}"
export NEXT_PUBLIC_BASE_URL="${NEXT_PUBLIC_BASE_URL:-$PUBLIC_URL}"

mkdir -p "$HOST_DATA_DIR"
append_env_if_missing "$RUN_ENV" "HOST_DATA_DIR" "$HOST_DATA_DIR"
append_env_if_missing "$RUN_ENV" "NODE_IMAGE" "$NODE_IMAGE"

echo "[1/6] Installing dependencies..."
run_build_cmd "set -e; if command -v apk >/dev/null 2>&1; then apk add --no-cache python3 make g++ linux-headers; fi; npm install; chown -R \"\${HOST_UID:-$(id -u)}:\${HOST_GID:-$(id -g)}\" node_modules package-lock.json 2>/dev/null || true"

echo "[2/6] Building Next standalone output..."
run_build_cmd "set -e; npm run build; chown -R \"\${HOST_UID:-$(id -u)}:\${HOST_GID:-$(id -g)}\" .next 2>/dev/null || true"

echo "[3/6] Syncing standalone static assets..."
mkdir -p "$ROOT/.next/standalone/.next"
rm -rf "$ROOT/.next/standalone/public" "$ROOT/.next/standalone/.next/static"
cp -a "$ROOT/public" "$ROOT/.next/standalone/public"
cp -a "$ROOT/.next/static" "$ROOT/.next/standalone/.next/static"
mkdir -p "$ROOT/.next/standalone/data"

echo "[4/6] Stopping legacy bare 9router process if present..."
pids="$(legacy_pid)"
if [ -n "$pids" ]; then
  kill $pids
  sleep 1
fi

echo "[5/6] Recreating Docker Compose service..."
ensure_runtime_image
docker compose --env-file "$RUN_ENV" -f "$ROOT/compose.yaml" up -d --force-recreate

echo "[6/6] Waiting for health check..."
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
