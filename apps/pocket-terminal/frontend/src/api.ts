/**
 * Canonical API boundary. Every payload from terminald enters through these
 * parsers; the UI consumes named domain types only, never raw JSON shapes.
 */

export type ApiErrorCode =
  | 'invalid_json'
  | 'invalid_query'
  | 'invalid_profile'
  | 'not_found'
  | 'session_limit'
  | 'session_not_running'
  | 'unknown_shell'
  | 'host_key_unknown'
  | 'host_key_mismatch'
  | 'ssh_connect_failed'
  | 'confirmation_required'
  | 'system_control_disabled'
  | 'log_unavailable'
  | 'unauthorized'
  | string;

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
    public status: number,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? {'Content-Type': 'application/json'} : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {error: {code: 'bad_response', message: text.slice(0, 200)}};
    }
  }
  if (!response.ok) {
    const record = asRecord(body);
    const error = asRecord(record.error);
    throw new ApiError(
      typeof error.code === 'string' ? error.code : 'http_error',
      typeof error.message === 'string' ? error.message : `Request failed (${response.status})`,
      response.status,
      asRecord(error.details),
    );
  }
  return body as T;
};

export const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;

export const asNumber = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const asBool = (value: unknown): boolean => value === true || value === 'true';

// --- health/meta ---------------------------------------------------------

export interface Health {
  status: string;
  service: string;
  version: string;
  uptime: string;
  mock: boolean;
  sessions: number;
}

export interface ShellOption {
  id: string;
  name: string;
  path: string;
  default: boolean;
}

export interface Meta {
  service: string;
  version: string;
  defaultShell: string;
  shells: ShellOption[];
  capabilities: Record<string, boolean>;
  limits: Record<string, unknown>;
}

export const fetchHealth = (): Promise<Health> =>
  request<Record<string, unknown>>('/health').then(raw => ({
    status: asString(raw.status, 'unknown'),
    service: asString(raw.service),
    version: asString(raw.version),
    uptime: asString(raw.uptime),
    mock: asBool(raw.mock),
    sessions: asNumber(raw.sessions),
  }));

export const fetchMeta = (): Promise<Meta> =>
  request<Record<string, unknown>>('/meta').then(raw => ({
    service: asString(raw.service),
    version: asString(raw.version),
    defaultShell: asString(raw.defaultShell),
    shells: asArray(raw.shells).map(entry => {
      const row = asRecord(entry);
      return {
        id: asString(row.id),
        name: asString(row.name),
        path: asString(row.path),
        default: asBool(row.default),
      };
    }),
    capabilities: Object.fromEntries(
      Object.entries(asRecord(raw.capabilities)).map(([key, value]) => [key, asBool(value)]),
    ),
    limits: asRecord(raw.limits),
  }));

// --- terminal ------------------------------------------------------------

export type SessionState = 'running' | 'exited' | 'closed';
export type SessionKind = 'local' | 'ssh';

export interface TerminalSession {
  id: string;
  title: string;
  shell: string;
  shellId: string;
  kind: SessionKind;
  tabsGroup: string;
  profileId: string;
  mock: boolean;
  state: SessionState;
  createdAt: string;
  exitCode: number | null;
  rows: number;
  cols: number;
  bytes: number;
}

const parseSession = (value: unknown): TerminalSession => {
  const row = asRecord(value);
  return {
    id: asString(row.id),
    title: asString(row.title, 'shell'),
    shell: asString(row.shell),
    shellId: asString(row.shellId, 'bash'),
    kind: asString(row.kind, 'local') === 'ssh' ? 'ssh' : 'local',
    tabsGroup: asString(row.tabsGroup, 'main'),
    profileId: asString(row.profileId),
    mock: asBool(row.mock),
    state: (['running', 'exited', 'closed'].includes(asString(row.state)) ? asString(row.state) : 'running') as SessionState,
    createdAt: asString(row.createdAt),
    exitCode: row.exitCode === null || row.exitCode === undefined ? null : asNumber(row.exitCode),
    rows: asNumber(row.rows, 24),
    cols: asNumber(row.cols, 80),
    bytes: asNumber(row.bytes),
  };
};

