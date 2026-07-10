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
IMAGE_NAME="${IMAGE_NAME:-9router:local}"
BUILD_NODE_IMAGE="${BUILD_NODE_IMAGE:-node:22-bookworm-slim}"

SSH_OPTIONS=(
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR
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
  ssh_remote "printf '%s\n' $(shell_quote "$SUDO_PASS") | sudo -S -p '' sh -lc $(shell_quote "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/packages/ContainerManager/target/usr/bin:\$PATH; $cmd")"
}

compose_remote() {
  local args="$1"
  sudo_remote "cd $(shell_quote "$REMOTE_DIR") && if docker compose version >/dev/null 2>&1; then docker compose -f $(shell_quote "$COMPOSE_FILE") $args; else docker-compose -f $(shell_quote "$COMPOSE_FILE") $args; fi"
}

print_container_status() {
  sudo_remote "docker inspect $(shell_quote "$CONTAINER_NAME") --format 'container={{.Name}} status={{.State.Status}} started={{.State.StartedAt}} network={{.HostConfig.NetworkMode}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}'"
}

sync_compose_file() {
  local tmp="/tmp/9router-compose-$(date +%s).yaml"
  ssh_remote "cat > $(shell_quote "$tmp")" < "$ROOT/compose.yaml"
  sudo_remote "mv $(shell_quote "$tmp") $(shell_quote "$REMOTE_DIR/$COMPOSE_FILE")"
}

MODE="${1:-upgrade}"
case "$MODE" in
  upgrade) ;;
  status)
    require_cmd sshpass
    require_var REMOTE_HOST
    require_var REMOTE_USER
    require_var REMOTE_PASS
    require_var SUDO_PASS
    print_container_status
    exit 0
    ;;
  *)
    echo "Usage: $0 [upgrade|status]" >&2
    exit 1
    ;;
esac

echo "[1/7] Checking local tools..."
require_cmd sshpass
require_cmd docker
require_cmd curl
require_var REMOTE_HOST
require_var REMOTE_USER
require_var REMOTE_PASS
require_var SUDO_PASS

echo "[2/7] Checking remote deployment..."
ssh_remote "test -d $(shell_quote "$REMOTE_DIR") && test -f $(shell_quote "$REMOTE_DIR/$COMPOSE_FILE")"
ssh_remote "grep -Eq '^[[:space:]]*network_mode:[[:space:]]*host[[:space:]]*$' $(shell_quote "$REMOTE_DIR/$COMPOSE_FILE")"

echo "[3/7] Building local Docker image..."
docker build --build-arg NODE_IMAGE="$BUILD_NODE_IMAGE" -t "$IMAGE_NAME" "$ROOT"

echo "[4/7] Loading image on remote host..."
REMOTE_IMAGE_TAR="/tmp/9router-image-$(date +%s).tar"
docker save "$IMAGE_NAME" | ssh_remote "cat > $(shell_quote "$REMOTE_IMAGE_TAR")"
sudo_remote "docker load -i $(shell_quote "$REMOTE_IMAGE_TAR") && rm -f $(shell_quote "$REMOTE_IMAGE_TAR")"

echo "[5/7] Updating remote compose..."
sync_compose_file

echo "[6/7] Recreating container..."
compose_remote "stop $(shell_quote "$CONTAINER_NAME") || true"
compose_remote "up -d --force-recreate $(shell_quote "$CONTAINER_NAME")"

echo "[7/7] Waiting for health check..."
for _ in $(seq 1 40); do
  if curl -fsS "http://$REMOTE_HOST:$PORT/api/health" >/dev/null; then
    status="$(sudo_remote "docker inspect $(shell_quote "$CONTAINER_NAME") --format '{{.HostConfig.NetworkMode}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}'" | tail -n 1)"
    if [ "$status" = "host healthy" ] || [ "$status" = "host no-healthcheck" ]; then
      echo "$status"
      print_container_status
      echo "9router upgraded: http://$REMOTE_HOST:$PORT"
      exit 0
    fi
  fi
  sleep 2
done

echo "9router did not become healthy in time. Recent logs:" >&2
sudo_remote "docker logs --tail=120 $(shell_quote "$CONTAINER_NAME")" >&2 || true
exit 1
