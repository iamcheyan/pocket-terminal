package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// --- harness -------------------------------------------------------------

func testServer(t *testing.T) (*server, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	logger := log.New(io.Discard, "", 0)
	cfg := config{
		addr:        "127.0.0.1:0",
		dataDir:     dir,
		idleTimeout: time.Minute,
		keepExited:  time.Minute,
		maxSessions: 4,
	}
	srv, err := newServer(cfg, logger)
	if err != nil {
		t.Fatalf("newServer: %v", err)
	}
	t.Cleanup(srv.close)
	ts := httptest.NewServer(srv.routes())
	t.Cleanup(ts.Close)
	return srv, ts
}

func doJSON(t *testing.T, method, url string, body any) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	out := map[string]any{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return resp.StatusCode, out
}

func waitFor(t *testing.T, timeout time.Duration, check func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if check() {
			return true
		}
		time.Sleep(25 * time.Millisecond)
	}
	return false
}

// --- ring buffer ---------------------------------------------------------

func TestRingBufferOffsetsAndWrap(t *testing.T) {
	ring := newRingBuffer(8)
	ring.Write([]byte("abcd"))
	if data, next := ring.Since(0); string(data) != "abcd" || next != 4 {
		t.Fatalf("initial read: %q next=%d", data, next)
	}
	if data, next := ring.Since(2); string(data) != "cd" || next != 4 {
		t.Fatalf("partial read: %q next=%d", data, next)
	}
	ring.Write([]byte("efghij"))
	// Capacity 8 keeps only the newest 8 bytes: "cdefghij".
	if data, next := ring.Since(0); string(data) != "cdefghij" || next != 10 {
		t.Fatalf("wrapped read: %q next=%d", data, next)
	}
	if data, _ := ring.Since(8); string(data) != "ij" {
		t.Fatalf("tail read: %q", data)
	}
	if data, _ := ring.Since(999); len(data) != 0 {
		t.Fatalf("future offset must be empty, got %q", data)
	}
}

func TestRingBufferRejectsOversizedWrite(t *testing.T) {
	ring := newRingBuffer(4)
	ring.Write([]byte("0123456789"))
	if data, _ := ring.Since(0); string(data) != "6789" {
		t.Fatalf("oversized write truncated to tail: %q", data)
	}
}

// --- secrets -------------------------------------------------------------

func TestSecretBoxRoundTripAndContextBinding(t *testing.T) {
	box, err := OpenSecretBox(t.TempDir())
	if err != nil {
		t.Fatalf("open box: %v", err)
	}
	sealed, err := box.Seal("hunter2", "profile/password")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if strings.Contains(sealed, "hunter2") {
		t.Fatal("ciphertext must not contain plaintext")
	}
	plain, err := box.Open(sealed, "profile/password")
	if err != nil || plain != "hunter2" {
		t.Fatalf("open: %q %v", plain, err)
	}
	if _, err := box.Open(sealed, "other/profile"); err == nil {
		t.Fatal("ciphertext must not open under another context")
	}
}

