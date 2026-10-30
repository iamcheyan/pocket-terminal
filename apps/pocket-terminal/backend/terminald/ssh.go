package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/crypto/ssh"
)

// SSHManager owns profile connection attempts, TOFU host-key decisions and the
// optional loopback mock target.
type SSHManager struct {
	srv *server

	mu           sync.Mutex
	pending      map[string]pendingHostKey
	mockListener net.Listener
	mockPort     int
	mockDone     sync.WaitGroup
}

type pendingHostKey struct {
	ID          string
	Host        string
	Port        int
	Fingerprint string
	KeyType     string
	CreatedAt   time.Time
}

var (
	errHostKeyUnknown  = errors.New("host key is not yet trusted")
	errHostKeyMismatch = errors.New("host key changed since it was trusted")
	errProfileNotFound = errors.New("profile not found")
)

func NewSSHManager(s *server) *SSHManager {
	return &SSHManager{srv: s, pending: map[string]pendingHostKey{}}
}

func (m *SSHManager) KnownHostCount() int { return len(m.srv.store.KnownHosts()) }

func (m *SSHManager) MockActive() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mockListener != nil
}

func (m *SSHManager) MockPort() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mockPort
}

// StartMockTarget runs a loopback-only SSH server with fixed credentials so the
// complete SSH flow is exercisable without a remote host. Every session that
// reaches it is labelled mock=true in the UI.
func (m *SSHManager) StartMockTarget() error {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		return err
	}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(conn ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			if conn.User() == "demo" && string(password) == "pocket" {
				return &ssh.Permissions{}, nil
			}
			return nil, fmt.Errorf("invalid credentials")
		},
	}
	cfg.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.mockListener = listener
	m.mockPort = listener.Addr().(*net.TCPAddr).Port
	m.mu.Unlock()

	m.mockDone.Add(1)
	go func() {
		defer m.mockDone.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go serveMockConn(conn, cfg, m.srv.logger)
		}
	}()
	return nil
}

func (m *SSHManager) Close() {
	m.mu.Lock()
	listener := m.mockListener
	m.mockListener = nil
	m.mu.Unlock()
	if listener != nil {
		_ = listener.Close()
	}
	m.mockDone.Wait()
}

func serveMockConn(raw net.Conn, cfg *ssh.ServerConfig, logger *log.Logger) {
	defer func() { _ = raw.Close() }()
	serverConn, chans, reqs, err := ssh.NewServerConn(raw, cfg)
	if err != nil {
		return
	}
	defer func() { _ = serverConn.Close() }()
	go ssh.DiscardRequests(reqs)
	for newChannel := range chans {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "only session channels are supported")
			continue
		}
		channel, requests, err := newChannel.Accept()
		if err != nil {
			continue
		}
		go serveMockSession(channel, requests, logger)
	}
}

type ptyRequest struct {
	Term   string
	Cols   uint32
	Rows   uint32
	Width  uint32
	Height uint32
	Modes  string
}

// serveMockSession is a miniature sshd: pty-req/window-change resize a real
// local PTY, shell bridges the SSH channel to it.
func serveMockSession(channel ssh.Channel, requests <-chan *ssh.Request, logger *log.Logger) {
	defer func() { _ = channel.Close() }()

	cols, rows := uint32(80), uint32(24)
	var execCommand string

loop:
	for req := range requests {
		switch req.Type {
		case "pty-req":
			var payload ptyRequest
			if err := ssh.Unmarshal(req.Payload, &payload); err == nil {
				if payload.Cols > 0 {
					cols = payload.Cols
				}
				if payload.Rows > 0 {
					rows = payload.Rows
				}
			}
			_ = req.Reply(true, nil)
		case "window-change":
			var payload struct{ Cols, Rows, Width, Height uint32 }
			if err := ssh.Unmarshal(req.Payload, &payload); err == nil {
				if payload.Cols > 0 {
					cols = payload.Cols
				}
				if payload.Rows > 0 {
					rows = payload.Rows
				}
			}
		case "shell":
			_ = req.Reply(true, nil)
			break loop
		case "exec":
			var payload struct{ Command string }
			_ = ssh.Unmarshal(req.Payload, &payload)
			execCommand = payload.Command
			_ = req.Reply(true, nil)
			break loop
		case "env":
			_ = req.Reply(true, nil)
		default:
			_ = req.Reply(false, nil)
		}
	}

	shellPath := "/bin/sh"
	if path, _, err := resolveShell(""); err == nil {
		shellPath = path
	}
	var cmd *exec.Cmd
	if execCommand != "" {
		cmd = exec.Command(shellPath, "-c", execCommand)
		cmd.Env = append(os.Environ(), "TERM=xterm-256color", "POCKET_TERMINAL=1")
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	} else {
		cmd = newShellCommand(shellPath, "")
	}
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		logger.Printf("mock ssh pty: %v", err)
		return
	}
	go func() {
		for req := range requests {
			if req.Type == "window-change" {
				var payload struct{ Cols, Rows, Width, Height uint32 }
				if err := ssh.Unmarshal(req.Payload, &payload); err == nil && payload.Cols > 0 && payload.Rows > 0 {
					_ = pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(payload.Cols), Rows: uint16(payload.Rows)})
				}
			}
		}
	}()
	defer func() {
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}()

	go func() {
		_, _ = io.Copy(ptmx, channel)
	}()
	_, _ = io.Copy(channel, ptmx)
}

