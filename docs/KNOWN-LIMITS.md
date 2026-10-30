# Known limits

Everything here is a deliberate boundary or an unverified claim, not an
oversight. Nothing in this file is implemented-but-undocumented.

## Not implemented

| Item | State | Where it shows up |
|---|---|---|
| SSH port forwarding (`-L` / `-R` / `-D`) | TODO | `GET /api/ssh/profiles` → `portForwarding.status = "todo"`; SSH page renders two disabled buttons with the explanation |
| System keyring (`secret-tool`, libsecret) for credentials | TODO | `GET /api/security` → `secretStore.keyring = false` with the follow-up note. Phase 1 uses an AES-256-GCM file key at `0600` |
| Multi-device sync of profiles/known_hosts | not started | state is a single JSON file in the data dir |
| Remote terminald over TLS | not started | bind is loopback by default; see the token in `docs/API.md` |
| Sudo/polkit escalation for privileged actions | intentionally absent | privileged actions are refused instead (`system_control_disabled`) |
| Terminal search, links, hyperlink provider, sixel/kitty graphics | not started | xterm.js defaults only |
| Session persistence across daemon restart | not started | scrollback lives in memory; surviving a restart would need a journal |
| i18n | not started | UI is English-only |

## Mock / fixture surfaces

- The **Mock Lab** SSH profile connects to a loopback sshd started by `terminald`
  itself. It exercises real SSH (TOFU, password auth, PTY, resize, disconnect),
  but it is a fixture: every session it carries reports `mock:true`, which the UI
  prints in the tab, pane header and status bar.
- Its host key is regenerated on each daemon start (by design — the fixture has
  no persistent identity). The profile's advertised port is refreshed and the
  stale trust entry for the previous port is pruned on startup.
- The two placeholder profiles (`Edge Router`, `Build Box`) point at addresses
  that do not exist on this host. They prove the "no secret stored" and
  connection-failure paths, not successful remote administration.

## Host-dependent behaviour

- `journald` requires `journalctl` and read access to the journal. On this host
  the user can read the system journal; on a host where that is denied, the
  source reports `available:true` but queries return an empty set or
  `503 log_unavailable`, and the UI shows the error text.
- `systemctl list-units` is filtered to a service whitelist. A host without
  systemd reports `providers.services = "unavailable"` and no rows.
- Thermal zones exist only where the kernel exposes `/sys/class/thermal`; this
  host exposes exactly one (`iwlwifi_1`).
- `network.ports` (`ss -ltnp`) reports process names only for sockets the daemon
  user owns. The UI shows the command output as-is rather than claiming full
  visibility.
- Diagnostics run as the invoking user. Counters that require root (e.g. other
  users' processes) are not visible and are not faked.

## Hardware not verified

No physical handheld was available on the build host (HX90, headless NixOS
server). Therefore:

- **Not verified on device:** RG34XX, RG35XX, RG40XX, Leaf3C, M21, Android
  tablets. All layout, theme and input evidence was produced in headless
  Chromium at 390×844 and 1280×800.
- **Not verified:** real D-Pad and gamepad events from device hardware. The
  navigation tests use synthetic geometry, and the smoke run drives the same
  `[data-kb]` path the controller uses; a physical `Gamepad` object was never
  present.
- **Not verified:** real touch input on a touchscreen, e-ink refresh behaviour on
  a participant panel (the e-ink layout is a CSS surface, not a driver), and
  physical keyboard layouts other than the host's.
- **Not verified:** performance and memory on 1 GB-class ARM devices. Numbers in
  this repo come from an x86_64 host.

## Browser coverage

Verified in Chromium 152 (headless) only. The app uses standard DOM and
`WebSocket`/`EventSource` APIs, but Firefox and Safari were not exercised. Two
Chromium-specific behaviours are known:

- Clipboard read/write requires a user gesture and, in headless runs, explicit
  permissions; on a real device the browser prompts once.
- `navigator.getGamepads()` may stay empty until the page receives a gamepad
  event. The Settings page re-checks every 2 s and the mapping remains editable.

## Scale limits

- `-max-sessions` defaults to 8 concurrent terminal sessions; the daemon answers
  `409 session_limit` beyond that.
- Scrollback is 512 KiB per session (daemon) and 6000 lines (xterm.js).
- Log queries clamp to 5000 rows; the UI keeps the last 1500 in memory.
- Follow mode re-reads the query every 1.5 s rather than holding a long-lived
  `journalctl -f`, which bounds the cost but adds up to 1.5 s of latency.
- 24 PocketJS app directories are reported at most.
