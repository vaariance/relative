"use client";

import type { Epoch, PreviewHistory } from "@eox/app-api";
import { type ReactNode, useEffect, useState } from "react";
import { type Move } from "@/lib/epoch";
import { type Estimate, historyEstimates } from "@/lib/estimate";
import type { Point } from "@/lib/view";
import { useAccount } from "./account";
import { CoinIcon } from "./coin-icon";
import { ordered, pct, tone } from "./epoch-shared";
import { Sparkline } from "./sparkline";

const SERIES_MS = 60_000;

export function useEpochSeries(epoch: Epoch | null, now: number): Estimate[] {
  const { apiUrl, live } = useAccount();
  const [held, setHeld] = useState<{ key: number; points: Estimate[] } | null>(null);
  const opensAt = epoch?.opensAt ?? null;
  const started = opensAt !== null && now >= opensAt;
  const running = epoch !== null && started && now < epoch.closesAt;
  useEffect(() => {
    if (!live || opensAt === null || !started) return;
    let current = true;
    const load = async () => {
      try {
        const response = await fetch(`${apiUrl}/v1/epochs/${opensAt}/history?step=60`);
        const payload = (await response.json().catch(() => null)) as { data?: PreviewHistory } | null;
        if (current) setHeld({ key: opensAt, points: payload?.data ? historyEstimates(payload.data) : [] });
      } catch {
        if (current) setHeld((value) => value ?? { key: opensAt, points: [] });
      }
    };
    void load();
    const timer = running ? window.setInterval(() => void load(), SERIES_MS) : undefined;
    return () => {
      current = false;
      if (timer) window.clearInterval(timer);
    };
  }, [apiUrl, live, opensAt, started, running]);
  return held && held.key === opensAt ? held.points : [];
}

export function roundSeries(points: readonly Estimate[], id: string): Point[] {
  const first = points.find((point) => (point.references[id] ?? 0) > 0)?.references[id];
  if (!first) return [];
  return points.filter((point) => point.references[id] !== undefined).map((point) => ({ cutoff: point.at, value: (point.references[id]! / first) * 100 }));
}

const columns = "grid-cols-[1.5rem_minmax(0,1fr)_4.5rem_auto] sm:grid-cols-[1.5rem_minmax(0,1fr)_7rem_5rem_auto]";

export function AssetRows({ rows, series, title, action, onRow, rowLabel, toolbar }: { rows: readonly Move[]; series: readonly Estimate[]; title?: string; action: (row: Move) => ReactNode; onRow?: (row: Move) => void; rowLabel?: (row: Move) => string; toolbar?: ReactNode }) {
  const [query, setQuery] = useState("");
  const ranks = new Map(ordered(rows, "strong").map((row, index) => [row.id, index + 1]));
  const term = query.trim().toUpperCase();
  const shown = ordered(
    rows.filter((row) => row.id.toUpperCase().includes(term)),
    "strong",
  );

  return (
    <section className="min-w-0 rounded-[24px] bg-surface">
      <div className="flex flex-col gap-3 border-b border-white/[0.06] px-4 py-3">
        {(title || toolbar) && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {toolbar}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search coins" aria-label="Search assets" className="h-9 min-w-0 flex-1 rounded-control border border-line bg-bg px-3 text-xs text-ink placeholder:text-muted sm:max-w-64" />
          <span className="num ml-auto text-xs text-muted">{term ? `${shown.length} of ${rows.length}` : `${rows.length} assets`}</span>
        </div>
      </div>
      <div className={`hidden gap-3 px-4 pt-3 text-[11px] uppercase tracking-wide text-muted sm:grid ${columns}`}>
        <span />
        <span>Asset</span>
        <span>This round</span>
        <span className="text-right">Move</span>
        <span className="min-w-[5.5rem]" />
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted">No coin matches “{query.trim()}”.</p>
      ) : (
        <ul className="divide-y divide-white/[0.06]">
          {shown.map((row) => {
            const points = roundSeries(series, row.id);
            const body = (
              <>
                <span className="num text-right text-xs text-muted">{ranks.get(row.id)}</span>
                <span className="flex min-w-0 items-center gap-2.5">
                  <CoinIcon id={row.id} size={24} />
                  <span className="truncate text-sm font-medium">{row.id}</span>
                </span>
                <span className="hidden sm:block">{points.length > 1 && <Sparkline points={points} tone={row.change === null || row.change === 0 ? "flat" : row.change > 0 ? "up" : "down"} width={112} height={28} />}</span>
                <span className={`num text-right text-sm ${tone(row.change)}`}>{pct(row.change, 2)}</span>
                <span className="flex min-w-[5.5rem] justify-end">{action(row)}</span>
              </>
            );
            const shape = `grid w-full items-center gap-3 px-4 py-2.5 text-left ${columns}`;
            return (
              <li key={row.id}>
                {onRow ? (
                  <button type="button" onClick={() => onRow(row)} aria-label={rowLabel?.(row)} className={`${shape} cursor-pointer transition-colors duration-150 hover:bg-white/[0.03]`}>
                    {body}
                  </button>
                ) : (
                  <div className={shape}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
