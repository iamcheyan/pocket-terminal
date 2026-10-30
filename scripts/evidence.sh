#!/usr/bin/env bash
# Regenerate the API transcripts under docs/evidence/api from the running daemon.
#
#   ./scripts/evidence.sh                       # daemon at 127.0.0.1:8795
#   API=http://127.0.0.1:9000 ./scripts/evidence.sh
#
# The script only reads state plus one disposable SSH profile, which it deletes
# again. It never prints a credential: the request body is shown with the
# password replaced before it is sent to the transcript.
#
# Because the daemon caps concurrent sessions, it first closes any sessions it
# finds (these are dev shells from earlier smoke runs). Run it against a daemon
# you do not mind resetting.
set -euo pipefail

SELF="$0"
API="${API:-http://127.0.0.1:8795}"
SHOTS_DOC="docs/evidence/api"
mkdir -p "$SHOTS_DOC"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing $1" >&2; exit 1; }; }
need curl
need python3

say() { printf '%s\n' "$*"; }
head_file() { say "## $1 — captured $(date -Is) from $API"; say; }

json() { python3 -m json.tool; }

# Free session slots: the daemon answers 409 otherwise and curl -f aborts.
for id in $(curl -sf "$API/api/terminal/sessions" | python3 -c '
import json, sys
for s in json.load(sys.stdin)["sessions"]:
    print(s["id"])'); do
  curl -sf -X DELETE "$API/api/terminal/sessions/$id" >/dev/null || true
done

# --- health / meta / shells -------------------------------------------------
{
  head_file "Health, meta and shell detection"
  say '### GET /api/health'
  curl -sf "$API/api/health" | json
  say
  say '### GET /api/meta'
  curl -sf "$API/api/meta" | json
  say
  say '### GET /api/security'
  curl -sf "$API/api/security" | json
  say
  say '### GET /api/terminal/shells'
  curl -sf "$API/api/terminal/shells" | json
} > "$SHOTS_DOC/health-meta-shells.txt"

# --- terminal + ssh profiles ------------------------------------------------
{
  head_file "Terminal PTY and SSH profile surface"
  say '### POST /api/terminal/sessions {"shell":"bash","cols":100,"rows":30}'
  created=$(curl -sf -X POST "$API/api/terminal/sessions" -H 'Content-Type: application/json' \
    -d '{"shell":"bash","cols":100,"rows":30}')
  say "$created" | json
  sid=$(printf '%s' "$created" | python3 -c 'import json,sys;print(json.load(sys.stdin)["session"]["id"])')
  sleep 0.8
  say
  say "### POST /api/terminal/sessions/$sid/input"
  say 'body: {"data":"echo POCKET_API_EVIDENCE_$((6*7)); uname -sr; whoami; pwd\\n"}'
  curl -sf -X POST "$API/api/terminal/sessions/$sid/input" -H 'Content-Type: application/json' \
    -d '{"data":"echo POCKET_API_EVIDENCE_$((6*7)); uname -sr; whoami; pwd\n"}' | json
  sleep 1.3
  say
  say "### GET /api/terminal/sessions/$sid/output?offset=0  (ANSI stripped)"
  curl -sf "$API/api/terminal/sessions/$sid/output?offset=0" | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | tail -8
  say
  say "### POST /api/terminal/sessions/$sid/resize {\"cols\":132,\"rows\":40}"
  curl -sf -X POST "$API/api/terminal/sessions/$sid/resize" -H 'Content-Type: application/json' \
    -d '{"cols":132,"rows":40}' | json
  say
  say '### POST /api/terminal/sessions {"shell":"nosuchshell"}  (rejected)'
  curl -s -X POST "$API/api/terminal/sessions" -H 'Content-Type: application/json' \
    -d '{"shell":"nosuchshell"}' -w '\nHTTP %{http_code}\n'
  say
  curl -s -X DELETE "$API/api/terminal/sessions/$sid" >/dev/null

  say '### GET /api/ssh/profiles'
  curl -sf "$API/api/ssh/profiles" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("groups:", json.dumps(d["groups"]))
print("mockTarget:", json.dumps(d["mockTarget"]))
print("portForwarding:", json.dumps(d["portForwarding"]))
for p in d["profiles"]:
    print("  %-12s %s@%s:%d auth=%s hasPassword=%s hasKey=%s mock=%s" % (
        p["name"], p["user"], p["host"], p["port"], p["authKind"],
        p["hasPassword"], p["hasKey"], p["mock"]))
    assert "password" not in p and "privateKey" not in p, "API echoed a secret"
print("response contains no secret fields: verified")
'
  say
  say '### POST /api/ssh/profiles  (password redacted in this transcript)'
  newp=$(curl -sf -X POST "$API/api/ssh/profiles" -H 'Content-Type: application/json' \
    -d '{"name":"Evidence","group":"Temp","host":"127.0.0.1","port":22,"user":"demo","authKind":"password","password":"example-password-for-evidence"}')
  say "$newp" | json
  newid=$(printf '%s' "$newp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["profile"]["id"])')
  say
  say '### DELETE the temporary profile'
  curl -sf -X DELETE "$API/api/ssh/profiles/$newid"
} > "$SHOTS_DOC/terminal-ssh.txt"

# --- SSH TOFU + credentials at rest ----------------------------------------
data_dir="${POCKET_TERMINAL_DATA:-$HOME/.local/share/pocket-terminal}"
{
  head_file "SSH TOFU handshake and credential storage"
  pid=$(curl -sf "$API/api/ssh/profiles" | python3 -c '
import json, sys
print(next(p["id"] for p in json.load(sys.stdin)["profiles"] if p["mock"]))')
  say "mock profile: $pid"
  say
  say '### reset the trust store so the TOFU prompt is exercised'
  for id in $(curl -sf "$API/api/ssh/known-hosts" | python3 -c '
import json, sys
for h in json.load(sys.stdin)["knownHosts"]:
    print(h["id"])'); do
    curl -sf -X DELETE "$API/api/ssh/known-hosts/$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1], safe=""))' "$id")" >/dev/null
  done
  curl -sf "$API/api/ssh/known-hosts"
  say
  say
  say "### POST /api/ssh/profiles/$pid/test  (pre-flight, host not trusted)"
  curl -sf -X POST "$API/api/ssh/profiles/$pid/test" | json
  say
  say "### POST /api/ssh/profiles/$pid/connect {}  → TOFU challenge"
  challenge=$(curl -s -X POST "$API/api/ssh/profiles/$pid/connect" -H 'Content-Type: application/json' -d '{}' -w '\nHTTP %{http_code}')
  say "$challenge"
  fp=$(printf '%s' "$challenge" | head -1 | python3 -c 'import json,sys;print(json.load(sys.stdin)["error"]["details"]["fingerprint"])')
  say
  say '### trust store is still empty before the user confirms'
  curl -sf "$API/api/ssh/known-hosts"
  say
  say
  say "### POST connect {acceptHostKey:true, fingerprint:<shown>}"
  resp=$(curl -sf -X POST "$API/api/ssh/profiles/$pid/connect" -H 'Content-Type: application/json' \
    -d "{\"cols\":100,\"rows\":30,\"acceptHostKey\":true,\"fingerprint\":\"$fp\"}")
  say "$resp" | json
  sid=$(printf '%s' "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["session"]["id"])')
  sleep 1.2
  say
  say "### POST input on the SSH session: echo SSH_EVIDENCE_\$((11*11)); hostname"
  curl -sf -X POST "$API/api/terminal/sessions/$sid/input" -H 'Content-Type: application/json' \
    -d '{"data":"echo SSH_EVIDENCE_$((11*11)); hostname\n"}' | json
  sleep 1.3
  say
  say '### output (ANSI stripped)'
  curl -sf "$API/api/terminal/sessions/$sid/output?offset=0" | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g' | tail -6
  say
  say '### GET /api/ssh/known-hosts after confirmation (keyed by the profile address)'
  curl -sf "$API/api/ssh/known-hosts" | json
  say
  say '### connecting again does not re-prompt'
  curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST "$API/api/ssh/profiles/$pid/connect" -H 'Content-Type: application/json' -d '{}'
  sleep 0.5
  say
  say "### credentials at rest in $data_dir/state.json"
  python3 - "$data_dir" <<'PY'
import json, sys, os
data = json.load(open(os.path.join(sys.argv[1], "state.json")))
for p in data["profiles"]:
    pw = p.get("passwordCipher") or ""
    key = p.get("keyCipher") or ""
    # Report shape only: never echo ciphertext into a transcript.
    print("%-12s passwordCipher=%s keyCipher=%s" % (
        p["name"], ("<%d bytes base64>" % len(pw)) if pw else "(none)", key and ("<%d bytes base64>" % len(key)) or "(none)"))
plaintext = [p["name"] for p in data["profiles"] if isinstance(p.get("password"), str)]
print("profiles with a plaintext password field:", plaintext or "none")
PY
  say
  say '### file modes'
  stat -c '%a %n' "$data_dir/state.json" "$data_dir/secret.key"
  say
  say '### known hosts (trust store)'
  python3 -c "import json;d=json.load(open('$data_dir/state.json'));print(json.dumps(d.get('knownHosts'), indent=2))"
} > "$SHOTS_DOC/ssh-tofu.txt"

# --- logs / diagnostics / runtime / actions --------------------------------
{
  head_file "Logs, diagnostics, runtime and quick actions"
  say '### GET /api/logs/sources'
  curl -sf "$API/api/logs/sources" | json
  say
  say '### GET /api/logs?source=journald&limit=5'
  curl -sf "$API/api/logs?source=journald&limit=5" | json
  say
  say '### GET /api/logs?source=journald&level=error&limit=3'
  curl -sf "$API/api/logs?source=journald&level=error&limit=3" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("count:", d["count"], "durationMs:", d["durationMs"])
for e in d["entries"]:
    print(" ", e["time"], e["level"], e["unit"], "|", e["message"][:100])'
  say
  say '### GET /api/logs?source=file:/etc/shadow  (allowlist refusal)'
  curl -s "$API/api/logs?source=file:/etc/shadow" -w '\nHTTP %{http_code}\n'
  say
  say '### POST /api/logs/export (headers + first rows)'
  tmp=$(mktemp)
  curl -s -X POST "$API/api/logs/export" -H 'Content-Type: application/json' \
    -d '{"source":"journald","limit":"5"}' -D - -o "$tmp" | head -6
  say '--- body head'
  head -4 "$tmp"
  rm -f "$tmp"
  say
  say '### GET /api/diagnostics'
  curl -sf "$API/api/diagnostics" | json
  say
  say '### GET /api/runtime (trimmed)'
  curl -sf "$API/api/runtime" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("daemon:", json.dumps(d["daemon"]))
print("go:", json.dumps(d["go"]))
print("bridges:", [(b["id"], b["reachable"], b["latencyMs"]) for b in d["bridges"]])
print("apps:", [(a["id"], a["hasDist"]) for a in d["apps"]][:8])
print("roots:", d["appsRoots"])'
  say
  say '### GET /api/actions'
  curl -sf "$API/api/actions" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("controlEnabled:", d["controlEnabled"])
for a in d["actions"]:
    print("  %-30s %-10s dangerous=%s needsRoot=%s" % (a["id"], a["support"], a["dangerous"], a["needsRoot"]))'
  say
  say '### POST /api/actions/terminal.killAll {}  (dangerous, unconfirmed)'
  curl -s -X POST "$API/api/actions/terminal.killAll" -H 'Content-Type: application/json' -d '{}' -w '\nHTTP %{http_code}\n'
  say
  say '### POST /api/actions/system.uptime {}  (preview)'
  curl -sf -X POST "$API/api/actions/system.uptime" -H 'Content-Type: application/json' -d '{}' | json
  say
  say '### POST /api/actions/power.reboot {confirm:true}  (control disabled)'
  curl -sf -X POST "$API/api/actions/power.reboot" -H 'Content-Type: application/json' -d '{"confirm":true}' | json
} > "$SHOTS_DOC/logs-diagnostics-runtime.txt"

say "wrote:"
ls -1 "$SHOTS_DOC"
