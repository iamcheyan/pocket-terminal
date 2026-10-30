package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RuntimeInspector answers "what is this device actually running?" without
// shelling out per request: it caches the report and refreshes on demand.
//
// PocketJS app surfaces are discovered from the same filesystem layout the
// launcher uses (apps/<id>/); each entry is reported with the evidence path so
// the UI never claims a runtime it cannot substantiate.
type RuntimeInspector struct {
	startedAt time.Time
	mu        sync.RWMutex
	lastDiag  *DiagnosticsReport
	seenAt    time.Time

	appsRootsOnce sync.Once
	appsRoots     []string
}

func NewRuntimeInspector(startedAt time.Time) *RuntimeInspector {
	return &RuntimeInspector{startedAt: startedAt}
}

func (r *RuntimeInspector) RecordDiagnostics(report DiagnosticsReport) {
	r.mu.Lock()
	r.lastDiag = &report
	r.seenAt = time.Now()
	r.mu.Unlock()
}

type RuntimeApp struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	HasPackage bool   `json:"hasPackage"`
	HasDist    bool   `json:"hasDist"`
	UpdatedAt  string `json:"updatedAt,omitempty"`
	Mock       bool   `json:"mock"`
}

type RuntimeReport struct {
	GeneratedAt string         `json:"generatedAt"`
	Daemon      map[string]any `json:"daemon"`
	Go          map[string]any `json:"go"`
	Process     map[string]any `json:"process"`
	Host        map[string]any `json:"host"`
	AppsRoots   []string       `json:"appsRoots"`
	Apps        []RuntimeApp   `json:"apps"`
	Bridges     []BridgeInfo   `json:"bridges"`
	Health      map[string]any `json:"health"`
	Notes       []string       `json:"notes"`
}

type BridgeInfo struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	BaseURL     string `json:"baseUrl"`
	Reachable   bool   `json:"reachable"`
	LatencyMs   int64  `json:"latencyMs"`
	Mock        bool   `json:"mock"`
	Description string `json:"description"`
}

// candidateBridges are sibling PJOS daemons; probing them is the runtime view
// of "which services back this console right now".
var candidateBridges = []struct {
	id, label, url, description string
}{
	{"launcherd", "Launcher", "http://127.0.0.1:8788/api/health", "Pocket Launcher backend"},
	{"filesd", "Files", "http://127.0.0.1:8787/api/health", "Pocket Files backend"},
	{"settingsd", "Settings", "http://127.0.0.1:8090/api/health", "Pocket Settings backend"},
	{"terminald", "Terminal", "http://127.0.0.1:8795/api/health", "This daemon"},
}

func (r *RuntimeInspector) appsRootsFor() []string {
	r.appsRootsOnce.Do(func() {
		candidates := []string{
			filepath.Join(os.Getenv("HOME"), "development"),
			filepath.Join(os.Getenv("HOME"), ".local/share/pocket"),
			"/opt/pocket/apps",
			"/usr/share/pocket/apps",
		}
		for _, root := range candidates {
			if info, err := os.Stat(root); err == nil && info.IsDir() {
				r.appsRoots = append(r.appsRoots, root)
			}
		}
	})
	return r.appsRoots
}

func (r *RuntimeInspector) discoverApps() []RuntimeApp {
	var apps []RuntimeApp
	seen := map[string]bool{}
	for _, root := range r.appsRootsFor() {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "pocket-") {
				continue
			}
			if seen[entry.Name()] {
				continue
			}
			path := filepath.Join(root, entry.Name())
			info, err := entry.Info()
			if err != nil {
				continue
			}
			app := RuntimeApp{
				ID: entry.Name(), Name: strings.TrimPrefix(entry.Name(), "pocket-"), Path: path, Kind: "pocketjs",
				UpdatedAt: info.ModTime().UTC().Format(time.RFC3339),
			}
			if _, err := os.Stat(filepath.Join(path, "package.json")); err == nil {
				app.HasPackage = true
			}
			if _, err := os.Stat(filepath.Join(path, "dist")); err == nil {
				app.HasDist = true
			}
			seen[entry.Name()] = true
			apps = append(apps, app)
		}
	}
	sort.Slice(apps, func(i, j int) bool { return apps[i].ID < apps[j].ID })
	if len(apps) > 24 {
		apps = apps[:24]
	}
	return apps
}

