// Shared data model for the PocketJS ports. Every app's client.ts exports
// APP (static presentation config) and client (fixture/http/bridge adapter).

export type PortKind = "player" | "reader" | "terminal" | "browser" | "video" | "detail";

export interface Line {
  label: string;
  value: string;
}

export interface Item {
  id: string;
  title: string;
  subtitle: string;
  meta: string;
  badge?: string;
  progress?: number;
  body?: string;
  lines?: Line[];
  state?: string;
}

export interface Section {
  id: string;
  title: string;
  jp: string;
  items: Item[];
}

export interface Metric {
  label: string;
  value: string;
  accent?: string;
}

export interface SettingRow {
  id: string;
  label: string;
  jp: string;
  value: string;
  options: string[];
}

export interface AppConfig {
  title: string;
  jp: string;
  kind: PortKind;
  page: string;
  tabs: [string, string, string];
  actions: string[];
  settingsTitle: string;
  settingsJp: string;
  deviceGap: string;
  sourceNote: string;
}

export interface ActionReport {
  ok: boolean;
  message: string;
  data?: unknown;
}

export interface AppClient {
  readonly source: "fixture" | "http" | "bridge";
  list(): Promise<Item[]>;
  get(id: string): Promise<Item | null>;
  sections(): Promise<Section[]>;
  metrics(): Promise<Metric[]>;
  settings(): Promise<SettingRow[]>;
  action(name: string, payload?: Record<string, unknown>): Promise<ActionReport>;
}
