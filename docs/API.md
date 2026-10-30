# HTTP API

`terminald` serves JSON on `127.0.0.1:8795` by default. Every response carries
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`.

Errors are uniform:

```json
{"error": {"code": "host_key_unknown", "message": "host key is not trusted yet", "details": {"fingerprint": "SHA256:…"}}}
```

| Status | Codes |
|---|---|
| 400 | `invalid_json`, `invalid_query`, `invalid_profile`, `invalid_request`, `unknown_shell` |
| 401 | `unauthorized` (only when `POCKET_TERMINAL_TOKEN` is set) |
| 404 | `not_found` |
| 409 | `session_limit`, `session_not_running`, `host_key_unknown`, `host_key_mismatch`, `confirmation_required` |
| 502 | `ssh_connect_failed` |
| 503 | `log_unavailable` |
| 500 | `internal_error`, `session_create_failed` |

Environment: `POCKET_TERMINAL_ADDR`, `POCKET_TERMINAL_DATA`,
`POCKET_TERMINAL_TOKEN`, `POCKET_TERMINAL_ORIGINS`.

Flags: `-addr`, `-data`, `-token` (env only), `-allow-system-control`,
`-no-mock-ssh`, `-max-sessions`, `-idle-timeout`, `-cors-origins`.

## Meta

| Method and path | Behaviour |
|---|---|
| `GET /api/health` | `{status, service, version, uptime, time, sessions, mock, dataStore}`. Never requires a token. |
| `GET /api/meta` | Detected shells, default shell, capability flags, limits, secret store description. |
| `GET /api/security` | Bind address, token requirement, system-control flag, secret store, known-host count, `plaintextSecrets:false`. |

`GET /api/meta` response (trimmed):

```json
{
  "defaultShell": "bash",
  "shells": [{"id": "bash", "name": "Bash", "path": "/run/current-system/sw/bin/bash", "default": true}],
  "capabilities": {
    "pty": true, "ssh": true, "mockSSH": true, "journald": true, "fileLogs": true,
    "diagnostics": true, "runtime": true, "quickActions": true, "systemControl": false,
    "terminalEmulator": "xterm.js (client-side rendering)"
  },
  "limits": {"maxSessions": 8, "idleTimeout": 1800000000000,
             "secrets": {"provider": "aes-256-gcm-file", "keyFile": "secret.key", "keyMode": "0600"}}
}
```

## Terminal sessions

| Method and path | Behaviour |
|---|---|
| `GET /api/terminal/shells` | `{shells:[{id,name,path,default}], defaultShell, userShell}` |
| `GET /api/terminal/sessions` | `{sessions:[SessionDTO], max}` |
| `POST /api/terminal/sessions` | Body `{shell?, cols?, rows?, title?, tabsGroup?, cwd?}` → `201 {session}` |
| `GET /api/terminal/sessions/{id}` | One session |
| `POST /api/terminal/sessions/{id}/input` | Body `{data:"…"}` → `{accepted:n}`; `409` when not running |
| `POST /api/terminal/sessions/{id}/resize` | Body `{cols, rows}` → updated session |
| `DELETE /api/terminal/sessions/{id}` | `{closed:true}`, process group terminated |
| `GET /api/terminal/sessions/{id}/output?offset=N` | `application/octet-stream`, `X-Offset: <next>` — polling fallback |
| `GET /api/terminal/sessions/{id}/stream?offset=N` | WebSocket upgrade; see below |

`SessionDTO` never contains a device path, pid or file descriptor:

```json
{
  "id": "smvuysp5i_f7f75f8e", "title": "Mock Lab", "shell": "ssh demo@127.0.0.1",
  "shellId": "ssh", "cwd": "", "kind": "ssh", "tabsGroup": "main",
  "profileId": "pmvuytmd6_d20b200b", "mock": true, "state": "running",
  "createdAt": "2026-10-30T12:45:51Z", "exitCode": null,
  "rows": 30, "cols": 100, "bytes": 0
}
```

`state ∈ {running, exited, closed}`. `kind ∈ {local, ssh}`.

### WebSocket protocol

`ws(s)://<host>/api/terminal/sessions/{id}/stream?offset=N`

- **Server → client, binary**: raw PTY bytes starting at `offset`.
- **Server → client, text (JSON)**: `{"type":"ready","state":"running"}`,
  `{"type":"tick"}`, `{"type":"exit","state":"exited","data":"process exited with code 0"}`.
- **Client → server, binary**: keystrokes written verbatim to the PTY.
- **Client → server, text**: `{"type":"input","data":"…"}`, `{"type":"resize","cols":…,"rows":…}`, `{"type":"ping"}`.

A viewer that reconnects with the last received offset gets exactly the missed
bytes; the daemon keeps 512 KiB of scrollback per session. Origin is checked
against loopback patterns plus any `-cors-origins` entries.

## SSH

| Method and path | Behaviour |
|---|---|
| `GET /api/ssh/profiles` | `{profiles, groups, mockTarget, portForwarding}` |
| `POST /api/ssh/profiles` | Create; body `{name, group, host, port, user, authKind, password?/privateKey?, description?, mock?}` |
| `PUT /api/ssh/profiles/{id}` | Partial update; blank `password`/`privateKey` keeps the stored secret |
| `DELETE /api/ssh/profiles/{id}` | Removes the profile and its ciphertext |
| `POST /api/ssh/profiles/{id}/test` | Handshake only → `{result:{reachable, authenticated, hostKeyState, fingerprint, latencyMs, message}}` |
| `POST /api/ssh/profiles/{id}/connect` | Body `{cols?, rows?, acceptHostKey?, fingerprint?, title?, tabsGroup?}` → `201 {session}` |
| `GET /api/ssh/known-hosts` | Trust store |
| `DELETE /api/ssh/known-hosts/{id}` | Forget one host key |

