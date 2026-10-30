// Shared adapter factory. Apps supply fixture data, endpoint names and one
// normalize function; the UI still sees only list()/get()/action().
import { fetch as netFetch, netHost } from "@pocketjs/framework/net-api";
import type { ActionReport, AppClient, Item, Metric, Section, SettingRow } from "./model";

export interface FixtureBundle {
  sections: Section[];
  metrics: Metric[];
  settings: SettingRow[];
}

export interface Endpoints {
  list: string;
  get: (id: string) => string;
  action: (name: string) => string;
  metrics?: string;
  settings?: string;
  sections?: string;
}

export interface ClientOptions {
  resource: string;
  fixture: FixtureBundle;
  endpoints: Endpoints;
  /** Map one backend record to a native Item. Defaults to a small identity map. */
  normalize?: (raw: Record<string, unknown>) => Item | null;
  /** Apply a fixture action. Mutate the bundle in place and return a report. */
  act?: (name: string, payload: Record<string, unknown> | undefined, bundle: FixtureBundle) => ActionReport;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultNormalize(raw: Record<string, unknown>): Item | null {
  if (typeof raw.id !== "string" && typeof raw.id !== "number") return null;
  return {
    id: String(raw.id),
    title: String(raw.title ?? raw.name ?? raw.id),
    subtitle: String(raw.subtitle ?? raw.category ?? ""),
    meta: String(raw.meta ?? raw.status ?? ""),
    badge: typeof raw.badge === "string" ? raw.badge : undefined,
    progress: typeof raw.progress === "number" ? raw.progress : undefined,
    body: typeof raw.body === "string" ? raw.body : undefined,
    state: typeof raw.state === "string" ? raw.state : undefined,
    lines: Array.isArray(raw.lines) ? raw.lines as Item["lines"] : undefined,
  };
}

function pickItems(payload: unknown, normalize: (raw: Record<string, unknown>) => Item | null): Item[] {
  const value = payload as Record<string, unknown>;
  const list = Array.isArray(value) ? value
    : Array.isArray(value?.items) ? value.items
    : Array.isArray(value?.data) ? value.data
    : Array.isArray(value?.results) ? value.results
    : [];
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = normalize(entry as Record<string, unknown>);
    return item ? [item] : [];
  });
}

function fixtureClient(options: ClientOptions): AppClient {
  const bundle = clone(options.fixture);
  const items = () => bundle.sections.flatMap((section) => section.items);
  return {
    source: "fixture",
    async list() { return clone(items()); },
    async get(id) { return clone(items().find((item) => item.id === id) ?? null); },
    async sections() { return clone(bundle.sections); },
    async metrics() { return clone(bundle.metrics); },
    async settings() { return clone(bundle.settings); },
    async action(name, payload) {
      if (options.act) return options.act(name, payload, bundle);
      return { ok: false, message: `${name} is not wired in this port` };
    },
  };
}

function httpClient(options: ClientOptions): AppClient {
  const normalize = options.normalize ?? defaultNormalize;
  const read = async <T>(path: string): Promise<T> => {
    const response = await netFetch(path, { timeoutMs: 4000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json<T>();
  };
  return {
    source: "http",
    async list() {
      return pickItems(await read<unknown>(options.endpoints.list), normalize);
    },
    async get(id) {
      return normalize(await read<Record<string, unknown>>(options.endpoints.get(id)));
    },
    async sections() {
      return options.endpoints.sections
        ? await read<Section[]>(options.endpoints.sections)
        : options.fixture.sections;
    },
    async metrics() {
      return options.endpoints.metrics
        ? await read<Metric[]>(options.endpoints.metrics)
        : options.fixture.metrics;
    },
    async settings() {
      return options.endpoints.settings
        ? await read<SettingRow[]>(options.endpoints.settings)
        : options.fixture.settings;
    },
    async action(name, payload) {
      const response = await netFetch(options.endpoints.action(name), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        timeoutMs: 4000,
      });
      const body = await response.json<Record<string, unknown>>();
      return { ok: response.ok, message: String(body.message ?? `${name}: HTTP ${response.status}`), data: body };
    },
  };
}

interface BridgeHost {
  __pvc?: (request: string) => unknown;
}

function bridgeClient(options: ClientOptions): AppClient {
  const host = (globalThis as { host?: BridgeHost }).host;
  const normalize = options.normalize ?? defaultNormalize;
  const call = async (request: Record<string, unknown>): Promise<unknown> => {
    const raw = await host?.__pvc?.(JSON.stringify(request));
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  };
  return {
    source: "bridge",
    async list() {
      return pickItems(await call({ op: "list", resource: options.resource }), normalize);
    },
    async get(id) {
      const raw = await call({ op: "get", resource: options.resource, id });
      return raw ? normalize(raw as Record<string, unknown>) : null;
    },
    async sections() {
      return (await call({ op: "list", resource: `${options.resource}.sections` }) as Section[]) ?? options.fixture.sections;
    },
    async metrics() {
      return (await call({ op: "get", resource: `${options.resource}.metrics` }) as Metric[]) ?? options.fixture.metrics;
    },
    async settings() {
      return (await call({ op: "get", resource: `${options.resource}.settings` }) as SettingRow[]) ?? options.fixture.settings;
    },
    async action(name, payload) {
      const value = await call({ op: "action", resource: options.resource, action: name, payload });
      return (value as ActionReport) ?? { ok: false, message: "bridge returned no report" };
    },
  };
}

export function createPortClient(options: ClientOptions): AppClient {
  const host = (globalThis as { host?: BridgeHost }).host;
  if (typeof host?.__pvc === "function") return bridgeClient(options);
  if (netHost() && (globalThis as { __PJS_HTTP?: boolean }).__PJS_HTTP) return httpClient(options);
  return fixtureClient(options);
}
