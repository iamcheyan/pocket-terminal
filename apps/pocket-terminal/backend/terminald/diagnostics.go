package main

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Diagnostics reads host health through procfs/sysfs and standard tools. All
// reads are side-effect free and run as the daemon's unprivileged user.
type Diagnostics struct {
	mu          sync.Mutex
	lastCPU     cpuSample
	lastNet     map[string]netSample
	lastSampled time.Time
}

type cpuSample struct {
	idle  uint64
	total uint64
	at    time.Time
}

type netSample struct {
	rx, tx uint64
	at     time.Time
}

func NewDiagnostics() *Diagnostics {
	return &Diagnostics{lastNet: map[string]netSample{}}
}

type Metric struct {
	Label   string  `json:"label"`
	Value   float64 `json:"value"`
	Unit    string  `json:"unit"`
	Detail  string  `json:"detail,omitempty"`
	Percent float64 `json:"percent,omitempty"`
}

type DiskInfo struct {
	Mount string `json:"mount"`
	// Aliases lists further mounts that resolve to the same storage pool
	// (btrfs subvolumes, bind mounts). They are grouped rather than repeated so
	// three rows of identical numbers are not read as three full filesystems.
	Aliases    []string `json:"aliases,omitempty"`
	TotalBytes uint64   `json:"totalBytes"`
	UsedBytes  uint64   `json:"usedBytes"`
	FreeBytes  uint64   `json:"freeBytes"`
	UsedPct    float64  `json:"usedPct"`
}

type ThermalInfo struct {
	Zone    string  `json:"zone"`
	Label   string  `json:"label"`
	Celsius float64 `json:"celsius"`
}

type NetInfo struct {
	Interface string  `json:"interface"`
	RxBytes   uint64  `json:"rxBytes"`
	TxBytes   uint64  `json:"txBytes"`
	RxRate    float64 `json:"rxRate"`
	TxRate    float64 `json:"txRate"`
}

type ServiceInfo struct {
	Name        string `json:"name"`
	Load        string `json:"load"`
	Active      string `json:"active"`
	Sub         string `json:"sub"`
	Description string `json:"description"`
}

type DiagnosticsReport struct {
	GeneratedAt  string            `json:"generatedAt"`
	Host         map[string]any    `json:"host"`
	CPU          []Metric          `json:"cpu"`
	Memory       []Metric          `json:"memory"`
	Disks        []DiskInfo        `json:"disks"`
	Temperatures []ThermalInfo     `json:"temperatures"`
	Network      []NetInfo         `json:"network"`
	Services     []ServiceInfo     `json:"services"`
	Load         []float64         `json:"load"`
	Uptime       float64           `json:"uptime"`
	Providers    map[string]string `json:"providers"`
}

func (d *Diagnostics) Report(ctx context.Context) DiagnosticsReport {
	report := DiagnosticsReport{
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Providers:   map[string]string{},
	}
	report.Host = hostInfo()
	report.CPU, report.Providers["cpu"] = d.cpuMetrics()
	report.Memory, report.Providers["memory"] = memoryMetrics()
	report.Disks, report.Providers["disk"] = diskMetrics()
	report.Temperatures, report.Providers["temperature"] = temperatureMetrics()
	report.Network, report.Providers["network"] = d.networkMetrics()
	report.Services, report.Providers["services"] = serviceMetrics(ctx)
	report.Load = loadAverages()
	report.Uptime = uptimeSeconds()
	return report
}

func hostInfo() map[string]any {
	hostname, _ := os.Hostname()
	kernel, _ := os.ReadFile("/proc/sys/kernel/osrelease")
	pretty := ""
	if raw, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				pretty = strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
			}
		}
	}
	return map[string]any{
		"hostname":  hostname,
		"kernel":    strings.TrimSpace(string(kernel)),
		"os":        pretty,
		"arch":      runtime.GOARCH,
		"goVersion": runtime.Version(),
		"numCPU":    runtime.NumCPU(),
		"bootTime":  time.Now().Add(-time.Duration(uptimeSeconds()) * time.Second).UTC().Format(time.RFC3339),
	}
}

