"use client";

import { CandlestickChart, LineChart as LineIcon } from "lucide-react";
import { useState } from "react";
import type { Point } from "@/lib/view";
import { barsOf } from "@/lib/bars";
import { type SeriesKind, joinHistory, preferEstimates, seriesOf, withLiveMinute } from "@/lib/estimate";
import { useAccount } from "./account";
import { useLive, useRangeHistory } from "./live";
import { type ChartLine, type ChartMark, TradeChart } from "./trade-chart";

export interface Series {
  id: string;
  label: string;
  points: Point[];
  digits: number;
  baseline?: number;
  lines?: ChartLine[];
  marks?: ChartMark[];
  compare?: number;
  live?: { kind: SeriesKind; id?: string; scale?: number; realtime?: boolean };
}

const ranges = [
  { label: "1H", minutes: 60, interval: 1 },
  { label: "4H", minutes: 240, interval: 5 },
  { label: "1D", minutes: 1440, interval: 15 },
  { label: "1W", minutes: 10080, interval: 60 },
  { label: "1M", minutes: 43200, interval: 240 },
];

const seconds = [
  { label: "1s", minutes: 1 / 60 },
  { label: "5s", minutes: 5 / 60 },
  { label: "15s", minutes: 15 / 60 },
];

const intervals = [
  { label: "1m", minutes: 1 },
  { label: "5m", minutes: 5 },
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "4h", minutes: 240 },
  { label: "1D", minutes: 1440 },
];

const MIN_BARS = 12;
const control = "h-8 cursor-pointer rounded-control px-2.5 text-xs transition-colors duration-150";

function Tabs<T extends string | number>({ items, value, onChange, name }: { items: { key: T; label: string }[]; value: T; onChange: (next: T) => void; name: string }) {
  return (
    <div role="group" aria-label={name} className="flex gap-0.5">
      {items.map((item) => (
        <button key={item.key} type="button" aria-pressed={value === item.key} onClick={() => onChange(item.key)} className={`${control} ${value === item.key ? "bg-surface-2 font-medium text-ink" : "text-muted hover:bg-surface-2 hover:text-ink"}`}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

function span(seconds: number): string {
  if (seconds >= 2 * 86400) return `${Math.round(seconds / 86400)} days`;
  if (seconds >= 2 * 3600) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.max(1, Math.round(seconds / 60))} minutes`;
}

function since(cutoff: number, end: number): string {
  const date = new Date(cutoff * 1000);
  const time = `${date.toISOString().slice(11, 16)} UTC`;
  if (new Date(end * 1000).toISOString().slice(0, 10) === date.toISOString().slice(0, 10)) return time;
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}, ${time}`;
}

export function AssetChart({ series, note, height }: { series: Series[]; note?: string; height?: number }) {
  const [selected, setSelected] = useState(series[0].id);
  const [range, setRange] = useState(240);
  const [candles, setCandles] = useState(true);
  const [chosen, setChosen] = useState<number | null>(null);
  const { history } = useLive();
  const { sequence } = useAccount();
  const current = series.find((item) => item.id === selected) ?? series[0];
  const preset = ranges.find((item) => item.minutes === range) ?? ranges[1];
  const realtime = current.live?.realtime === true;
  const older = useRangeHistory(range * 60, current.live !== undefined && !realtime);
  const raw = current.live ? seriesOf(joinHistory(older, history), current.live.kind, current.live.id, sequence) : [];
  const scaled = current.live?.scale === undefined ? raw : raw.map((point) => ({ cutoff: point.cutoff, value: point.value * (current.live?.scale ?? 1) }));
  const estimated = realtime ? scaled : withLiveMinute(scaled);
  const end = Math.max(current.points[current.points.length - 1]?.cutoff ?? 0, estimated[estimated.length - 1]?.cutoff ?? 0);
  const settled = current.points.filter((point) => point.cutoff > end - range * 60);
  const recent = estimated.filter((point) => point.cutoff > end - range * 60);
  const live = preferEstimates(recent, settled);
  const shown = live ? recent : settled;
  const choices = live && realtime ? [...seconds, ...intervals] : intervals;
  const wanted = candles ? preset.interval : live && realtime ? preset.interval / 5 : Math.max(1, Math.floor(preset.interval / 5));
  const fitting = [...choices].reverse().find((item) => item.minutes <= wanted && barsOf(shown, item.minutes).length >= MIN_BARS);
  const interval = chosen ?? fitting?.minutes ?? choices[0].minutes;
  const bars = barsOf(shown, interval);
  const held = shown.length > 1 ? end - shown[0].cutoff : 0;
  const short = shown.length > 1 && held < range * 60 * 0.9;
  const lines = [...(current.lines ?? []), ...(current.baseline === undefined ? [] : [{ value: current.baseline, label: "Start", tone: "ink" as const }])];

  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-2 py-1.5">
        <Tabs name="Series" items={series.map((item) => ({ key: item.id, label: item.label }))} value={selected} onChange={setSelected} />
        <span className="h-5 w-px bg-line" aria-hidden="true" />
        <div role="group" aria-label="Chart type" className="flex gap-0.5">
          <button type="button" aria-pressed={!candles} aria-label="Line chart" title="Line" onClick={() => setCandles(false)} className={`${control} ${!candles ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink"}`}>
            <LineIcon size={15} aria-hidden="true" />
          </button>
          <button type="button" aria-pressed={candles} aria-label="Candlestick chart" title="Candles" onClick={() => setCandles(true)} className={`${control} ${candles ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink"}`}>
            <CandlestickChart size={15} aria-hidden="true" />
          </button>
        </div>
        <label className="flex items-center gap-1 text-xs text-muted">
          <span className="sr-only">Interval</span>
          <select value={interval} onChange={(event) => setChosen(Number(event.target.value))} className="h-8 cursor-pointer rounded-control bg-transparent px-1.5 text-xs text-ink hover:bg-surface-2">
            {choices.map((item) => (
              <option key={item.minutes} value={item.minutes}>{item.label}</option>
            ))}
          </select>
        </label>
        <div className="ml-auto">
          <Tabs
            name="Range"
            items={ranges.map((item) => ({ key: item.minutes, label: item.label }))}
            value={range}
            onChange={(next) => {
              setRange(next);
              setChosen(null);
            }}
          />
        </div>
      </div>
      <div className="px-1 pb-1 pt-2">
        {bars.length > 1 ? (
          <TradeChart bars={bars} candles={candles} digits={current.digits} label={current.label} lines={lines} marks={current.marks ?? []} compare={current.compare} height={height} />
        ) : (
          <p className="flex items-center justify-center px-6 text-center text-sm text-muted" style={{ height: height ?? 420 }}>
            {shown.length > 1 ? "There is not enough history yet for bars this wide. Choose a shorter interval." : current.live ? "The live line starts in a few seconds." : "No settled values in this period yet. Choose a longer range."}
          </p>
        )}
      </div>
      {(note || short || live) && (
        <p className="border-t border-line px-4 py-2 text-xs text-muted">
          {live && `Estimates from ${since(recent[0].cutoff, end)}, ${realtime ? "updated every second" : "the current minute moves every second and finished minutes stay fixed"}. `}
          {short && (live ? `Estimates cover ${span(held)} of this range. ` : held >= 23 * 3600 ? "Showing the last 24 hours, the most this page loads. " : `Showing ${span(held)} of history so far. `)}
          {note}
        </p>
      )}
    </section>
  );
}
