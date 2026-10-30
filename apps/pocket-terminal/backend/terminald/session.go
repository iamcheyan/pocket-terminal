package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// shellCandidate describes a shell binary the daemon may spawn. Paths are
// resolved from the real filesystem so the API never exposes a non-existent
// candidate.
type shellCandidate struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Default bool   `json:"default"`
}

var shellSpecs = []struct {
	id, name, binary string
}{
	{"bash", "Bash", "bash"},
	{"zsh", "Zsh", "zsh"},
	{"fish", "Fish", "fish"},
	{"sh", "POSIX sh", "sh"},
}

// detectShells prefers $SHELL, then PATH lookups, then the first shell that
// exists.
func detectShells(userShell string) ([]shellCandidate, string) {
	seen := map[string]bool{}
	var out []shellCandidate
	add := func(id, name, path string, isDefault bool) {
		if path == "" || seen[path] {
			return
		}
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			return
		}
		seen[path] = true
		out = append(out, shellCandidate{ID: id, Name: name, Path: path, Default: isDefault})
	}
	defaultID := ""
	if userShell != "" {
		if abs, err := filepath.Abs(userShell); err == nil {
			base := filepath.Base(abs)
			for _, spec := range shellSpecs {
				if base == spec.binary {
					add(spec.id, spec.name, abs, true)
					defaultID = spec.id
					break
				}
			}
			if defaultID == "" {
				id := strings.TrimSuffix(base, ".exe")
				add(id, base, abs, true)
				defaultID = id
			}
		}
	}
	for _, spec := range shellSpecs {
		path, err := exec.LookPath(spec.binary)
		if err != nil {
			continue
		}
		add(spec.id, spec.name, path, defaultID == "")
		if defaultID == "" {
			defaultID = spec.id
		}
	}
	return out, defaultID
}

type sessionState string

const (
	sessionRunning sessionState = "running"
	sessionExited  sessionState = "exited"
	sessionClosed  sessionState = "closed"
)

// Session is one terminal process (local PTY or SSH channel) plus a bounded
// scrollback ring. The UI attaches with an offset cursor, so reconnects replay
// only what it missed.
type Session struct {
	ID        string       `json:"id"`
	Title     string       `json:"title"`
	Shell     string       `json:"shell"`
	ShellID   string       `json:"shellId"`
	Cwd       string       `json:"cwd"`
	Kind      string       `json:"kind"`
	TabsGroup string       `json:"tabsGroup"`
	ProfileID string       `json:"profileId,omitempty"`
	Mock      bool         `json:"mock"`
	State     sessionState `json:"state"`
	CreatedAt time.Time    `json:"createdAt"`
	ExitCode  *int         `json:"exitCode,omitempty"`
	Rows      uint16       `json:"rows"`
	Cols      uint16       `json:"cols"`

	rw       io.ReadWriteCloser
	resizeFn func(cols, rows uint16) error
	cmd      *exec.Cmd

	mu       sync.Mutex
	buffer   *ringBuffer
	waiters  map[chan struct{}]struct{}
	closedCh chan struct{}
	lastView time.Time
}

func (s *Session) notify() {
	s.mu.Lock()
	waiters := make([]chan struct{}, 0, len(s.waiters))
	for ch := range s.waiters {
		waiters = append(waiters, ch)
	}
	s.mu.Unlock()
	for _, ch := range waiters {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (s *Session) subscribe() (chan struct{}, func()) {
	ch := make(chan struct{}, 1)
	s.mu.Lock()
	if s.waiters == nil {
		s.waiters = map[chan struct{}]struct{}{}
	}
	s.waiters[ch] = struct{}{}
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		delete(s.waiters, ch)
		s.mu.Unlock()
	}
}

// Output returns bytes from the scrollback at and after offset.
func (s *Session) Output(offset int) ([]byte, int) { return s.buffer.Since(offset) }

func (s *Session) TotalBytes() int { return s.buffer.Total() }

// WriteInput sends raw terminal input to the process.
func (s *Session) WriteInput(data []byte) error {
	s.mu.Lock()
	rw, running := s.rw, s.State == sessionRunning
	s.mu.Unlock()
	if !running || rw == nil {
		return errors.New("session is not running")
	}
	_, err := rw.Write(data)
	return err
}

// Resize applies a new window size, remembering it for reconnects.
func (s *Session) Resize(cols, rows uint16) error {
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	s.mu.Lock()
	s.Cols, s.Rows = cols, rows
	fn, running := s.resizeFn, s.State == sessionRunning
	s.mu.Unlock()
	if !running || fn == nil {
		return nil
	}
	return fn(cols, rows)
}

// Close terminates the process group and releases the terminal.
func (s *Session) Close() {
	s.mu.Lock()
	if s.State == sessionClosed {
		s.mu.Unlock()
		return
	}
	prev := s.State
	s.State = sessionClosed
	cmd, rw, closed := s.cmd, s.rw, s.closedCh
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil && prev == sessionRunning {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
		go func() {
			time.Sleep(1500 * time.Millisecond)
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}()
	}
	if rw != nil {
		_ = rw.Close()
	}
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
	}
	s.notify()
}

