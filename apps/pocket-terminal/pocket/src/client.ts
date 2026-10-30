// Terminal client: local shell, SSH profiles, logs and diagnostics over terminald.
// The PTY path uses the pocketshell-terminal bridge contract; not built here.
import { createPortClient } from "./client-kit";
import type { AppConfig, Metric, Section, SettingRow } from "./model";

const sections: Section[] = [
  {
    id: "sessions", title: "SESSIONS", jp: "セッション", items: [
      { id: "s1", title: "local-1", subtitle: "bash · attached · 8941", meta: "local", badge: "TTY", progress: 1, body: "pocket@pjos:~$ uptime\n 08:41:12 up 4 days,  2:17,  1 user\n$ uname -a\nLinux pjos 6.1.0-rocknix aarch64", lines: [{ label: "pid", value: "8941" }, { label: "kind", value: "pty" }, { label: "mock", value: "no" }] },
      { id: "s2", title: "mock-lab", subtitle: "demo@127.0.0.1 · ssh", meta: "mock", badge: "SSH", body: "demo@pocket:~$ echo ready\nready\n$ ", lines: [{ label: "host", value: "loopback" }, { label: "auth", value: "tofu" }, { label: "mock", value: "yes" }] },
      { id: "s3", title: "journal tail", subtitle: "journald · follow", meta: "live", badge: "LOG", body: "systemd[1]: Started terminald.\nkernel: usb 1-1: new high-speed USB device", lines: [{ label: "source", value: "journald" }, { label: "priority", value: "info" }, { label: "follow", value: "on" }] },
    ],
  },
  {
    id: "tools", title: "TOOLS", jp: "ツール", items: [
      { id: "t-diag", title: "Diagnostics", subtitle: "load · memory · thermal", meta: "procfs", badge: "DIA", body: "Load, memory, thermal zones and service state." },
      { id: "t-runtime", title: "Runtime", subtitle: "daemon · Go · PocketJS", meta: "inspect", badge: "RUN", body: "Bridge probes and runtime versions." },
      { id: "t-actions", title: "Actions", subtitle: "uptime · restart · kill", meta: "allowlist", badge: "ACT", body: "Only allowlisted actions run; system control is off by default." },
    ],
  },
];

const metrics: Metric[] = [
  { label: "SESSIONS", value: "2" },
  { label: "LOAD", value: "0.42" },
  { label: "MEM", value: "31%" },
];

const settings: SettingRow[] = [
  { id: "font", label: "Font size", jp: "文字サイズ", value: "14", options: ["12", "14", "16"] },
  { id: "scroll", label: "Scrollback", jp: "履歴", value: "2000", options: ["500", "1000", "2000"] },
  { id: "system", label: "System control", jp: "システム操作", value: "OFF", options: ["OFF", "ON"] },
];

export const APP: AppConfig = {
  title: "TERMINAL",
  jp: "端末",
  kind: "terminal",
  page: "TERMINAL",
  tabs: ["端末", "セッション", "設定"],
  actions: ["SHELL", "SSH", "LOGS", "STOP"],
  settingsTitle: "CONSOLE",
  settingsJp: "端末設定",
  deviceGap: "PTY bridge missing.",
  sourceNote: "/api/terminal · /api/logs",
};

export const client = createPortClient({
  resource: "terminal",
  fixture: { sections, metrics, settings },
  endpoints: {
    list: "/api/terminal/sessions",
    get: (id) => `/api/terminal/sessions/${encodeURIComponent(id)}`,
    action: (name) => `/api/actions/${encodeURIComponent(name.toLowerCase())}`,
  },
  act(name, payload, bundle) {
    const item = bundle.sections.flatMap((section) => section.items).find((entry) => entry.id === payload?.id);
    if (!item) return { ok: false, message: "no session selected" };
    if (name === "SHELL") { item.state = "spawned"; return { ok: true, message: "local shell spawned · PTY bridge TODO" }; }
    if (name === "SSH") { item.state = "connecting"; return { ok: true, message: "ssh mock-lab · TOFU known_hosts" }; }
    if (name === "LOGS") { item.state = "following"; return { ok: true, message: "journal follow on · SSE bridge TODO" }; }
    if (name === "STOP") { item.state = "stopped"; return { ok: true, message: `${item.title} stopped` }; }
    return { ok: false, message: `${name} unavailable` };
  },
});
