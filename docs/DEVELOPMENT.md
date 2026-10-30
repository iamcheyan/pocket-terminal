# Development

## Requirements

- Go 1.24+ (built and tested with 1.26.6)
- Node 20+ (built and tested with 26.8.1)
- A POSIX host with `/proc`, `/sys` and (optionally) `journalctl`/`systemctl`
- Chromium for the headless verification scripts

## Run

```sh
# backend
cd apps/pocket-terminal/backend/terminald
go run .                       # 127.0.0.1:8795

# frontend (dev server proxies /api and the WebSocket)
cd apps/pocket-terminal/frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5178
```

From the repository root:

| Target | Does |
|---|---|
| `make dev` | builds terminald, runs it, serves the UI (one Ctrl+C stops both) |
| `make backend` | terminald only |
| `make test` | `go vet` + `go test` + `tsc` + `vitest` |
| `make ui-smoke` | headless Chromium walk against an already-running stack |
| `make verify` | starts the stack, runs everything above, stops it — the release gate |

Production bundle:

```sh
cd apps/pocket-terminal/frontend
npm run build                  # dist/, with ?v=<hash> on every asset URL
npm run preview -- --host 127.0.0.1 --port 5178
```

The dev/preview servers proxy `/api` (including WebSocket upgrades) to
`POCKET_TERMINAL_API` (default `http://127.0.0.1:8795`), so the browser only ever
talks to one origin and no CORS relaxation is needed for normal use.

## Tests

```sh
# Go: unit + HTTP integration (spawns real PTYs and the mock sshd)
cd apps/pocket-terminal/backend/terminald
go vet ./... && go test ./...

# Frontend: typecheck + component/interaction tests
cd apps/pocket-terminal/frontend
npx tsc -b && npx vitest run
```

Go coverage includes the ring buffer's offset/wrap/oversize behaviour, secret
sealing (round-trip, AAD binding, `0600` key mode), store persistence, shell
detection fallbacks, PTY command execution, session limits, SSH profile CRUD
without plaintext, the full TOFU flow, wrong-password rejection, host-key
mismatch refusal, log parsing/allowlist/limits, diagnostics shape, runtime
reports, the action confirmation policy, the bearer-token gate and IPv6 host IDs.

Frontend coverage includes spatial navigation (grid movement, edge refusal,
disabled skipping, activation), hand-drawn control semantics (dialog focus
trap/Escape, segmented `aria-pressed`, switch `aria-checked`, field labelling),
palette filtering/selection/Escape/touch, and the API boundary parsers.

## Headless verification

```sh
cd apps/pocket-terminal/frontend
node scripts/ui-smoke.mjs       # assertions + evidence shots
node scripts/screenshots.mjs    # full layout/theme matrix
```

`ui-smoke.mjs` launches one Chromium via `playwright-core`, walks all eight pages
at 1280×800 and 390×844 (both layouts, both themes), asserts
`documentElement.scrollWidth === clientWidth` and `.page` non-overflow,
types a real command into the terminal, connects the mock SSH profile through the
TOFU dialog, opens the palette with `Ctrl+K`, moves the D-Pad ring, and fails on
any console error, `pageerror`, or unexpected HTTP ≥ 400 (the TOFU `409` is the
only whitelisted status, because it is the contract under test).

Environment: `POCKET_TERMINAL_URL`, `POCKET_TERMINAL_SHOTS`, `CHROME_PATH`,
`POCKET_SKIP_SHOTS=1`.

Screenshots land in `docs/evidence/screens/`; the smoke run also writes
`terminal-live-command`, `terminal-split`, `ssh-profiles`, `ssh-tofu-dialog`,
`ssh-connected`, `palette` and `dpad-focus-ring`.

## Layout of the repo

```
apps/pocket-terminal/
  backend/terminald/     Go daemon (module pocket-terminal/terminald)
  frontend/              Vite + React + TypeScript UI
    src/                 application source
    scripts/             headless verification and screenshot harnesses
docs/                    architecture, API, input, limits, evidence
```

## Conventions

- Every external payload goes through `src/api.ts` parsers; pages never touch
  raw JSON.
- No native `select`, `dialog`, `alert`, `confirm` or date pickers. Add a
  component in `src/components.tsx` instead.
- New interactive element → give it `data-kb` so the D-Pad can reach it, and a
  real `aria-label`/text so the focus ring is meaningful.
- Anything privileged belongs in `terminald` with an explicit endpoint; the
  frontend must not gain filesystem, process or journal access.
- Credentials never travel back to the UI and never appear in logs or tests.
