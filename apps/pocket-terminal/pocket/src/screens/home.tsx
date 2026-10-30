// Home: feature strip + a 3-column focus grid of the app's primary items.
import { FocusGrid, FocusScope, Focusable, For, Text, View } from "@pocketjs/framework/solid/components";
import type { Metric, Section } from "../model";
import { Header, MetricRow, TabBar, Footer, Divider } from "../ui";

export function HomeScreen(props: {
  title: string;
  jp: string;
  tabs: [string, string, string];
  metrics: Metric[];
  sections: Section[];
  source: string;
  onOpen: (id: string) => void;
}) {
  const items = () => props.sections.flatMap((section) => section.items);
  const feature = () => items()[0];
  return (
    <View class="w-full h-full flex-col bg-slate-950">
      <Header title={props.title} jp={props.jp} badge={props.source} />
      <MetricRow metrics={props.metrics} source={props.source} />
      <TabBar tabs={props.tabs} active={0} />
      <View class="w-full flex-1 flex-col px-[6] py-[3]">
        <View class="w-full h-[34] flex-row items-center gap-[8] rounded-[6] px-[8] bg-slate-900">
          <View class="w-[26] h-[26] rounded-[6] bg-emerald-800 items-center justify-center">
            <Text class="text-sm text-emerald-200">{feature()?.badge ?? "P"}</Text>
          </View>
          <View class="flex-1 flex-col">
            <Text class="text-xs font-bold text-white">{feature()?.title ?? "-"}</Text>
            <Text class="text-2xs text-slate-400">{feature()?.subtitle ?? ""}</Text>
          </View>
          <Text class="text-2xs text-emerald-300">{feature()?.meta ?? ""}</Text>
        </View>
        <View class="w-full h-[4]" />
        <FocusScope autoFocus>
          <FocusGrid columns={3} wrap class="w-full flex-row flex-wrap gap-[4]">
            <For each={items()} by={(item) => item.id}>
              {(item) => (
                <Focusable
                  class="w-[110] h-[42] flex-col justify-center rounded-[6] px-[6] py-[3] bg-slate-900 border-slate-700 focus:bg-slate-800 focus:border-emerald-300"
                  onPress={() => props.onOpen(item().id)}
                >
                  <View class="w-full flex-row items-center justify-between">
                    <Text class="text-xs font-bold text-white">{item().title}</Text>
                    <Text class="text-2xs text-emerald-300">{item().badge ?? ""}</Text>
                  </View>
                  <Text class="text-2xs text-slate-500 overflow-hidden">{item().meta}</Text>
                </Focusable>
              )}
            </For>
          </FocusGrid>
        </FocusScope>
        <View class="flex-1" />
        <Divider />
        <View class="w-full h-[14] flex-row items-center justify-between">
          {props.sections.slice(0, 2).map((section) => (
            <Text class="text-2xs text-slate-500">{`${section.title} ${section.jp}`}</Text>
          ))}
        </View>
      </View>
      <Footer hint="D-PAD grid · O open · L/R tab · B back" page={props.title} />
    </View>
  );
}
