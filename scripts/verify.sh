#!/usr/bin/env bash
# Full verification gate: unit/integration suites, then a real-browser walk.
#
#   ./scripts/verify.sh            # expects a daemon on 127.0.0.1:8795
#   ./scripts/verify.sh --start    # starts terminald + vite itself, then stops them
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backend="$root/apps/pocket-terminal/backend/terminald"
frontend="$root/apps/pocket-terminal/frontend"
start_self=false

if [[ "${1:-}" == "--start" ]]; then
  start_self=true
fi

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

if $start_self; then
  echo "== building terminald"
  (cd "$backend" && go build -o terminald .)
  POCKET_TERMINAL_ADDR=127.0.0.1:8795 "$backend/terminald" &
  pids+=($!)
  for _ in $(seq 1 60); do
    curl -fsS http://127.0.0.1:8795/api/health >/dev/null 2>&1 && break
    sleep 0.2
  done
  (cd "$frontend" && node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5178 >/tmp/pocket-terminal-verify-ui.log 2>&1) &
  pids+=($!)
  for _ in $(seq 1 120); do
    curl -fsS http://127.0.0.1:5178/ >/dev/null 2>&1 && break
    sleep 0.2
  done
fi

echo "== go vet + go test"
(cd "$backend" && go vet ./... && go test ./... -count=1)

echo "== typecheck + component tests"
(cd "$frontend" && npx tsc -b && npx vitest run)

echo "== headless browser walk"
(cd "$frontend" && node scripts/ui-smoke.mjs)

echo
echo "ALL CHECKS PASSED"