export const fetchSessions = (): Promise<{sessions: TerminalSession[]; max: number}> =>
  request<Record<string, unknown>>('/terminal/sessions').then(raw => ({
    sessions: asArray(raw.sessions).map(parseSession),
    max: asNumber(raw.max, 8),
  }));

export interface CreateSessionInput {
  shell?: string;
  cols?: number;
  rows?: number;
  title?: string;
  tabsGroup?: string;
  cwd?: string;
}

export const createSession = (input: CreateSessionInput): Promise<TerminalSession> =>
  request<Record<string, unknown>>('/terminal/sessions', {
    method: 'POST',
    body: JSON.stringify(input),
  }).then(raw => parseSession(raw.session));

export const closeSession = (id: string): Promise<void> =>
  request(`/terminal/sessions/${encodeURIComponent(id)}`, {method: 'DELETE'}).then(() => undefined);

export const resizeSession = (id: string, cols: number, rows: number): Promise<TerminalSession> =>
  request<Record<string, unknown>>(`/terminal/sessions/${encodeURIComponent(id)}/resize`, {
    method: 'POST',
    body: JSON.stringify({cols, rows}),
  }).then(raw => parseSession(raw.session));

export const fetchSession = (id: string): Promise<TerminalSession> =>
  request<Record<string, unknown>>(`/terminal/sessions/${encodeURIComponent(id)}`).then(raw => parseSession(raw.session));