func TestSecretKeyFileIsOwnerOnly(t *testing.T) {
	dir := t.TempDir()
	if _, err := OpenSecretBox(dir); err != nil {
		t.Fatalf("open box: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, secretKeyFile))
	if err != nil {
		t.Fatalf("stat key: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("key mode = %o, want 600", mode)
	}
}

// --- store ---------------------------------------------------------------

func TestStorePersistsProfilesWithoutSecrets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	rec, err := store.UpsertProfile(ProfileRecord{ID: "p1", Name: "Box", Group: "Lab", Host: "h", Port: 22, User: "u", AuthKind: "password", PasswordCipher: "cipher"})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if rec.CreatedAt == "" || rec.UpdatedAt == "" {
		t.Fatal("timestamps must be set")
	}
	if err := store.MarkConnected("p1"); err != nil {
		t.Fatalf("mark connected: %v", err)
	}

	reopened, err := OpenStore(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got, ok := reopened.Profile("p1")
	if !ok || got.Name != "Box" || got.LastConnectedAt == "" {
		t.Fatalf("profile did not round-trip: %+v", got)
	}
	if got.PasswordCipher != "cipher" {
		t.Fatalf("cipher should persist verbatim: %q", got.PasswordCipher)
	}
	if err := reopened.DeleteProfile("p1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok := reopened.Profile("p1"); ok {
		t.Fatal("profile should be gone")
	}
}

func TestStoreKnownHosts(t *testing.T) {
	store, err := OpenStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := store.UpsertKnownHost(KnownHostRecord{ID: hostID("::1", 2222), Host: "::1", Port: 2222, KeyType: "ssh-ed25519", Fingerprint: "SHA256:x"}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if _, ok := store.KnownHost("[::1]:2222"); !ok {
		t.Fatal("IPv6 host key must be addressable")
	}
}

// --- shell detection -----------------------------------------------------

func TestDetectShellsFindsWorkingShell(t *testing.T) {
	shells, defaultID := detectShells(os.Getenv("SHELL"))
	if len(shells) == 0 {
		t.Fatal("no shells detected")
	}
	if defaultID == "" {
		t.Fatal("no default shell chosen")
	}
	for _, shell := range shells {
		if info, err := os.Stat(shell.Path); err != nil || info.IsDir() {
			t.Fatalf("reported shell path is not a file: %s", shell.Path)
		}
		if shell.ID == "" || shell.Name == "" {
			t.Fatalf("incomplete shell entry: %+v", shell)
		}
	}
	if _, _, err := resolveShell("definitely-not-a-shell"); err == nil {
		t.Fatal("unknown shell must be rejected")
	}
}

func TestDetectShellsIgnoresMissingUserShell(t *testing.T) {
	shells, defaultID := detectShells("/nonexistent/bin/fishy")
	if len(shells) == 0 || defaultID == "" {
		t.Fatal("fallback detection must still find a shell")
	}
	for _, shell := range shells {
		if shell.Path == "/nonexistent/bin/fishy" {
			t.Fatal("missing $SHELL must not be reported")
		}
	}
}

// --- HTTP surface --------------------------------------------------------

func TestHealthAndMeta(t *testing.T) {
	_, ts := testServer(t)
	status, body := doJSON(t, http.MethodGet, ts.URL+"/api/health", nil)
	if status != http.StatusOK || body["status"] != "ok" {
		t.Fatalf("health: %d %v", status, body)
	}
	status, meta := doJSON(t, http.MethodGet, ts.URL+"/api/meta", nil)
	if status != http.StatusOK {
		t.Fatalf("meta status: %d", status)
	}
	caps := meta["capabilities"].(map[string]any)
	if caps["pty"] != true || caps["ssh"] != true {
		t.Fatalf("capabilities: %v", caps)
	}
	if meta["defaultShell"] == "" {
		t.Fatal("default shell missing")
	}
}

func TestTerminalSessionExecutesCommand(t *testing.T) {
	_, ts := testServer(t)
	status, created := doJSON(t, http.MethodPost, ts.URL+"/api/terminal/sessions", map[string]any{"cols": 100, "rows": 30})
	if status != http.StatusCreated {
		t.Fatalf("create: %d %v", status, created)
	}
	session := created["session"].(map[string]any)
	id, _ := session["id"].(string)
	if id == "" {
		t.Fatal("session id missing")
	}
	if session["kind"] != "local" || session["mock"] != false {
		t.Fatalf("unexpected session metadata: %v", session)
	}

	status, _ = doJSON(t, http.MethodPost, ts.URL+"/api/terminal/sessions/"+id+"/input", map[string]any{"data": "echo POCKET_TEST_$((6*7))\n"})
	if status != http.StatusOK {
		t.Fatalf("input: %d", status)
	}
	var output string
	ok := waitFor(t, 5*time.Second, func() bool {
		resp, err := http.Get(ts.URL + "/api/terminal/sessions/" + id + "/output?offset=0")
		if err != nil {
			return false
		}
		defer func() { _ = resp.Body.Close() }()
		raw, _ := io.ReadAll(resp.Body)
		output = string(raw)
		return strings.Contains(output, "POCKET_TEST_42")
	})
	if !ok {
		t.Fatalf("command output missing; got %q", output)
	}

	status, _ = doJSON(t, http.MethodPost, ts.URL+"/api/terminal/sessions/"+id+"/resize", map[string]any{"cols": 132, "rows": 40})
	if status != http.StatusOK {
		t.Fatalf("resize: %d", status)
	}
	status, fetched := doJSON(t, http.MethodGet, ts.URL+"/api/terminal/sessions/"+id, nil)
	if status != http.StatusOK {
		t.Fatalf("get: %d", status)
	}
	got := fetched["session"].(map[string]any)
	if got["cols"].(float64) != 132 || got["rows"].(float64) != 40 {
		t.Fatalf("resize not applied: %v", got)
	}

	status, _ = doJSON(t, http.MethodDelete, ts.URL+"/api/terminal/sessions/"+id, nil)
	if status != http.StatusOK {
		t.Fatalf("delete: %d", status)
	}
	if status, _ := doJSON(t, http.MethodGet, ts.URL+"/api/terminal/sessions/"+id, nil); status != http.StatusNotFound {
		t.Fatalf("closed session must 404, got %d", status)
	}
}

func TestTerminalRejectsUnknownShellAndInvalidCwd(t *testing.T) {
	_, ts := testServer(t)
	status, body := doJSON(t, http.MethodPost, ts.URL+"/api/terminal/sessions", map[string]any{"shell": "nosuchshell"})
	if status != http.StatusBadRequest {
		t.Fatalf("unknown shell: %d %v", status, body)
	}
	status, _ = doJSON(t, http.MethodPost, ts.URL+"/api/terminal/sessions", map[string]any{"cwd": "/nonexistent/directory"})
	if status != http.StatusBadRequest {
		t.Fatalf("invalid cwd: %d", status)
	}
}

func TestTerminalSessionLimit(t *testing.T) {
	srv, ts := testServer(t)
	for i := 0; i < srv.cfg.maxSessions; i++ {
		if status, body := doJSON(t, http.MethodPost, ts.URL+"/api/terminal/sessions", map[string]any{"title": "t"}); status != http.StatusCreated {
			t.Fatalf("create %d: %d %v", i, status, body)
		}
	}
	status, body := doJSON(t, http.MethodPost, ts.URL+"/api/terminal/sessions", map[string]any{})
	if status != http.StatusConflict {
		t.Fatalf("limit: %d %v", status, body)
	}
}

func TestSSHProfileCRUDNeverStoresPlaintext(t *testing.T) {
	srv, ts := testServer(t)
	status, created := doJSON(t, http.MethodPost, ts.URL+"/api/ssh/profiles", map[string]any{
		"name": "Prod", "group": "Ops", "host": "prod.example", "port": 2222, "user": "deploy",
		"authKind": "password", "password": "s3cret-value",
	})
	if status != http.StatusCreated {
		t.Fatalf("create: %d %v", status, created)
	}
	profile := created["profile"].(map[string]any)
	id := profile["id"].(string)
	if profile["hasPassword"] != true {
		t.Fatalf("hasPassword should be true: %v", profile)
	}
	if _, present := profile["password"]; present {
		t.Fatal("API must never echo the password field")
	}
	raw, err := os.ReadFile(filepath.Join(srv.cfg.dataDir, "state.json"))
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	if strings.Contains(string(raw), "s3cret-value") {
		t.Fatal("plaintext password leaked into the state file")
	}

	status, updated := doJSON(t, http.MethodPut, ts.URL+"/api/ssh/profiles/"+id, map[string]any{"name": "Prod 2", "port": 22})
	if status != http.StatusOK {
		t.Fatalf("update: %d %v", status, updated)
	}
	got := updated["profile"].(map[string]any)
	if got["name"] != "Prod 2" || got["port"].(float64) != 22 || got["hasPassword"] != true {
		t.Fatalf("update did not merge: %v", got)
	}

	status, list := doJSON(t, http.MethodGet, ts.URL+"/api/ssh/profiles", nil)
	if status != http.StatusOK {
		t.Fatalf("list: %d", status)
	}
	forwarding := list["portForwarding"].(map[string]any)
	if forwarding["status"] != "todo" || forwarding["supported"] != false {
		t.Fatalf("port forwarding must be an explicit TODO: %v", forwarding)
	}
}

func TestSSHMockConnectTOFUFlow(t *testing.T) {
	srv, ts := testServer(t)
	var mockID string
	_, list := doJSON(t, http.MethodGet, ts.URL+"/api/ssh/profiles", nil)
	for _, raw := range list["profiles"].([]any) {
		profile := raw.(map[string]any)
		if profile["mock"] == true {
			mockID = profile["id"].(string)
		}
	}
	if mockID == "" {
		t.Skip("mock ssh target not available")
	}

	status, first := doJSON(t, http.MethodPost, ts.URL+"/api/ssh/profiles/"+mockID+"/connect", map[string]any{})
	if status != http.StatusConflict {
		t.Fatalf("first connect must require TOFU: %d %v", status, first)
	}
	errBody := first["error"].(map[string]any)
	if errBody["code"] != "host_key_unknown" {
		t.Fatalf("unexpected error: %v", errBody)
	}
	details := errBody["details"].(map[string]any)
	fingerprint := details["fingerprint"].(string)
	if !strings.HasPrefix(fingerprint, "SHA256:") {
		t.Fatalf("fingerprint format: %q", fingerprint)
	}
	if len(srv.store.KnownHosts()) != 0 {
		t.Fatal("host must not be trusted before confirmation")
	}

	status, second := doJSON(t, http.MethodPost, ts.URL+"/api/ssh/profiles/"+mockID+"/connect", map[string]any{"acceptHostKey": true, "fingerprint": fingerprint, "cols": 90, "rows": 24})
	if status != http.StatusCreated {
		t.Fatalf("trusted connect: %d %v", status, second)
	}
	session := second["session"].(map[string]any)
	if session["kind"] != "ssh" || session["mock"] != true {
		t.Fatalf("ssh session metadata: %v", session)
	}
	if len(srv.store.KnownHosts()) != 1 {
		t.Fatalf("known hosts: %v", srv.store.KnownHosts())
	}

	id := session["id"].(string)
	status, _ = doJSON(t, http.MethodPost, ts.URL+"/api/terminal/sessions/"+id+"/input", map[string]any{"data": "echo SSH_ROUNDTRIP_$((9*9))\n"})
	if status != http.StatusOK {
		t.Fatalf("ssh input: %d", status)
	}
	var output string
	if !waitFor(t, 6*time.Second, func() bool {
		resp, err := http.Get(ts.URL + "/api/terminal/sessions/" + id + "/output?offset=0")
		if err != nil {
			return false
		}
		defer func() { _ = resp.Body.Close() }()
		raw, _ := io.ReadAll(resp.Body)
		output = string(raw)
		return strings.Contains(output, "SSH_ROUNDTRIP_81")
	}) {
		t.Fatalf("ssh command output missing; got %q", output)
	}

	status, probe := doJSON(t, http.MethodPost, ts.URL+"/api/ssh/profiles/"+mockID+"/test", nil)
	if status != http.StatusOK {
		t.Fatalf("probe: %d", status)
	}
	result := probe["result"].(map[string]any)
	if result["hostKeyState"] != "trusted" || result["authenticated"] != true {
		t.Fatalf("probe after trust: %v", result)
	}
}

func TestSSHRejectsWrongPassword(t *testing.T) {
	srv, ts := testServer(t)
	mockID := ""
	for _, rec := range srv.store.Profiles() {
		if rec.Mock {
			mockID = rec.ID
		}
	}
	if mockID == "" {
		t.Skip("mock ssh target not available")
	}
	status, created := doJSON(t, http.MethodPost, ts.URL+"/api/ssh/profiles", map[string]any{
		"name": "Bad", "host": "127.0.0.1", "port": srv.ssh.MockPort(), "user": "demo",
		"authKind": "password", "password": "wrong",
	})
	if status != http.StatusCreated {
		t.Fatalf("create: %d %v", status, created)
	}
	badID := created["profile"].(map[string]any)["id"].(string)
	status, _ = doJSON(t, http.MethodPost, ts.URL+"/api/ssh/profiles/"+badID+"/connect", map[string]any{"acceptHostKey": true})
	if status != http.StatusBadGateway {
		t.Fatalf("wrong password must fail the connect: %d", status)
	}
}

func TestSSHHostKeyMismatchIsRefused(t *testing.T) {
	srv, ts := testServer(t)
	var mockID string
	for _, rec := range srv.store.Profiles() {
		if rec.Mock {
			mockID = rec.ID
		}
	}
	if mockID == "" {
		t.Skip("mock ssh target not available")
	}
	// Trust the current key, then corrupt it to simulate a changed host key.
	status, _ := doJSON(t, http.MethodPost, ts.URL+"/api/ssh/profiles/"+mockID+"/connect", map[string]any{"acceptHostKey": true})
	if status != http.StatusCreated {
		t.Fatalf("trusted connect: %d", status)
	}
	known := srv.store.KnownHosts()
	if len(known) != 1 {
		t.Fatalf("known hosts: %v", known)
	}
	known[0].Fingerprint = "SHA256:changed"
	if err := srv.store.UpsertKnownHost(known[0]); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	status, body := doJSON(t, http.MethodPost, ts.URL+"/api/ssh/profiles/"+mockID+"/connect", map[string]any{"acceptHostKey": true})
	if status != http.StatusConflict {
		t.Fatalf("mismatch must be refused: %d %v", status, body)
	}
	if code := body["error"].(map[string]any)["code"]; code != "host_key_mismatch" {
		t.Fatalf("error code: %v", code)
	}
}

func TestLogsSurfaceAndValidation(t *testing.T) {
	_, ts := testServer(t)
	status, sources := doJSON(t, http.MethodGet, ts.URL+"/api/logs/sources", nil)
	if status != http.StatusOK {
		t.Fatalf("sources: %d", status)
	}
	if len(sources["sources"].([]any)) == 0 {
		t.Fatal("at least the journal source must be listed")
	}
	if status, _ := doJSON(t, http.MethodGet, ts.URL+"/api/logs?source=file:/etc/shadow", nil); status != http.StatusBadRequest {
		t.Fatalf("arbitrary file read must be rejected, got %d", status)
	}
	if status, _ := doJSON(t, http.MethodGet, ts.URL+"/api/logs?source=journald&priority=panic", nil); status != http.StatusBadRequest {
		t.Fatalf("invalid priority must be rejected, got %d", status)
	}
}

func TestFileLogTailAndFilter(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.log")
	content := strings.Join([]string{
		"2026-10-30T10:00:00 host app[1]: started",
		"2026-10-30T10:00:01 host app[1]: WARN cache is warm",
		"2026-10-30T10:00:02 host app[1]: ERROR disk on fire",
		"2026-10-30T10:00:03 host app[1]: info fine again",
	}, "\n")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	entries, err := queryFileLog(t.Context(), path, logQuery{Limit: 100})
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(entries) != 4 {
		t.Fatalf("entries: %d", len(entries))
	}
	if entries[2].Level != "error" || entries[1].Level != "warning" {
		t.Fatalf("levels: %+v", entries)
	}
	filtered, err := queryFileLog(t.Context(), path, logQuery{Limit: 100, Query: "disk"})
	if err != nil || len(filtered) != 1 || filtered[0].Level != "error" {
		t.Fatalf("filter: %+v %v", filtered, err)
	}
	onlyErrors, _ := queryFileLog(t.Context(), path, logQuery{Limit: 100, Level: "error"})
	if len(onlyErrors) != 1 {
		t.Fatalf("level filter: %+v", onlyErrors)
	}
	limited, _ := queryFileLog(t.Context(), path, logQuery{Limit: 2})
	if len(limited) != 2 || !strings.Contains(limited[1].Message, "fine again") {
		t.Fatalf("limit must keep the newest rows: %+v", limited)
	}
}

func TestLogFileAllowlist(t *testing.T) {
	if logFileAllowed("/etc/shadow") {
		t.Fatal("/etc/shadow must not be readable")
	}
	if !logFileAllowed("/var/log/messages") {
		t.Fatal("/var/log entries must be allowed")
	}
	if !logFileAllowed(filepath.Join(os.Getenv("HOME"), ".local/state/pocket/x.log")) {
		t.Fatal("user state logs must be allowed")
	}
}

func TestDiagnosticsPayloadShape(t *testing.T) {
	_, ts := testServer(t)
	status, report := doJSON(t, http.MethodGet, ts.URL+"/api/diagnostics", nil)
	if status != http.StatusOK {
		t.Fatalf("diagnostics: %d", status)
	}
	host := report["host"].(map[string]any)
	if host["hostname"] == "" || host["kernel"] == "" {
		t.Fatalf("host summary incomplete: %v", host)
	}
	cpu := report["cpu"].([]any)
	if len(cpu) == 0 {
		t.Fatal("cpu metrics missing")
	}
	if _, ok := report["disks"].([]any); !ok {
		t.Fatalf("disks missing: %v", report["disks"])
	}
	providers := report["providers"].(map[string]any)
	if providers["cpu"] != "procfs" || providers["memory"] != "procfs" {
		t.Fatalf("providers must be labelled: %v", providers)
	}
}

func TestRuntimeReport(t *testing.T) {
	_, ts := testServer(t)
	status, report := doJSON(t, http.MethodGet, ts.URL+"/api/runtime", nil)
	if status != http.StatusOK {
		t.Fatalf("runtime: %d", status)
	}
	daemon := report["daemon"].(map[string]any)
	if daemon["name"] != appName || daemon["pid"] == nil {
		t.Fatalf("daemon block: %v", daemon)
	}
	if _, ok := report["apps"].([]any); !ok {
		t.Fatalf("apps must be a list: %v", report["apps"])
	}
	bridges := report["bridges"].([]any)
	if len(bridges) == 0 {
		t.Fatal("bridge probes missing")
	}
	for _, raw := range bridges {
		bridge := raw.(map[string]any)
		if _, ok := bridge["reachable"].(bool); !ok {
			t.Fatalf("bridge reachability missing: %v", bridge)
		}
	}
}

func TestActionConfirmationPolicy(t *testing.T) {
	_, ts := testServer(t)
	status, listing := doJSON(t, http.MethodGet, ts.URL+"/api/actions", nil)
	if status != http.StatusOK {
		t.Fatalf("list: %d", status)
	}
	if listing["controlEnabled"] != false {
		t.Fatalf("control must default to off: %v", listing)
	}
	if status, body := doJSON(t, http.MethodPost, ts.URL+"/api/actions/terminal.killAll", map[string]any{}); status != http.StatusConflict {
		t.Fatalf("unconfirmed dangerous action must 409: %d %v", status, body)
	}
	status, body := doJSON(t, http.MethodPost, ts.URL+"/api/actions/system.uptime", map[string]any{})
	if status != http.StatusOK {
		t.Fatalf("preview action: %d %v", status, body)
	}
	result := body["result"].(map[string]any)
	if result["executed"] != true || result["preview"] == nil {
		t.Fatalf("preview result: %v", result)
	}
	if status, _ := doJSON(t, http.MethodPost, ts.URL+"/api/actions/nope", map[string]any{}); status != http.StatusNotFound {
		t.Fatalf("unknown action: %d", status)
	}
	status, body = doJSON(t, http.MethodPost, ts.URL+"/api/actions/power.reboot", map[string]any{"confirm": true})
	if status != http.StatusOK {
		t.Fatalf("reboot with control off: %d", status)
	}
	result = body["result"].(map[string]any)
	if result["refusal"] != "system_control_disabled" {
		t.Fatalf("reboot must be refused: %v", result)
	}
}

func TestSecurityReport(t *testing.T) {
	_, ts := testServer(t)
	status, report := doJSON(t, http.MethodGet, ts.URL+"/api/security", nil)
	if status != http.StatusOK {
		t.Fatalf("security: %d", status)
	}
	if report["plaintextSecrets"] != false || report["allowSystemControl"] != false {
		t.Fatalf("security report: %v", report)
	}
}

func TestBearerTokenGate(t *testing.T) {
	dir := t.TempDir()
	srv, err := newServer(config{addr: "127.0.0.1:0", dataDir: dir, token: "tok", idleTimeout: time.Minute, keepExited: time.Minute, maxSessions: 2}, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatalf("newServer: %v", err)
	}
	t.Cleanup(srv.close)
	ts := httptest.NewServer(srv.routes())
	t.Cleanup(ts.Close)

	if status, _ := doJSON(t, http.MethodGet, ts.URL+"/api/meta", nil); status != http.StatusUnauthorized {
		t.Fatalf("missing token must 401, got %d", status)
	}
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/meta", nil)
	req.Header.Set("Authorization", "Bearer tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("valid token: %d", resp.StatusCode)
	}
}

// --- helpers -------------------------------------------------------------

func TestSSHFingerprintFormat(t *testing.T) {
	fp := sshFingerprint([]byte("host-key-bytes"))
	if !strings.HasPrefix(fp, "SHA256:") {
		t.Fatalf("fingerprint: %q", fp)
	}
	// OpenSSH uses standard base64 without padding, so + and / are legal.
	if strings.Contains(fp, "=") {
		t.Fatalf("fingerprint must be unpadded: %q", fp)
	}
	if want := len("SHA256:") + 43; len(fp) != want {
		t.Fatalf("fingerprint length = %d, want %d (%q)", len(fp), want, fp)
	}
	if sshFingerprint([]byte("host-key-bytes")) != fp {
		t.Fatal("fingerprint must be deterministic")
	}
}

func TestHostIDHandlesIPv6(t *testing.T) {
	if got := hostID("::1", 22); got != "[::1]:22" {
		t.Fatalf("ipv6 host id: %q", got)
	}
	if got := hostID("EXAMPLE.com", 22); got != "example.com:22" {
		t.Fatalf("host id normalisation: %q", got)
	}
}

func TestDiskMetricsGroupsSharedPools(t *testing.T) {
	disks, provider := diskMetrics()
	if provider != "statfs" {
		t.Skipf("statfs unavailable: %s", provider)
	}
	seen := map[[2]uint64]bool{}
	for _, disk := range disks {
		key := [2]uint64{disk.TotalBytes, disk.FreeBytes}
		if seen[key] {
			t.Fatalf("duplicate storage pool reported: %+v", disks)
		}
		seen[key] = true
		if disk.UsedBytes+disk.FreeBytes > disk.TotalBytes {
			t.Fatalf("inconsistent disk accounting: %+v", disk)
		}
	}
}

func TestParsePlainLineLevels(t *testing.T) {
	cases := map[string]string{
		"2026-10-30T10:00:00 host app: ERROR boom":   "error",
		"2026-10-30T10:00:00 host app: warning slow": "warning",
		"2026-10-30T10:00:00 host app: info fine":    "info",
		"plain line without timestamp":               "info",
	}
	for line, want := range cases {
		if got := parsePlainLine(line).Level; got != want {
			t.Fatalf("%q => %q, want %q", line, got, want)
		}
	}
}

func TestRingBufferResumesAfterDisconnect(t *testing.T) {
	ring := newRingBuffer(64)
	ring.Write([]byte("first-chunk;"))
	_, cursor := ring.Since(0)
	ring.Write([]byte("second-chunk"))
	replay, next := ring.Since(cursor)
	if string(replay) != "second-chunk" {
		t.Fatalf("resume must replay only new bytes: %q", replay)
	}
	if next != ring.Total() {
		t.Fatalf("next offset: %d vs %d", next, ring.Total())
	}
}

func TestParsePlainLineExtractsGoLogTimestamp(t *testing.T) {
	entry := parsePlainLine("2026/10/30 21:47:51 terminald GET /api/logs 200 3ms")
	if entry.Time == "" || entry.Time == "now" {
		t.Fatalf("timestamp not parsed: %+v", entry)
	}
	if entry.Message != "terminald GET /api/logs 200 3ms" {
		t.Fatalf("message still carries the timestamp: %q", entry.Message)
	}
	rfc := parsePlainLine("2026-10-30T10:00:00 host app[1]: ERROR boom")
	if rfc.Level != "error" || rfc.Message != "host app[1]: ERROR boom" {
		t.Fatalf("rfc3339 line: %+v", rfc)
	}
}

func TestLogServiceAllowlistUsesConfiguredDataDir(t *testing.T) {
	dir := t.TempDir()
	logs := NewLogService(log.New(io.Discard, "", 0), dir)
	path := filepath.Join(dir, "logs", "terminald.log")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("2026/10/30 21:00:00 terminald booted\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := parseLogQueryWithRoots(map[string]string{"source": "file:" + path}, logs.roots); err != nil {
		t.Fatalf("own log file must be readable: %v", err)
	}
	if _, err := parseLogQueryWithRoots(map[string]string{"source": "file:/etc/shadow"}, logs.roots); err == nil {
		t.Fatal("/etc/shadow must stay unreadable")
	}
}

// --- websocket transport ------------------------------------------------

func TestWebSocketSessionRoundTrip(t *testing.T) {
	_, ts := testServer(t)
	status, created := doJSON(t, http.MethodPost, ts.URL+"/api/terminal/sessions", map[string]any{"cols": 90, "rows": 24})
	if status != http.StatusCreated {
		t.Fatalf("create: %d", status)
	}
	id := created["session"].(map[string]any)["id"].(string)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/terminal/sessions/" + id + "/stream?offset=0"
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"http://127.0.0.1:5178"}},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	var output strings.Builder
	ready := false
	deadline := time.Now().Add(8 * time.Second)
	sent := false
	for time.Now().Before(deadline) {
		ctxRead, cancelRead := context.WithTimeout(ctx, time.Second)
		typ, payload, err := conn.Read(ctxRead)
		cancelRead()
		if err != nil {
			break
		}
		switch typ {
		case websocket.MessageText:
			if strings.Contains(string(payload), `"ready"`) && !sent {
				ready = true
				if err := conn.Write(ctx, websocket.MessageBinary, []byte("echo WS_GO_$((9*9))\n")); err != nil {
					t.Fatalf("write: %v", err)
				}
				sent = true
			}
		case websocket.MessageBinary:
			output.Write(payload)
			if strings.Contains(output.String(), "WS_GO_81") {
				if !ready {
					t.Fatal("output arrived before the ready control frame")
				}
				return
			}
		}
	}
	t.Fatalf("did not observe command output; got %q", output.String())
}

func TestWebSocketRejectsForeignOrigin(t *testing.T) {
	_, ts := testServer(t)
	status, created := doJSON(t, http.MethodPost, ts.URL+"/api/terminal/sessions", map[string]any{})
	if status != http.StatusCreated {
		t.Fatalf("create: %d", status)
	}
	id := created["session"].(map[string]any)["id"].(string)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/terminal/sessions/" + id + "/stream"
	conn, resp, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://evil.example"}},
	})
	if err == nil {
		_ = conn.CloseNow()
		t.Fatal("foreign origin must be refused")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for foreign origin, got %+v", resp)
	}
}

func TestWebSocketResumesFromOffset(t *testing.T) {
	srv, ts := testServer(t)
	session, err := srv.sessions.Create(createRequest{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !waitFor(t, 4*time.Second, func() bool { return session.TotalBytes() > 0 }) {
		t.Fatal("session produced no banner")
	}
	first, cursor := session.Output(0)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/api/terminal/sessions/" + session.ID + "/stream?offset=" + itoa(cursor)
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	// Reconnect must not replay the bytes we already had.
	ctxRead, cancelRead := context.WithTimeout(ctx, 1500*time.Millisecond)
	typ, payload, readErr := conn.Read(ctxRead)
	cancelRead()
	if readErr == nil && typ == websocket.MessageBinary && len(first) > 0 && string(payload) == string(first) {
		t.Fatal("offset resume replayed already-seen output")
	}
}