func (s *Session) setExited(code int) {
	s.mu.Lock()
	if s.State == sessionClosed {
		s.mu.Unlock()
		return
	}
	s.State = sessionExited
	s.ExitCode = &code
	close(s.closedCh)
	rw := s.rw
	s.rw = nil
	s.mu.Unlock()
	if rw != nil {
		_ = rw.Close()
	}
	s.notify()
}

// SessionDTO is the JSON view of a session. File descriptors and addresses
// never cross the API boundary.
type SessionDTO struct {
	ID        string       `json:"id"`
	Title     string       `json:"title"`
	Shell     string       `json:"shell"`
	ShellID   string       `json:"shellId"`
	Cwd       string       `json:"cwd"`
	Kind      string       `json:"kind"`
	TabsGroup string       `json:"tabsGroup"`
	ProfileID string       `json:"profileId,omitempty"`
	Mock      bool         `json:"mock"`
	State     sessionState `json:"state"`
	CreatedAt string       `json:"createdAt"`
	ExitCode  *int         `json:"exitCode,omitempty"`
	Rows      uint16       `json:"rows"`
	Cols      uint16       `json:"cols"`
	Bytes     int          `json:"bytes"`
}

func (s *Session) DTO() SessionDTO {
	s.mu.Lock()
	defer s.mu.Unlock()
	return SessionDTO{
		ID: s.ID, Title: s.Title, Shell: s.Shell, ShellID: s.ShellID, Cwd: s.Cwd,
		Kind: s.Kind, TabsGroup: s.TabsGroup, ProfileID: s.ProfileID, Mock: s.Mock,
		State: s.State, CreatedAt: s.CreatedAt.UTC().Format(time.RFC3339),
		ExitCode: s.ExitCode, Rows: s.Rows, Cols: s.Cols, Bytes: s.buffer.Total(),
	}
}

// SessionManager owns lifecycle: create, attach, resize, detach, reap.
type SessionManager struct {
	mu          sync.RWMutex
	sessions    map[string]*Session
	max         int
	idleTimeout time.Duration
	keepExited  time.Duration
	logger      *log.Logger
	stopReaper  chan struct{}
	stopOnce    sync.Once
}

func NewSessionManager(max int, idleTimeout, keepExited time.Duration, logger *log.Logger) *SessionManager {
	m := &SessionManager{
		sessions:    map[string]*Session{},
		max:         max,
		idleTimeout: idleTimeout,
		keepExited:  keepExited,
		logger:      logger,
		stopReaper:  make(chan struct{}),
	}
	go m.reaper()
	return m
}

func (m *SessionManager) reaper() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.stopReaper:
			return
		case <-ticker.C:
			m.reap()
		}
	}
}

func (m *SessionManager) reap() {
	now := time.Now()
	m.mu.Lock()
	var doomed []*Session
	for id, s := range m.sessions {
		s.mu.Lock()
		state, last := s.State, s.lastView
		s.mu.Unlock()
		if state == sessionRunning && now.Sub(last) > m.idleTimeout {
			doomed = append(doomed, s)
			delete(m.sessions, id)
			continue
		}
		if state != sessionRunning && now.Sub(last) > m.keepExited {
			doomed = append(doomed, s)
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()
	for _, s := range doomed {
		m.logger.Printf("reap session %s", s.ID)
		s.Close()
	}
}

func (m *SessionManager) CloseAll() {
	m.stopOnce.Do(func() { close(m.stopReaper) })
	m.mu.Lock()
	all := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.sessions = map[string]*Session{}
	m.mu.Unlock()
	for _, s := range all {
		s.Close()
	}
}

func (m *SessionManager) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.sessions)
}

func (m *SessionManager) List() []SessionDTO {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]SessionDTO, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s.DTO())
	}
	return out
}