`ProfileDTO` exposes only `hasPassword` / `hasKey`; secrets are never returned.

`authKind` is `password`, `key` or `none`. For `key`, an `SSH_AUTH_SOCK` agent is
also offered as a fallback (the agent holds the private key; nothing is copied).

`portForwarding` is always:

```json
{"supported": false, "status": "todo",
 "note": "Local/remote forwarding is planned; the UI exposes a placeholder so the surface is not silently missing."}
```

### TOFU handshake

First connect to an unknown host:

```
HTTP/1.1 409 Conflict
{"error":{"code":"host_key_unknown","message":"host key is not trusted yet",
  "details":{"fingerprint":"SHA256:WjGBQ…","host":"127.0.0.1","port":45921,
             "keyType":"ssh-ed25519","mock":true}}}
```

Retry with `{"acceptHostKey":true,"fingerprint":"SHA256:WjGBQ…"}` and the daemon
writes `known_hosts` before completing the handshake. A stored-key mismatch is
always `409 host_key_mismatch` and cannot be auto-accepted; the user must forget
the entry first.

## Logs

| Method and path | Behaviour |
|---|---|
| `GET /api/logs/sources` | `{sources:[{id,kind,label,description,available,reason?}], levels}` |
| `GET /api/logs?source=&level=&priority=&unit=&q=&limit=` | `{source, entries, count, durationMs}` |
| `GET /api/logs/stream?…` | SSE: `hello`, then `batch` events, `: keepalive` comments |
| `POST /api/logs/export` | Same filters → `text/plain` attachment |

`source` is `journald` or `file:<absolute path>`. File paths must resolve under
`/var/log`, `~/.local/state`, or the daemon data dir; anything else is
`400 invalid_query`. `priority` accepts the syslog names; `level` accepts
`all|emerg|alert|crit|error|warning|notice|info|debug`. `limit` is clamped to
1…5000 (default 200).

## Diagnostics

`GET /api/diagnostics` →

```json
{
  "generatedAt": "…", "host": {"hostname": "hx90", "kernel": "6.12.108", "os": "NixOS 26.05 (Yarara)", "arch": "amd64", "numCPU": 16, "bootTime": "…"},
  "cpu": [{"label": "CPU usage", "value": 55.2, "unit": "%", "percent": 55.2, "detail": "load 3.76"}, …],
  "memory": [{"label": "Memory used", "value": 25980000000, "unit": "B", "percent": 40, "detail": "24.2 GiB of 62.2 GiB"}, …],
  "disks": [{"mount": "/", "aliases": ["/home", "/tmp", "/var"], "totalBytes": 925635481600, "usedBytes": 757…, "freeBytes": 168…, "usedPct": 81.8}],
  "temperatures": [{"zone": "thermal_zone0", "label": "iwlwifi_1", "celsius": 55}],
  "network": [{"interface": "wlp3s0", "rxBytes": 45…, "txBytes": 4…, "rxRate": 113630, "txRate": 2048}],
  "services": [{"name": "sshd", "load": "loaded", "active": "active", "sub": "running", "description": "SSH Daemon"}],
  "load": [3.76, 6.99, 5.04], "uptime": 311260.28,
  "providers": {"cpu": "procfs", "memory": "procfs", "disk": "statfs", "temperature": "sysfs-thermal", "network": "procfs", "services": "systemctl"}
}
```

`aliases` groups mounts that resolve to the same storage pool (btrfs
subvolumes/bind mounts), so identical numbers are not repeated as separate
devices.

## Runtime

| Method and path | Behaviour |
|---|---|
| `GET /api/runtime` | Daemon process, Go runtime, host identity, PocketJS app discovery, sibling bridge probes, notes |
| `GET /api/runtime/processes` | The daemon's own process row plus terminal sessions |

Bridges probed: `launcherd` (8788), `filesd` (8787), `settingsd` (8090),
`terminald` (own port). Each result carries `reachable`, `latencyMs` and `mock`.

## Quick actions

| Method and path | Behaviour |
|---|---|
| `GET /api/actions` | `{actions:[ActionSpec], controlEnabled, policy}` |
| `POST /api/actions/{id}` | Body `{confirm?:bool}` → `{result:{actionId, executed, confirmed, output?, refusal?, durationMs, preview?}}` |

| Action | Support | Dangerous | Needs root |
|---|---|---|---|
| `system.info` | preview | no | no |
| `system.uptime` | preview | no | no |
| `terminal.newShell` | native | no | no |
| `terminal.killAll` | native | yes | no |
| `logs.journalErrors` | preview | no | no |
| `network.ports` | command (`ss -ltnp`) | no | partial |
| `services.restart.terminald` | systemctl | yes | yes |
| `services.restart.launcherd` | systemctl | yes | yes |
| `power.reboot` | systemctl | yes | yes |

Rules:

1. Dangerous without `{"confirm":true}` → `409 confirmation_required`, nothing runs.
2. `systemctl` support without `-allow-system-control` → `200` with
   `refusal:"system_control_disabled"`, nothing runs.
3. Unknown action → `404 not_found`.
4. No endpoint accepts a command string; argv is fixed in the catalog.
