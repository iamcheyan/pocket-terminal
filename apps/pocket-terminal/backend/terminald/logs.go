package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// LogService exposes journald and file logs. Everything is read-only: no log
// file is truncated, rotated or written by this daemon.
type LogService struct {
	logger  *log.Logger
	journal bool
	mu      sync.Mutex
}

func NewLogService(logger *log.Logger) *LogService {
	_, err := exec.LookPath("journalctl")
	return &LogService{logger: logger, journal: err == nil}
}

func (l *LogService) JournaldAvailable() bool { return l.journal }

type LogSource struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Available   bool   `json:"available"`
	Reason      string `json:"reason,omitempty"`
	SizeBytes   int64  `json:"sizeBytes,omitempty"`
	UpdatedAt   string `json:"updatedAt,omitempty"`
}

type LogEntry struct {
	ID       string         `json:"id"`
	Time     string         `json:"time"`
	Level    string         `json:"level"`
	Unit     string         `json:"unit,omitempty"`
	Message  string         `json:"message"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

func (l *LogService) Sources() []LogSource {
	sources := []LogSource{{
		ID: "journald", Kind: "journal", Label: "systemd journal",
		Description: "Structured host logs via journalctl (read-only).",
		Available:   l.journal, Reason: reasonIf(!l.journal, "journalctl is not installed"),
	}}
	candidates := []string{
		"/var/log/messages", "/var/log/syslog", "/var/log/auth.log", "/var/log/kern.log",
		"/var/log/daemon.log", "/var/log/pacman.log", "/var/log/Xorg.0.log",
		filepath.Join(os.Getenv("HOME"), ".local/state/terminald/terminald.log"),
	}
	for _, path := range candidates {
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		sources = append(sources, LogSource{
			ID: "file:" + path, Kind: "file", Label: filepath.Base(path),
			Description: path, Available: true, SizeBytes: info.Size(),
			UpdatedAt: info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	return sources
}

func reasonIf(cond bool, reason string) string {
	if cond {
		return reason
	}
	return ""
}

type logQuery struct {
	Source   string
	Unit     string
	Priority string
	Query    string
	Limit    int
	Level    string
}

func parseLogQuery(values map[string]string) (logQuery, error) {
	q := logQuery{
		Source:   firstNonEmpty(values["source"], "journald"),
		Unit:     values["unit"],
		Priority: values["priority"],
		Query:    values["q"],
		Limit:    clampInt(values["limit"], 200, 1, 5000),
		Level:    values["level"],
	}
	if strings.HasPrefix(q.Source, "file:") {
		path := strings.TrimPrefix(q.Source, "file:")
		if !logFileAllowed(path) {
			return q, fmt.Errorf("log file is outside the allowlist")
		}
	} else if q.Source != "journald" {
		return q, fmt.Errorf("unknown source")
	}
	switch q.Priority {
	case "", "emerg", "alert", "crit", "err", "warning", "notice", "info", "debug":
	default:
		return q, fmt.Errorf("invalid priority")
	}
	return q, nil
}

// logFileAllowed keeps the file-backed source to predictable locations so the
// API cannot be used as an arbitrary file reader.
func logFileAllowed(path string) bool {
	clean := filepath.Clean(path)
	roots := []string{"/var/log", filepath.Join(os.Getenv("HOME"), ".local/state"), filepath.Join(defaultDataDir(), "logs")}
	for _, root := range roots {
		if strings.HasPrefix(clean, root+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

func (l *LogService) Query(ctx context.Context, q logQuery) ([]LogEntry, error) {
	if strings.HasPrefix(q.Source, "file:") {
		return queryFileLog(ctx, strings.TrimPrefix(q.Source, "file:"), q)
	}
	return l.queryJournal(ctx, q)
}

func (l *LogService) queryJournal(ctx context.Context, q logQuery) ([]LogEntry, error) {
	if !l.journal {
		return nil, fmt.Errorf("journald is unavailable on this host")
	}
	args := []string{"--no-pager", "-o", "json", "-n", strconv.Itoa(q.Limit), "--output-fields=__REALTIME_TIMESTAMP,PRIORITY,MESSAGE,SYSLOG_IDENTIFIER,_SYSTEMD_UNIT,_PID,_HOSTNAME"}
	if q.Unit != "" {
		args = append(args, "-u", q.Unit)
	}
	if q.Priority != "" {
		args = append(args, "-p", q.Priority)
	}
	if q.Query != "" {
		args = append(args, "--grep", q.Query)
	}
	runCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "journalctl", args...)
	cmd.Env = append(os.Environ(), "SYSTEMD_COLORS=0", "LC_ALL=C", "SYSTEMD_PAGER=")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	entries := make([]LogEntry, 0, q.Limit)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	for scanner.Scan() {
		entry, ok := parseJournalLine(scanner.Bytes())
		if ok && levelMatches(entry.Level, q.Level) {
			entries = append(entries, entry)
		}
	}
	_ = cmd.Wait()
	return entries, nil
}

var journalPriority = map[string]string{
	"0": "emerg", "1": "alert", "2": "crit", "3": "error", "4": "warning",
	"5": "notice", "6": "info", "7": "debug",
}

func parseJournalLine(raw []byte) (LogEntry, bool) {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return LogEntry{}, false
	}
	asString := func(key string) string {
		switch value := payload[key].(type) {
		case string:
			return value
		case float64:
			return strconv.FormatFloat(value, 'f', -1, 64)
		}
		return ""
	}
	entry := LogEntry{
		Time:    journalTime(asString("__REALTIME_TIMESTAMP")),
		Level:   journalPriority[asString("PRIORITY")],
		Unit:    firstNonEmpty(asString("_SYSTEMD_UNIT"), asString("SYSLOG_IDENTIFIER")),
		Message: asString("MESSAGE"),
	}
	if entry.Level == "" {
		entry.Level = "info"
	}
	if entry.Message == "" {
		return entry, false
	}
	metadata := map[string]any{}
	for _, key := range []string{"_PID", "_HOSTNAME", "SYSLOG_IDENTIFIER"} {
		if value := asString(key); value != "" {
			metadata[key] = value
		}
	}
	if len(metadata) > 0 {
		entry.Metadata = metadata
	}
	entry.ID = hashID(entry.Time + entry.Unit + entry.Message)
	return entry, true
}

func journalTime(microseconds string) string {
	value, err := strconv.ParseInt(microseconds, 10, 64)
	if err != nil {
		return time.Now().UTC().Format(time.RFC3339)
	}
	return time.UnixMicro(value).UTC().Format(time.RFC3339)
}

func queryFileLog(ctx context.Context, path string, q logQuery) ([]LogEntry, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("source is a directory")
	}
	const tailWindow = 512 * 1024
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	start := int64(0)
	if info.Size() > tailWindow {
		start = info.Size() - tailWindow
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	entries := make([]LogEntry, 0, q.Limit)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	if start > 0 {
		// Drop the first partial line after seeking mid-file.
		scanner.Scan()
	}
	pattern, _ := regexp.Compile("(?i)" + regexp.QuoteMeta(q.Query))
	for scanner.Scan() {
		if ctx.Err() != nil {
			break
		}
		line := scanner.Text()
		if q.Query != "" && !pattern.MatchString(line) {
			continue
		}
		entry := parsePlainLine(line)
		if !levelMatches(entry.Level, q.Level) {
			continue
		}
		entries = append(entries, entry)
	}
	if len(entries) > q.Limit {
		entries = entries[len(entries)-q.Limit:]
	}
	return entries, nil
}

var levelPattern = regexp.MustCompile(`(?i)\b(emerg|alert|crit|error|err|warn|warning|notice|debug|info)\b`)

func parsePlainLine(line string) LogEntry {
	entry := LogEntry{Message: line, Level: "info"}
	if len(line) >= 19 {
		if _, err := time.Parse("2006-01-02T15:04:05", line[:19]); err == nil {
			entry.Time = line[:19] + "Z"
			entry.Message = strings.TrimSpace(line[19:])
		}
	}
	if match := levelPattern.FindStringSubmatch(line); match != nil {
		entry.Level = normalizeLevel(match[1])
	}
	if entry.Time == "" {
		entry.Time = time.Now().UTC().Format(time.RFC3339)
	}
	entry.ID = hashID(entry.Time + line)
	return entry
}

func normalizeLevel(value string) string {
	switch strings.ToLower(value) {
	case "emerg":
		return "emerg"
	case "alert":
		return "alert"
	case "crit":
		return "crit"
	case "err", "error":
		return "error"
	case "warn", "warning":
		return "warning"
	case "notice":
		return "notice"
	case "debug":
		return "debug"
	default:
		return "info"
	}
}

func levelMatches(level, filter string) bool {
	if filter == "" || filter == "all" {
		return true
	}
	return normalizeLevel(level) == normalizeLevel(filter)
}

func (s *server) handleLogSources(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"sources": s.logs.Sources(),
		"levels":  []string{"emerg", "alert", "crit", "error", "warning", "notice", "info", "debug"},
	})
}

func (s *server) handleLogQuery(w http.ResponseWriter, r *http.Request) {
	values := map[string]string{}
	for key := range r.URL.Query() {
		values[key] = r.URL.Query().Get(key)
	}
	q, err := parseLogQuery(values)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}
	started := time.Now()
	entries, err := s.logs.Query(r.Context(), q)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "log_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"source": q.Source, "entries": entries, "count": len(entries),
		"durationMs": time.Since(started).Milliseconds(),
	})
}

// handleLogStream pushes new entries as server-sent events. File sources use
// polling (portable, no inotify dependency); journald uses `journalctl -f`.
func (s *server) handleLogStream(w http.ResponseWriter, r *http.Request) {
	values := map[string]string{}
	for key := range r.URL.Query() {
		values[key] = r.URL.Query().Get(key)
	}
	q, err := parseLogQuery(values)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "stream_unsupported", "streaming is not available")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	_ = s.writeSSEEvent(w, flusher, "hello", map[string]any{"source": q.Source, "at": time.Now().UTC().Format(time.RFC3339)})

	initial, err := s.logs.Query(r.Context(), q)
	if err != nil {
		_ = s.writeSSEEvent(w, flusher, "error", map[string]any{"message": err.Error()})
		return
	}
	seen := map[string]bool{}
	for _, entry := range initial {
		seen[entry.ID] = true
	}
	_ = s.writeSSEEvent(w, flusher, "batch", map[string]any{"entries": initial})

	ticker := time.NewTicker(1500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			entries, err := s.logs.Query(r.Context(), q)
			if err != nil {
				_ = s.writeSSEEvent(w, flusher, "error", map[string]any{"message": err.Error()})
				return
			}
			fresh := make([]LogEntry, 0, 32)
			for _, entry := range entries {
				if !seen[entry.ID] {
					seen[entry.ID] = true
					fresh = append(fresh, entry)
				}
			}
			if len(fresh) == 0 {
				if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
					return
				}
				flusher.Flush()
				continue
			}
			if len(seen) > 4000 {
				seen = map[string]bool{}
				for _, entry := range entries {
					seen[entry.ID] = true
				}
			}
			if err := s.writeSSEEvent(w, flusher, "batch", map[string]any{"entries": fresh}); err != nil {
				return
			}
		}
	}
}

// handleLogExport returns the filtered log window as a downloadable text file.
// Nothing is written to host storage; the browser saves the response.
func (s *server) handleLogExport(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Source   string `json:"source"`
		Unit     string `json:"unit"`
		Priority string `json:"priority"`
		Query    string `json:"q"`
		Level    string `json:"level"`
		Limit    string `json:"limit"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	q, err := parseLogQuery(map[string]string{
		"source": req.Source, "unit": req.Unit, "priority": req.Priority,
		"q": req.Query, "level": req.Level, "limit": firstNonEmpty(req.Limit, "2000"),
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	entries, err := s.logs.Query(ctx, q)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "log_unavailable", err.Error())
		return
	}
	label := strings.NewReplacer("/", "-", ":", "").Replace(q.Source)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="pocket-terminal-%s-%s.log"`, label, time.Now().Format("20060102-150405")))
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, "# Pocket Terminal log export\n# source=%s unit=%s level=%s query=%s\n# exported=%s entries=%d\n",
		q.Source, q.Unit, q.Level, q.Query, time.Now().UTC().Format(time.RFC3339), len(entries))
	for _, entry := range entries {
		_, _ = fmt.Fprintf(w, "%s %-7s %-18s %s\n", entry.Time, strings.ToUpper(entry.Level), entry.Unit, entry.Message)
	}
}