/** WebSocket URL for a session; offset lets a reconnect replay missed output. */
export const sessionSocketUrl = (id: string, offset = 0): string => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/terminal/sessions/${encodeURIComponent(id)}/stream?offset=${offset}`;
};

// --- ssh -----------------------------------------------------------------

export interface SSHProfile {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  user: string;
  authKind: 'password' | 'key' | 'none';
  hasPassword: boolean;
  hasKey: boolean;
  mock: boolean;
  color: string;
  description: string;
  createdAt: string;
  lastConnectedAt: string;
}

export interface KnownHost {
  id: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  addedAt: string;
  mock: boolean;
}

export interface MockTarget {
  available: boolean;
  host: string;
  port: number;
  user: string;
  note: string;
}

export interface ProfileBundle {
  profiles: SSHProfile[];
  groups: Record<string, number>;
  mockTarget: MockTarget;
  portForwarding: {supported: boolean; status: string; note: string};
}

const parseProfile = (value: unknown): SSHProfile => {
  const row = asRecord(value);
  const auth = asString(row.authKind, 'password');
  return {
    id: asString(row.id),
    name: asString(row.name),
    group: asString(row.group, 'Ungrouped'),
    host: asString(row.host),
    port: asNumber(row.port, 22),
    user: asString(row.user),
    authKind: auth === 'key' || auth === 'none' ? auth : 'password',
    hasPassword: asBool(row.hasPassword),
    hasKey: asBool(row.hasKey),
    mock: asBool(row.mock),
    color: asString(row.color, '#c4dc9c'),
    description: asString(row.description),
    createdAt: asString(row.createdAt),
    lastConnectedAt: asString(row.lastConnectedAt),
  };
};

export const fetchProfiles = (): Promise<ProfileBundle> =>
  request<Record<string, unknown>>('/ssh/profiles').then(raw => {
    const forwarding = asRecord(raw.portForwarding);
    const mock = asRecord(raw.mockTarget);
    return {
      profiles: asArray(raw.profiles).map(parseProfile),
      groups: Object.fromEntries(
        Object.entries(asRecord(raw.groups)).map(([key, value]) => [key, asNumber(value)]),
      ),
      mockTarget: {
        available: asBool(mock.available),
        host: asString(mock.host, '127.0.0.1'),
        port: asNumber(mock.port),
        user: asString(mock.user),
        note: asString(mock.note),
      },
      portForwarding: {
        supported: asBool(forwarding.supported),
        status: asString(forwarding.status, 'todo'),
        note: asString(forwarding.note),
      },
    };
  });

export interface ProfileInput {
  name?: string;
  group?: string;
  host?: string;
  port?: number;
  user?: string;
  authKind?: string;
  password?: string;
  privateKey?: string;
  description?: string;
  mock?: boolean;
}

export const saveProfile = (input: ProfileInput, id?: string): Promise<SSHProfile> =>
  request<Record<string, unknown>>(id ? `/ssh/profiles/${encodeURIComponent(id)}` : '/ssh/profiles', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(input),
  }).then(raw => parseProfile(raw.profile));

export const deleteProfile = (id: string): Promise<void> =>
  request(`/ssh/profiles/${encodeURIComponent(id)}`, {method: 'DELETE'}).then(() => undefined);

export interface SSHTestResult {
  reachable: boolean;
  authenticated: boolean;
  hostKeyState: 'trusted' | 'unknown' | 'mismatch';
  fingerprint: string;
  mock: boolean;
  latencyMs: number;
  message: string;
}

export const testProfile = (id: string): Promise<SSHTestResult> =>
  request<Record<string, unknown>>(`/ssh/profiles/${encodeURIComponent(id)}/test`, {method: 'POST'}).then(raw => {
    const result = asRecord(raw.result);
    return {
      reachable: asBool(result.reachable),
      authenticated: asBool(result.authenticated),
      hostKeyState: asString(result.hostKeyState, 'unknown') as SSHTestResult['hostKeyState'],
      fingerprint: asString(result.fingerprint),
      mock: asBool(result.mock),
      latencyMs: asNumber(result.latencyMs),
      message: asString(result.message),
    };
  });

export interface ConnectInput {
  cols?: number;
  rows?: number;
  acceptHostKey?: boolean;
  fingerprint?: string;
  title?: string;
}

/** Throws ApiError with code host_key_unknown / host_key_mismatch for TOFU. */
export const connectProfile = (id: string, input: ConnectInput): Promise<TerminalSession> =>
  request<Record<string, unknown>>(`/ssh/profiles/${encodeURIComponent(id)}/connect`, {
    method: 'POST',
    body: JSON.stringify(input),
  }).then(raw => parseSession(raw.session));

export const fetchKnownHosts = (): Promise<KnownHost[]> =>
  request<Record<string, unknown>>('/ssh/known-hosts').then(raw =>
    asArray(raw.knownHosts).map(entry => {
      const row = asRecord(entry);
      return {
        id: asString(row.id),
        host: asString(row.host),
        port: asNumber(row.port),
        keyType: asString(row.keyType),
        fingerprint: asString(row.fingerprint),
        addedAt: asString(row.addedAt),
        mock: asBool(row.mock),
      };
    }),
  );

export const deleteKnownHost = (id: string): Promise<void> =>
  request(`/ssh/known-hosts/${encodeURIComponent(id)}`, {method: 'DELETE'}).then(() => undefined);

// --- logs ----------------------------------------------------------------

export interface LogSource {
  id: string;
  kind: 'journal' | 'file';
  label: string;
  description: string;
  available: boolean;
  reason: string;
}

export interface LogEntry {
  id: string;
  time: string;
  level: string;
  unit: string;
  message: string;
}

export const fetchLogSources = (): Promise<LogSource[]> =>
  request<Record<string, unknown>>('/logs/sources').then(raw =>
    asArray(raw.sources).map(entry => {
      const row = asRecord(entry);
      return {
        id: asString(row.id),
        kind: asString(row.kind, 'file') === 'journal' ? 'journal' : 'file',
        label: asString(row.label),
        description: asString(row.description),
        available: asBool(row.available),
        reason: asString(row.reason),
      };
    }),
  );

export interface LogQuery {
  source: string;
  level?: string;
  priority?: string;
  unit?: string;
  q?: string;
  limit?: number;
}

const logQueryString = (query: LogQuery): string => {
  const params = new URLSearchParams({source: query.source});
  if (query.level && query.level !== 'all') params.set('level', query.level);
  if (query.priority) params.set('priority', query.priority);
  if (query.unit) params.set('unit', query.unit);
  if (query.q) params.set('q', query.q);
  if (query.limit) params.set('limit', String(query.limit));
  return params.toString();
};

const parseLogEntries = (value: unknown): LogEntry[] =>
  asArray(value).map(entry => {
    const row = asRecord(entry);
    return {
      id: asString(row.id),
      time: asString(row.time),
      level: asString(row.level, 'info'),
      unit: asString(row.unit),
      message: asString(row.message),
    };
  });

export const fetchLogs = (query: LogQuery): Promise<{entries: LogEntry[]; durationMs: number}> =>
  request<Record<string, unknown>>(`/logs?${logQueryString(query)}`).then(raw => ({
    entries: parseLogEntries(raw.entries),
    durationMs: asNumber(raw.durationMs),
  }));

/** SSE follow. Returns a disposer that closes the EventSource. */
export const followLogs = (
  query: LogQuery,
  handlers: {onBatch: (entries: LogEntry[]) => void; onError: (message: string) => void},
): (() => void) => {
  const source = new EventSource(`/api/logs/stream?${logQueryString(query)}`);
  source.addEventListener('batch', event => {
    try {
      const payload = asRecord(JSON.parse((event as MessageEvent<string>).data));
      handlers.onBatch(parseLogEntries(payload.entries));
    } catch {
      handlers.onError('malformed log stream payload');
    }
  });
  source.addEventListener('error', () => handlers.onError('log stream disconnected'));
  return () => source.close();
};

export const exportLogs = async (query: LogQuery): Promise<{filename: string; text: string}> => {
  const response = await fetch('/api/logs/export', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(query),
  });
  if (!response.ok) {
    throw new ApiError('export_failed', `Export failed (${response.status})`, response.status);
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return {filename: match?.[1] ?? 'pocket-terminal.log', text: await response.text()};
};

// --- diagnostics/runtime -------------------------------------------------

export interface Metric {
  label: string;
  value: number;
  unit: string;
  detail: string;
  percent: number;
}

export interface DiagnosticReport {
  generatedAt: string;
  host: Record<string, string | number>;
  cpu: Metric[];
  memory: Metric[];
  disks: {mount: string; aliases: string[]; totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number}[];
  temperatures: {zone: string; label: string; celsius: number}[];
  network: {interface: string; rxBytes: number; txBytes: number; rxRate: number; txRate: number}[];
  services: {name: string; load: string; active: string; sub: string; description: string}[];
  load: number[];
  uptime: number;
  providers: Record<string, string>;
}

const parseMetrics = (value: unknown): Metric[] =>
  asArray(value).map(entry => {
    const row = asRecord(entry);
    return {
      label: asString(row.label),
      value: asNumber(row.value),
      unit: asString(row.unit),
      detail: asString(row.detail),
      percent: asNumber(row.percent),
    };
  });

export const fetchDiagnostics = (): Promise<DiagnosticReport> =>
  request<Record<string, unknown>>('/diagnostics').then(raw => ({
    generatedAt: asString(raw.generatedAt),
    host: Object.fromEntries(
      Object.entries(asRecord(raw.host)).map(([key, value]) => [
        key,
        typeof value === 'number' ? value : asString(value),
      ]),
    ),
    cpu: parseMetrics(raw.cpu),
    memory: parseMetrics(raw.memory),
    disks: asArray(raw.disks).map(entry => {
      const row = asRecord(entry);
      return {
        mount: asString(row.mount),
        aliases: asArray(row.aliases).map(value => asString(value)),
        totalBytes: asNumber(row.totalBytes),
        usedBytes: asNumber(row.usedBytes),
        freeBytes: asNumber(row.freeBytes),
        usedPct: asNumber(row.usedPct),
      };
    }),
    temperatures: asArray(raw.temperatures).map(entry => {
      const row = asRecord(entry);
      return {zone: asString(row.zone), label: asString(row.label), celsius: asNumber(row.celsius)};
    }),
    network: asArray(raw.network).map(entry => {
      const row = asRecord(entry);
      return {
        interface: asString(row.interface),
        rxBytes: asNumber(row.rxBytes),
        txBytes: asNumber(row.txBytes),
        rxRate: asNumber(row.rxRate),
        txRate: asNumber(row.txRate),
      };
    }),
    services: asArray(raw.services).map(entry => {
      const row = asRecord(entry);
      return {
        name: asString(row.name),
        load: asString(row.load),
        active: asString(row.active),
        sub: asString(row.sub),
        description: asString(row.description),
      };
    }),
    load: asArray(raw.load).map(value => asNumber(value)),
    uptime: asNumber(raw.uptime),
    providers: Object.fromEntries(
      Object.entries(asRecord(raw.providers)).map(([key, value]) => [key, asString(value)]),
    ),
  }));

export interface RuntimeApp {
  id: string;
  name: string;
  path: string;
  kind: string;
  hasPackage: boolean;
  hasDist: boolean;
  updatedAt: string;
}

export interface RuntimeReport {
  generatedAt: string;
  daemon: Record<string, string | number>;
  go: Record<string, string | number>;
  host: Record<string, string | number>;
  appsRoots: string[];
  apps: RuntimeApp[];
  bridges: {id: string; label: string; baseURL: string; reachable: boolean; latencyMs: number; mock: boolean}[];
  health: Record<string, unknown>;
  notes: string[];
}

export const fetchRuntime = (): Promise<RuntimeReport> =>
  request<Record<string, unknown>>('/runtime').then(raw => ({
    generatedAt: asString(raw.generatedAt),
    daemon: asRecord(raw.daemon) as Record<string, string | number>,
    go: asRecord(raw.go) as Record<string, string | number>,
    host: asRecord(raw.host) as Record<string, string | number>,
    appsRoots: asArray(raw.appsRoots).map(value => asString(value)),
    apps: asArray(raw.apps).map(entry => {
      const row = asRecord(entry);
      return {
        id: asString(row.id),
        name: asString(row.name),
        path: asString(row.path),
        kind: asString(row.kind),
        hasPackage: asBool(row.hasPackage),
        hasDist: asBool(row.hasDist),
        updatedAt: asString(row.updatedAt),
      };
    }),
    bridges: asArray(raw.bridges).map(entry => {
      const row = asRecord(entry);
      return {
        id: asString(row.id),
        label: asString(row.label),
        baseURL: asString(row.baseURL),
        reachable: asBool(row.reachable),
        latencyMs: asNumber(row.latencyMs),
        mock: asBool(row.mock),
      };
    }),
    health: asRecord(raw.health),
    notes: asArray(raw.notes).map(value => asString(value)),
  }));

// --- actions -------------------------------------------------------------

export interface ActionSpec {
  id: string;
  title: string;
  category: string;
  description: string;
  dangerous: boolean;
  support: string;
  needsRoot: boolean;
  cooldown: string;
}

export interface ActionResult {
  actionId: string;
  executed: boolean;
  confirmed: boolean;
  output: string;
  refusal: string;
  durationMs: number;
  preview: unknown;
}

export const fetchActions = (): Promise<{actions: ActionSpec[]; controlEnabled: boolean; policy: string}> =>
  request<Record<string, unknown>>('/actions').then(raw => ({
    actions: asArray(raw.actions).map(entry => {
      const row = asRecord(entry);
      return {
        id: asString(row.id),
        title: asString(row.title),
        category: asString(row.category),
        description: asString(row.description),
        dangerous: asBool(row.dangerous),
        support: asString(row.support),
        needsRoot: asBool(row.needsRoot),
        cooldown: asString(row.cooldown),
      };
    }),
    controlEnabled: asBool(raw.controlEnabled),
    policy: asString(raw.policy),
  }));

export const runAction = async (id: string, confirm = false): Promise<ActionResult> => {
  try {
    const raw = await request<Record<string, unknown>>(`/actions/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({confirm}),
    });
    return parseActionResult(raw.result);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'confirmation_required') {
      return {
        actionId: id,
        executed: false,
        confirmed: false,
        output: '',
        refusal: 'confirmation_required',
        durationMs: 0,
        preview: null,
      };
    }
    throw error;
  }
};

const parseActionResult = (value: unknown): ActionResult => {
  const row = asRecord(value);
  return {
    actionId: asString(row.actionId),
    executed: asBool(row.executed),
    confirmed: asBool(row.confirmed),
    output: asString(row.output),
    refusal: asString(row.refusal),
    durationMs: asNumber(row.durationMs),
    preview: row.preview ?? null,
  };
};

// --- helpers -------------------------------------------------------------

export const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** index;
  return `${index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
};

export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

export const formatTime = (iso: string): string => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
};

export const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.code === 'host_key_unknown') return 'Host key is new — confirm the fingerprint to continue.';
    if (error.code === 'host_key_mismatch') return 'Host key changed — connection refused.';
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
};