func (d *Diagnostics) cpuMetrics() ([]Metric, string) {
	raw, err := os.ReadFile("/proc/stat")
	if err != nil {
		return nil, "unavailable"
	}
	fields := strings.Fields(strings.SplitN(string(raw), "\n", 2)[0])
	if len(fields) < 5 {
		return nil, "unavailable"
	}
	var total, idle uint64
	for i, field := range fields[1:] {
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			continue
		}
		total += value
		if i == 3 || i == 4 {
			idle += value
		}
	}
	now := time.Now()
	d.mu.Lock()
	previous := d.lastCPU
	d.lastCPU = cpuSample{idle: idle, total: total, at: now}
	d.mu.Unlock()

	usage := 0.0
	if previous.total > 0 && total > previous.total {
		totalDelta := float64(total - previous.total)
		idleDelta := float64(idle - previous.idle)
		usage = (totalDelta - idleDelta) / totalDelta * 100
	}
	load := loadAverages()
	detail := ""
	if len(load) > 0 {
		detail = "load " + strings.TrimRight(strings.TrimRight(strconv.FormatFloat(load[0], 'f', 2, 64), "0"), ".")
	}
	metrics := []Metric{
		{Label: "CPU usage", Value: round1(usage), Unit: "%", Percent: round1(usage), Detail: detail},
		{Label: "Cores", Value: float64(runtime.NumCPU()), Unit: "cores"},
		{Label: "Processes", Value: float64(countDirEntries("/proc")), Unit: "procs"},
	}
	if len(load) == 3 {
		metrics = append(metrics,
			Metric{Label: "Load 1m", Value: round2(load[0]), Unit: ""},
			Metric{Label: "Load 5m", Value: round2(load[1]), Unit: ""},
			Metric{Label: "Load 15m", Value: round2(load[2]), Unit: ""},
		)
	}
	return metrics, "procfs"
}

func memoryMetrics() ([]Metric, string) {
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return nil, "unavailable"
	}
	values := map[string]uint64{}
	for _, line := range strings.Split(string(raw), "\n") {
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		value, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			continue
		}
		values[strings.TrimSuffix(parts[0], ":")] = value * 1024
	}
	total := values["MemTotal"]
	available := values["MemAvailable"]
	if available == 0 {
		available = values["MemFree"]
	}
	used := total - available
	pct := 0.0
	if total > 0 {
		pct = float64(used) / float64(total) * 100
	}
	swapTotal := values["SwapTotal"]
	swapFree := values["SwapFree"]
	swapUsed := swapTotal - swapFree
	swapPct := 0.0
	if swapTotal > 0 {
		swapPct = float64(swapUsed) / float64(swapTotal) * 100
	}
	return []Metric{
		{Label: "Memory used", Value: float64(used), Unit: "B", Percent: round1(pct), Detail: humanBytes(used) + " of " + humanBytes(total)},
		{Label: "Swap used", Value: float64(swapUsed), Unit: "B", Percent: round1(swapPct), Detail: humanBytes(swapUsed) + " of " + humanBytes(swapTotal)},
	}, "procfs"
}

func diskMetrics() ([]DiskInfo, string) {
	mounts := []string{"/", "/home", "/tmp", "/var", "/run/media", "/storage"}
	seen := map[string]bool{}
	// btrfs subvolumes report distinct fsids for the same pool, so grouping by
	// (total, free) is the reliable signal for "same storage".
	groups := map[[2]uint64]int{}
	var out []DiskInfo
	for _, mount := range mounts {
		if seen[mount] {
			continue
		}
		info, err := os.Stat(mount)
		if err != nil || !info.IsDir() {
			continue
		}
		var stat syscall.Statfs_t
		if err := syscall.Statfs(mount, &stat); err != nil {
			continue
		}
		total := stat.Blocks * uint64(stat.Bsize)
		free := stat.Bavail * uint64(stat.Bsize)
		if total == 0 {
			continue
		}
		poolKey := [2]uint64{total, free}
		if index, ok := groups[poolKey]; ok {
			out[index].Aliases = append(out[index].Aliases, mount)
			seen[mount] = true
			continue
		}
		used := total - free
		seen[mount] = true
		groups[poolKey] = len(out)
		out = append(out, DiskInfo{
			Mount: mount, TotalBytes: total, UsedBytes: used, FreeBytes: free,
			UsedPct: round1(float64(used) / float64(total) * 100),
		})
	}
	if len(out) == 0 {
		return nil, "unavailable"
	}
	return out, "statfs"
}

