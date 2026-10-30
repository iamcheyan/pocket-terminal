# Verification — pocket-terminal @ 2026-10-31

- Verdict: PASS
- Commit: `888cc7dc5a60f87e9e1a4c8c114e978a51741699` (screenshots + docs; this document is the following commit)
- Remote: `888cc7dc5a60f87e9e1a4c8c114e978a51741699`
- Runtime: `./scripts/verify.sh --start` (terminald `127.0.0.1:8795` + Vite `127.0.0.1:5178`), then `npm run build` + `vite preview 127.0.0.1:5179` for the production-form probe
- Toolchain: go 1.26.0, node v22.23.3, Chrome 155.0.8059.84

## Test gate
| command | result | notes |
|---|---|---|
| `go vet ./...` | PASS | terminald |
| `go test ./... -count=1` | PASS | 34 tests, 0 failures (24.9s, includes real PTY + mock sshd) |
| `npx tsc -b` | PASS | frontend typecheck |
| `npx vitest run` | PASS | 31 tests in 5 files |
| `node scripts/ui-smoke.mjs` | PASS | real browser walk at 1280×800 and 390×844: terminal command round-trip, mock SSH TOFU dialog, command palette, D-Pad focus ring, gamepad mapping; asserts no console error, no unexpected ≥400 and no horizontal overflow |
| `npm run build` | PASS | production bundle |

Full gate `./scripts/verify.sh --start` ended with `ALL CHECKS PASSED`.

## Screenshot matrix
Captured this run from the real stack: `node scripts/screenshots.mjs` (48 page-matrix shots,
8 pages × 6 layout/theme/viewport combinations) and `node scripts/ui-smoke.mjs` (7 workflow
shots). No image is reused from history — all 55 files were rewritten.