// Get marks the session recently viewed, feeding the idle reaper.
func (m *SessionManager) Get(id string) (*Session, bool) {
	m.mu.RLock()
	s, ok := m.sessions[id]
	m.mu.RUnlock()
	if ok {
		s.mu.Lock()
		s.lastView = time.Now()
		s.mu.Unlock()
	}
	return s, ok
}

type createRequest struct {
	Shell     string `json:"shell"`
	Cols      uint16 `json:"cols"`
	Rows      uint16 `json:"rows"`
	Title     string `json:"title"`
	TabsGroup string `json:"tabsGroup"`
	Cwd       string `json:"cwd"`
	Kind      string `json:"kind"`
	ProfileID string `json:"profileId"`
	Mock      bool   `json:"mock"`
}

// Create spawns a login shell in a fresh PTY.
func (m *SessionManager) Create(req createRequest) (*Session, error) {
	if m.Count() >= m.max {
		return nil, errTooManySessions
	}
	shellPath, shellID, err := resolveShell(req.Shell)
	if err != nil {
		return nil, err
	}
	cols, rows := req.Cols, req.Rows
	if cols == 0 {
		cols = 100
	}
	if rows == 0 {
		rows = 28
	}
	kind := firstNonEmpty(req.Kind, "local")
	if kind == "local" && req.Cwd != "" {
		info, statErr := os.Stat(req.Cwd)
		if statErr != nil || !info.IsDir() {
			return nil, errInvalidCwd
		}
	}

	cmd := newShellCommand(shellPath, req.Cwd)
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, fmt.Errorf("start pty: %w", err)
	}
	created := time.Now()
	session := &Session{
		Title:     firstNonEmpty(req.Title, shellID+" shell"),
		Shell:     shellPath,
		ShellID:   shellID,
		Cwd:       req.Cwd,
		Kind:      kind,
		TabsGroup: firstNonEmpty(req.TabsGroup, "main"),
		ProfileID: req.ProfileID,
		Mock:      req.Mock,
		State:     sessionRunning,
		CreatedAt: created,
		Rows:      rows,
		Cols:      cols,
		rw:        ptmx,
		cmd:       cmd,
		buffer:    newRingBuffer(512 * 1024),
		waiters:   map[chan struct{}]struct{}{},
		closedCh:  make(chan struct{}),
		resizeFn: func(cols, rows uint16) error {
			return pty.Setsize(ptmx, &pty.Winsize{Cols: cols, Rows: rows})
		},
	}
	m.register(session)
	go m.pump(session)
	go func() {
		code := waitExitCode(cmd.Wait())
		session.setExited(code)
	}()
	return session, nil
}

// adopt registers a pre-built session (used by the SSH engine).
func (m *SessionManager) adopt(session *Session) *Session {
	session.ID = newID("s")
	session.CreatedAt = time.Now()
	session.closedCh = make(chan struct{})
	m.register(session)
	go m.pump(session)
	return session
}

func (m *SessionManager) register(session *Session) {
	if session.ID == "" {
		session.ID = newID("s")
	}
	session.lastView = time.Now()
	m.mu.Lock()
	m.sessions[session.ID] = session
	m.mu.Unlock()
}

func newShellCommand(shellPath, cwd string) *exec.Cmd {
	cmd := exec.Command(shellPath, "-l")
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor", "POCKET_TERMINAL=1")
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd
}

func waitExitCode(err error) int {
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode()
	}
	return 0
}

func (m *SessionManager) pump(s *Session) {
	s.mu.Lock()
	rw := s.rw
	s.mu.Unlock()
	if rw == nil {
		return
	}
	buf := make([]byte, 32*1024)
	for {
		n, err := rw.Read(buf)
		if n > 0 {
			s.buffer.Write(buf[:n])
			s.notify()
		}
		if err != nil {
			return
		}
	}
}

func (m *SessionManager) Remove(id string) bool {
	m.mu.Lock()
	s, ok := m.sessions[id]
	if ok {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
	if ok {
		s.Close()
	}
	return ok
}

func resolveShell(requested string) (path, id string, err error) {
	shells, defaultID := detectShells(os.Getenv("SHELL"))
	for _, candidate := range shells {
		if requested == "" || requested == candidate.ID || requested == candidate.Path {
			return candidate.Path, candidate.ID, nil
		}
	}
	if requested == "" && len(shells) > 0 {
		return shells[0].Path, defaultID, nil
	}
	return "", "", errUnknownShell
}

var (
	errTooManySessions = errors.New("session limit reached")
	errUnknownShell    = errors.New("unknown shell")
	errInvalidCwd      = errors.New("invalid working directory")
)

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// --- HTTP handlers -------------------------------------------------------

func (s *server) handleShells(w http.ResponseWriter, r *http.Request) {
	shells, defaultID := detectShells(os.Getenv("SHELL"))
	writeJSON(w, http.StatusOK, map[string]any{"shells": shells, "defaultShell": defaultID, "userShell": os.Getenv("SHELL")})
}

func (s *server) handleSessionList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"sessions": s.sessions.List(), "max": s.cfg.maxSessions})
}

