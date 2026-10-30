# Pocket Terminal


> **PocketJS port (product target):** `apps/pocket-terminal/pocket/` is the
> native PocketJS program (Solid TSX → `.pocket` → `pocket-linux-kms`). The
> `frontend/` tree remains the frozen React design reference and is not
> extended. Frames: `docs/pocket/`; verification:
> `apps/pocket-terminal/POCKETJS-VERIFICATION.md`.

PJOS developer console: a local terminal, SSH manager, log viewer, diagnostics panel,
runtime inspector and command palette in one palm-sized surface.

Built for handhelds (RG34XX / RG35XX / RG40XX / Leaf3C / M21), Android tablets and
desktop Linux. It is **not** a terminal emulator project: rendering is
[xterm.js](https://xtermjs.org/), and every privileged operation is owned by the
`terminald` Go daemon.

```
Pocket Terminal (React + TypeScript + Vite, xterm.js)
        │  REST + WebSocket (same origin, /api)
        ▼
terminald (Go)
        │
        ├── Local shell   PTY sessions (creack/pty)
        ├── SSH engine    x/crypto/ssh, TOFU known_hosts, sealed credentials
        ├── Diagnostics   procfs / sysfs / systemd
        ├── Logs          journald + allowlisted files, SSE follow, export
        └── Runtime       daemon/Go/PocketJS inspection, bridge probes
```

## Run it

```sh
./scripts/dev.sh          # builds terminald, starts it, serves the UI
# → http://127.0.0.1:5178  (Ctrl+C stops both)
```

`make dev` is the same thing. Manual equivalent:

```sh
# 1. backend (loopback, no root needed)
cd apps/pocket-terminal/backend/terminald
go run .                       # http://127.0.0.1:8795

# 2. frontend (proxies /api and the WebSocket to the daemon)
cd apps/pocket-terminal/frontend
npm install
npm run dev -- --host 127.0.0.1 --port 5178   # http://127.0.0.1:5178
```

Other root targets: `make test` (go vet + go test + tsc + vitest),
`make ui-smoke`, `make build`, and `make verify` — which starts the stack itself,
runs both suites, then drives the real browser walk and stops everything again.
Inside `apps/pocket-terminal/frontend`, `npm test` is the same vitest run.

Open <http://127.0.0.1:5178>. The first local shell is one click (or `Ctrl/⌘+K` →
“New local shell”). The seeded **Mock Lab** SSH profile connects to a loopback sshd
bundled with the daemon (`demo` / `pocket`) and marks every session `mock=true`.

Options (all optional):

| Flag | Default | Meaning |
|---|---|---|
| `-addr` | `127.0.0.1:8795` | Listen address. Keep it on loopback unless you also set a token. |
| `-data` | `$XDG_DATA_HOME/pocket-terminal` | State + AES key directory (created `0700`). |
| `-allow-system-control` | `false` | Enables allowlisted `systemctl restart` actions. Off means systems actions are refused, not silently executed. |
| `-no-mock-ssh` | `false` | Disable the loopback SSH fixture. |
| `-max-sessions` | `8` | Concurrent terminal sessions. |
| `-idle-timeout` | `30m` | Close running sessions with no viewer. |

Env: `POCKET_TERMINAL_ADDR`, `POCKET_TERMINAL_DATA`, `POCKET_TERMINAL_TOKEN`
(Bearer token required for every `/api` call except `/api/health`).

## What is implemented

| Area | Status |
|---|---|
| Local terminal: tabs, split pane, copy/paste, font size, theme-aware palette | ✅ xterm.js + real PTY |
| Shell detection `$SHELL` → `bash`/`zsh`/`fish`/`sh` | ✅ verified on this host |
| SSH profiles, groups, quick connect, TOFU host keys, mismatch refusal | ✅ real SSH stack |
| SSH mock target labelled `mock=true` | ✅ loopback sshd |
| Port forwarding | ⛔ TODO, UI placeholder states this explicitly |
| Logs: journald + allowlisted files, level filter, grep, follow, export | ✅ read-only |
| Diagnostics: CPU, memory, swap, disks, thermals, network, services | ✅ procfs/sysfs/systemctl |
| Runtime inspector: daemon, Go runtime, PocketJS apps, sibling bridges | ✅ |
| Quick actions with explicit confirmation | ✅ allowlisted argv only |
| Command palette (keyboard / DPad / gamepad / touch) | ✅ |
| Layouts: handheld, e-ink, desktop; dark + light | ✅ |
| Native controls (select/dialog/alert/confirm) | none — all hand-drawn |

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, boundaries, session lifecycle, security model.
- [`docs/API.md`](docs/API.md) — every endpoint, payload and error code.
- [`docs/INPUT.md`](docs/INPUT.md) — keyboard, D-Pad, gamepad mapping, touch targets.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — local run, tests, headless verification.
- [`docs/KNOWN-LIMITS.md`](docs/KNOWN-LIMITS.md) — mock surfaces, unverified hardware, TODOs.
- [`docs/evidence/`](docs/evidence) — screenshots, captured API output, test transcripts.

## Verification

```sh
make test                                             # Go + frontend suites
cd apps/pocket-terminal/frontend && node scripts/ui-smoke.mjs   # real browser walk
```

The smoke run drives Chromium against the real daemon: it types into the terminal,
connects the mock SSH profile through the TOFU dialog, opens the palette with
`Ctrl+K` and walks the D-Pad focus ring, asserting no console error, no failed
request and no horizontal overflow at 1280×800 and 390×844.

`./scripts/evidence.sh` regenerates the `curl` transcripts under
`docs/evidence/api/`; `node scripts/screenshots.mjs` regenerates the layout/theme
matrix.

## Limits

No physical handheld was available: all layout/input evidence comes from headless
Chromium at the documented viewports. See `docs/KNOWN-LIMITS.md` for the precise
list.
