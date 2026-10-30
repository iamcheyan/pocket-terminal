# Architecture

Pocket Terminal is split at one hard boundary: **the browser renders, the daemon
acts**. There is no shell, filesystem, `/proc`, `/sys`, `/dev` or journald access
from the frontend, and no device path (`/dev/pts/N`, inode numbers, file
descriptors) ever enters a UI data model.

```
┌───────────────────────────────────────────────────────────────┐
│ Pocket Terminal UI  (React 19 + TypeScript + Vite, xterm.js)  │
│  pages: Home · Terminal · SSH · Logs · Diagnostics ·          │
│         Runtime · Quick actions · Settings                    │
│  input: keyboard · mouse · touch · D-Pad · gamepad            │
└───────────────────────────────┬───────────────────────────────┘
                                │ REST /api/*  +  WebSocket /api/terminal/sessions/{id}/stream
                                │ + SSE /api/logs/stream
┌───────────────────────────────▼───────────────────────────────┐
│ terminald (Go 1.26, no root required)                        │
│                                                               │
│  session.go    PTY lifecycle: create/attach/resize/detach/reap│
│  websocket.go  one socket per viewer, offset-based resume     │
│  ssh.go        profile CRUD, TOFU host keys, mock sshd        │
│  logs.go       journald + allowlisted files, SSE, export      │
│  diagnostics.go procfs/sysfs/systemctl sampling               │
│  runtime.go    daemon/Go/PocketJS inspection, bridge probes    │
│  actions.go    allowlisted argv, confirmation policy          │
│  secrets.go    AES-256-GCM credential sealing                 │
│  store.go      atomic JSON state (profiles, known_hosts)      │
└───────────────────────────────────────────────────────────────┘
```

## Why a daemon

1. **Security.** A browser tab cannot open a PTY. Keeping the privileged edge in
   a single auditable Go process means the frontend can be served from anywhere
   (dev server, static bundle) without gaining host authority.
2. **Reconnect semantics.** The daemon owns scrollback, so closing a tab or
   losing Wi-Fi on a handheld does not kill the shell. The UI re-attaches with a
   byte offset and replays what it missed.
3. **No new emulator.** Character rendering is xterm.js; the PTY is
   `github.com/creack/pty`. Nothing in this repo implements escape-sequence
   parsing.

## Session lifecycle

```
POST /api/terminal/sessions      create PTY, spawn login shell, register
        │
        ├── GET  .../{id}/stream?offset=N   WebSocket attach (binary = PTY bytes)
        ├── POST .../{id}/input             HTTP fallback for keystrokes
        ├── POST .../{id}/resize            PTY winsize + remembered geometry
        ├── GET  .../{id}/output?offset=N   polling fallback (X-Offset header)
        └── DELETE .../{id}                 SIGTERM process group, then SIGKILL
```

Each `Session` holds a 512 KiB ring buffer that tracks a monotonically growing
total offset. `Since(offset)` returns the delta plus the next offset, so a
reconnect is exact rather than "last 200 lines".

State machine: `running → exited` (process ended, scrollback readable) or
`running → closed` (explicit close). A reaper runs every 15 s and closes running
sessions with no viewer for `-idle-timeout`, then drops exited sessions after
`-keep-exited`.

Shell selection is daemon-side: `$SHELL` is resolved to a real file, then
`bash`/`zsh`/`fish`/`sh` are looked up on `PATH`. The API only offers shells it
actually found, and rejects anything else with `400 invalid_request`.

## SSH

```
profile (JSON state, credentials as ciphertext)
   │
   ├─ probe  → TCP + handshake, no shell, reports reachable/authenticated/key state
   └─ connect → handshake with TOFU callback → RequestPty → Shell
                │
                └─ wrapped as a Session with kind="ssh" so tabs, split panes,
                   resize and reconnect behave identically to a local PTY
```

**Trust on first use.** The first `connect` to an unknown host returns
`409 host_key_unknown` with the `SHA256:` fingerprint. The UI shows a dialog; only
an explicit `acceptHostKey:true` (plus the fingerprint the user was shown) writes
`known_hosts`. A later connection presenting a different key is refused with
`409 host_key_mismatch` and is never auto-accepted.

Trust entries are keyed by the address the **user configured**, not the address
dialled. That matters for the bundled mock fixture, whose loopback port changes
on every daemon start: the profile's identity is stable, and the stale entry for
the previous port is pruned when the fixture moves.

