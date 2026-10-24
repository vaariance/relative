"use client";

import type { Epoch, EpochLot, EpochOverview, PreviewHistory } from "@eox/app-api";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Activity, ArrowLeft, BarChart3, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock, Coins, LayoutList, Lock, Plus, Timer, X } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { walletEpochLots } from "@/app/actions";
import { parseScaled } from "@/lib/amounts";
import { COLLATERAL } from "@/lib/config";
import { type LotGroup, type Move, type Stage, STAGE_LABEL, TIMELINE, countdown, executionReferences, feeOf, lotView, moves, scoreOf, stageOf, timelineStep, units, utcTime, windowText } from "@/lib/epoch";
import { historyEstimates } from "@/lib/estimate";
import { formatAmount } from "@/lib/format";
import type { Intent } from "@/lib/requests";
import { useAccount } from "./account";
import { CoinIcon } from "./coin-icon";
import { useLive } from "./live";
import { SendButton } from "./send-button";

const REFERENCE_DIGITS = 12;
const PREVIEW_BASE = 100;
const LOTS_MS = 20_000;
const BASKET_SIZE = 30;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const card = "min-w-0 rounded-2xl border border-white/[0.06] bg-surface";
const gradient = "bg-[linear-gradient(90deg,#f2622e,#c2418f_60%,#7c3aed)]";
const primary = `flex h-11 w-full items-center justify-center gap-2 rounded-pill ${gradient} text-sm font-medium text-white`;
const pill = "inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-pill bg-surface-2 px-4 text-sm transition-colors duration-150 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";
const quiet = "flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-pill bg-surface-2 text-sm transition-colors duration-150 hover:bg-white/10";
const well = "rounded-xl bg-bg/70 p-3";
const eyebrow = "text-[11px] uppercase tracking-wider text-muted";

function useNow(start: number): number {
  const [now, setNow] = useState(start);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

function pct(value: number | null, digits = 3): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatAmount(Math.abs(value) * 100, digits)}%`;
}

function tone(value: number | null): string {
  return value === null || value === 0 ? "text-muted" : value > 0 ? "text-up" : "text-down";
}

function chip(value: number | null): string {
  return value === null || value === 0 ? "bg-surface-2 text-muted" : value > 0 ? "bg-up/15 text-up" : "bg-down/15 text-down";
}

function coinsOf(epoch: Epoch, roster: readonly string[]): string[] {
  if (epoch.universe.length > 0) return epoch.universe.map((member) => member.assetId);
  if (epoch.closingReferences.length > 0) return epoch.closingReferences.map((item) => item.assetId);
  return [...roster];
}

function pickDefault(epochs: readonly Epoch[], now: number): string | null {
  const open = epochs.find((epoch) => stageOf(epoch, now) === "open");
  const next = epochs.find((epoch) => stageOf(epoch, now) === "upcoming");
  const last = [...epochs].reverse().find((epoch) => stageOf(epoch, now) !== "upcoming");
  return (open ?? next ?? last ?? epochs[0])?.address ?? null;
}

function useOpeningReferences(epoch: Epoch | null, now: number): Record<string, number> | null {
  const { apiUrl, live } = useAccount();
  const [held, setHeld] = useState<{ key: number; references: Record<string, number> | null } | null>(null);
  const opensAt = epoch?.opensAt ?? null;
  const started = opensAt !== null && now >= opensAt;
  useEffect(() => {
    if (!live || opensAt === null || !started) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiUrl}/v1/preview/history?from=${opensAt - 120}&to=${opensAt + 300}&step=60`, { signal: controller.signal });
        const payload = (await response.json().catch(() => null)) as { data?: PreviewHistory } | null;
        const points = payload?.data ? historyEstimates(payload.data) : [];
        const atOpen = [...points].reverse().find((point) => point.at <= opensAt) ?? points[0];
        setHeld({ key: opensAt, references: atOpen?.references ?? null });
      } catch {
        if (!controller.signal.aborted) setHeld({ key: opensAt, references: null });
      }
    })();
    return () => controller.abort();
  }, [apiUrl, live, opensAt, started]);
  return held && held.key === opensAt ? held.references : null;
}

