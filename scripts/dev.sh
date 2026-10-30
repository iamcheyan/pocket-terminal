#!/usr/bin/env bash
# One-command local run: terminald + Vite dev server, one Ctrl+C stops both.
#
#   ./scripts/dev.sh            # http://127.0.0.1:5178
#   ADDR=127.0.0.1:9000 ./scripts/dev.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backend="$root/apps/pocket-terminal/backend/terminald"
frontend="$root/apps/pocket-terminal/frontend"

ADDR="${ADDR:-127.0.0.1:8795}"
UI_PORT="${UI_PORT:-5178}"
API="http://${ADDR/0.0.0.0/127.0.0.1}"

if [[ ! -d "$frontend/node_modules" ]]; then
  echo "installing frontend dependencies…"
  (cd "$frontend" && npm install --silent)
fi

cleanup() {
  if [[ -n "${daemon_pid:-}" ]] && kill -0 "$daemon_pid" 2>/dev/null; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "building terminald…"
(cd "$backend" && go build -o terminald .)

echo "starting terminald on $ADDR"
POCKET_TERMINAL_ADDR="$ADDR" "$backend/terminald" &
daemon_pid=$!

for _ in $(seq 1 60); do
  if curl -fsS "$API/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "starting UI on http://127.0.0.1:$UI_PORT (Ctrl+C stops both)"
cd "$frontend"
POCKET_TERMINAL_API="$API" exec node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$UI_PORT"