**Credentials.** Passwords and private keys are sealed with AES-256-GCM using a
32-byte key generated on first start (`<data>/secret.key`, mode `0600`). Each
ciphertext is bound to `<profileID>/<field>` as additional authenticated data, so
a blob cannot be replayed against another profile. `state.json` contains only
base64 ciphertext. The API never returns a secret, only `hasPassword` / `hasKey`.

**Mock target.** `terminald` starts a loopback-only `x/crypto/ssh` server with
fixed credentials (`demo` / `pocket`) and a freshly generated ED25519 host key.
It bridges an SSH channel to a real local PTY, so the whole UI flow — TOFU,
authentication, PTY, resize, disconnect — is exercised without a remote machine.
Every session it carries is reported with `mock:true`, and the UI labels it in
the tab, the pane header and the status bar.

**Port forwarding** is not implemented. `GET /api/ssh/profiles` reports
`portForwarding.status = "todo"`, and the SSH page renders a disabled,
explained placeholder instead of hiding the gap.

## Logs

Two source families:

| Source | Mechanism | Notes |
|---|---|---|
| `journald` | `journalctl -o json` with `--grep`/`-p`/`-u` | read-only, 6 s timeout |
| `file:<path>` | tail window of 512 KiB, allowlisted roots | `/var/log`, `~/.local/state`, `<data>/logs` |

`file:` paths outside the allowlist are rejected (`400 invalid_query`) — the API
cannot be used as an arbitrary file reader. Filtering, level matching and paging
happen in the daemon. `GET /api/logs/stream` is SSE: an initial `batch` plus
incremental batches every 1.5 s (journald is re-read rather than holding a `-f`
process open, which keeps cancellation simple and avoids orphan processes).
`POST /api/logs/export` returns `text/plain` with a `Content-Disposition`
filename; nothing is written to the host.

## Diagnostics and runtime

Diagnostics read `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/uptime`,
`/proc/net/dev`, `statfs(2)` and `/sys/class/thermal/*`, plus `systemctl
list-units` for a whitelist of service names. Each block reports its provider
(`procfs`, `statfs`, `sysfs-thermal`, `systemctl`, or `unavailable`) so a missing
subsystem reads as unavailable rather than as zero.

Storage rows are grouped by `(total, free)`: btrfs subvolumes and bind mounts of
the same pool would otherwise appear as several identically-full filesystems.

The runtime inspector reports the daemon's own process (pid, uptime, goroutines,
heap), the Go runtime, discovered PocketJS app directories (with `dist/`
presence), and health probes for sibling daemons. It explicitly does **not**
inspect WebView internals.

## Quick actions

`actions.go` holds a static catalog. Each entry declares `support`:

- `preview` — pure reads (diagnostics, uptime, recent journal errors).
- `native` — in-daemon operations (`terminal.newShell`, `terminal.killAll`).
- `command` / `systemctl` — a fixed argv slice; never a shell string.

Dangerous actions require `{"confirm":true}`; without it the daemon answers `409
confirmation_required` and performs nothing. `systemctl` actions additionally
require `-allow-system-control`, otherwise they return
`system_control_disabled`. There is no arbitrary command endpoint and no root
escalation path: the daemon runs as the invoking user.

## Security posture

| Concern | Mitigation |
|---|---|
| Network exposure | binds `127.0.0.1` by default |
| Remote use | `POCKET_TERMINAL_TOKEN` gates every `/api` route except health |
| WebSocket origin | `OriginPatterns` allowlist (localhost/127.0.0.1/::1 + `-cors-origins`) |
| Credentials at rest | AES-256-GCM, AAD-bound, `0600` key file |
| Arbitrary file read | log paths allowlisted; cwd must stat as a directory |
| Privilege | never runs as root; no setuid, no polkit, no sudo |
| Logging | request logs contain method/path/status only; secrets are never logged |

## Frontend structure

```
src/
  api.ts          single JSON boundary + named domain types + parsers
  terminal.ts     WebSocket transport with offset resume and backoff
  input.ts        spatial navigation: keyboard, D-Pad, gamepad
  components.tsx  hand-drawn controls (no native select/dialog/confirm)
  styles.css      design tokens, three layouts, two themes
  pages/          Terminal, SSH, Logs, Diagnostics, Runtime, Actions, Settings, Palette, Home
```

Layout is driven by `document.documentElement.dataset.layout`
(`handheld` / `eink` / `desktop`) and `data-theme` (`dark` / `light`), both
persisted in `localStorage`. The handheld layout also applies by media query
below 760 px, so choosing "desktop" on a phone still yields a non-overflowing
page.