func temperatureMetrics() ([]ThermalInfo, string) {
	var out []ThermalInfo
	if entries, err := os.ReadDir("/sys/class/thermal"); err == nil {
		for _, entry := range entries {
			if !strings.HasPrefix(entry.Name(), "thermal_zone") {
				continue
			}
			base := filepath.Join("/sys/class/thermal", entry.Name())
			raw, err := os.ReadFile(filepath.Join(base, "temp"))
			if err != nil {
				continue
			}
			milli, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
			if err != nil {
				continue
			}
			label := entry.Name()
			if typ, err := os.ReadFile(filepath.Join(base, "type")); err == nil {
				label = strings.TrimSpace(string(typ))
			}
			out = append(out, ThermalInfo{Zone: entry.Name(), Label: label, Celsius: round1(milli / 1000)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Celsius > out[j].Celsius })
	if len(out) > 8 {
		out = out[:8]
	}
	if len(out) == 0 {
		return nil, "unavailable"
	}
	return out, "sysfs-thermal"
}

func (d *Diagnostics) networkMetrics() ([]NetInfo, string) {
	raw, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return nil, "unavailable"
	}
	now := time.Now()
	d.mu.Lock()
	previous := d.lastNet
	next := map[string]netSample{}
	d.mu.Unlock()
	var out []NetInfo
	for _, line := range strings.Split(string(raw), "\n")[2:] {
		parts := strings.Fields(line)
		if len(parts) < 10 {
			continue
		}
		name := strings.TrimSuffix(parts[0], ":")
		if name == "lo" || strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "br-") {
			continue
		}
		rx, err1 := strconv.ParseUint(parts[1], 10, 64)
		tx, err2 := strconv.ParseUint(parts[9], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		entry := NetInfo{Interface: name, RxBytes: rx, TxBytes: tx}
		if prev, ok := previous[name]; ok && now.After(prev.at) {
			seconds := now.Sub(prev.at).Seconds()
			if seconds > 0 && rx >= prev.rx && tx >= prev.tx {
				entry.RxRate = round2(float64(rx-prev.rx) / seconds)
				entry.TxRate = round2(float64(tx-prev.tx) / seconds)
			}
		}
		next[name] = netSample{rx: rx, tx: tx, at: now}
		out = append(out, entry)
	}
	d.mu.Lock()
	d.lastNet = next
	d.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].RxBytes > out[j].RxBytes })
	if len(out) == 0 {
		return nil, "unavailable"
	}
	return out, "procfs"
}

// serviceMetrics lists systemd units via `systemctl` when present; a host
// without systemd reports the provider as unavailable rather than fabricating
// rows.
func serviceMetrics(ctx context.Context) ([]ServiceInfo, string) {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return nil, "unavailable"
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "systemctl", "list-units", "--type=service", "--all", "--no-pager", "--no-legend", "--plain")
	cmd.Env = append(os.Environ(), "SYSTEMD_COLORS=0", "LC_ALL=C")
	output, err := cmd.Output()
	if err != nil {
		return nil, "unavailable"
	}
	interesting := map[string]bool{
		"terminald": true, "launcherd": true, "filesd": true, "settingsd": true,
		"sshd": true, "ssh": true, "NetworkManager": true, "systemd-journald": true,
		"pocketjs": true, "keyboardd": true,
	}
	var out []ServiceInfo
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 4 {
			continue
		}
		name := strings.TrimSuffix(fields[0], ".service")
		if !interesting[name] && !strings.HasPrefix(name, "pocket") && name != "terminald" {
			continue
		}
		description := ""
		if len(fields) > 4 {
			description = strings.Join(fields[4:], " ")
		}
		out = append(out, ServiceInfo{Name: name, Load: fields[1], Active: fields[2], Sub: fields[3], Description: description})
	}
	if len(out) == 0 {
		return nil, "unavailable"
	}
	return out, "systemctl"
}

func loadAverages() []float64 {
	raw, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return nil
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 3 {
		return nil
	}
	out := make([]float64, 0, 3)
	for _, field := range fields[:3] {
		value, err := strconv.ParseFloat(field, 64)
		if err != nil {
			return nil
		}
		out = append(out, value)
	}
	return out
}

func uptimeSeconds() float64 {
	raw, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(raw))
	if len(fields) == 0 {
		return 0
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0
	}
	return value
}

func countDirEntries(path string) int {
	entries, err := os.ReadDir(path)
	if err != nil {
		return 0
	}
	count := 0
	for _, entry := range entries {
		if _, err := strconv.Atoi(entry.Name()); err == nil {
			count++
		}
	}
	return count
}

func humanBytes(v uint64) string {
	const unit = 1024
	if v < unit {
		return strconv.FormatUint(v, 10) + " B"
	}
	div, exp := uint64(unit), 0
	for n := v / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return strconv.FormatFloat(float64(v)/float64(div), 'f', 1, 64) + " " + string("KMGTPE"[exp]) + "iB"
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }
func round2(v float64) float64 { return float64(int(v*100+0.5)) / 100 }

func (s *server) handleDiagnostics(w http.ResponseWriter, r *http.Request) {
	report := s.diag.Report(r.Context())
	s.runtime.RecordDiagnostics(report)
	writeJSON(w, http.StatusOK, report)
}

// hostnameForDisplay keeps the UI honest about which host produced a report.
func hostnameForDisplay() string {
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		return "unknown-host"
	}
	if addr, err := net.LookupHost(hostname); err == nil && len(addr) > 0 {
		return hostname
	}
	return hostname
}
