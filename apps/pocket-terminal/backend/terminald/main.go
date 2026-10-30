// terminald is the Pocket Terminal daemon. It owns every privileged surface the
// UI needs: PTY-backed shell sessions, the SSH engine, log streaming, host
// diagnostics, PocketJS runtime inspection and allowlisted quick actions.
//
// The browser never touches the filesystem, /proc, journald or a shell; it only
// speaks JSON/WebSocket to this process.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	appName = "terminald"
	version = "0.1.0"
)

type config struct {
	addr           string
	dataDir        string
	token          string
	idleTimeout    time.Duration
	keepExited     time.Duration
	maxSessions    int
	allowControl   bool
	noMockSSH      bool
	allowedOrigins []string
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func defaultDataDir() string {
	if dir := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); dir != "" {
		return filepath.Join(dir, "pocket-terminal")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "pocket-terminal")
	}
	return filepath.Join(home, ".local", "share", "pocket-terminal")
}

func parseConfig(args []string) (config, error) {
	cfg := config{
		addr:        env("POCKET_TERMINAL_ADDR", "127.0.0.1:8795"),
		dataDir:     env("POCKET_TERMINAL_DATA", defaultDataDir()),
		token:       os.Getenv("POCKET_TERMINAL_TOKEN"),
		idleTimeout: 30 * time.Minute,
		keepExited:  10 * time.Minute,
		maxSessions: 8,
	}
	fs := flag.NewFlagSet(appName, flag.ContinueOnError)
	fs.StringVar(&cfg.addr, "addr", cfg.addr, "listen address (loopback by default)")
	fs.StringVar(&cfg.dataDir, "data", cfg.dataDir, "state directory")
	fs.BoolVar(&cfg.allowControl, "allow-system-control", false, "enable allowlisted restart/reboot actions (default off)")
	fs.BoolVar(&cfg.noMockSSH, "no-mock-ssh", false, "disable the in-process mock SSH target")
	fs.DurationVar(&cfg.idleTimeout, "idle-timeout", cfg.idleTimeout, "close running sessions with no viewers after this idle period")
	fs.IntVar(&cfg.maxSessions, "max-sessions", cfg.maxSessions, "maximum concurrent terminal sessions")
	origins := fs.String("cors-origins", env("POCKET_TERMINAL_ORIGINS", ""), "extra comma-separated websocket origins")
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	for _, origin := range strings.Split(*origins, ",") {
		if trimmed := strings.TrimSpace(origin); trimmed != "" {
			cfg.allowedOrigins = append(cfg.allowedOrigins, trimmed)
		}
	}
	if cfg.maxSessions < 1 {
		cfg.maxSessions = 1
	}
	return cfg, nil
}

type server struct {
	cfg       config
	logger    *log.Logger
	store     *Store
	secrets   *SecretBox
	sessions  *SessionManager
	ssh       *SSHManager
	diag      *Diagnostics
	logs      *LogService
	runtime   *RuntimeInspector
	actions   *ActionService
	startedAt time.Time
}

