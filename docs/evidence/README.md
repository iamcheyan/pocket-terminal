# Evidence index

All artefacts in this directory were produced on the build host (Debian NAS VM, x86_64)
by the commands quoted in each section. No physical handheld was
available — see [`../KNOWN-LIMITS.md`](../KNOWN-LIMITS.md).

## Screenshots — `screens/`

Captured with `node scripts/screenshots.mjs` and `node scripts/ui-smoke.mjs`
against Chrome 155 (headless) driving the real daemon (2026-10-31 run).

| Group | Count | Viewport | Notes |
|---|---|---|---|
| `desktop-<page>-dark-1280x800.png` | 8 | 1280×800 | desktop layout, dark theme, every page |
| `desktop-<page>-light-1280x800.png` | 8 | 1280×800 | desktop layout, light theme, every page |
| `eink-<page>-light-1280x800.png` | 8 | 1280×800 | e-ink layout (grayscale, 1.5 px borders) |
| `handheld-<page>-dark-390x844.png` | 8 | 390×844 | handheld layout, dark theme |
| `handheld-<page>-light-390x844.png` | 8 | 390×844 | handheld layout, light theme |
| `desktop-layout-<page>-dark-390x844.png` | 8 | 390×844 | desktop layout forced onto the phone breakpoint (media-query fallback) |
| `terminal-live-command-1280x800.png` | 1 | 1280×800 | real PTY output from typed command |
| `terminal-split-1280x800.png` | 1 | 1280×800 | split pane with two live sessions |
| `ssh-profiles-1280x800.png` | 1 | 1280×800 | grouped profiles + mock badge |
| `ssh-tofu-dialog-1280x800.png` | 1 | 1280×800 | TOFU fingerprint confirmation |
| `ssh-connected-1280x800.png` | 1 | 1280×800 | mock SSH session executing a command |
| `palette-1280x800.png` | 1 | 1280×800 | command palette filtered by typing |
| `dpad-focus-ring-1280x800.png` | 1 | 1280×800 | spatial focus ring after keyboard/gamepad traversal |

Page set for every matrix: `home`, `terminal`, `ssh`, `logs`, `diagnostics`,
`runtime`, `actions`, `settings`.

Total: 55 PNGs — 8 desktop dark + 8 desktop light + 8 e-ink + 8 handheld dark +
8 handheld light + 8 desktop-layout-on-phone + 7 workflow shots.

Page-matrix shots come from `screenshots.mjs`, which measures each page before
capturing; workflow shots come from `ui-smoke.mjs`, which fails the run on any
`documentElement.scrollWidth !== clientWidth`, any `.page` overflow, any console
error, or any unexpected HTTP ≥ 400. A committed image therefore implies the
geometry check passed.

## API transcripts — `api/`

| File | Command source |
|---|---|
| `health-meta-shells.txt` | `GET /api/health`, `/api/meta`, `/api/security`, `/api/terminal/shells` |
| `terminal-ssh.txt` | create PTY session, send `echo POCKET_API_EVIDENCE_$((6*7))`, read output, resize, rejected shell, SSH profile list, disposable profile create/delete |
| `ssh-tofu.txt` | probe → `409 host_key_unknown` → explicit accept → live session → `echo SSH_EVIDENCE_$((11*11))` → known_hosts → ciphertext-at-rest shape + `0600` modes |
| `logs-diagnostics-runtime.txt` | log sources/queries/allowlist refusal/export, full diagnostics, trimmed runtime, action catalog, confirmation + control-disabled refusals |

All four were produced by `./scripts/evidence.sh` (idempotent; it frees stale
sessions first and never echoes ciphertext or a password).

## Test transcripts — `tests/`

| File | Contents |
|---|---|
| `go-test.txt` | `go vet ./... && go test ./... -v` — 34 passing tests |
| `frontend-test.txt` | `npx tsc -b && npx vitest run` — 31 passing tests across 5 files |
| `make-test.txt` | the aggregate `make test` target (Go + typecheck + vitest) |
| `verify.txt` | `./scripts/verify.sh --start` — the release gate: builds, boots the stack, runs both suites and the browser walk, then stops everything |
| `ui-smoke.txt` | full headless walk: 8 pages × 2 viewports × themes, terminal round-trip, SSH TOFU flow, palette, D-Pad ring |

## Regenerating

```sh
make backend                                     # terminald
cd apps/pocket-terminal/frontend
npm run dev -- --host 127.0.0.1 --port 5178      # or: npm run build && npm run preview
node scripts/screenshots.mjs
node scripts/ui-smoke.mjs
```

```sh
./scripts/evidence.sh                            # rewrites docs/evidence/api/*
```
