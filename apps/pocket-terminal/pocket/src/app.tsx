// Generic PocketJS port shell. All product differences live in client.ts.
import { createEffect, createSignal, onMount, Show } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/solid/components";
import { animate } from "@pocketjs/framework/animation";
import { virtualFrame } from "@pocketjs/framework/clock";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { APP, client } from "./client";
import type { Item, Metric, Section, SettingRow } from "./model";
import { HomeScreen } from "./screens/home";
import { DetailScreen } from "./screens/detail";
import { SettingsScreen } from "./screens/settings";
import { Header, MetricRow, Footer } from "./ui";

export default function App() {
  const [tab, setTab] = createSignal(0);
  const [items, setItems] = createSignal<Item[]>([]);
  const [sections, setSections] = createSignal<Section[]>([]);
  const [metrics, setMetrics] = createSignal<Metric[]>([]);
  const [rows, setRows] = createSignal<SettingRow[]>([]);
  const [selectedId, setSelectedId] = createSignal("");
  const [toast, setToast] = createSignal("");
  const [ready, setReady] = createSignal(false);
  let toastUntil = 0;
  let root: NodeMirror | undefined;

  const selected = () => items().find((item) => item.id === selectedId()) ?? items()[0] ?? null;

  const say = (message: string) => {
    setToast(message);
    toastUntil = virtualFrame() + 15;
  };

  const refresh = async () => {
    const [nextSections, nextMetrics, nextRows] = await Promise.all([
      client.sections(), client.metrics(), client.settings(),
    ]);
    setSections(nextSections);
    setMetrics(nextMetrics);
    setRows(nextRows);
    setItems(nextSections.flatMap((section) => section.items));
    if (!selectedId() && nextSections[0]?.items[0]) setSelectedId(nextSections[0].items[0].id);
  };

  onMount(() => {
    void refresh().then(() => setReady(true));
  });

  createEffect(() => {
    void tab();
    if (root) animate(root, "opacity", 1, { dur: 120, easing: "out" });
  });

  onFrame(() => {
    if (toast() && virtualFrame() > toastUntil) setToast("");
  });

  onButtonPress(BTN.LTRIGGER, () => { setToast(""); setTab((tab() + 2) % 3); });
  onButtonPress(BTN.RTRIGGER, () => { setToast(""); setTab((tab() + 1) % 3); });
  onButtonPress(BTN.START, () => { setToast(""); setTab((tab() + 1) % 3); });
  onButtonPress(BTN.CROSS, () => { if (tab() !== 0) setTab(0); });

  const open = (id: string) => {
    setSelectedId(id);
    setTab(1);
  };

  const runAction = (name: string) => {
    const item = selected();
    void client.action(name, item ? { id: item.id } : undefined).then(async (report) => {
      say(report.message);
      await refresh();
    });
  };

  const toggleRow = (id: string) => {
    setRows((current) => current.map((row) => {
      if (row.id !== id) return row;
      const at = row.options.indexOf(row.value);
      const value = row.options[(at + 1) % row.options.length]!;
      say(`${row.label}: ${value}`);
      return { ...row, value };
    }));
  };

  return (
    <View ref={(node) => { root = node; }} class="w-full h-full">
      <Show when={ready()} fallback={
        <View class="w-full h-full flex-col bg-slate-950">
          <Header title={APP.title} jp={APP.jp} badge={client.source} />
          <MetricRow metrics={[]} source={client.source} />
          <View class="w-full flex-1 items-center justify-center">
            <Text class="text-sm text-slate-400">{"loading… · 読み込み中"}</Text>
          </View>
          <Footer hint="reading client adapter" page={APP.page} />
        </View>
      }>
        <Show when={tab() === 0}>
          <HomeScreen
            title={APP.title}
            jp={APP.jp}
            tabs={APP.tabs}
            metrics={metrics()}
            sections={sections()}
            source={client.source}
            onOpen={open}
          />
        </Show>
        <Show when={tab() === 1}>
          <DetailScreen
            title={APP.title}
            jp={APP.jp}
            kind={APP.kind}
            tabs={APP.tabs}
            metrics={metrics()}
            item={selected()}
            actions={APP.actions}
            source={client.source}
            onAction={runAction}
          />
        </Show>
        <Show when={tab() === 2}>
          <SettingsScreen
            title={APP.title}
            jp={APP.jp}
            tabs={APP.tabs}
            metrics={metrics()}
            rows={rows()}
            source={client.source}
            settingsTitle={APP.settingsTitle}
            settingsJp={APP.settingsJp}
            deviceGap={APP.deviceGap}
            sourceNote={APP.sourceNote}
            onToggle={toggleRow}
          />
        </Show>
        <Show when={toast()}>
          <View class="absolute left-[10] right-[10] bottom-[26] rounded-[6] px-[9] py-[4] bg-slate-800">
            <Text class="text-xs text-emerald-200">{toast()}</Text>
          </View>
        </Show>
      </Show>
    </View>
  );
}