func (s *server) handleSessionCreate(w http.ResponseWriter, r *http.Request) {
	var req createRequest
	if r.ContentLength > 0 {
		if err := decodeJSON(r, &req); err != nil && !errors.Is(err, io.EOF) {
			writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
			return
		}
	}
	session, err := s.sessions.Create(req)
	if err != nil {
		switch {
		case errors.Is(err, errUnknownShell), errors.Is(err, errInvalidCwd):
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		case errors.Is(err, errTooManySessions):
			writeError(w, http.StatusConflict, "session_limit", err.Error())
		default:
			writeError(w, http.StatusInternalServerError, "session_create_failed", err.Error())
		}
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"session": session.DTO(), "transport": "ws"})
}

func (s *server) handleSessionGet(w http.ResponseWriter, r *http.Request) {
	session, ok := s.sessions.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": session.DTO()})
}

func (s *server) handleSessionDelete(w http.ResponseWriter, r *http.Request) {
	if !s.sessions.Remove(r.PathValue("id")) {
		writeError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"closed": true})
}

func (s *server) handleSessionResize(w http.ResponseWriter, r *http.Request) {
	session, ok := s.sessions.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}
	var req struct {
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if err := session.Resize(req.Cols, req.Rows); err != nil {
		writeError(w, http.StatusBadRequest, "resize_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": session.DTO()})
}

func (s *server) handleSessionInput(w http.ResponseWriter, r *http.Request) {
	session, ok := s.sessions.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}
	var req struct {
		Data string `json:"data"`
	}
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if err := session.WriteInput([]byte(req.Data)); err != nil {
		writeError(w, http.StatusConflict, "session_not_running", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"accepted": len(req.Data)})
}

// handleSessionOutput is the polling fallback for clients without WebSocket.
func (s *server) handleSessionOutput(w http.ResponseWriter, r *http.Request) {
	session, ok := s.sessions.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}
	data, next := session.Output(parseOffset(r.URL.Query().Get("offset")))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Offset", itoa(next))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func parseOffset(raw string) int {
	var offset int
	_, _ = fmt.Sscanf(raw, "%d", &offset)
	if offset < 0 {
		offset = 0
	}
	return offset
}

// handleSessionStream serves the WebSocket transport.
func (s *server) handleSessionStream(w http.ResponseWriter, r *http.Request) {
	session, ok := s.sessions.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}
	s.serveSessionWebsocket(w, r, session)
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any) bool {
	if r.Body == nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "request body required")
		return false
	}
	defer func() { _ = r.Body.Close() }()
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return false
	}
	return true
}

// --- ring buffer ---------------------------------------------------------

// ringBuffer is a fixed-capacity byte ring tracking a monotonic total offset,
// so a client can resume from any prior offset.
type ringBuffer struct {
	mu    sync.Mutex
	data  []byte
	head  int
	size  int
	total int
}

func newRingBuffer(capacity int) *ringBuffer {
	return &ringBuffer{data: make([]byte, capacity)}
}

func (r *ringBuffer) Write(p []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	capacity := len(r.data)
	if len(p) > capacity {
		p = p[len(p)-capacity:]
	}
	r.total += len(p)
	r.size += len(p)
	if r.size > capacity {
		r.size = capacity
	}
	for _, b := range p {
		r.data[r.head] = b
		r.head = (r.head + 1) % capacity
	}
}

func (r *ringBuffer) Total() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.total
}

// Since returns bytes available at or after offset plus the next offset.
func (r *ringBuffer) Since(offset int) ([]byte, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	capacity := len(r.data)
	oldest := r.total - r.size
	if offset < oldest {
		offset = oldest
	}
	if offset > r.total {
		offset = r.total
	}
	count := r.total - offset
	out := make([]byte, 0, count)
	start := (r.head - r.size + (offset - oldest)) % capacity
	if start < 0 {
		start += capacity
	}
	for i := range count {
		out = append(out, r.data[(start+i)%capacity])
	}
	return out, r.total
}