function useWalletCollateral(mint: string, decimals: number, refreshKey: number): number | null {
  const { connection } = useConnection();
  const { owner } = useAccount();
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    setBalance(null);
    if (!owner) return;
    let current = true;
    const wallet = new PublicKey(owner);
    const account = PublicKey.findProgramAddressSync([wallet.toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
    connection
      .getAccountInfo(account)
      .then((info) => {
        if (!current) return;
        const amount = info && info.owner.equals(TOKEN_PROGRAM) && info.data.length === 165 ? new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(64, true) : 0n;
        setBalance(Number(amount) / 10 ** decimals);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [connection, owner, mint, decimals, refreshKey]);
  return balance;
}

function CardHead({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3">
      <h2 className="flex items-center gap-2.5 text-sm font-medium">
        <span className="grid size-7 place-items-center rounded-full bg-surface-2 text-ink">{icon}</span>
        {title}
      </h2>
      {children}
    </div>
  );
}

function Figure({ main, dim, unit }: { main: string; dim?: string; unit?: string }) {
  return (
    <p className="num text-[2.5rem] font-semibold leading-none tracking-tight">
      {main}
      {dim && <span className="text-muted/50">{dim}</span>}
      {unit && <span className="ml-2 text-base font-normal text-muted">{unit}</span>}
    </p>
  );
}

function splitAmount(value: number | null, digits = 2): { main: string; dim?: string } {
  if (value === null) return { main: "—" };
  const text = formatAmount(value, digits);
  const dot = text.lastIndexOf(".");
  return dot < 0 ? { main: text } : { main: text.slice(0, dot), dim: text.slice(dot) };
}

function ModeSwitch() {
  return (
    <div role="tablist" aria-label="Mode" className="inline-flex rounded-pill bg-surface p-1">
      <Link href="/markets" role="tab" aria-selected={false} className="rounded-pill px-4 py-1.5 text-sm text-muted transition-colors duration-150 hover:text-ink">Basic</Link>
      <span role="tab" aria-selected className="rounded-pill bg-surface-2 px-4 py-1.5 text-sm font-medium text-ink">Epoch</span>
    </div>
  );
}

const STAGE_TONE: Record<Stage, string> = {
  upcoming: "bg-surface-2 text-muted",
  open: "bg-up/15 text-up",
  closing: "bg-warn/15 text-warn",
  scoring: "bg-warn/15 text-warn",
  allocating: "bg-warn/15 text-warn",
  settled: "bg-surface-2 text-ink",
  voided: "bg-warn/15 text-warn",
};

function StageChip({ stage }: { stage: Stage }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-[11px] font-medium ${STAGE_TONE[stage]}`}><span className="size-1.5 rounded-full bg-current" />{STAGE_LABEL[stage]}</span>;
}

function bannerText(epoch: Epoch, stage: Stage): string {
  switch (stage) {
    case "upcoming":
      return `This Epoch opens at ${utcTime(epoch.opensAt)} UTC. Entries open then.`;
    case "open":
      return `Entries are open until ${utcTime(epoch.closesAt)} UTC. Each entry starts from its execution reference, not from your click.`;
    case "closing":
      return `Waiting for the closing reference at ${utcTime(epoch.closesAt)} UTC. A later market price is never substituted.`;
    case "scoring":
    case "allocating":
      return "Scores and payouts are being calculated. Withdrawals open when allocation finishes.";
    case "settled":
      return "This Epoch is settled. Any payout or refund is withdrawable from My entries.";
    case "voided":
      return "No qualifying closing data within 24 hours of the close. Every entry is refundable in full.";
  }
}

function Banner({ epoch, stage }: { epoch: Epoch; stage: Stage }) {
  const key = `${epoch.address}:${stage}`;
  const [hidden, setHidden] = useState<string | null>(null);
  if (hidden === key) return null;
  return (
    <div className={`flex items-center gap-3 rounded-xl border border-white/[0.06] px-4 py-2.5 text-xs ${stage === "voided" ? "bg-warn/10 text-warn" : "bg-[linear-gradient(90deg,rgba(242,98,46,0.22),rgba(194,65,143,0.12)_55%,rgba(124,58,237,0.06))] text-ink"}`}>
      <CircleAlert size={15} aria-hidden="true" className="shrink-0" />
      <p className="min-w-0 flex-1">{bannerText(epoch, stage)}</p>
      <button type="button" onClick={() => setHidden(key)} aria-label="Dismiss" className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full text-muted hover:text-ink">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

function ClockCard({ epochs, epoch, now, canEnter, onSelect, onEnter }: { epochs: Epoch[]; epoch: Epoch; now: number; canEnter: boolean; onSelect: (address: string) => void; onEnter: () => void }) {
  const mounted = useMounted();
  const stage = stageOf(epoch, now);
  const index = epochs.findIndex((item) => item.address === epoch.address);
  const previous = epochs[index - 1];
  const next = epochs[index + 1];
  const local = mounted ? new Date(epoch.closesAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  const ticking = stage === "open" || stage === "upcoming";
  const time = ticking ? countdown((stage === "open" ? epoch.closesAt : epoch.opensAt) - now) : null;
  const label = stage === "open" ? "Closes in" : stage === "upcoming" ? "Opens in" : "Closed at";

  return (
    <section className={`${card} flex flex-col gap-5 p-5`}>
      <CardHead icon={<Timer size={14} aria-hidden="true" />} title="Epoch">
        <span className="num text-xs text-muted">{windowText(epoch)}</span>
      </CardHead>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-3">
          <span className={eyebrow}>{label}</span>
          {time ? <Figure main={time.slice(0, 5)} dim={time.slice(5)} /> : <Figure main={utcTime(epoch.closesAt)} unit="UTC" />}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <StageChip stage={stage} />
            <span className="num">Closes {utcTime(epoch.closesAt)} UTC{local ? ` · ${local} your time` : ""}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canEnter && (
            <button type="button" onClick={onEnter} className={`hidden h-9 cursor-pointer items-center gap-1.5 rounded-pill px-4 text-sm font-medium text-white shadow-none xl:inline-flex xl:shadow-[0_0_24px_rgba(242,98,46,0.35)] ${gradient}`}>
              <Plus size={14} aria-hidden="true" /> New entry
            </button>
          )}
          <button type="button" className={pill} disabled={!previous} onClick={() => previous && onSelect(previous.address)}>
            <ChevronLeft size={14} aria-hidden="true" /> Previous
          </button>
          <button type="button" className={pill} disabled={!next} onClick={() => next && onSelect(next.address)}>
            Next <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}

function PotCard({ epoch, now, decimals }: { epoch: Epoch; now: number; decimals: number }) {
  const stage = stageOf(epoch, now);
  const step = timelineStep(stage);
  const settled = epoch.settlementPot !== null && (stage === "allocating" || stage === "settled");
  const net = settled ? units(epoch.settlementPot!, decimals) : epoch.ledger ? units(epoch.ledger.activeNet, decimals) : null;
  const queued = epoch.ledger ? units(epoch.ledger.pendingGross, decimals) : null;
  const entries = epoch.nextNonce !== null ? Number(epoch.nextNonce) : (epoch.lots?.executed ?? null);
  const figure = splitAmount(net);

  return (
    <section className={`${card} flex flex-col gap-5 p-5`}>
      <CardHead icon={<Coins size={14} aria-hidden="true" />} title="Pot" />
      <div className="flex flex-col gap-3">
        <span className={eyebrow}>{settled ? "Settlement pot" : "Net stake pot"}</span>
        <Figure main={figure.main} dim={figure.dim} unit={COLLATERAL.symbol} />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="num rounded-pill bg-surface-2 px-2 py-0.5">{entries ?? "—"} entries</span>
          <span className="num text-muted">Queued {queued === null ? "—" : formatAmount(queued, 2)} {COLLATERAL.symbol}</span>
        </div>
      </div>
      <div className="flex gap-1" aria-hidden="true">
        {TIMELINE.map((label, index) => (
          <span key={label} className={`h-1.5 flex-1 rounded-full ${stage === "voided" ? "bg-warn/40" : index < step ? "bg-accent" : index === step ? "bg-accent/40" : "bg-surface-2"}`} />
        ))}
      </div>
    </section>
  );
}

function PromoCard({ onExplain }: { onExplain: () => void }) {
  return (
    <section className="relative isolate flex min-w-0 flex-col justify-between gap-5 overflow-hidden rounded-2xl p-5">
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(120%_120%_at_0%_0%,#f2622e_0%,#b23a74_45%,#3b1d6e_100%)] opacity-90" />
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(60%_60%_at_100%_100%,rgba(0,0,0,0.35),transparent)]" />
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold leading-tight text-white">One pot. Four hours.</h2>
        <p className="text-xs leading-relaxed text-white/80">Every entry backs one coin in a basket of 30 and counts from its own execution. At the close, the pot is shared by score: your coin's share of the basket's gains, weighted by your net stake.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onExplain} aria-haspopup="dialog" className="h-9 cursor-pointer rounded-pill bg-white px-4 text-sm font-medium text-black transition-opacity duration-150 hover:opacity-90">
          How payouts work
        </button>
        <span className="inline-flex h-9 items-center rounded-pill bg-white/15 px-4 text-sm text-white backdrop-blur">30 coins · 4 hours</span>
      </div>
    </section>
  );
}

interface Slide {
  kicker: string;
  title: string;
  body: string;
  visual?: "split";
}

const PAYOUT_SLIDES: Slide[] = [
  { kicker: "Step 1", title: "Back a coin", body: "Pick one coin in a basket of 30. Each coin's move runs from your entry's execution to the close, measured against $CRYPTO." },
  { kicker: "Step 2", title: "Get a score", body: "Your coin's rise as a share of all the basket's rises, your own coin included. Coins that did worse than $CRYPTO count as zero." },
  { kicker: "Step 3", title: "Weight it", body: "Your score is multiplied by your net stake." },
  { kicker: "Step 4", title: "Share the pot", body: "Each entry is paid its weight's share of the total weight of all entries. An entry with a score of zero gets nothing back." },
  { kicker: "Example", title: "Two entries, one pot", body: "Two 100 USDC entries, each with a net stake of 99.98 after the fee. Scores of 10% and 30% split the 199.96 pot 25% / 75%. The first coin beat $CRYPTO, yet that entry gets back 49.99 of its 100.", visual: "split" },
  { kicker: "Good to know", title: "Scores are not odds", body: "Other entries' stakes, entry times and scores decide the money, and several entries can be paid. If every score is zero, everyone is refunded in full, fee included." },
];

function PayoutModal({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const last = PAYOUT_SLIDES.length - 1;
  const slide = PAYOUT_SLIDES[index];

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") setIndex((value) => Math.min(last, value + 1));
      if (event.key === "ArrowLeft") setIndex((value) => Math.max(0, value - 1));
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", key);
    };
  }, [onClose, last]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-6" onClick={onClose}>
      <div aria-hidden="true" className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <section
        role="dialog"
        aria-modal="true"
        aria-roledescription="carousel"
        aria-labelledby="payout-title"
        onClick={(event) => event.stopPropagation()}
        className="relative isolate flex w-full max-w-md flex-col overflow-hidden rounded-t-3xl border border-white/[0.08] bg-surface shadow-[0_30px_80px_rgba(0,0,0,0.6)] sm:rounded-3xl"
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-64 bg-[radial-gradient(90%_100%_at_15%_0%,rgba(242,98,46,0.32),transparent_70%),radial-gradient(70%_100%_at_100%_0%,rgba(124,58,237,0.22),transparent_70%)]" />

        <header className="flex items-center justify-between px-7 pt-6">
          <span className="text-[11px] uppercase tracking-[0.2em] text-accent">How payouts work</span>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-9 cursor-pointer place-items-center rounded-full bg-white/5 text-muted transition-colors duration-150 hover:bg-white/10 hover:text-ink">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div key={index} aria-live="polite" className="flex min-h-[300px] flex-col gap-5 px-7 pb-4 pt-8 motion-safe:animate-[slide-in_200ms_ease-out]">
          <span className={`grid size-12 place-items-center rounded-2xl text-lg font-semibold text-white shadow-[0_8px_30px_rgba(242,98,46,0.35)] ${gradient}`}>
            {index < 4 ? index + 1 : index === 4 ? "Ex" : "!"}
          </span>
          <div className="flex flex-col gap-3">
            <span className="text-[11px] uppercase tracking-wider text-muted">{slide.kicker}</span>
            <h2 id="payout-title" className="text-2xl font-semibold tracking-tight">{slide.title}</h2>
            <p className="text-sm leading-relaxed text-muted">{slide.body}</p>
          </div>
          {slide.visual === "split" && (
            <div className="mt-auto flex flex-col gap-2">
              <div className="flex h-10 overflow-hidden rounded-xl text-xs font-medium">
                <span className="flex w-1/4 items-center justify-center bg-surface-2 text-muted">49.99</span>
                <span className={`flex w-3/4 items-center justify-center text-white ${gradient}`}>149.97</span>
              </div>
              <div className="flex justify-between text-[11px] text-muted"><span>Score 10%</span><span>Score 30%</span></div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-4 px-7 pb-7 pt-4">
          <div className="flex items-center gap-1.5" role="tablist" aria-label="Slides">
            {PAYOUT_SLIDES.map((item, dot) => (
              <button
                key={item.title}
                type="button"
                role="tab"
                aria-selected={dot === index}
                aria-label={`${item.kicker}: ${item.title}`}
                onClick={() => setIndex(dot)}
                className={`h-1.5 cursor-pointer rounded-full transition-all duration-200 ${dot === index ? "w-6 bg-accent" : "w-1.5 bg-white/20 hover:bg-white/40"}`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setIndex(index - 1)} disabled={index === 0} aria-label="Previous" className="grid size-10 cursor-pointer place-items-center rounded-full bg-white/5 text-ink transition-colors duration-150 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30">
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            {index < last ? (
              <button type="button" onClick={() => setIndex(index + 1)} className={`inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-full px-5 text-sm font-medium text-white ${gradient}`}>
                Next <ChevronRight size={16} aria-hidden="true" />
              </button>
            ) : (
              <button type="button" onClick={onClose} className="inline-flex h-10 cursor-pointer items-center rounded-full bg-white px-5 text-sm font-medium text-black">
                Got it
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function MovesCard({ epoch, coins, now, backed, canPick, onPick }: { epoch: Epoch; coins: string[]; now: number; backed: string | null; canPick: boolean; onPick: (id: string) => void }) {
  const { estimate, freshness } = useLive();
  const stage = stageOf(epoch, now);
  const opening = useOpeningReferences(epoch, now);
  const closing = useMemo(() => {
    if (epoch.closingReferences.length === 0) return null;
    return Object.fromEntries(epoch.closingReferences.map((item) => [item.assetId, (Number(BigInt(item.reference)) / 10 ** REFERENCE_DIGITS) * PREVIEW_BASE]));
  }, [epoch.closingReferences]);
  const end = closing ?? (stage === "open" ? (estimate?.references ?? null) : null);
  const rows = moves(coins, opening, end);
  const scored = rows.filter((row) => row.change !== null);
  const largest = Math.max(1e-9, ...scored.map((row) => Math.abs(row.change ?? 0)));
  const ready = opening !== null && end !== null && scored.length > 0;
  const leader = scored[0] ?? null;
  const laggard = scored[scored.length - 1] ?? null;
  const above = scored.filter((row) => (row.change ?? 0) > 0).length;
  const below = scored.filter((row) => (row.change ?? 0) < 0).length;
  const focus = (backed ? rows.find((row) => row.id === backed) : null) ?? leader;

  const basis = closing
    ? `Closing reference · ${utcTime(epoch.closesAt, true)} UTC`
    : freshness === "live" && estimate
      ? `Live estimate · ${utcTime(estimate.at, true)} UTC`
      : estimate
        ? `Estimate paused · ${utcTime(estimate.at, true)} UTC`
        : "Estimate unavailable";

  const stats = [
    { label: "Leader", value: leader ? leader.id : "—", change: leader?.change ?? null },
    { label: "Laggard", value: laggard ? laggard.id : "—", change: laggard?.change ?? null },
    { label: "Ahead of $CRYPTO", value: ready ? String(above) : "—", change: null },
    { label: "Behind $CRYPTO", value: ready ? String(below) : "—", change: null },
  ];

  return (
    <section className={`${card} flex flex-col`}>
      <div className="flex flex-col gap-5 p-5">
        <CardHead icon={<BarChart3 size={14} aria-hidden="true" />} title="Relative moves since Epoch start">
          {stage !== "upcoming" && <span className={`num rounded-pill px-2.5 py-1 text-[11px] ${closing ? "bg-surface-2 text-ink" : freshness === "live" ? "bg-surface-2 text-muted" : "bg-warn/15 text-warn"}`}>{basis}</span>}
        </CardHead>

        {ready && focus && (
          <div className="flex flex-wrap items-end justify-between gap-5">
            <div className="flex flex-col gap-3">
              <span className={`${eyebrow} flex items-center gap-2`}>
                <CoinIcon id={focus.id} size={18} />
                {focus.id} · {focus.id === backed ? "selected" : "leading"} · since {utcTime(epoch.opensAt)} UTC
              </span>
              <p className={`num text-[2.5rem] font-semibold leading-none tracking-tight ${tone(focus.change)}`}>{pct(focus.change)}</p>
            </div>
            <dl className="grid flex-1 grid-cols-2 gap-px overflow-hidden rounded-xl bg-white/[0.06] sm:max-w-xl sm:grid-cols-4">
              {stats.map((stat) => (
                <div key={stat.label} className="flex flex-col gap-1.5 bg-surface px-3 py-2.5">
                  <dt className="text-[11px] text-muted">{stat.label}</dt>
                  <dd className="flex items-center gap-1.5">
                    <span className="num text-sm font-medium">{stat.value}</span>
                    {stat.change !== null && <span className={`num rounded-pill px-1.5 py-0.5 text-[10px] ${chip(stat.change)}`}>{pct(stat.change, 2)}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {ready && stage === "open" && (
          <p className={`${well} flex items-start gap-2 text-xs text-muted`}>
            <Clock size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
            These moves started at {utcTime(epoch.opensAt)} UTC. A new entry counts only from its own execution, so moves before then do not count toward it.
          </p>
        )}
      </div>

      {stage === "upcoming" ? (
        <p className="px-5 pb-10 pt-4 text-center text-sm text-muted">Moves appear once this Epoch opens at {utcTime(epoch.opensAt)} UTC.</p>
      ) : !ready ? (
        <p className="px-5 pb-10 pt-4 text-center text-sm text-muted">{stage === "open" ? "Loading the opening references…" : "Awaiting the closing reference. A later market price is not substituted."}</p>
      ) : (
        <>
          <div className={`grid grid-cols-[28px_minmax(0,1fr)_88px] gap-4 border-t border-white/[0.06] px-5 py-2 sm:grid-cols-[28px_150px_minmax(0,1fr)_88px] ${eyebrow}`}>
            <span>#</span>
            <span>Asset</span>
            <span className="hidden text-center sm:block">vs $CRYPTO</span>
            <span className="text-right">Move</span>
          </div>
          <ul className="max-h-[440px] overflow-y-auto [scrollbar-color:rgba(255,255,255,0.12)_transparent] [scrollbar-width:thin]">
            {rows.map((row, index) => (
              <MoveRow key={row.id} rank={index + 1} row={row} largest={largest} backed={row.id === backed} canPick={canPick} onPick={() => onPick(row.id)} />
            ))}
          </ul>
        </>
      )}
      <p className="border-t border-white/[0.06] px-5 py-3 text-[11px] text-muted">0% means matching $CRYPTO over the interval, not an unchanged USD price. This ranks assets since the Epoch opened, not entries or payouts.</p>
    </section>
  );
}

function MoveRow({ rank, row, largest, backed, canPick, onPick }: { rank: number; row: Move; largest: number; backed: boolean; canPick: boolean; onPick: () => void }) {
  const width = row.change === null ? 0 : Math.round((Math.abs(row.change) / largest) * 50);
  const bar = backed ? gradient : row.change !== null && row.change >= 0 ? "bg-[linear-gradient(90deg,rgba(62,207,142,0.25),#3ecf8e)]" : "bg-[linear-gradient(270deg,rgba(240,97,109,0.25),#f0616d)]";
  const content = (
    <>
      <span className="num text-xs text-muted">{rank}</span>
      <span className="flex min-w-0 items-center gap-2.5">
        <CoinIcon id={row.id} size={22} />
        <span className="truncate text-sm font-medium">{row.id}</span>
        {backed && <span className="rounded-pill bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">Backed</span>}
      </span>
      <span className="relative hidden h-1.5 sm:block" aria-hidden="true">
        <span className="absolute inset-y-[-4px] left-1/2 w-px bg-white/10" />
        {row.change !== null && <span className={`absolute inset-y-0 rounded-full ${bar}`} style={row.change >= 0 ? { left: "50%", width: `${width}%` } : { right: "50%", width: `${width}%` }} />}
      </span>
      <span className={`num text-right text-sm ${tone(row.change)}`}>{pct(row.change)}</span>
    </>
  );
  const grid = `grid w-full grid-cols-[28px_minmax(0,1fr)_88px] items-center gap-4 px-5 py-2.5 text-left sm:grid-cols-[28px_150px_minmax(0,1fr)_88px] ${backed ? "bg-accent/[0.07]" : ""}`;
  return (
    <li>
      {canPick ? (
        <button type="button" onClick={onPick} className={`${grid} cursor-pointer transition-colors duration-150 hover:bg-white/[0.03]`} aria-label={`Back ${row.id}`}>
          {content}
        </button>
      ) : (
        <div className={grid}>{content}</div>
      )}
    </li>
  );
}

function SettlementCard({ epoch, now }: { epoch: Epoch; now: number }) {
  const stage = stageOf(epoch, now);
  const step = timelineStep(stage);
  return (
    <section className={`${card} flex flex-col gap-4 p-5`}>
      <CardHead icon={<Activity size={14} aria-hidden="true" />} title="Settlement">
        <StageChip stage={stage} />
      </CardHead>
      {stage === "voided" ? (
        <p className="flex items-start gap-2 text-xs text-warn"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />No qualifying closing data within 24 hours of the close. Every entry is refundable in full.</p>
      ) : (
        <ol className="flex flex-col">
          {TIMELINE.map((label, index) => {
            const done = index < step;
            const current = index === step;
            const last = index === TIMELINE.length - 1;
            return (
              <li key={label} className="flex gap-3">
                <span className="flex flex-col items-center">
                  <span className={`grid size-6 shrink-0 place-items-center rounded-full ${done ? "bg-accent text-white" : current ? "bg-accent/20" : "bg-surface-2"}`}>
                    {done && <Check size={13} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" />}
                    {current && <span className="size-2 rounded-full bg-accent" />}
                  </span>
                  {!last && <span className={`w-px flex-1 ${done ? "bg-accent/60" : "bg-white/10"}`} />}
                </span>
                <span className={`flex flex-wrap items-center gap-x-1.5 pb-4 pt-0.5 text-xs ${current ? "font-medium text-ink" : done ? "text-ink/80" : "text-muted"}`}>
                  {label}
                  {current && label === "Closing reference" && <span className="num text-muted">· {utcTime(epoch.closesAt, true)} UTC</span>}
                  {current && label === "Scoring" && epoch.lots && <span className="num text-muted">· {epoch.lots.scored} of {epoch.lots.executed}</span>}
                  {current && label === "Allocating payouts" && epoch.lots && <span className="num text-muted">· {epoch.lots.allocated} of {epoch.lots.executed}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function EntryPanel(props: { epoch: Epoch; coins: string[]; now: number; decimals: number; fee: { bps: number; cap: string }; mint: string; backed: string | null; onBacked: (id: string) => void; onSent: () => void; onClose?: () => void }) {
  const { epoch, coins, now, decimals, fee, backed } = props;
  const { owner } = useAccount();
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState(false);
  const [showBasket, setShowBasket] = useState(false);
  const [sent, setSent] = useState(0);
  const wallet = useWalletCollateral(props.mint, decimals, sent);
  const stage = stageOf(epoch, now);
  const open = stage === "open" && epoch.entriesOpen;
  const gross = amount.trim() === "" ? null : parseScaled(amount, decimals);
  const charge = gross !== null && gross > 0n ? feeOf(gross, fee.bps, BigInt(fee.cap)) : null;
  const net = gross !== null && charge !== null ? gross - charge : null;
  const exact = coins.length === BASKET_SIZE;
  const short = wallet !== null && gross !== null && Number(gross) / 10 ** decimals > wallet;
  const problem = !backed ? "Choose the asset to back." : gross === null || gross <= 0n ? "Enter a stake above zero." : !exact ? "This Epoch's asset list is not available yet." : short ? `Your wallet has ${formatAmount(wallet ?? 0, 2)} ${COLLATERAL.symbol}.` : null;
  const intent: Intent | null = open && problem === null && gross !== null && backed !== null ? { operation: "epoch-entry", opensAt: epoch.opensAt, grossStake: gross.toString(), basket: coins, backedAsset: backed } : null;
  const show = (value: bigint | null) => (value === null ? "—" : `${formatAmount(Number(value) / 10 ** decimals, 2)} ${COLLATERAL.symbol}`);

  const closedReason =
    stage === "upcoming"
      ? `This Epoch opens at ${utcTime(epoch.opensAt)} UTC. It is shown for information until entries open.`
      : stage === "open"
        ? "This Epoch is not taking entries right now (for example it is full or paused)."
        : "This Epoch has closed. New entries go into a later Epoch.";

  const head = (
    <CardHead icon={<Plus size={14} aria-hidden="true" />} title={review ? "Review entry" : "Create entry"}>
      {props.onClose && (
        <button type="button" onClick={props.onClose} aria-label="Close" className="grid size-8 cursor-pointer place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink">
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </CardHead>
  );

  if (!open) {
    return (
      <section id="epoch-entry" className={`${card} flex flex-col gap-4 p-5`}>
        {head}
        <div className={`${well} flex items-start gap-3 text-sm text-muted`}>
          <Clock size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          {closedReason}
        </div>
      </section>
    );
  }

  if (review && intent && gross !== null && charge !== null && net !== null && backed) {
    return (
      <section id="epoch-entry" className={`${card} flex flex-col gap-4 p-5`}>
        {head}
        <div className={`${well} flex items-center gap-3`}>
          <CoinIcon id={backed} size={32} />
          <span className="text-base font-semibold">{backed}</span>
          <span className="rounded-pill bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">Backed</span>
          <span className="num ml-auto text-xs text-muted">in a 30-coin basket</span>
        </div>
        <dl className="flex flex-col gap-2 text-xs">
          <div className="flex justify-between gap-4"><dt className="text-muted">Gross stake</dt><dd className="num text-right">{show(gross)}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">Entry fee, held</dt><dd className="num text-right">{show(charge)}</dd></div>
          <div className="flex justify-between gap-4 text-sm font-medium"><dt>Net stake</dt><dd className="num text-right">{show(net)}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">Closes</dt><dd className="num text-right">{utcTime(epoch.closesAt)} UTC · in {countdown(epoch.closesAt - now)}</dd></div>
        </dl>
        <ul className={`${well} flex flex-col gap-1.5 text-[11px] text-muted`}>
          <li className="flex gap-2"><Lock size={12} aria-hidden="true" className="mt-0.5 shrink-0" />The backed asset and basket are fixed once submitted. There is no early exit after execution.</li>
          <li className="flex gap-2"><Clock size={12} aria-hidden="true" className="mt-0.5 shrink-0" />Performance starts from the execution reference, not from this click. If it cannot execute before the close, the entry is refundable.</li>
          <li className="flex gap-2"><CircleAlert size={12} aria-hidden="true" className="mt-0.5 shrink-0" />Positive relative performance does not guarantee a profit.</li>
        </ul>
        <div className="flex flex-col gap-2">
          <SendButton
            intent={intent}
            label="Confirm in wallet"
            connectLabel="Connect wallet"
            describe={`Your ${backed} entry was submitted. It starts at its execution reference.`}
            onDone={() => {
              setAmount("");
              setReview(false);
              setSent((count) => count + 1);
              props.onSent();
            }}
            className={`h-11 rounded-pill ${gradient} text-sm font-medium text-white`}
          />
          <button type="button" onClick={() => setReview(false)} className={quiet}><ArrowLeft size={14} aria-hidden="true" /> Edit</button>
        </div>
      </section>
    );
  }

  return (
    <section id="epoch-entry" className={`${card} flex flex-col gap-4 p-5`}>
      {head}

      <div className="flex flex-col gap-1.5">
        <div className={`${well} flex flex-col gap-3`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted">Back</span>
            <span className="relative">
              <select aria-label="Backed asset" value={backed ?? ""} onChange={(event) => props.onBacked(event.target.value)} className="h-8 cursor-pointer appearance-none rounded-pill bg-surface-2 pl-3 pr-8 text-xs font-medium">
                <option value="" disabled>Choose</option>
                {coins.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
              <ChevronDown size={12} aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted" />
            </span>
          </div>
          <div className="flex items-center gap-3">
            {backed ? <CoinIcon id={backed} size={30} /> : <span className="grid size-[30px] place-items-center rounded-full border border-dashed border-white/20 text-muted"><Plus size={14} aria-hidden="true" /></span>}
            <span className="num text-2xl font-semibold">{backed ?? "Pick a coin"}</span>
          </div>
        </div>
        <div className={`${well} flex flex-col gap-2`}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted">Basket</span>
            <span className="num text-[11px] text-muted">{coins.length} / {BASKET_SIZE}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">{exact ? `30 coins · 1 backed + 29 comparison` : "Asset list not available"}</span>
            {exact && <button type="button" onClick={() => setShowBasket(!showBasket)} className="cursor-pointer text-xs text-accent underline-offset-4 hover:underline">{showBasket ? "Hide" : "View basket"}</button>}
          </div>
          {exact && <p className="text-[11px] text-muted">All 30 eligible coins are included this Epoch. Your score compares your coin's rise with the rises of all 30, including your own.</p>}
          {showBasket && (
            <ul className="flex flex-wrap gap-1.5 pt-1">
              {coins.map((id) => (
                <li key={id} className={`num rounded-pill px-2 py-0.5 text-[11px] ${id === backed ? "bg-accent/20 text-accent" : "bg-surface-2 text-muted"}`}>{id}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className={`${well} flex flex-col gap-2`}>
        <div className="flex items-center justify-between text-[11px] text-muted">
          <label htmlFor="epoch-stake">Stake</label>
          {owner && <span className="num">Wallet {wallet === null ? "…" : formatAmount(wallet, 2)} {COLLATERAL.symbol}</span>}
        </div>
        <div className="flex items-center gap-2">
          <input id="epoch-stake" inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} className="num min-w-0 flex-1 bg-transparent text-2xl font-semibold text-ink outline-none placeholder:text-muted/50" />
          <span className="text-xs text-muted">{COLLATERAL.symbol}</span>
        </div>
      </div>

      <dl className="flex flex-col gap-1.5 text-xs">
        <div className="flex justify-between"><dt className="text-muted">Entry fee ({fee.bps / 100}%, held to settlement)</dt><dd className="num">{show(charge)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Net stake</dt><dd className="num font-medium text-ink">{show(net)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Closes</dt><dd className="num">{utcTime(epoch.closesAt)} UTC</dd></div>
      </dl>

      <div className="flex flex-col gap-2">
        <button type="button" disabled={problem !== null} onClick={() => setReview(true)} className={`${primary} ${problem === null ? "cursor-pointer hover:opacity-90" : "cursor-not-allowed opacity-40"}`}>
          Review entry
        </button>
        {amount.trim() !== "" && problem && <p className="text-xs text-muted">{problem}</p>}
        <p className="text-[11px] text-muted">Each entry is separate. Entering again creates a new entry, not a top-up.</p>
      </div>
    </section>
  );
}

const GROUPS: { id: LotGroup; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "active", label: "Active" },
  { id: "withdrawable", label: "Withdrawable" },
  { id: "history", label: "History" },
];

const STATUS_TONE: Record<LotGroup, string> = {
  withdrawable: "bg-accent/15 text-accent",
  pending: "bg-warn/15 text-warn",
  active: "bg-up/15 text-up",
  history: "bg-surface-2 text-muted",
};

const TABLE = "grid min-w-[820px] grid-cols-[minmax(130px,1.1fr)_minmax(150px,1.2fr)_minmax(130px,1fr)_minmax(110px,0.9fr)_minmax(150px,1.3fr)_70px_minmax(120px,1fr)_150px] items-center gap-3 px-5";

function useEntryMoves(lot: EpochLot, epoch: Epoch | null): { rows: Move[]; backed: Move | null; basis: string | null } {
  const { estimate, freshness } = useLive();
  return useMemo(() => {
    const start = executionReferences(lot, PREVIEW_BASE);
    if (!start || !epoch) return { rows: [], backed: null, basis: null };
    let end: Record<string, number> | null = null;
    let basis: string | null = null;
    if (epoch.closingReferences.length > 0) {
      end = Object.fromEntries(epoch.closingReferences.map((item) => [item.assetId, (Number(BigInt(item.reference)) / 10 ** REFERENCE_DIGITS) * PREVIEW_BASE]));
      basis = "at close";
    } else if (epoch.phase === "open" && estimate && estimate.at < epoch.closesAt && estimate.at >= (lot.execution?.timestamp ?? Infinity)) {
      end = estimate.references;
      basis = freshness === "live" ? "live estimate" : "estimate paused";
    }
    if (!end) return { rows: [], backed: null, basis: null };
    const rows = moves(lot.basket, start, end);
    return { rows, backed: rows.find((row) => row.id === lot.backedAsset) ?? null, basis };
  }, [lot, epoch, estimate, freshness]);
}

function EntryRow({ lot, epoch, decimals, onSent }: { lot: EpochLot; epoch: Epoch | null; decimals: number; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const view = lotView(lot, epoch);
  const since = useEntryMoves(lot, epoch);
  const gross = units(lot.grossStake, decimals);
  const net = gross - units(lot.fee, decimals);
  const score = scoreOf(lot);
  const claimable = lot.claimable === null ? null : units(lot.claimable, decimals);
  const owed = claimable !== null && claimable > 0 && lot.state !== "withdrawn";
  const result = claimable !== null && lot.state !== "withdrawn" ? claimable - gross : null;

  return (
    <li className="border-t border-white/[0.06]">
      <div className={`${TABLE} py-3 text-xs`}>
        <span className="flex items-center gap-2">
          <CoinIcon id={lot.backedAsset} size={26} />
          <span className="flex flex-col">
            <span className="text-sm font-medium">{lot.backedAsset}</span>
            <span className="num text-[10px] text-muted">#{lot.nonce}</span>
          </span>
        </span>
        <span className="num text-muted">{epoch ? windowText(epoch) : `${utcTime(lot.epochOpensAt)} UTC`}</span>
        <span><span className={`inline-flex rounded-pill px-2 py-0.5 text-[11px] ${STATUS_TONE[view.group]}`}>{view.label}</span></span>
        <span className="num flex flex-col">
          <span>{formatAmount(gross, 2)}</span>
          <span className="text-[10px] text-muted">net {formatAmount(net, 2)}</span>
        </span>
        <span className="num flex flex-col">
          <span className="text-muted">{lot.execution ? `Executed ${utcTime(lot.execution.timestamp, true)}` : `Entered ${utcTime(lot.admittedAt, true)} · awaiting`}</span>
          {since.backed && since.backed.change !== null && (
            <span className="text-[10px]">
              <span className={tone(since.backed.change)}>{lot.backedAsset} {pct(since.backed.change, 2)}</span>
              <span className="text-muted"> since execution · {since.basis}</span>
            </span>
          )}
        </span>
        <span className="num">{score === null ? "—" : `${formatAmount(score * 100, 2)}%`}</span>
        <span className="num flex flex-col">
          <span>{claimable === null ? "Not settled" : `${formatAmount(claimable, 4)} ${view.refund ? "refund" : ""}`}</span>
          {result !== null && !view.refund && <span className={`text-[10px] ${tone(result)}`}>{result >= 0 ? "+" : "−"}{formatAmount(Math.abs(result), 4)}</span>}
        </span>
        <span className="flex items-center justify-end gap-2">
          {owed && epoch ? (
            <SendButton
              intent={{ operation: "epoch-withdraw", opensAt: epoch.opensAt, nonce: lot.nonce }}
              label={view.refund ? "Withdraw refund" : "Withdraw"}
              connectLabel="Connect wallet"
              onDone={onSent}
              className={`h-8 rounded-pill px-3 text-xs font-medium text-white ${gradient}`}
            />
          ) : null}
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Show basket" className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink">
            <ChevronDown size={14} aria-hidden="true" className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
          </button>
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-2 px-5 pb-3">
          <p className="text-[11px] text-muted">
            {since.rows.length > 0 && lot.execution
              ? `Basket moves against $CRYPTO since your execution at ${utcTime(lot.execution.timestamp, true)} UTC · ${since.basis}`
              : lot.execution
                ? "Basket. Moves since your execution appear when an estimate or the closing reference is available."
                : "Basket. Moves start once this entry executes."}
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {(since.rows.length > 0 ? since.rows : lot.basket.map((id) => ({ id, change: null }))).map((row) => (
              <li key={row.id} className={`num inline-flex gap-1.5 rounded-pill px-2 py-0.5 text-[11px] ${row.id === lot.backedAsset ? "bg-accent/20 text-accent" : "bg-surface-2 text-muted"}`}>
                {row.id}
                {row.change !== null && <span className={row.id === lot.backedAsset ? "" : tone(row.change)}>{pct(row.change, 2)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function MyEntries({ epochs, lots, decimals, onSent }: { epochs: Epoch[]; lots: EpochLot[]; decimals: number; onSent: () => void }) {
  const { owner } = useAccount();
  const [filter, setFilter] = useState<LotGroup | "all">("all");
  const byOpen = new Map(epochs.map((epoch) => [epoch.opensAt, epoch]));
  const views = lots
    .map((lot) => ({ lot, epoch: byOpen.get(lot.epochOpensAt) ?? null }))
    .map((item) => ({ ...item, view: lotView(item.lot, item.epoch) }))
    .sort((a, b) => b.lot.epochOpensAt - a.lot.epochOpensAt || Number(b.lot.nonce) - Number(a.lot.nonce));
  const shown = views.filter((item) => filter === "all" || item.view.group === filter);
  const tabs: { id: LotGroup | "all"; label: string }[] = [{ id: "all", label: "All" }, ...GROUPS];

  return (
    <section className={`${card} flex flex-col`}>
      <div className="flex flex-col gap-3 p-5 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <CardHead icon={<LayoutList size={14} aria-hidden="true" />} title="My entries" />
        <div role="tablist" aria-label="Filter entries" className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
          {tabs.map((item) => {
            const on = filter === item.id;
            return (
              <button key={item.id} type="button" role="tab" aria-selected={on} onClick={() => setFilter(item.id)} className={`h-8 shrink-0 cursor-pointer rounded-xl px-3 text-xs font-medium transition-colors duration-150 ${on ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
      {!owner ? (
        <p className="border-t border-white/[0.06] px-5 py-8 text-center text-sm text-muted">Connect a wallet to see your entries.</p>
      ) : shown.length === 0 ? (
        <p className="border-t border-white/[0.06] px-5 py-8 text-center text-sm text-muted">{lots.length === 0 ? "No entries yet. Create one while an Epoch is open." : "No entries in this group."}</p>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div className={`${TABLE} py-2 ${eyebrow}`}>
            <span>Asset</span>
            <span>Epoch</span>
            <span>Status</span>
            <span>Stake ({COLLATERAL.symbol})</span>
            <span>Basis</span>
            <span>Score</span>
            <span>Payout</span>
            <span />
          </div>
          <ul>
            {shown.map((item) => (
              <EntryRow key={item.lot.address} lot={item.lot} epoch={item.epoch} decimals={decimals} onSent={onSent} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function EpochsView({ overview, roster, serverNow }: { overview: EpochOverview; roster: string[]; serverNow: number }) {
  const now = useNow(serverNow);
  const { owner, market } = useAccount();
  const decimals = market.decimals || 6;
  const epochs = useMemo(() => [...overview.epochs].sort((a, b) => a.opensAt - b.opensAt), [overview.epochs]);
  const [selected, setSelected] = useState<string | null>(() => pickDefault(epochs, serverNow));
  const [backed, setBacked] = useState<string | null>(null);
  const [lots, setLots] = useState<EpochLot[]>([]);
  const [sheet, setSheet] = useState(false);
  const [explain, setExplain] = useState(false);
  const closeExplain = useCallback(() => setExplain(false), []);
  const epoch = epochs.find((item) => item.address === selected) ?? epochs[0] ?? null;
  const coins = epoch ? coinsOf(epoch, roster) : [];
  const stage: Stage | null = epoch ? stageOf(epoch, now) : null;
  const open = stage === "open" && Boolean(epoch?.entriesOpen);

  const loadLots = useCallback(async () => {
    if (!owner) return setLots([]);
    const result = await walletEpochLots(owner, epochs.map((item) => item.opensAt));
    if (result.ok) setLots(result.value);
  }, [owner, epochs]);

  useEffect(() => {
    void loadLots();
    const timer = window.setInterval(() => void loadLots(), LOTS_MS);
    return () => window.clearInterval(timer);
  }, [loadLots]);

  const header = (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Epoch</h1>
        <p className="text-sm text-muted">Back one coin in a basket of 30. Your entry counts from its execution to the fixed Epoch close.</p>
      </div>
      <div className="flex items-center gap-2">
        <ModeSwitch />
        <span className="inline-flex h-9 items-center gap-2 rounded-pill bg-surface px-3 text-[11px] uppercase tracking-wider text-muted">
          <span className="size-1.5 rounded-full bg-accent" /> Devnet
        </span>
      </div>
    </header>
  );

  if (!epoch || !stage) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <p className={`${card} p-6 text-sm text-muted`}>No Epochs are scheduled yet.</p>
      </div>
    );
  }

  const entryProps = {
    epoch,
    coins,
    now,
    decimals,
    fee: overview.configuration.entryFee,
    mint: overview.configuration.collateralMint,
    backed,
    onBacked: setBacked,
    onSent: () => void loadLots(),
  };

  const enter = () => {
    if (window.matchMedia("(min-width: 1280px)").matches) {
      document.getElementById("epoch-entry")?.scrollIntoView({ behavior: "smooth", block: "center" });
      document.getElementById("epoch-stake")?.focus({ preventScroll: true });
    } else {
      setSheet(true);
    }
  };

  return (
    <div className={`relative isolate flex flex-col gap-4 ${open ? "pb-24 xl:pb-0" : ""}`}>
      <div aria-hidden="true" className="pointer-events-none absolute -top-24 left-1/3 -z-10 h-72 w-2/3 bg-[radial-gradient(closest-side,rgba(242,98,46,0.10),transparent)]" />
      {header}
      <Banner epoch={epoch} stage={stage} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
        <div className="md:col-span-2 xl:col-span-5"><ClockCard epochs={epochs} epoch={epoch} now={now} canEnter={open} onSelect={(address) => setSelected(address)} onEnter={enter} /></div>
        <div className="xl:col-span-4"><PotCard epoch={epoch} now={now} decimals={decimals} /></div>
        <div className="flex xl:col-span-3 [&>*]:flex-1"><PromoCard onExplain={() => setExplain(true)} /></div>
      </div>


      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-8">
          <MovesCard epoch={epoch} coins={coins} now={now} backed={backed} canPick={open} onPick={(id) => setBacked(id)} />
          <MyEntries epochs={epochs} lots={lots} decimals={decimals} onSent={() => void loadLots()} />
        </div>
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-4">
          <div className="hidden xl:block">
            <EntryPanel {...entryProps} />
          </div>
          <SettlementCard epoch={epoch} now={now} />
        </div>
      </div>

      {open && !sheet && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/[0.06] bg-bg/95 p-3 backdrop-blur xl:hidden">
          <button type="button" onClick={() => setSheet(true)} className={`${primary} cursor-pointer`}>
            <Plus size={16} aria-hidden="true" /> New entry{backed ? ` · ${backed}` : ""}
          </button>
        </div>
      )}
      {sheet && (
        <div className="fixed inset-0 z-50 flex flex-col gap-4 overflow-y-auto bg-bg p-4 xl:hidden">
          <EntryPanel {...entryProps} onClose={() => setSheet(false)} />
          <button type="button" onClick={() => setExplain(true)} className="mx-auto cursor-pointer text-xs text-accent underline-offset-4 hover:underline">How payouts work</button>
        </div>
      )}
      {explain && <PayoutModal onClose={closeExplain} />}
    </div>
  );
}