func (r *RuntimeInspector) probeBridges(port int) []BridgeInfo {
	out := make([]BridgeInfo, 0, len(candidateBridges))
	client := &http.Client{Timeout: 700 * time.Millisecond}
	for _, candidate := range candidateBridges {
		url := candidate.url
		if candidate.id == "terminald" {
			url = "http://127.0.0.1:" + strconv.Itoa(port) + "/api/health"
		}
		info := BridgeInfo{ID: candidate.id, Label: candidate.label, BaseURL: url, Description: candidate.description}
		started := time.Now()
		resp, err := client.Get(url)
		info.LatencyMs = time.Since(started).Milliseconds()
		if err == nil {
			info.Reachable = resp.StatusCode == http.StatusOK
			var payload struct {
				Mock *bool `json:"mock"`
			}
			if info.Reachable && resp.Body != nil {
				_ = json.NewDecoder(resp.Body).Decode(&payload)
				if payload.Mock != nil {
					info.Mock = *payload.Mock
				}
			}
			_ = resp.Body.Close()
		}
		out = append(out, info)
	}
	return out
}

func (r *RuntimeInspector) Report(port int) RuntimeReport {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	hostname, _ := os.Hostname()
	r.mu.RLock()
	diag := r.lastDiag
	r.mu.RUnlock()

	sessionCount := 0
	if diag != nil {
		sessionCount = len(diag.Services)
	}
	_ = sessionCount

	report := RuntimeReport{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Daemon: map[string]any{
			"name":           appName,
			"version":        version,
			"pid":            os.Getpid(),
			"uptime":         time.Since(r.startedAt).Round(time.Second).String(),
			"startedAt":      r.startedAt.UTC().Format(time.RFC3339),
			"addr":           "127.0.0.1:" + strconv.Itoa(port),
			"goroutines":     runtime.NumGoroutine(),
			"heapAllocBytes": stats.HeapAlloc,
			"sysBytes":       stats.Sys,
			"gcCycles":       stats.NumGC,
		},
		Go: map[string]any{
			"version": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH, "numCPU": runtime.NumCPU(),
		},
		Process: map[string]any{
			"uid": os.Getuid(), "gid": os.Getgid(), "hostname": hostname,
			"goroutines": runtime.NumGoroutine(),
		},
		AppsRoots: r.appsRootsFor(),
		Apps:      r.discoverApps(),
		Bridges:   r.probeBridges(port),
		Notes: []string{
			"PocketJS runtime state is reported from process introspection plus sibling daemon health probes; no WebView internals are inspected.",
			"Apps are discovered from development/install roots; dist/ presence indicates a built PocketJS bundle.",
		},
	}
	if diag != nil {
		report.Host = diag.Host
		report.Health = map[string]any{
			"lastDiagnosticsAt": r.seenAt.UTC().Format(time.RFC3339),
			"cpu":               firstMetric(diag.CPU, "CPU usage"),
			"memory":            firstMetric(diag.Memory, "Memory used"),
			"temperatures":      len(diag.Temperatures),
			"disks":             len(diag.Disks),
		}
	} else {
		report.Health = map[string]any{"status": "not-sampled", "hint": "open Diagnostics to populate host metrics"}
	}
	return report
}

func firstMetric(metrics []Metric, label string) any {
	for _, metric := range metrics {
		if metric.Label == label {
			return metric
		}
	}
	return nil
}

func (s *server) handleRuntime(w http.ResponseWriter, r *http.Request) {
	port := parsePortFromAddr(s.cfg.addr)
	writeJSON(w, http.StatusOK, s.runtime.Report(port))
}

// handleRuntimeProcesses returns the daemon's own process tree view; it never
// lists unrelated host processes.
type processRow struct {
	PID     int     `json:"pid"`
	Command string  `json:"command"`
	CPU     float64 `json:"cpu"`
	Memory  uint64  `json:"memory"`
	Kind    string  `json:"kind"`
}

func (s *server) handleRuntimeProcesses(w http.ResponseWriter, r *http.Request) {
	rows := []processRow{{PID: os.Getpid(), Command: appName, Kind: "daemon"}}
	for _, session := range s.sessions.List() {
		rows = append(rows, processRow{PID: 0, Command: session.Title, Kind: session.Kind})
	}
	writeJSON(w, http.StatusOK, map[string]any{"processes": rows, "sessions": s.sessions.List()})
}

func parsePortFromAddr(addr string) int {
	idx := strings.LastIndex(addr, ":")
	if idx < 0 {
		return 8795
	}
	port, err := strconv.Atoi(addr[idx+1:])
	if err != nil {
		return 8795
	}
	return port
}

// readProcStats is retained for tests that assert procfs parsing without
// touching the host.
func readProcStats(path string) map[string]string {
	out := map[string]string{}
	file, err := os.Open(path)
	if err != nil {
		return out
	}
	defer func() { _ = file.Close() }()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		parts := strings.SplitN(scanner.Text(), ":", 2)
		if len(parts) == 2 {
			out[parts[0]] = strings.TrimSpace(parts[1])
		}
	}
	return out
}
