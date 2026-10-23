"use client";

import type { PreviewPortfolio } from "@eox/app-api";
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
import { type Estimate, type Freshness, type SeriesKind, type WalletEstimate, ageText, appendHistory, estimateOf, freshnessOf, perMinute, sampled, seriesOf, walletEstimateOf } from "@/lib/estimate";
import { direction, formatAmount, formatPrice } from "@/lib/format";
import { CRYPTO_CLASS, type Point } from "@/lib/view";
import { useAccount } from "./account";
import { Change, ChangePill } from "./change";
import { Sparkline } from "./sparkline";
import { Figure } from "./stat-card";

const WALLET_MS = 5000;

interface Live {
  estimate: Estimate | null;
  freshness: Freshness;
  age: number | null;
  wallet: WalletEstimate | null;
  history: Estimate[];
}

const LiveContext = createContext<Live>({ estimate: null, freshness: "none", age: null, wallet: null, history: [] });

function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const { preview, market, live, owner, apiUrl, sequence } = useAccount();
  const now = useNow();
  const [held, setHeld] = useState<{ owner: string; portfolio: PreviewPortfolio | null } | null>(null);
  const [history, setHistory] = useState<Estimate[]>([]);

  useEffect(() => {
    if (!preview) return;
    const next = estimateOf(preview, market.decimals);
    setHistory((current) => appendHistory(current, next));
  }, [preview, market.decimals]);
  const freshness = now === null ? (preview ? "live" : "none") : freshnessOf(preview, now);
  const watching = live && owner !== null && freshness === "live" ? owner : null;

  useEffect(() => {
    if (!watching) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`${apiUrl}/v1/preview/portfolio?owner=${watching}`, { signal: controller.signal, cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as { data?: PreviewPortfolio } | null;
        setHeld({ owner: watching, portfolio: response.ok ? (payload?.data ?? null) : null });
      } catch {
        if (!controller.signal.aborted) setHeld({ owner: watching, portfolio: null });
      }
    };
    void load();
    const timer = window.setInterval(load, WALLET_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [watching, apiUrl, sequence]);

  const value = useMemo<Live>(() => {
    const estimate = preview ? estimateOf(preview, market.decimals) : null;
    const portfolio = held && held.owner === owner ? held.portfolio : null;
    const wallet = portfolio && freshness === "live" ? walletEstimateOf(portfolio, market.decimals, sequence) : null;
    return { estimate, freshness, age: preview && now !== null ? now - preview.record.timestamp : null, wallet, history };
  }, [preview, market.decimals, held, owner, freshness, now, sequence, history]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  return useContext(LiveContext);
}

type Kind = "price" | "reference" | "level" | "unitValue";

function liveNumber(estimate: Estimate | null, kind: Kind, id: string | undefined, sequence: number | null): number | null {
  if (!estimate) return null;
  if (kind === "level") return estimate.benchmark;
  if (!id) return null;
  if (kind === "price") return estimate.prices[id] ?? null;
  if (kind === "reference") return id === CRYPTO_CLASS ? 100 : (estimate.references[id] ?? null);
  if (estimate.basis === null || estimate.basis !== sequence) return null;
  return estimate.unitValues?.[id] ?? null;
}

function shown(kind: Kind, value: number): string {
  if (kind === "price") return formatPrice(value);
  if (kind === "unitValue") return formatAmount(value, 6);
  return formatAmount(value, 4);
}

function useValue(kind: Kind, id: string | undefined, committed: number | null): { value: number | null; estimated: boolean; stale: boolean } {
  const { estimate, freshness } = useLive();
  const { sequence } = useAccount();
  const value = liveNumber(estimate, kind, id, sequence);
  if (value === null) return { value: committed, estimated: false, stale: false };
  return { value, estimated: true, stale: freshness === "stale" };
}

export function LiveFigure({ kind, id, committed, unit, plain = false }: { kind: Kind; id?: string; committed: number | null; unit?: string; plain?: boolean }) {
  const { value, estimated, stale } = useValue(kind, id, committed);
  if (value === null) return <span className="text-muted">—</span>;
  const text = shown(kind, value);
  const title = estimated ? (stale ? "Estimate, not updating" : "Live estimate") : "Last settled value";
  return (
    <span title={title} className={`inline-flex items-center gap-2 transition-opacity duration-300 ${stale ? "opacity-60" : ""}`}>
      {plain ? <span className="num">{text}</span> : <Figure text={text} unit={unit} />}
    </span>
  );
}

function standingOf(kind: "reference" | "level", value: number | null): number | null {
  return value === null ? null : value / 100 - 1;
}

export function LiveChange({ kind, id, committed, pill = false }: { kind: "reference" | "level"; id?: string; committed: number | null; pill?: boolean }) {
  const { value, stale } = useValue(kind, id, committed === null ? null : (committed + 1) * 100);
  const ratio = standingOf(kind, value);
  if (ratio === null) return null;
  return <span className={stale ? "opacity-60" : undefined}>{pill ? <ChangePill ratio={ratio} /> : <Change ratio={ratio} />}</span>;
}

export function StandingNote({ id, committed }: { id: string; committed: number | null }) {
  const { value } = useValue("reference", id, committed === null ? null : (committed + 1) * 100);
  const ratio = standingOf("reference", value);
  if (ratio === null) return null;
  const way = direction(ratio);
  return <>{way === "up" ? "ahead of $CRYPTO" : way === "down" ? "behind $CRYPTO" : "level with $CRYPTO"}</>;
}

function settledText(cutoff: number, now: number | null): string {
  const date = new Date(cutoff * 1000);
  const time = `${date.toISOString().slice(11, 16)} UTC`;
  if (now !== null && new Date(now * 1000).toISOString().slice(0, 10) === date.toISOString().slice(0, 10)) return time;
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}, ${time}`;
}

export function EstimateBar({ settledAt }: { settledAt: number | null }) {
  const { freshness, age } = useLive();
  const now = useNow();
  const label = freshness === "live" ? "Live estimate" : freshness === "stale" ? `Estimate paused · ${age === null ? "" : ageText(age)}` : "Showing settled values";
  const tone = freshness === "stale" ? "text-warn" : "text-ink";
  return (
    <div className="border-b border-line bg-bg">
      <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs text-muted sm:px-6">
        <span className={tone}>{label}</span>
        {settledAt !== null && <span>Last settled on chain {settledText(settledAt, now)}</span>}
      </div>
    </div>
  );
}

const SPARK_POINTS = 120;

export function LiveSparkline({ kind, id, fallback, card = false }: { kind: SeriesKind; id?: string; fallback: Point[]; card?: boolean }) {
  const { history } = useLive();
  const live = perMinute(seriesOf(history, kind, id));
  const points = live.length > 1 ? sampled(live, SPARK_POINTS) : fallback;
  if (points.length < 2) return null;
  const last = points[points.length - 1].value;
  const tone = direction(kind === "price" ? last / points[0].value - 1 : last / 100 - 1);
  return card ? <Sparkline points={points} tone={tone} width={132} height={48} area fluid /> : <Sparkline points={points} tone={tone} />;
}
