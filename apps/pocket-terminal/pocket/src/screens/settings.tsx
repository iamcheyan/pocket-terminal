// Settings: focusable option rows plus the adapter/device limits note.
import { FocusGrid, FocusScope, Focusable, For, Text, View } from "@pocketjs/framework/solid/components";
import type { Metric, SettingRow } from "../model";
import { Header, MetricRow, TabBar, Footer, Divider } from "../ui";

export function SettingsScreen(props: {
  title: string;
  jp: string;
  tabs: [string, string, string];
  metrics: Metric[];
  rows: SettingRow[];
  source: string;
  settingsTitle: string;
  settingsJp: string;
  deviceGap: string;
  sourceNote: string;
  onToggle: (id: string) => void;
}) {
  return (
    <View class="w-full h-full flex-col bg-slate-950">
      <Header title={props.title} jp={props.jp} badge={props.source} />
      <MetricRow metrics={props.metrics} source={props.source} />
      <TabBar tabs={props.tabs} active={2} />
      <View class="w-full flex-1 flex-row px-[8] py-[4] gap-[6]">
        <View class="w-[190] h-full flex-col">
          <Text class="text-xs font-bold text-white">{props.settingsTitle}</Text>
          <Text class="text-2xs text-slate-500">{props.settingsJp}</Text>
          <View class="w-full h-[4]" />
          <FocusScope autoFocus>
            <FocusGrid columns={1} class="w-[190] flex-col gap-[4]">
              <For each={props.rows} by={(row) => row.id}>
                {(row) => (
                  <Focusable
                    class="w-[190] h-[28] flex-row items-center justify-between px-[8] rounded-[6] bg-slate-900 border-slate-700 focus:bg-slate-800 focus:border-emerald-300"
                    onPress={() => props.onToggle(row().id)}
                  >
                    <View class="flex-col">
                      <Text class="text-xs text-white">{row().label}</Text>
                      <Text class="text-2xs text-slate-500">{row().jp}</Text>
                    </View>
                    <Text class="text-xs text-emerald-300">{row().value}</Text>
                  </Focusable>
                )}
              </For>
            </FocusGrid>
          </FocusScope>
        </View>
        <View class="flex-1 h-full flex-col rounded-[6] px-[8] py-[5] bg-slate-900">
          <Text class="text-xs font-bold text-white">{"ADAPTER 接続"}</Text>
          <Divider />
          <Text class="text-2xs text-emerald-200" style={{ marginT: 3 }}>{props.source}</Text>
          <Text class="text-2xs text-slate-400 overflow-hidden">{props.sourceNote}</Text>
          <View class="w-full h-[5]" />
          <Text class="text-2xs text-slate-500">{"DEVICE GAP · 未実装"}</Text>
          <Text class="text-2xs text-slate-400 overflow-hidden">{props.deviceGap}</Text>
          <View class="flex-1" />
          <Text class="text-2xs text-slate-600">{"caps: glyphs.baked, buttons"}</Text>
        </View>
      </View>
      <Footer hint="D-PAD rows · O toggle · L/R tab · B back" page={props.title} />
    </View>
  );
}
