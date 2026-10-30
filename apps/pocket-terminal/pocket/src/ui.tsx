// Shared native chrome for the PocketJS ports.
// 360x240 logical canvas: 32 px header, 20 px metric row, 20 px tabs, 22 px footer.

import { Text, View } from "@pocketjs/framework/solid/components";
import type { Metric } from "./model";

export const ICON = {
  home: "\uF015",
  search: "\uF002",
  cog: "\uF013",
  play: "\uF04B",
  pause: "\uF04C",
  folder: "\uF07B",
  book: "\uF02D",
  music: "\uF001",
  film: "\uF008",
  terminal: "\uF120",
  globe: "\uF0AC",
  gamepad: "\uF11B",
  star: "\uF005",
  back: "\uF060",
  next: "\uF061",
  check: "\uF00C",
  bolt: "\uF0E7",
  user: "\uF007",
  cloud: "\uF0C2",
  youtube: "\uF167",
};

export function Icon(props: { glyph: string; class?: string }) {
  return <Text class={props.class ?? "text-sm text-slate-400"}>{props.glyph}</Text>;
}

export function Header(props: { title: string; jp: string; badge: string }) {
  return (
    <View class="h-[32] w-full flex-row items-center justify-between px-[10] bg-slate-900">
      <View class="flex-row items-center gap-[7]">
        <Icon glyph={ICON.star} class="text-lg text-emerald-300" />
        <Text class="text-lg font-bold text-white">{props.title}</Text>
        <Text class="text-xs text-slate-400">{props.jp}</Text>
      </View>
      <View class="flex-row items-center gap-[8]">
        <Text class="text-2xs text-slate-500">{props.badge}</Text>
        <View class="rounded-[6] px-[6] py-[2] bg-emerald-900">
          <Text class="text-2xs text-emerald-300">{"PJS"}</Text>
        </View>
      </View>
    </View>
  );
}

export function MetricRow(props: { metrics: Metric[]; source: string }) {
  return (
    <View class="h-[20] w-full flex-row items-center gap-[10] px-[10] bg-slate-900">
      {props.metrics.slice(0, 3).map((metric) => (
        <View class="flex-row items-center gap-[3]">
          <Text class="text-2xs text-slate-500">{metric.label}</Text>
          <Text class="text-xs text-emerald-200">{metric.value}</Text>
        </View>
      ))}
      <View class="flex-1" />
      <Text class="text-2xs text-slate-500">{props.source}</Text>
    </View>
  );
}

export function TabBar(props: { tabs: [string, string, string]; active: number }) {
  return (
    <View class="h-[20] w-full flex-row items-center gap-[4] px-[6] bg-slate-900">
      {props.tabs.map((tab, index) => (
        <View class={index === props.active ? "flex-row items-center gap-[4] px-[10] h-[18] rounded-[5] bg-emerald-800" : "flex-row items-center gap-[4] px-[10] h-[18]"}>
          <Text class={index === props.active ? "text-xs text-white" : "text-xs text-slate-500"}>{tab}</Text>
        </View>
      ))}
      <View class="flex-1" />
      <Text class="text-2xs text-slate-500">{`${props.active + 1}/3`}</Text>
    </View>
  );
}

export function Footer(props: { hint: string; page: string }) {
  return (
    <View class="h-[22] w-full flex-row items-center justify-between px-[10] bg-slate-950">
      <Text class="text-2xs text-slate-500">{props.hint}</Text>
      <Text class="text-2xs text-slate-500">{props.page}</Text>
    </View>
  );
}

export function Divider() {
  return <View class="h-[1] w-full bg-slate-800" />;
}

export function Toast(props: { message: string }) {
  return (
    <View class="absolute left-[10] right-[10] bottom-[26] rounded-[6] px-[9] py-[4] bg-slate-800">
      <Text class="text-xs text-emerald-200">{props.message}</Text>
    </View>
  );
}

export function Progress(props: { value: number; width?: number; color?: string }) {
  const width = props.width ?? 220;
  return (
    <View class="h-[5] rounded-[3] bg-slate-800 overflow-hidden" style={{ width }}>
      <View class="h-[5] bg-emerald-400" style={{ width: Math.round(Math.max(0, Math.min(1, props.value)) * width) }} />
    </View>
  );
}