func newServer(cfg config, logger *log.Logger) (*server, error) {
	if err := os.MkdirAll(cfg.dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	store, err := OpenStore(filepath.Join(cfg.dataDir, "state.json"))
	if err != nil {
		return nil, err
	}
	secrets, err := OpenSecretBox(cfg.dataDir)
	if err != nil {
		return nil, err
	}
	s := &server{
		cfg:       cfg,
		logger:    logger,
		store:     store,
		secrets:   secrets,
		startedAt: time.Now(),
	}
	s.sessions = NewSessionManager(cfg.maxSessions, cfg.idleTimeout, cfg.keepExited, logger)
	s.diag = NewDiagnostics()
	s.logs = NewLogService(logger)
	s.runtime = NewRuntimeInspector(s.startedAt)
	s.actions = NewActionService(s)
	s.ssh = NewSSHManager(s)
	if !cfg.noMockSSH {
		if err := s.ssh.StartMockTarget(); err != nil {
			logger.Printf("mock ssh target unavailable: %v", err)
		}
	}
	s.ssh.seedProfiles()
	return s, nil
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/meta", s.handleMeta)

	mux.HandleFunc("GET /api/terminal/shells", s.handleShells)
	mux.HandleFunc("GET /api/terminal/sessions", s.handleSessionList)
	mux.HandleFunc("POST /api/terminal/sessions", s.handleSessionCreate)
	mux.HandleFunc("GET /api/terminal/sessions/{id}", s.handleSessionGet)
	mux.HandleFunc("DELETE /api/terminal/sessions/{id}", s.handleSessionDelete)
	mux.HandleFunc("POST /api/terminal/sessions/{id}/resize", s.handleSessionResize)
	mux.HandleFunc("POST /api/terminal/sessions/{id}/input", s.handleSessionInput)
	mux.HandleFunc("GET /api/terminal/sessions/{id}/output", s.handleSessionOutput)
	mux.HandleFunc("GET /api/terminal/sessions/{id}/stream", s.handleSessionStream)

	mux.HandleFunc("GET /api/ssh/profiles", s.handleProfileList)
	mux.HandleFunc("POST /api/ssh/profiles", s.handleProfileCreate)
	mux.HandleFunc("PUT /api/ssh/profiles/{id}", s.handleProfileUpdate)
	mux.HandleFunc("DELETE /api/ssh/profiles/{id}", s.handleProfileDelete)
	mux.HandleFunc("POST /api/ssh/profiles/{id}/connect", s.handleProfileConnect)
	mux.HandleFunc("POST /api/ssh/profiles/{id}/test", s.handleProfileTest)
	mux.HandleFunc("GET /api/ssh/known-hosts", s.handleKnownHosts)
	mux.HandleFunc("DELETE /api/ssh/known-hosts/{id}", s.handleKnownHostDelete)

	mux.HandleFunc("GET /api/logs/sources", s.handleLogSources)
	mux.HandleFunc("GET /api/logs", s.handleLogQuery)
	mux.HandleFunc("GET /api/logs/stream", s.handleLogStream)
	mux.HandleFunc("POST /api/logs/export", s.handleLogExport)

	mux.HandleFunc("GET /api/diagnostics", s.handleDiagnostics)
	mux.HandleFunc("GET /api/runtime", s.handleRuntime)
	mux.HandleFunc("GET /api/runtime/processes", s.handleRuntimeProcesses)

	mux.HandleFunc("GET /api/actions", s.handleActionList)
	mux.HandleFunc("POST /api/actions/{id}", s.handleActionRun)

	mux.HandleFunc("GET /api/security", s.handleSecurity)

	return s.withMiddleware(mux)
}

func (s *server) withMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if r.Header.Get("Origin") != "" && r.Method == http.MethodOptions {
			writeCORS(w, r)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if s.cfg.token != "" && !strings.HasPrefix(r.URL.Path, "/api/health") {
			auth := r.Header.Get("Authorization")
			if auth != "Bearer "+s.cfg.token {
				writeError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid bearer token")
				return
			}
		}
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			if recovered := recover(); recovered != nil {
				s.logger.Printf("panic serving %s %s: %v", r.Method, r.URL.Path, recovered)
				writeError(w, http.StatusInternalServerError, "internal_error", "unexpected daemon error")
			}
			s.logger.Printf("%s %s %d %s", r.Method, r.URL.Path, recorder.status, time.Since(start).Round(time.Millisecond))
		}()
		next.ServeHTTP(recorder, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Flush() {
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Hijack forwards to the underlying writer so WebSocket upgrades work through
// the logging middleware.
func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("response writer does not support hijacking")
	}
	return hijacker.Hijack()
}

// Unwrap lets http.ResponseController find the original writer.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func main() {
	cfg, err := parseConfig(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	logger := log.New(os.Stdout, "", log.LstdFlags|log.Lmsgprefix)
	logger.SetPrefix("terminald ")
	srv, err := newServer(cfg, logger)
	if err != nil {
		logger.Fatalf("startup failed: %v", err)
	}
	defer srv.close()

	httpServer := &http.Server{
		Addr:              cfg.addr,
		Handler:           srv.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	logger.Printf("listening on http://%s (data=%s, mock-ssh=%v, control=%v)", cfg.addr, cfg.dataDir, !cfg.noMockSSH, cfg.allowControl)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Fatalf("server error: %v", err)
	}
}

func (s *server) close() {
	s.sessions.CloseAll()
	if s.ssh != nil {
		s.ssh.Close()
	}
	if s.store != nil {
		_ = s.store.Close()
	}
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"service":   appName,
		"version":   version,
		"uptime":    time.Since(s.startedAt).Round(time.Second).String(),
		"time":      time.Now().Format(time.RFC3339),
		"sessions":  s.sessions.Count(),
		"mock":      s.ssh.MockActive(),
		"dataStore": s.store.Kind(),
	})
}

func (s *server) handleMeta(w http.ResponseWriter, r *http.Request) {
	shells, defaultShell := detectShells(os.Getenv("SHELL"))
	writeJSON(w, http.StatusOK, map[string]any{
		"service":      appName,
		"version":      version,
		"startedAt":    s.startedAt.Format(time.RFC3339),
		"defaultShell": defaultShell,
		"shells":       shells,
		"capabilities": map[string]any{
			"pty":              true,
			"ssh":              true,
			"mockSSH":          s.ssh.MockActive(),
			"journald":         s.logs.JournaldAvailable(),
			"fileLogs":         true,
			"diagnostics":      true,
			"runtime":          true,
			"quickActions":     true,
			"systemControl":    s.cfg.allowControl,
			"terminalEmulator": "xterm.js (client-side rendering)",
		},
		"limits": map[string]any{
			"maxSessions": s.cfg.maxSessions,
			"idleTimeout": s.cfg.idleTimeout,
			"secrets":     s.secrets.Describe(),
		},
	})
}

func (s *server) handleSecurity(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"bindAddr":           s.cfg.addr,
		"authTokenRequired":  s.cfg.token != "",
		"allowSystemControl": s.cfg.allowControl,
		"secretStore":        s.secrets.Describe(),
		"knownHosts":         s.ssh.KnownHostCount(),
		"plaintextSecrets":   false,
	})
}

// writeJSON is the single JSON response boundary.
func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if payload == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("encode response: %v", err)
	}
}

type apiError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": apiError{Code: code, Message: message}})
}

func writeErrorDetails(w http.ResponseWriter, status int, code, message string, details map[string]any) {
	writeJSON(w, status, map[string]any{"error": apiError{Code: code, Message: message, Details: details}})
}

func writeCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

// writeSSEEvent is the shared server-sent-events writer.
func (s *server) writeSSEEvent(w io.Writer, flusher http.Flusher, event string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func decodeJSON(r *http.Request, target any) error {
	defer func() { _ = r.Body.Close() }()
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return nil
}
