#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONFIG_FILE="${CONFIG_FILE:-$ROOT/scripts/upgrade-remote-9router.local.env}"
if [ -f "$CONFIG_FILE" ]; then
  set -a
  . "$CONFIG_FILE"
  set +a
fi

REMOTE_HOST="${REMOTE_HOST:-}"
REMOTE_USER="${REMOTE_USER:-}"
REMOTE_PASS="${REMOTE_PASS:-}"
SUDO_PASS="${SUDO_PASS:-$REMOTE_PASS}"
REMOTE_DIR="${REMOTE_DIR:-/volume1/docker/9router}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.remote.yml}"
CONTAINER_NAME="${CONTAINER_NAME:-9router}"
PORT="${PORT:-20128}"
BUILD_DATA_DIR=""

cleanup() {
  if [ -n "$BUILD_DATA_DIR" ]; then
    rm -rf "$BUILD_DATA_DIR"
  fi
}
trap cleanup EXIT

SSH_OPTIONS=(
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
)

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

require_var() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required config: $name" >&2
    echo "Create $CONFIG_FILE from scripts/upgrade-remote-9router.local.env.example" >&2
    exit 1
  fi
}

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

ssh_remote() {
  SSHPASS="$REMOTE_PASS" sshpass -e ssh "${SSH_OPTIONS[@]}" "$REMOTE_USER@$REMOTE_HOST" "$@"
}

sudo_remote() {
  local cmd="$1"
  ssh_remote "printf '%s\n' $(shell_quote "$SUDO_PASS") | sudo -S sh -lc $(shell_quote "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/packages/ContainerManager/target/usr/bin:\$PATH; $cmd")"
}

compose_remote() {
  local args="$1"
  sudo_remote "cd $(shell_quote "$REMOTE_DIR") && if docker compose version >/dev/null 2>&1; then docker compose -f $(shell_quote "$COMPOSE_FILE") $args; else docker-compose -f $(shell_quote "$COMPOSE_FILE") $args; fi"
}

sync_standalone() {
  local dest="$REMOTE_DIR/.next/standalone"

  sudo_remote "mkdir -p $(shell_quote "$dest") && uid=\$(id -u $(shell_quote "$REMOTE_USER")) && gid=\$(id -g $(shell_quote "$REMOTE_USER")) && chown -R \"\$uid:\$gid\" $(shell_quote "$REMOTE_DIR/.next")"
  ssh_remote "find $(shell_quote "$dest") -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf {} +"
  tar \
    --exclude './.env' \
    --exclude './.env.*' \
    --exclude './data' \
    --exclude './*.sqlite' \
    --exclude './*.sqlite-*' \
    --exclude './*.db' \
    --exclude './auth.json' \
    --exclude './config.toml' \
    -C "$ROOT/.next/standalone" \
    -cf - . | ssh_remote "tar -C $(shell_quote "$dest") -xmf -"
}

echo "[1/7] Checking local tools..."
require_cmd sshpass
require_cmd tar
require_cmd npm
require_cmd curl
require_var REMOTE_HOST
require_var REMOTE_USER
require_var REMOTE_PASS
require_var SUDO_PASS

echo "[2/7] Checking remote deployment..."
ssh_remote "test -d $(shell_quote "$REMOTE_DIR") && test -f $(shell_quote "$REMOTE_DIR/$COMPOSE_FILE")"
ssh_remote "grep -Eq '^[[:space:]]*network_mode:[[:space:]]*host[[:space:]]*$' $(shell_quote "$REMOTE_DIR/$COMPOSE_FILE")"

echo "[3/7] Installing local dependencies..."
if [ -f "$ROOT/package-lock.json" ]; then
  npm ci
else
  npm install
fi

echo "[4/7] Building Next standalone output..."
BUILD_DATA_DIR="$(mktemp -d)"
DATA_DIR="$BUILD_DATA_DIR" npm run build

echo "[5/7] Preparing standalone assets..."
mkdir -p "$ROOT/.next/standalone/.next"
rm -rf "$ROOT/.next/standalone/public" "$ROOT/.next/standalone/.next/static"
rm -f "$ROOT/.next/standalone/.env" "$ROOT/.next/standalone/auth.json" "$ROOT/.next/standalone/config.toml"
cp -a "$ROOT/public" "$ROOT/.next/standalone/public"
cp -a "$ROOT/.next/static" "$ROOT/.next/standalone/.next/static"

echo "[6/7] Syncing runtime files and recreating container..."
compose_remote "stop $(shell_quote "$CONTAINER_NAME") || true"
sync_standalone
compose_remote "up -d --force-recreate $(shell_quote "$CONTAINER_NAME")"

echo "[7/7] Waiting for health check..."
for _ in $(seq 1 40); do
  if curl -fsS "http://$REMOTE_HOST:$PORT/api/health" >/dev/null; then
    status="$(sudo_remote "docker inspect $(shell_quote "$CONTAINER_NAME") --format '{{.HostConfig.NetworkMode}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}'" | tail -n 1)"
    if [ "$status" = "host healthy" ] || [ "$status" = "host no-healthcheck" ]; then
      echo "$status"
      echo "9router upgraded: http://$REMOTE_HOST:$PORT"
      exit 0
    fi
  fi
  sleep 2
done

echo "9router did not become healthy in time. Recent logs:" >&2
sudo_remote "docker logs --tail=120 $(shell_quote "$CONTAINER_NAME")" >&2 || true
exit 1