// --- profile management --------------------------------------------------

type profileInput struct {
	Name        string `json:"name"`
	Group       string `json:"group"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	User        string `json:"user"`
	AuthKind    string `json:"authKind"`
	Password    string `json:"password"`
	PrivateKey  string `json:"privateKey"`
	Color       string `json:"color"`
	Description string `json:"description"`
	Mock        *bool  `json:"mock"`
}

type ProfileDTO struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Group           string `json:"group"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
	User            string `json:"user"`
	AuthKind        string `json:"authKind"`
	HasPassword     bool   `json:"hasPassword"`
	HasKey          bool   `json:"hasKey"`
	Mock            bool   `json:"mock"`
	Color           string `json:"color,omitempty"`
	Description     string `json:"description,omitempty"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
	LastConnectedAt string `json:"lastConnectedAt,omitempty"`
}

func profileDTO(rec ProfileRecord) ProfileDTO {
	return ProfileDTO{
		ID: rec.ID, Name: rec.Name, Group: rec.Group, Host: rec.Host, Port: rec.Port, User: rec.User,
		AuthKind: rec.AuthKind, HasPassword: rec.PasswordCipher != "", HasKey: rec.KeyCipher != "",
		Mock: rec.Mock, Color: rec.Color, Description: rec.Description,
		CreatedAt: rec.CreatedAt, UpdatedAt: rec.UpdatedAt, LastConnectedAt: rec.LastConnectedAt,
	}
}

// seedProfiles creates the demo set on first start: one connectable mock target
// and two clearly-labelled placeholders.
func (m *SSHManager) seedProfiles() {
	if len(m.srv.store.Profiles()) > 0 {
		m.refreshMockProfile()
		return
	}
	records := []profileInput{
		{Name: "Mock Lab", Group: "Demo", Host: "127.0.0.1", Port: m.MockPort(), User: "demo", AuthKind: "password", Password: "pocket", Mock: new(true), Color: "#c4dc9c", Description: "Built-in loopback SSH fixture. Credentials demo / pocket; sessions are labelled mock."},
		{Name: "Edge Router", Group: "Lab", Host: "192.168.50.1", Port: 22, User: "admin", AuthKind: "key", Color: "#9ca9dc", Description: "Placeholder profile; add a private key before connecting."},
		{Name: "Build Box", Group: "Lab", Host: "build.lan", Port: 2222, User: "dev", AuthKind: "password", Color: "#cfaa75", Description: "Placeholder profile for a LAN build machine."},
	}
	for _, rec := range records {
		if _, err := m.createProfile(rec); err != nil {
			m.srv.logger.Printf("seed profile: %v", err)
		}
	}
}

// refreshMockProfile keeps the bundled fixture's advertised port current: the
// loopback listener picks an ephemeral port on every daemon start.
func (m *SSHManager) refreshMockProfile() {
	port := m.MockPort()
	if port == 0 {
		return
	}
	for _, rec := range m.srv.store.Profiles() {
		if !rec.Mock || rec.Port == port {
			continue
		}
		staleID := hostID(rec.Host, rec.Port)
		rec.Port = port
		if _, err := m.srv.store.UpsertProfile(rec); err != nil {
			m.srv.logger.Printf("refresh mock profile: %v", err)
			continue
		}
		// The fixture mints a new host key per daemon start, so its previous
		// trust entry can never match again. Drop it rather than leave a
		// permanently stale fingerprint in the trust store.
		if err := m.srv.store.DeleteKnownHost(staleID); err == nil {
			m.srv.logger.Printf("pruned stale mock known-host %s", staleID)
		}
	}
}

func (m *SSHManager) createProfile(in profileInput) (ProfileDTO, error) {
	if strings.TrimSpace(in.Name) == "" {
		return ProfileDTO{}, errors.New("name is required")
	}
	if strings.TrimSpace(in.Host) == "" {
		return ProfileDTO{}, errors.New("host is required")
	}
	port := in.Port
	if port == 0 {
		port = 22
	}
	if port < 1 || port > 65535 {
		return ProfileDTO{}, errors.New("port must be between 1 and 65535")
	}
	authKind := firstNonEmpty(in.AuthKind, "password")
	if authKind != "password" && authKind != "key" && authKind != "none" {
		return ProfileDTO{}, errors.New("authKind must be password, key or none")
	}
	rec := ProfileRecord{
		ID: newID("p"), Name: strings.TrimSpace(in.Name), Group: firstNonEmpty(in.Group, "Ungrouped"),
		Host: strings.TrimSpace(in.Host), Port: port, User: firstNonEmpty(in.User, "root"),
		AuthKind: authKind, Mock: in.Mock != nil && *in.Mock, Color: in.Color, Description: in.Description,
	}
	if err := m.sealSecrets(&rec, in.Password, in.PrivateKey); err != nil {
		return ProfileDTO{}, err
	}
	saved, err := m.srv.store.UpsertProfile(rec)
	if err != nil {
		return ProfileDTO{}, err
	}
	return profileDTO(saved), nil
}

func (m *SSHManager) sealSecrets(rec *ProfileRecord, password, key string) error {
	if password != "" {
		sealed, err := m.srv.secrets.Seal(password, rec.ID+"/password")
		if err != nil {
			return err
		}
		rec.PasswordCipher = sealed
	}
	if key != "" {
		sealed, err := m.srv.secrets.Seal(key, rec.ID+"/key")
		if err != nil {
			return err
		}
		rec.KeyCipher = sealed
	}
	return nil
}

func (m *SSHManager) updateProfile(id string, in profileInput) (ProfileDTO, error) {
	rec, ok := m.srv.store.Profile(id)
	if !ok {
		return ProfileDTO{}, errProfileNotFound
	}
	if strings.TrimSpace(in.Name) != "" {
		rec.Name = strings.TrimSpace(in.Name)
	}
	if strings.TrimSpace(in.Group) != "" {
		rec.Group = strings.TrimSpace(in.Group)
	}
	if strings.TrimSpace(in.Host) != "" {
		rec.Host = strings.TrimSpace(in.Host)
	}
	if in.Port != 0 {
		if in.Port < 1 || in.Port > 65535 {
			return ProfileDTO{}, errors.New("port must be between 1 and 65535")
		}
		rec.Port = in.Port
	}
	if strings.TrimSpace(in.User) != "" {
		rec.User = strings.TrimSpace(in.User)
	}
	if in.AuthKind != "" {
		if in.AuthKind != "password" && in.AuthKind != "key" && in.AuthKind != "none" {
			return ProfileDTO{}, errors.New("authKind must be password, key or none")
		}
		rec.AuthKind = in.AuthKind
	}
	if in.Mock != nil {
		rec.Mock = *in.Mock
	}
	if in.Color != "" {
		rec.Color = in.Color
	}
	if in.Description != "" {
		rec.Description = in.Description
	}
	if err := m.sealSecrets(&rec, in.Password, in.PrivateKey); err != nil {
		return ProfileDTO{}, err
	}
	saved, err := m.srv.store.UpsertProfile(rec)
	if err != nil {
		return ProfileDTO{}, err
	}
	return profileDTO(saved), nil
}

// --- HTTP handlers -------------------------------------------------------

func (s *server) handleProfileList(w http.ResponseWriter, r *http.Request) {
	records := s.store.Profiles()
	dtos := make([]ProfileDTO, 0, len(records))
	groups := map[string]int{}
	for _, rec := range records {
		dtos = append(dtos, profileDTO(rec))
		groups[rec.Group]++
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"profiles": dtos,
		"groups":   groups,
		"mockTarget": map[string]any{
			"available": s.ssh.MockActive(),
			"host":      "127.0.0.1",
			"port":      s.ssh.MockPort(),
			"user":      "demo",
			"note":      "loopback fixture; every session it carries is marked mock=true",
		},
		"portForwarding": map[string]any{
			"supported": false,
			"status":    "todo",
			"note":      "Local/remote forwarding is planned; the UI exposes a placeholder so the surface is not silently missing.",
		},
	})
}

func (s *server) handleProfileCreate(w http.ResponseWriter, r *http.Request) {
	var in profileInput
	if !decodeBody(w, r, &in) {
		return
	}
	dto, err := s.ssh.createProfile(in)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_profile", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"profile": dto})
}

func (s *server) handleProfileUpdate(w http.ResponseWriter, r *http.Request) {
	var in profileInput
	if !decodeBody(w, r, &in) {
		return
	}
	dto, err := s.ssh.updateProfile(r.PathValue("id"), in)
	if err != nil {
		if errors.Is(err, errProfileNotFound) {
			writeError(w, http.StatusNotFound, "not_found", err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, "invalid_profile", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": dto})
}

func (s *server) handleProfileDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.store.DeleteProfile(id); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "profile not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

func (s *server) handleKnownHosts(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"knownHosts": s.store.KnownHosts()})
}

func (s *server) handleKnownHostDelete(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteKnownHost(r.PathValue("id")); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "known host not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// testResult is the outcome of a pre-flight handshake (no shell is opened).
type testResult struct {
	Reachable     bool   `json:"reachable"`
	Authenticated bool   `json:"authenticated"`
	HostKeyState  string `json:"hostKeyState"`
	Fingerprint   string `json:"fingerprint,omitempty"`
	Mock          bool   `json:"mock"`
	LatencyMs     int64  `json:"latencyMs"`
	Message       string `json:"message"`
}

func (s *server) handleProfileTest(w http.ResponseWriter, r *http.Request) {
	rec, ok := s.store.Profile(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "profile not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": s.ssh.probe(rec)})
}

func (s *server) handleProfileConnect(w http.ResponseWriter, r *http.Request) {
	rec, ok := s.store.Profile(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "profile not found")
		return
	}
	var req struct {
		Cols          uint16 `json:"cols"`
		Rows          uint16 `json:"rows"`
		AcceptHostKey bool   `json:"acceptHostKey"`
		Fingerprint   string `json:"fingerprint"`
		Title         string `json:"title"`
		TabsGroup     string `json:"tabsGroup"`
	}
	if err := decodeJSON(r, &req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	session, hostKey, err := s.ssh.connect(rec, req.Cols, req.Rows, req.AcceptHostKey, req.Fingerprint, req.Title, req.TabsGroup)
	if err != nil {
		switch {
		case errors.Is(err, errHostKeyUnknown):
			writeErrorDetails(w, http.StatusConflict, "host_key_unknown", "host key is not trusted yet", map[string]any{
				"fingerprint": hostKey.Fingerprint,
				"keyType":     hostKey.KeyType,
				"host":        hostKey.Host,
				"port":        hostKey.Port,
				"mock":        rec.Mock,
			})
		case errors.Is(err, errHostKeyMismatch):
			writeErrorDetails(w, http.StatusConflict, "host_key_mismatch", "host key does not match the stored fingerprint", map[string]any{
				"fingerprint": hostKey.Fingerprint,
				"host":        hostKey.Host,
				"port":        hostKey.Port,
			})
		default:
			writeError(w, http.StatusBadGateway, "ssh_connect_failed", err.Error())
		}
		return
	}
	_ = s.store.MarkConnected(rec.ID)
	writeJSON(w, http.StatusCreated, map[string]any{"session": session.DTO()})
}

// connect opens a real SSH shell channel and wraps it as a terminal session.
func (m *SSHManager) connect(rec ProfileRecord, cols, rows uint16, acceptHostKey bool, fingerprint, title, tabsGroup string) (*Session, pendingHostKey, error) {
	client, outcome, err := m.dial(rec, acceptHostKey, fingerprint)
	if err != nil {
		hostKey := m.lastPending()
		if errors.Is(err, errHostKeyUnknown) || errors.Is(err, errHostKeyMismatch) {
			hostKey.Host, hostKey.Port = rec.Host, rec.Port
			hostKey.Fingerprint = outcome.fingerprint
		}
		return nil, hostKey, err
	}
	if cols == 0 {
		cols = 100
	}
	if rows == 0 {
		rows = 28
	}
	sshSession, err := client.NewSession()
	if err != nil {
		_ = client.Close()
		return nil, outcome.hostKey(), fmt.Errorf("open ssh channel: %w", err)
	}
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := sshSession.RequestPty("xterm-256color", int(rows), int(cols), modes); err != nil {
		_ = sshSession.Close()
		_ = client.Close()
		return nil, outcome.hostKey(), fmt.Errorf("request pty: %w", err)
	}
	stdin, err := sshSession.StdinPipe()
	if err != nil {
		_ = sshSession.Close()
		_ = client.Close()
		return nil, outcome.hostKey(), err
	}
	pr, pw := io.Pipe()
	sshSession.Stdout = pw
	sshSession.Stderr = pw
	if err := sshSession.Shell(); err != nil {
		_ = sshSession.Close()
		_ = client.Close()
		return nil, outcome.hostKey(), fmt.Errorf("start shell: %w", err)
	}

	rw := &remoteRW{reader: pr, writer: stdin, session: sshSession, client: client}
	session := m.srv.sessions.adopt(&Session{
		Title:     firstNonEmpty(title, rec.Name),
		Shell:     "ssh " + rec.User + "@" + rec.Host,
		ShellID:   "ssh",
		Kind:      "ssh",
		TabsGroup: firstNonEmpty(tabsGroup, "main"),
		ProfileID: rec.ID,
		Mock:      rec.Mock,
		State:     sessionRunning,
		Rows:      rows,
		Cols:      cols,
		buffer:    newRingBuffer(512 * 1024),
		rw:        rw,
		resizeFn: func(cols, rows uint16) error {
			return sshSession.WindowChange(int(rows), int(cols))
		},
	})
	go func() {
		waitErr := sshSession.Wait()
		code := 0
		var exitErr *ssh.ExitError
		switch {
		case errors.As(waitErr, &exitErr):
			code = exitErr.ExitStatus()
		case waitErr != nil:
			code = 1
		}
		_ = pw.Close()
		_ = client.Close()
		session.setExited(code)
	}()
	return session, outcome.hostKey(), nil
}

func (o dialOutcome) hostKey() pendingHostKey {
	return pendingHostKey{Fingerprint: o.fingerprint, KeyType: o.keyType, Host: o.host, Port: o.port}
}

func (m *SSHManager) lastPending() pendingHostKey {
	m.mu.Lock()
	defer m.mu.Unlock()
	var latest pendingHostKey
	for _, p := range m.pending {
		if latest.ID == "" || p.CreatedAt.After(latest.CreatedAt) {
			latest = p
		}
	}
	return latest
}

type dialOutcome struct {
	fingerprint  string
	keyType      string
	host         string
	port         int
	hostKeyState string
}

// dial performs TCP connect + handshake with TOFU host-key verification.
func (m *SSHManager) dial(rec ProfileRecord, acceptHostKey bool, fingerprint string) (*ssh.Client, dialOutcome, error) {
	target := rec
	if rec.Mock {
		port := m.MockPort()
		if port == 0 {
			return nil, dialOutcome{}, errors.New("mock ssh target is not running")
		}
		target.Host, target.Port = "127.0.0.1", port
	}
	addr := net.JoinHostPort(target.Host, strconv.Itoa(target.Port))

	authMethods, err := m.authMethods(rec)
	if err != nil {
		return nil, dialOutcome{}, err
	}
	outcome := dialOutcome{host: rec.Host, port: rec.Port}
	var decisionErr error

	// Trust is keyed by the address the user configured, not the address the
	// daemon dialled: the mock fixture binds an ephemeral port that changes on
	// every restart, and a profile's identity must survive that.
	trustHost, trustPort := rec.Host, rec.Port
	hostKeyCallback := func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		fp := sshFingerprint(key.Marshal())
		outcome.fingerprint = fp
		outcome.keyType = key.Type()
		known, exists := m.srv.store.KnownHost(hostID(trustHost, trustPort))
		switch {
		case !exists:
			outcome.hostKeyState = "unknown"
			if acceptHostKey && (fingerprint == "" || fingerprint == fp) {
				if err := m.trustHost(trustHost, trustPort, key, fp, rec.Mock); err != nil {
					decisionErr = err
					return err
				}
				outcome.hostKeyState = "trusted"
				return nil
			}
			m.rememberPending(trustHost, trustPort, key, fp)
			decisionErr = errHostKeyUnknown
			return errHostKeyUnknown
		case known.Fingerprint != fp:
			outcome.hostKeyState = "mismatch"
			decisionErr = errHostKeyMismatch
			return errHostKeyMismatch
		default:
			outcome.hostKeyState = "trusted"
			return nil
		}
	}

	cfg := &ssh.ClientConfig{
		User:            target.User,
		Auth:            authMethods,
		HostKeyCallback: hostKeyCallback,
		Timeout:         10 * time.Second,
	}
	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		if decisionErr != nil {
			return nil, outcome, decisionErr
		}
		return nil, outcome, fmt.Errorf("dial %s: %w", addr, err)
	}
	return client, outcome, nil
}

func (m *SSHManager) authMethods(rec ProfileRecord) ([]ssh.AuthMethod, error) {
	var methods []ssh.AuthMethod
	switch rec.AuthKind {
	case "password":
		password, err := m.srv.secrets.Open(rec.PasswordCipher, rec.ID+"/password")
		if err != nil {
			return nil, err
		}
		if password == "" {
			return nil, errors.New("profile has no stored password")
		}
		methods = append(methods, ssh.Password(password))
	case "key":
		raw, err := m.srv.secrets.Open(rec.KeyCipher, rec.ID+"/key")
		if err != nil {
			return nil, err
		}
		if raw == "" {
			return nil, errors.New("profile has no stored private key")
		}
		signer, err := ssh.ParsePrivateKey([]byte(raw))
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		methods = append(methods, ssh.PublicKeys(signer))
		if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
			if signers, agentErr := sshAgentSigners(sock); agentErr == nil && len(signers) > 0 {
				methods = append(methods, ssh.PublicKeys(signers...))
			}
		}
	case "none":
		// Some appliances allow none-auth; OpenSSH clients trial it implicitly.
	}
	if len(methods) == 0 {
		return nil, errors.New("no usable authentication method")
	}
	return methods, nil
}

func (m *SSHManager) rememberPending(host string, port int, key ssh.PublicKey, fp string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := hostID(host, port)
	m.pending[id] = pendingHostKey{
		ID: id, Host: host, Port: port, Fingerprint: fp,
		KeyType: key.Type(), CreatedAt: time.Now(),
	}
	// Bound memory: keep at most 32 pending decisions.
	if len(m.pending) > 32 {
		for k := range m.pending {
			delete(m.pending, k)
			break
		}
	}
}

func (m *SSHManager) trustHost(host string, port int, key ssh.PublicKey, fp string, mock bool) error {
	rec := KnownHostRecord{
		ID: hostID(host, port), Host: host, Port: port, KeyType: key.Type(),
		Fingerprint: fp, AddedAt: time.Now().UTC().Format(time.RFC3339), Mock: mock,
	}
	if err := m.srv.store.UpsertKnownHost(rec); err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.pending, rec.ID)
	m.mu.Unlock()
	return nil
}

// probe reports reachability and host-key state without opening a shell.
func (m *SSHManager) probe(rec ProfileRecord) testResult {
	started := time.Now()
	client, outcome, err := m.dial(rec, false, "")
	result := testResult{Mock: rec.Mock, LatencyMs: time.Since(started).Milliseconds(), Fingerprint: outcome.fingerprint, HostKeyState: outcome.hostKeyState}
	if result.HostKeyState == "" {
		result.HostKeyState = "unknown"
	}
	if err == nil {
		_ = client.Close()
		result.Reachable = true
		result.Authenticated = true
		result.Message = "handshake and authentication succeeded"
		return result
	}
	result.Message = err.Error()
	if errors.Is(err, errHostKeyUnknown) || errors.Is(err, errHostKeyMismatch) {
		result.Reachable = true
		return result
	}
	return result
}

// remoteRW adapts an SSH session channel to the io.ReadWriteCloser the pump uses.
type remoteRW struct {
	reader  io.Reader
	writer  io.Writer
	session *ssh.Session
	client  *ssh.Client
	once    sync.Once
}

func (r *remoteRW) Read(p []byte) (int, error)  { return r.reader.Read(p) }
func (r *remoteRW) Write(p []byte) (int, error) { return r.writer.Write(p) }

func (r *remoteRW) Close() error {
	var err error
	r.once.Do(func() {
		_ = r.session.Close()
		err = r.client.Close()
	})
	return err
}
