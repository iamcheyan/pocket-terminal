// Detail: the app's product surface. The kind switches the centre pane
// (player, reader, terminal, browser, video) while the chrome stays native.
import { Show } from "solid-js";
import { FocusGrid, FocusScope, Focusable, For, Text, View } from "@pocketjs/framework/solid/components";
import type { Item, Metric, PortKind } from "../model";
import { Header, MetricRow, TabBar, Footer, Divider, Progress, ICON, Icon } from "../ui";

export function DetailScreen(props: {
  title: string;
  jp: string;
  kind: PortKind;
  tabs: [string, string, string];
  metrics: Metric[];
  item: Item | null;
  actions: string[];
  source: string;
  onAction: (name: string) => void;
}) {
  const item = () => props.item;
  const progress = () => item()?.progress ?? 0;
  return (
    <View class="w-full h-full flex-col bg-slate-950">
      <Header title={props.title} jp={props.jp} badge={props.source} />
      <MetricRow metrics={props.metrics} source={props.source} />
      <TabBar tabs={props.tabs} active={1} />
      <View class="w-full flex-1 flex-col px-[8] py-[3]">
        <Show when={item()} fallback={
          <View class="w-full flex-1 items-center justify-center">
            <Text class="text-sm text-slate-500">{"NO ITEM · 項目なし"}</Text>
          </View>
        }>
          <View class="w-full h-[42] flex-row items-center gap-[8]">
            <View class="w-[42] h-[42] rounded-[6] bg-slate-800 items-center justify-center">
              <Icon glyph={props.kind === "player" ? ICON.music : props.kind === "video" ? ICON.film : props.kind === "reader" ? ICON.book : props.kind === "terminal" ? ICON.terminal : props.kind === "browser" ? ICON.globe : ICON.folder} class="text-xl text-emerald-300" />
            </View>
            <View class="flex-1 flex-col">
              <Text class="text-base font-bold text-white">{item()!.title}</Text>
              <Text class="text-2xs text-slate-400">{item()!.subtitle}</Text>
              <Text class="text-2xs text-slate-500">{item()!.meta}</Text>
            </View>
            <Text class="text-2xs text-emerald-300">{item()!.badge ?? item()!.state ?? ""}</Text>
          </View>
          <View class="w-full h-[6]" />
          <Show when={props.kind === "player" || props.kind === "video" || props.kind === "reader"}>
            <View class="w-full flex-row items-center gap-[8]">
              <Progress value={progress()} width={244} />
              <Text class="text-2xs text-slate-400">{`${Math.round(progress() * 100)}%`}</Text>
            </View>
            <View class="w-full h-[4]" />
          </Show>
          <Show when={props.kind === "terminal"}>
            <View class="w-full h-[46] flex-col rounded-[5] px-[7] py-[4] bg-black">
              <Text class="text-xs font-mono text-emerald-300">{item()!.body ?? ""}</Text>
            </View>
            <View class="w-full h-[4]" />
          </Show>
          <Show when={props.kind === "browser"}>
            <View class="w-full h-[20] flex-row items-center rounded-[5] px-[7] bg-slate-800">
              <Icon glyph={ICON.globe} class="text-xs text-slate-400" />
              <Text class="text-2xs text-slate-300" style={{ marginL: 4 }}>{item()!.body ?? ""}</Text>
            </View>
            <View class="w-full h-[4]" />
          </Show>
          <Show when={props.kind !== "terminal" && props.kind !== "browser"}>
            <Text class="text-2xs text-slate-300">{item()!.body ?? ""}</Text>
            <View class="w-full h-[3]" />
          </Show>
          <View class="w-full flex-row flex-wrap gap-[6]">
            <For each={(item()!.lines ?? []).slice(0, 3)} by={(line) => line.label}>
              {(line) => (
                <View class="w-[108] h-[18] flex-row items-center justify-between px-[5] rounded-[4] bg-slate-900">
                  <Text class="text-2xs text-slate-500">{line().label}</Text>
                  <Text class="text-2xs text-emerald-200">{line().value}</Text>
                </View>
              )}
            </For>
          </View>
          <View class="flex-1" />
          <Divider />
          <View class="w-full h-[4]" />
          <FocusScope autoFocus>
            <FocusGrid columns={props.actions.length} class="w-full flex-row gap-[5]">
              <For each={props.actions} by={(action) => action}>
                {(action) => (
                  <Focusable
                    class="h-[24] flex-1 items-center justify-center rounded-[5] bg-slate-800 border-slate-600 focus:bg-emerald-800 focus:border-emerald-300"
                    onPress={() => props.onAction(action())}
                  >
                    <Text class="text-2xs text-white">{action()}</Text>
                  </Focusable>
                )}
              </For>
            </FocusGrid>
          </FocusScope>
        </Show>
      </View>
      <Footer hint="D-PAD actions · O run · L/R tab · B back" page={props.title} />
    </View>
  );
}