| screen | viewport | theme | file | note |
|---|---|---|---|---|
| actions | 1280×800 | dark | `docs/evidence/screens/desktop-actions-dark-1280x800.png` | desktop layout |
| actions | 1280×800 | light | `docs/evidence/screens/desktop-actions-light-1280x800.png` | desktop layout |
| diagnostics | 1280×800 | dark | `docs/evidence/screens/desktop-diagnostics-dark-1280x800.png` | desktop layout |
| diagnostics | 1280×800 | light | `docs/evidence/screens/desktop-diagnostics-light-1280x800.png` | desktop layout |
| home | 1280×800 | dark | `docs/evidence/screens/desktop-home-dark-1280x800.png` | desktop layout |
| home | 1280×800 | light | `docs/evidence/screens/desktop-home-light-1280x800.png` | desktop layout |
| actions | 390×844 | dark | `docs/evidence/screens/desktop-layout-actions-dark-390x844.png` | desktop layout forced to phone width |
| diagnostics | 390×844 | dark | `docs/evidence/screens/desktop-layout-diagnostics-dark-390x844.png` | desktop layout forced to phone width |
| home | 390×844 | dark | `docs/evidence/screens/desktop-layout-home-dark-390x844.png` | desktop layout forced to phone width |
| logs | 390×844 | dark | `docs/evidence/screens/desktop-layout-logs-dark-390x844.png` | desktop layout forced to phone width |
| runtime | 390×844 | dark | `docs/evidence/screens/desktop-layout-runtime-dark-390x844.png` | desktop layout forced to phone width |
| settings | 390×844 | dark | `docs/evidence/screens/desktop-layout-settings-dark-390x844.png` | desktop layout forced to phone width |
| ssh | 390×844 | dark | `docs/evidence/screens/desktop-layout-ssh-dark-390x844.png` | desktop layout forced to phone width |
| terminal | 390×844 | dark | `docs/evidence/screens/desktop-layout-terminal-dark-390x844.png` | desktop layout forced to phone width |
| logs | 1280×800 | dark | `docs/evidence/screens/desktop-logs-dark-1280x800.png` | desktop layout |
| logs | 1280×800 | light | `docs/evidence/screens/desktop-logs-light-1280x800.png` | desktop layout |
| runtime | 1280×800 | dark | `docs/evidence/screens/desktop-runtime-dark-1280x800.png` | desktop layout |
| runtime | 1280×800 | light | `docs/evidence/screens/desktop-runtime-light-1280x800.png` | desktop layout |
| settings | 1280×800 | dark | `docs/evidence/screens/desktop-settings-dark-1280x800.png` | desktop layout |
| settings | 1280×800 | light | `docs/evidence/screens/desktop-settings-light-1280x800.png` | desktop layout |
| ssh | 1280×800 | dark | `docs/evidence/screens/desktop-ssh-dark-1280x800.png` | desktop layout |
| ssh | 1280×800 | light | `docs/evidence/screens/desktop-ssh-light-1280x800.png` | desktop layout |
| terminal | 1280×800 | dark | `docs/evidence/screens/desktop-terminal-dark-1280x800.png` | desktop layout |
| terminal | 1280×800 | light | `docs/evidence/screens/desktop-terminal-light-1280x800.png` | desktop layout |
| dpad-focus-ring | 1280×800 | dark | `docs/evidence/screens/dpad-focus-ring-1280x800.png` | interaction / workflow capture (ui-smoke) |
| actions | 1280×800 | light | `docs/evidence/screens/eink-actions-light-1280x800.png` | eink layout |
| diagnostics | 1280×800 | light | `docs/evidence/screens/eink-diagnostics-light-1280x800.png` | eink layout |
| home | 1280×800 | light | `docs/evidence/screens/eink-home-light-1280x800.png` | eink layout |
| logs | 1280×800 | light | `docs/evidence/screens/eink-logs-light-1280x800.png` | eink layout |
| runtime | 1280×800 | light | `docs/evidence/screens/eink-runtime-light-1280x800.png` | eink layout |
| settings | 1280×800 | light | `docs/evidence/screens/eink-settings-light-1280x800.png` | eink layout |
| ssh | 1280×800 | light | `docs/evidence/screens/eink-ssh-light-1280x800.png` | eink layout |
| terminal | 1280×800 | light | `docs/evidence/screens/eink-terminal-light-1280x800.png` | eink layout |
| actions | 390×844 | dark | `docs/evidence/screens/handheld-actions-dark-390x844.png` | handheld layout |
| actions | 390×844 | light | `docs/evidence/screens/handheld-actions-light-390x844.png` | handheld layout |
| diagnostics | 390×844 | dark | `docs/evidence/screens/handheld-diagnostics-dark-390x844.png` | handheld layout |
| diagnostics | 390×844 | light | `docs/evidence/screens/handheld-diagnostics-light-390x844.png` | handheld layout |
| home | 390×844 | dark | `docs/evidence/screens/handheld-home-dark-390x844.png` | handheld layout |
| home | 390×844 | light | `docs/evidence/screens/handheld-home-light-390x844.png` | handheld layout |
| logs | 390×844 | dark | `docs/evidence/screens/handheld-logs-dark-390x844.png` | handheld layout |
| logs | 390×844 | light | `docs/evidence/screens/handheld-logs-light-390x844.png` | handheld layout |
| runtime | 390×844 | dark | `docs/evidence/screens/handheld-runtime-dark-390x844.png` | handheld layout |
| runtime | 390×844 | light | `docs/evidence/screens/handheld-runtime-light-390x844.png` | handheld layout |
| settings | 390×844 | dark | `docs/evidence/screens/handheld-settings-dark-390x844.png` | handheld layout |
| settings | 390×844 | light | `docs/evidence/screens/handheld-settings-light-390x844.png` | handheld layout |
| ssh | 390×844 | dark | `docs/evidence/screens/handheld-ssh-dark-390x844.png` | handheld layout |
| ssh | 390×844 | light | `docs/evidence/screens/handheld-ssh-light-390x844.png` | handheld layout |
| terminal | 390×844 | dark | `docs/evidence/screens/handheld-terminal-dark-390x844.png` | handheld layout |
| terminal | 390×844 | light | `docs/evidence/screens/handheld-terminal-light-390x844.png` | handheld layout |
| palette | 1280×800 | dark | `docs/evidence/screens/palette-1280x800.png` | interaction / workflow capture (ui-smoke) |
| ssh-connected | 1280×800 | dark | `docs/evidence/screens/ssh-connected-1280x800.png` | interaction / workflow capture (ui-smoke) |
| ssh-profiles | 1280×800 | dark | `docs/evidence/screens/ssh-profiles-1280x800.png` | interaction / workflow capture (ui-smoke) |
| ssh-tofu-dialog | 1280×800 | dark | `docs/evidence/screens/ssh-tofu-dialog-1280x800.png` | interaction / workflow capture (ui-smoke) |
| terminal-live-command | 1280×800 | dark | `docs/evidence/screens/terminal-live-command-1280x800.png` | interaction / workflow capture (ui-smoke) |
| terminal-split | 1280×800 | dark | `docs/evidence/screens/terminal-split-1280x800.png` | interaction / workflow capture (ui-smoke) |

Count: 55 screenshots, 55 unique hashes (0 duplicates). `tools/check_shots.py` reports every PNG
valid, dimensions matching the requested viewport, minimum per-image RGB stddev 9.15 — no blank
or filled frames. The page-matrix script and ui-smoke both abort on horizontal overflow, so the
committed images imply the geometry check passed at 1280×800 and 390×844.

Production-form probe (`tools/probe.mjs` against `vite preview` on 5179, terminald on 8795) for
all eight pages at 1280×800: HTTP 200, no console errors, no page errors, no failed/4xx/5xx
requests, no horizontal overflow. Root also probed at 390×844: clean.

## Fixed
- No functional bug surfaced in this run. The terminal, mock SSH/TOFU session, logs,
  diagnostics, runtime and actions pages all rendered and responded against real processes.
- Housekeeping (not a runtime bug): refreshed `docs/evidence/README.md` provenance to state the
  actual capture host and Chrome version used for these artifacts, and added this verification
  record. The regenerated 55 PNGs replace the older committed ones (all hashes changed).

## Blocked / open questions
- Port forwarding remains an explicit TODO in the product (UI placeholder says so); not a
  regression and out of scope for this verification.

## Not verified here
- 掌机真机（RG34XX / PJOS-LINUX）未验证；本轮只在本机 headless Chrome 里跑真实进程。
- SSH to a real remote host, serial consoles, thermals on real hardware: not exercised.
