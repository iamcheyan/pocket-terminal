package main

import (
	"context"
	"errors"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// ActionService implements the Quick Actions surface. Every action is
// allowlisted, every mutating action requires an explicit confirm flag, and
// the daemon never runs a shell string: argv is fixed here.
type ActionService struct {
	srv    *server
	mu     sync.Mutex
	lastAt map[string]time.Time
}

func NewActionService(s *server) *ActionService {
	return &ActionService{srv: s, lastAt: map[string]time.Time{}}
}

type ActionSpec struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Category    string   `json:"category"`
	Description string   `json:"description"`
	Dangerous   bool     `json:"dangerous"`
	Support     string   `json:"support"` // native | systemctl | command | preview
	Command     []string `json:"command,omitempty"`
	NeedsRoot   bool     `json:"needsRoot"`
	Cooldown    string   `json:"cooldown,omitempty"`
}

var actionCatalog = []ActionSpec{
	{
		ID: "system.info", Title: "System summary", Category: "Diagnostics", Support: "preview",
		Description: "Collect the same read-only diagnostics the Diagnostics page shows.",
	},
	{
		ID: "system.uptime", Title: "Uptime and load", Category: "Diagnostics", Support: "preview",
		Description: "Report uptime, load averages and process count.",
	},
	{
		ID: "terminal.newShell", Title: "Open a clean shell", Category: "Terminal", Support: "native",
		Description: "Spawn a new login shell session in a fresh PTY.",
	},
	{
		ID: "terminal.killAll", Title: "Close all sessions", Category: "Terminal", Support: "native", Dangerous: true,
		Description: "Terminate every terminal session owned by terminald.",
	},
	{
		ID: "logs.journalErrors", Title: "Recent journal errors", Category: "Logs", Support: "preview",
		Description: "Show the last 50 error-level journal entries.",
	},
	{
		ID: "network.ports", Title: "Listening ports", Category: "Network", Support: "command",
		Command: []string{"ss", "-ltnp"}, NeedsRoot: true,
		Description: "List listening TCP sockets. Process names require root; the daemon reports the gap instead of hiding it.",
	},
	{
		ID: "services.restart.terminald", Title: "Restart terminald", Category: "Services", Support: "systemctl", Dangerous: true,
		Command: []string{"systemctl", "restart", "terminald"}, NeedsRoot: true,
		Description: "Restart this daemon via systemd. Only enabled with --allow-system-control.",
	},
	{
		ID: "services.restart.launcherd", Title: "Restart launcherd", Category: "Services", Support: "systemctl", Dangerous: true,
		Command: []string{"systemctl", "restart", "launcherd"}, NeedsRoot: true,
		Description: "Restart the Pocket Launcher backend. Only enabled with --allow-system-control.",
	},
	{
		ID: "power.reboot", Title: "Reboot device", Category: "Power", Support: "systemctl", Dangerous: true,
		Command: []string{"systemctl", "reboot"}, NeedsRoot: true,
		Description: "Reboot the host. Never enabled in the default build; shown so the surface is explicit.",
	},
}

func (a *ActionService) List(allowControl bool) []ActionSpec {
	out := make([]ActionSpec, len(actionCatalog))
	copy(out, actionCatalog)
	for i := range out {
		if out[i].Dangerous && out[i].Support == "systemctl" && !allowControl {
			out[i].Cooldown = "disabled"
		}
	}
	return out
}

// ActionResult explains what actually happened, including refusals.
type ActionResult struct {
	ActionID   string `json:"actionId"`
	Executed   bool   `json:"executed"`
	Confirmed  bool   `json:"confirmed"`
	Output     string `json:"output,omitempty"`
	Refusal    string `json:"refusal,omitempty"`
	DurationMs int64  `json:"durationMs"`
	Preview    any    `json:"preview,omitempty"`
}

func (a *ActionService) Run(ctx context.Context, id string, confirmed bool) (ActionResult, error) {
	spec, ok := a.spec(id)
	if !ok {
		return ActionResult{}, errUnknownAction
	}
	started := time.Now()
	result := ActionResult{ActionID: id, Confirmed: confirmed}

	if spec.Dangerous && !confirmed {
		result.Refusal = "confirmation_required"
		result.DurationMs = time.Since(started).Milliseconds()
		return result, nil
	}

	switch spec.Support {
	case "preview":
		result.Preview = a.preview(ctx, spec.ID)
		result.Executed = true
	case "native":
		if err := a.native(spec.ID); err != nil {
			result.Refusal = err.Error()
		} else {
			result.Executed = true
		}
	case "command", "systemctl":
		if spec.Dangerous && !a.srv.cfg.allowControl {
			result.Refusal = "system_control_disabled"
			break
		}
		output, err := a.exec(ctx, spec.Command...)
		result.Output = output
		if err != nil {
			result.Refusal = err.Error()
		} else {
			result.Executed = true
		}
	default:
		result.Refusal = "unsupported_action"
	}
	result.DurationMs = time.Since(started).Milliseconds()
	return result, nil
}

func (a *ActionService) spec(id string) (ActionSpec, bool) {
	for _, spec := range actionCatalog {
		if spec.ID == id {
			return spec, true
		}
	}
	return ActionSpec{}, false
}

func (a *ActionService) preview(ctx context.Context, id string) any {
	switch id {
	case "system.info":
		report := a.srv.diag.Report(ctx)
		return map[string]any{"host": report.Host, "cpu": report.CPU, "memory": report.Memory, "disks": report.Disks}
	case "system.uptime":
		return map[string]any{"uptimeSeconds": uptimeSeconds(), "load": loadAverages(), "processes": countDirEntries("/proc")}
	case "logs.journalErrors":
		entries, err := a.srv.logs.Query(ctx, logQuery{Source: "journald", Priority: "err", Limit: 50})
		if err != nil {
			return map[string]any{"available": false, "reason": err.Error()}
		}
		return map[string]any{"available": true, "entries": entries}
	}
	return nil
}

func (a *ActionService) native(id string) error {
	switch id {
	case "terminal.newShell":
		_, err := a.srv.sessions.Create(createRequest{Title: "quick shell"})
		return err
	case "terminal.killAll":
		a.srv.sessions.CloseAll()
		return nil
	}
	return errors.New("unknown native action")
}

func (a *ActionService) exec(ctx context.Context, argv ...string) (string, error) {
	if len(argv) == 0 {
		return "", errors.New("empty command")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	output, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(output))
	if len(text) > 8000 {
		text = text[:8000] + "\n… output truncated"
	}
	if err != nil {
		if text == "" {
			text = err.Error()
		}
		return text, errors.New("command failed: " + err.Error())
	}
	return text, nil
}

var errUnknownAction = errors.New("unknown action")

func (s *server) handleActionList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"actions":        s.actions.List(s.cfg.allowControl),
		"controlEnabled": s.cfg.allowControl,
		"policy":         "Every dangerous action needs an explicit confirm flag; systemctl actions additionally need --allow-system-control.",
	})
}

func (s *server) handleActionRun(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm bool `json:"confirm"`
	}
	if r.ContentLength > 0 {
		if err := decodeJSON(r, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
			return
		}
	}
	result, err := s.actions.Run(r.Context(), r.PathValue("id"), req.Confirm)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", err.Error())
		return
	}
	status := http.StatusOK
	if result.Refusal == "confirmation_required" {
		status = http.StatusConflict
	}
	writeJSON(w, status, map[string]any{"result": result})
}
