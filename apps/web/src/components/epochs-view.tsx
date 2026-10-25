"use client";

import { EPOCH_BASKET_SIZE, type Epoch, type EpochConfiguration, type EpochLot, type EpochOverview, type PreviewHistory } from "@eox/app-api";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Clock, Info, X } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { walletEpochLots } from "@/app/actions";
import { parseScaled } from "@/lib/amounts";
import { COLLATERAL } from "@/lib/config";
import { type LotGroup, type Move, type Stage, STAGE_LABEL, TEAMMATES, type VaultBalances, type EpochsSnapshot, basketProblem, heroRounds, latestEpochs, leavesOut, mateLocked, toggleMate, byMove, defaultTeam, entryBasket, leaveOutCount, countdown, epochBasket, executionReferences, feeOf, finalPayout, lotView, moves, refundStage, stageOf, units, utcTime, windowText, withdrawSource } from "@/lib/epoch";
import { historyEstimates } from "@/lib/estimate";
import { formatAmount } from "@/lib/format";
import { type Collateral, collateralsOf } from "@/lib/market";
import type { Intent } from "@/lib/requests";
import { useAccount } from "./account";
import { CoinIcon } from "./coin-icon";
import { EmptyMarket } from "./empty-market";
import { useLive } from "./live";
import { SendButton } from "./send-button";

const REFERENCE_DIGITS = 12;
const PREVIEW_BASE = 100;
const LOTS_MS = 20_000;
const REORDER_MS = 60_000;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const card = "min-w-0 rounded-[24px] border border-white/[0.06] bg-surface";
const gradient = "bg-[linear-gradient(90deg,#f2622e,#ff8a4c)]";
const primary = `flex h-11 w-full items-center justify-center gap-2 rounded-pill ${gradient} text-sm font-medium text-white`;
const quiet = "flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-pill bg-surface-2 text-sm transition-colors duration-150 hover:bg-white/10";
const well = "rounded-xl bg-bg/70 p-3";

function useNow(start: number): number {
  const [now, setNow] = useState(start);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function pct(value: number | null, digits = 3): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatAmount(Math.abs(value) * 100, digits)}%`;
}

function tone(value: number | null): string {
  return value === null || value === 0 ? "text-muted" : value > 0 ? "text-up" : "text-down";
}

function pickDefault(epochs: readonly Epoch[], now: number): string | null {
  const open = epochs.find((epoch) => stageOf(epoch, now) === "open");
  const next = epochs.find((epoch) => stageOf(epoch, now) === "upcoming");
  const last = [...epochs].reverse().find((epoch) => stageOf(epoch, now) !== "upcoming");
  return (open ?? next ?? last ?? epochs[0])?.address ?? null;
}

function useOpeningReferences(epoch: Epoch | null, now: number): Record<string, number> | null | undefined {
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
  return held && held.key === opensAt ? held.references : undefined;
}

function useWalletCollateral(mint: string | null, decimals: number, refreshKey: number): number | null {
  const { connection } = useConnection();
  const { owner } = useAccount();
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    setBalance(null);
    if (!owner || !mint) return;
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

function ModeSwitch() {
  return (
    <div role="tablist" aria-label="Mode" className="inline-flex rounded-pill bg-surface p-1">
      <Link href="/markets" role="tab" aria-selected={false} className="rounded-pill px-4 py-1.5 text-sm text-muted transition-colors duration-150 hover:text-ink">Basic</Link>
      <span role="tab" aria-selected className="rounded-pill bg-surface-2 px-4 py-1.5 text-sm font-medium text-ink">Epoch</span>
    </div>
  );
}

function useHeroRanking(epoch: Epoch, coins: string[], now: number): { rows: Move[]; empty: string | null } {
  const { estimate } = useLive();
  const stage = stageOf(epoch, now);
  const noResult = stage === "upcoming" || stage === "unopened" || refundStage(stage);
  const opening = useOpeningReferences(noResult ? null : epoch, now);
  const closing = useMemo(() => {
    if (epoch.closingReferences.length === 0) return null;
    return Object.fromEntries(epoch.closingReferences.map((item) => [item.assetId, (Number(BigInt(item.reference)) / 10 ** REFERENCE_DIGITS) * PREVIEW_BASE]));
  }, [epoch.closingReferences]);
  const end = closing ?? (stage === "open" ? (estimate?.references ?? null) : null);
  const rows = moves(coins, opening ?? null, end).filter((row) => row.change !== null);
  const empty =
    rows.length > 0
      ? null
      : stage === "upcoming"
        ? `The ranking starts at ${utcTime(epoch.opensAt)} UTC.`
        : noResult
          ? "No ranking for this round."
          : stage === "closing"
            ? "Waiting for the closing prices."
            : opening === null
              ? "Prices from the start of this round are not available."
              : "Loading the ranking…";
  return { rows, empty };
}

function RankingCarousel({ epoch, coins, now }: { epoch: Epoch; coins: string[]; now: number }) {
  const { rows, empty } = useHeroRanking(epoch, coins, now);
  const track = useRef<HTMLOListElement>(null);

  useEffect(() => {
    track.current?.scrollTo({ left: 0 });
  }, [epoch.address]);

  return (
    <div aria-roledescription="carousel" aria-label="Ranking against $CRYPTO" className="min-w-0 lg:pt-12">
      {empty ? (
        <p className="flex h-[116px] items-center justify-center rounded-2xl border border-dashed border-white/10 px-4 text-center text-xs text-muted">{empty}</p>
      ) : (
        <ol ref={track} className="flex snap-x snap-mandatory gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {rows.map((row, index) => (
            <li key={row.id} className="flex h-[116px] w-full shrink-0 snap-start flex-col justify-between rounded-xl border border-white/[0.06] bg-bg/60 p-3 sm:w-[calc((100%-1.5rem)/3)]">
              <span className="num text-xs text-muted">#{index + 1}</span>
              <span className="flex items-center gap-2">
                <CoinIcon id={row.id} size={24} />
                <span className="text-sm font-semibold">{row.id}</span>
              </span>
              <span className={`num text-base font-semibold leading-none ${tone(row.change)}`}>{pct(row.change, 2)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function heroClock(epoch: Epoch, stage: Stage, now: number): { label: string; value: string } {
  if (stage === "open") return { label: "Closes in", value: countdown(epoch.closesAt - now) };
  if (stage === "upcoming") return { label: "Opens in", value: countdown(epoch.opensAt - now) };
  if (stage === "unopened") return { label: "Was due to open", value: `${utcTime(epoch.opensAt)} UTC` };
  return { label: "Closed", value: `${utcTime(epoch.closesAt)} UTC` };
}

function rankingEpoch(epochs: readonly Epoch[], now: number): Epoch | null {
  const open = epochs.find((item) => stageOf(item, now) === "open");
  if (open) return open;
  return [...epochs].reverse().find((item) => item.closingReferences.length > 0 && !refundStage(stageOf(item, now))) ?? null;
}

const SLIDE_MS = 6000;

function RoundSlide({ epoch, now, decimals, active }: { epoch: Epoch; now: number; decimals: number; active: boolean }) {
  const stage = stageOf(epoch, now);
  const clock = heroClock(epoch, stage, now);
  const settled = epoch.settlementPot !== null && (stage === "allocating" || stage === "settled");
  const pot = settled ? units(epoch.settlementPot!, decimals) : epoch.ledger ? units(epoch.ledger.activeNet, decimals) : null;
  const entries = epoch.nextNonce !== null ? Number(epoch.nextNonce) : (epoch.lots?.executed ?? null);
  const day = new Date(epoch.opensAt * 1000).toUTCString().slice(5, 11);
  const stats = [
    { label: clock.label, value: clock.value },
    { label: "Pot", value: pot === null ? "—" : `${formatAmount(pot, 2)} ${COLLATERAL.symbol}` },
    { label: "Entries", value: entries === null ? "—" : String(entries) },
  ];

  return (
    <div aria-hidden={!active} inert={!active} className={`flex w-full shrink-0 flex-col gap-4 px-6 motion-safe:transition-opacity motion-safe:duration-700 ${active ? "opacity-100" : "opacity-0"}`}>
      <span className="inline-flex w-fit items-center gap-1.5 rounded-pill bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-ink">
        <span className={`size-1.5 rounded-full ${stage === "open" ? "bg-up" : refundStage(stage) ? "bg-warn" : "bg-muted"}`} />
        {STAGE_LABEL[stage]}
      </span>
      <h2 className="text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
        {day}
        <span className="mt-1 block text-base font-normal text-muted">{utcTime(epoch.opensAt)}–{utcTime(epoch.closesAt)} UTC</span>
      </h2>
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col">
            <dt className="text-[11px] text-muted">{stat.label}</dt>
            <dd className="num text-sm font-semibold text-ink">{stat.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function HeroCard({ epochs, ranked, rankedCoins, now, decimals, onExplain }: { epochs: Epoch[]; ranked: Epoch | null; rankedCoins: string[]; now: number; decimals: number; onExplain: () => void }) {
  const rounds = heroRounds(epochs, now);
  const [index, setIndex] = useState(Math.max(0, rounds.length - 1));
  const [paused, setPaused] = useState(false);
  const shown = Math.max(0, Math.min(index, rounds.length - 1));

  useEffect(() => {
    if (paused || rounds.length < 2) return;
    const timer = window.setTimeout(() => setIndex((value) => (value + 1) % rounds.length), SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [paused, shown, rounds.length]);

  return (
    <section className="relative isolate min-h-[260px] overflow-hidden rounded-[28px] border border-white/[0.06] bg-surface p-6 sm:p-9">
      <button type="button" onClick={onExplain} aria-haspopup="dialog" className="absolute right-6 top-6 z-10 cursor-pointer text-sm font-medium text-accent underline underline-offset-4 transition-colors duration-150 hover:text-ink sm:right-9 sm:top-9">
        How Epoch Works
      </button>
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(60%_90%_at_88%_100%,rgba(242,98,46,0.28),transparent_70%),radial-gradient(50%_80%_at_0%_0%,rgba(255,255,255,0.05),transparent_70%)]" />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center">
        <div
          aria-roledescription="carousel"
          aria-label="Rounds"
          className="relative -mx-6 flex max-w-[calc(36rem+3rem)] flex-col gap-4"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
        >
          <div className="overflow-hidden [mask-image:linear-gradient(90deg,transparent_0,black_24px,black_calc(100%-64px),transparent_100%)]">
            <div className="flex motion-safe:transition-transform motion-safe:duration-700 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]" style={{ transform: `translateX(-${shown * 100}%)` }}>
              {rounds.map((round, slide) => (
                <RoundSlide key={round.address} epoch={round} now={now} decimals={decimals} active={slide === shown} />
              ))}
              {rounds.length === 0 && (
                <div className="flex w-full shrink-0 flex-col gap-2 px-6">
                  <h2 className="text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">No round scheduled</h2>
                  <p className="text-sm text-muted">The next round shows here once it is scheduled.</p>
                </div>
              )}
            </div>
          </div>
          {rounds.length > 1 && (
            <div role="tablist" aria-label="Choose round" className="flex gap-1.5 px-6">
              {rounds.map((round, slide) => (
                <button
                  key={round.address}
                  type="button"
                  role="tab"
                  aria-selected={slide === shown}
                  aria-label={`${STAGE_LABEL[stageOf(round, now)]} round, ${windowText(round)}`}
                  onClick={() => setIndex(slide)}
                  className={`h-1.5 cursor-pointer rounded-full transition-all duration-300 ${slide === shown ? "w-6 bg-accent" : "w-1.5 bg-white/20 hover:bg-white/40"}`}
                />
              ))}
            </div>
          )}
        </div>
        {ranked ? <RankingCarousel epoch={ranked} coins={rankedCoins} now={now} /> : <p className="flex h-[116px] items-center justify-center rounded-2xl border border-dashed border-white/10 px-4 text-center text-xs text-muted lg:mt-12">No round has a ranking yet.</p>}
      </div>
    </section>
  );
}

interface Slide {
  kicker: string;
  title: string;
  body: string;
}

const PAYOUT_SLIDES: Slide[] = [
  { kicker: "Step 1", title: "Back one coin", body: "Choose the coin you think will do best against $CRYPTO. Your entry counts from when it executes until the round closes." },
  { kicker: "Step 2", title: "Add to basket", body: "Every entry has a basket that holds your backed coin and 29 others. Coins in your basket that trail $CRYPTO score zero, which raises your coin's share of the score. The basket fills itself; use Edit basket to choose which coins to leave out." },
  { kicker: "Step 3", title: "Get a score", body: "Your score is your coin's gain over $CRYPTO as a share of the gains of every coin in your basket. Coins behind $CRYPTO count as zero." },
  { kicker: "Step 4", title: "Share the pot", body: "The pot is every stake after fees, split by stake × score. If your coin is behind $CRYPTO at the close, you get nothing back. If every entry scores zero, everyone is refunded in full, fee included." },
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
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-64 bg-[radial-gradient(90%_100%_at_15%_0%,rgba(242,98,46,0.32),transparent_70%),radial-gradient(70%_100%_at_100%_0%,rgba(255,255,255,0.05),transparent_70%)]" />

        <header className="flex items-center justify-between px-7 pt-6">
          <span className="text-[11px] uppercase tracking-[0.2em] text-accent">How Epoch Works</span>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-9 cursor-pointer place-items-center rounded-full bg-white/5 text-muted transition-colors duration-150 hover:bg-white/10 hover:text-ink">
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div key={index} aria-live="polite" className="flex min-h-[300px] flex-col gap-5 px-7 pb-4 pt-8 motion-safe:animate-[slide-in_200ms_ease-out]">
          <span className={`grid size-12 place-items-center rounded-2xl text-lg font-semibold text-white shadow-[0_8px_30px_rgba(242,98,46,0.35)] ${gradient}`}>
            {slide.kicker.startsWith("Step") ? index + 1 : "Ex"}
          </span>
          <div className="flex flex-col gap-3">
            <span className="text-[11px] uppercase tracking-wider text-muted">{slide.kicker}</span>
            <h2 id="payout-title" className="text-2xl font-semibold tracking-tight">{slide.title}</h2>
            <p className="text-sm leading-relaxed text-muted">{slide.body}</p>
          </div>
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

function closingMap(epoch: Epoch): Record<string, number> | null {
  if (epoch.closingReferences.length === 0) return null;
  return Object.fromEntries(epoch.closingReferences.map((item) => [item.assetId, (Number(BigInt(item.reference)) / 10 ** REFERENCE_DIGITS) * PREVIEW_BASE]));
}

function rank(rows: readonly Move[]): string[] {
  return [...rows].sort((a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity)).map((row) => row.id);
}

function useSteadyOrder(rows: Move[], key: string, paused: boolean): Map<string, number> {
  const latest = useRef(rows);
  const hold = useRef(paused);
  const [order, setOrder] = useState<string[]>([]);
  const ready = rows.some((row) => row.change !== null);
  useEffect(() => {
    latest.current = rows;
    hold.current = paused;
  });
  useEffect(() => {
    if (!ready) return;
    setOrder(rank(latest.current));
    const timer = window.setInterval(() => {
      if (!hold.current) setOrder(rank(latest.current));
    }, REORDER_MS);
    return () => window.clearInterval(timer);
  }, [ready, key]);
  return useMemo(() => new Map(order.map((id, index) => [id, index])), [order]);
}

function CoinTile({ row, picked, canPick, onPick }: { row: Move; picked: boolean; canPick: boolean; onPick: () => void }) {
  const tone = row.change === null || row.change === 0 ? "text-muted" : row.change > 0 ? "text-up" : "text-down";
  const face = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <CoinIcon id={row.id} size={20} />
        <span className="truncate text-sm font-medium">{row.id}</span>
        {picked && <Check size={14} strokeWidth={3} aria-hidden="true" className="ml-auto shrink-0 text-accent" />}
      </span>
      <span className={`num text-sm ${tone}`}>{pct(row.change, 2)}</span>
    </>
  );
  const shape = `flex h-[68px] w-full flex-col justify-between rounded-xl border px-3 py-2.5 text-left motion-safe:animate-[slot-in_300ms_ease-out] ${picked ? "border-accent bg-accent/10" : "border-white/[0.06] bg-bg/60"}`;
  return (
    <li>
      {canPick ? (
        <button type="button" onClick={onPick} aria-pressed={picked} aria-label={`Back ${row.id}, ${pct(row.change, 2)} against $CRYPTO`} className={`${shape} cursor-pointer transition-colors duration-150 ${picked ? "" : "hover:border-white/20"}`}>
          {face}
        </button>
      ) : (
        <div className={shape}>{face}</div>
      )}
    </li>
  );
}

function CoinGroup({ title, rows, backed, canPick, onPick }: { title: string; rows: Move[]; backed: string | null; canPick: boolean; onPick: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="flex items-baseline gap-2 text-sm font-medium">
        {title}
        <span className="num text-xs font-normal text-muted">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-xs text-muted">None right now</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-3 2xl:grid-cols-4">
          {rows.map((row) => (
            <CoinTile key={row.id} row={row} picked={row.id === backed} canPick={canPick} onPick={() => onPick(row.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function useRoundMoves(epoch: Epoch, coins: string[], now: number): { rows: Move[]; opening: Record<string, number> | null | undefined; end: Record<string, number> | null } {
  const { estimate } = useLive();
  const stage = stageOf(epoch, now);
  const noResult = stage === "unopened" || refundStage(stage);
  const opening = useOpeningReferences(noResult ? null : epoch, now);
  const closing = useMemo(() => closingMap(epoch), [epoch]);
  const end = closing ?? (stage === "open" ? (estimate?.references ?? null) : null);
  return { rows: moves(coins, opening ?? null, end), opening, end };
}

function CoinBoard({ epoch, coins, now, backed, canPick, onPick }: { epoch: Epoch; coins: string[]; now: number; backed: string | null; canPick: boolean; onPick: (id: string) => void }) {
  const [hover, setHover] = useState(false);
  const stage = stageOf(epoch, now);
  const { rows, opening, end } = useRoundMoves(epoch, coins, now);
  const position = useSteadyOrder(rows, epoch.address, hover);
  const sorted = [...rows].sort((a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity));
  const ready = opening != null && end !== null && rows.some((row) => row.change !== null);
  const ahead = sorted.filter((row) => (row.change ?? 0) > 0);
  const behind = sorted.filter((row) => (row.change ?? 0) <= 0);

  const empty =
    stage === "upcoming"
      ? { title: "Not open yet", text: `Coins appear here when the round opens at ${utcTime(epoch.opensAt)} UTC.`, pending: false }
      : stage === "unopened"
        ? { title: "No result", text: "This round never opened.", pending: false }
        : refundStage(stage)
          ? { title: "No result", text: "No closing prices were recorded, so every entry is refunded.", pending: false }
          : stage === "closing"
            ? { title: "Waiting for the close", text: "Results appear once the closing prices are recorded.", pending: true }
            : opening === null
              ? { title: "No prices yet", text: "Prices from the start of this round are not available.", pending: false }
              : { title: "Loading prices", text: "Reading prices since the round opened.", pending: true };

  return (
    <section className={`${card} flex flex-col gap-5 p-5`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {!ready ? (
        <EmptyMarket title={empty.title} pending={empty.pending}>
          {empty.text}
        </EmptyMarket>
      ) : (
        <>
          <CoinGroup title="Ahead of $CRYPTO" rows={ahead} backed={backed} canPick={canPick} onPick={onPick} />
          <CoinGroup title="Behind $CRYPTO" rows={behind} backed={backed} canPick={canPick} onPick={onPick} />
          <p className="border-t border-white/[0.06] pt-4 text-xs text-muted">Only coins ahead of $CRYPTO at the close score. The pot is shared by stake and score.</p>
        </>
      )}
    </section>
  );
}

function TeamEditor({ epoch, coins, now, backed, mates, onSave, onClose }: { epoch: Epoch; coins: string[]; now: number; backed: string; mates: string[]; onSave: (mates: string[]) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<string[]>(mates);
  const { rows } = useRoundMoves(epoch, coins, now);
  const change = new Map(rows.map((row) => [row.id, row.change]));
  const others = coins.filter((id) => id !== backed).sort((a, b) => byMove(change.get(a) ?? null, change.get(b) ?? null));
  const leave = leaveOutCount(coins);
  const excluding = leavesOut(coins);
  const out = others.filter((id) => !draft.includes(id));
  const done = draft.length === TEAMMATES;
  const toggle = (id: string) => setDraft((current) => toggleMate(coins, backed, current, id));
  const locked = (id: string) => mateLocked(coins, draft, id);
  const count = excluding ? `${out.length} / ${leave} left out` : `${draft.length} / ${TEAMMATES} picked`;
  const remaining = excluding ? leave - out.length : TEAMMATES - draft.length;

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-6" onClick={onClose}>
      <div aria-hidden="true" className="absolute inset-0 bg-black/70" />
      <section role="dialog" aria-modal="true" aria-labelledby="team-title" onClick={(event) => event.stopPropagation()} className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-t-3xl border border-white/[0.08] bg-surface sm:rounded-3xl">
        <header className="flex items-start justify-between gap-4 px-6 pt-5">
          <div className="flex flex-col gap-1">
            <h2 id="team-title" className="text-lg font-semibold">{excluding ? `Leave out ${leave} ${leave === 1 ? "coin" : "coins"}` : `Pick ${TEAMMATES} teammates`}</h2>
            <p className="text-xs text-muted">Teammates behind $CRYPTO score zero, so they raise {backed}&apos;s share.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-white/10 hover:text-ink">
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="flex items-center justify-between px-6 pt-4 text-xs">
          <span className={`num ${remaining === 0 ? "text-up" : "text-muted"}`}>{count}</span>
          <span className="flex gap-3">
            <button type="button" onClick={() => setDraft(defaultTeam(coins, backed))} className="cursor-pointer text-muted underline-offset-4 hover:text-ink hover:underline">Reset</button>
          </span>
        </div>
        <ul className="grid grid-cols-2 gap-2 overflow-y-auto px-6 py-4 sm:grid-cols-3">
          <li className="flex h-14 items-center gap-2 rounded-xl border border-accent bg-accent/10 px-3">
            <CoinIcon id={backed} size={20} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{backed}</span>
              <span className="text-[10px] text-accent">Backed</span>
            </span>
          </li>
          {others.map((id) => {
            const on = draft.includes(id);
            const move = change.get(id) ?? null;
            return (
              <li key={id}>
                <button type="button" aria-pressed={on} disabled={locked(id)} onClick={() => toggle(id)} className={`flex h-14 w-full cursor-pointer items-center gap-2 rounded-xl border px-3 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${on ? "border-white/20 bg-white/[0.05]" : "border-dashed border-white/15 bg-transparent opacity-60 hover:opacity-100"}`}>
                  <CoinIcon id={id} size={20} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={`truncate text-sm font-medium ${on ? "" : "line-through"}`}>{id}</span>
                    <span className={`num text-[10px] ${tone(move)}`}>{pct(move, 2)}</span>
                  </span>
                  {on ? <Check size={14} strokeWidth={3} aria-hidden="true" className="shrink-0 text-ink" /> : <span className="shrink-0 text-[10px] text-muted">Out</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <footer className="border-t border-white/[0.06] px-6 py-4">
          <button type="button" disabled={!done} onClick={() => onSave(draft)} className={`${primary} ${done ? "cursor-pointer" : "cursor-not-allowed opacity-40"}`}>
            {done ? "Use this team" : excluding ? `Leave out ${remaining} more` : `Pick ${remaining} more`}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function EntryPanel(props: { epoch: Epoch; basket: string[]; now: number; decimals: number; fee: { bps: number; cap: string }; collaterals: Collateral[]; next: Epoch | null; backed: string | null; mates: string[]; anchored?: boolean; onMates: (mates: string[]) => void; onSelect: (address: string) => void; onSent: () => void; onClose?: () => void }) {
  const { epoch, basket: coins, now, decimals, fee, backed, mates, collaterals } = props;
  const { owner } = useAccount();
  const [amount, setAmount] = useState("");
  const [editing, setEditing] = useState(false);
  const choosable = coins.length > EPOCH_BASKET_SIZE;
  const out = backed && leavesOut(coins) ? coins.filter((id) => id !== backed && !mates.includes(id)) : [];
  const [sent, setSent] = useState(0);
  const [pay, setPay] = useState<string | null>(null);
  const chosen = collaterals.find((item) => item.mint === pay) ?? collaterals[0] ?? null;
  const symbol = chosen?.symbol ?? COLLATERAL.symbol;
  const wallet = useWalletCollateral(chosen?.mint ?? null, decimals, sent);
  const stage = stageOf(epoch, now);
  const open = stage === "open" && epoch.entriesOpen;
  const gross = amount.trim() === "" ? null : parseScaled(amount, decimals);
  const charge = gross !== null && gross > 0n ? feeOf(gross, fee.bps, BigInt(fee.cap)) : null;
  const basketIssue = backed ? basketProblem(coins, backed, mates) : null;
  const short = wallet !== null && gross !== null && Number(gross) / 10 ** decimals > wallet;
  const empty = amount.trim() === "";
  const problem = !backed ? "Pick a coin first." : gross === null || gross <= 0n ? "Enter an amount above zero." : basketIssue ? basketIssue : short ? `Your wallet has ${formatAmount(wallet ?? 0, 2)} ${symbol}.` : null;
  const collateralMint = collaterals.length > 1 && chosen ? chosen.mint : undefined;
  const intent: Intent | null = open && problem === null && gross !== null && backed !== null ? { operation: "epoch-entry", opensAt: epoch.opensAt, grossStake: gross.toString(), basket: entryBasket(coins, backed, mates), backedAsset: backed, collateralMint } : null;
  const show = (value: bigint | null) => {
    if (value === null) return "—";
    const scale = 10n ** BigInt(decimals);
    const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "").padEnd(2, "0");
    return `${(value / scale).toLocaleString("en-US")}.${fraction} ${symbol}`;
  };
  const anchor = props.anchored === false ? undefined : "epoch-entry";
  const stakeId = props.anchored === false ? "epoch-stake-sheet" : "epoch-stake";

  const other = props.next && props.next.address !== epoch.address ? props.next : null;
  const otherOpen = other !== null && stageOf(other, now) === "open" && other.entriesOpen;
  const closedReason =
    stage === "upcoming"
      ? `Entries open at ${utcTime(epoch.opensAt)} UTC.`
      : stage === "open"
        ? "This round is not taking entries right now."
        : other
          ? otherOpen
            ? `This round is closed. Entries are open in the ${windowText(other)} round.`
            : `This round is closed. The next one runs ${windowText(other)}.`
          : "This round is closed. No other round is open or scheduled.";

  const head = (
    <div className="flex min-h-9 items-center justify-between gap-3">
      <h2 className="text-base font-semibold">Your entry</h2>
      {props.onClose && (
        <button type="button" onClick={props.onClose} aria-label="Close" className="grid size-8 cursor-pointer place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink">
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );

  if (!open) {
    return (
      <section id={anchor} className={`${card} flex flex-col gap-4 p-5`}>
        {head}
        <p className={`${well} flex items-start gap-2.5 text-sm text-muted`}>
          <Clock size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          {closedReason}
        </p>
        {other && stage !== "upcoming" && stage !== "open" && (
          <button type="button" onClick={() => props.onSelect(other.address)} className={quiet}>
            {otherOpen ? "Go to the open round" : "Show the next round"} <ChevronRight size={14} aria-hidden="true" />
          </button>
        )}
      </section>
    );
  }

  return (
    <section id={anchor} className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4 shadow-card">
      {head}

      <form className="flex flex-col gap-3" onSubmit={(event) => event.preventDefault()}>
        <div className="flex items-center gap-3 rounded-control bg-surface-2 p-3">
          {backed ? <CoinIcon id={backed} size={28} /> : <span className="size-7 rounded-full border border-dashed border-white/20" />}
          <span className="flex flex-col">
            <span className="text-sm font-semibold">{backed ? `Back ${backed}` : "No coin yet"}</span>
            <span className="text-[11px] text-muted">{backed ? `In a team of ${EPOCH_BASKET_SIZE}, against $CRYPTO` : "Tap a coin to back it"}</span>
          </span>
        </div>

        {backed && (
          <div className="flex flex-col gap-1.5 rounded-control border border-line px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted">Your basket</span>
              {choosable && (
                <button type="button" onClick={() => setEditing(true)} className="shrink-0 cursor-pointer text-xs font-medium text-accent underline underline-offset-4 hover:text-ink">
                  Edit basket
                </button>
              )}
            </div>
            <span className="text-sm">{choosable ? `${backed} + ${mates.length} others` : `${backed} + all ${TEAMMATES} others`}</span>
            {out.length > 0 && (
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                Left out
                {out.map((id) => (
                  <span key={id} className="inline-flex items-center gap-1 rounded-pill bg-surface-2 px-2 py-0.5 text-ink">
                    <CoinIcon id={id} size={12} />
                    {id}
                  </span>
                ))}
              </span>
            )}
          </div>
        )}
        {editing && backed && (
          <TeamEditor
            epoch={epoch}
            coins={coins}
            now={now}
            backed={backed}
            mates={mates}
            onClose={() => setEditing(false)}
            onSave={(next) => {
              props.onMates(next);
              setEditing(false);
            }}
          />
        )}

        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-muted">
            <label htmlFor={stakeId}>You pay ({symbol})</label>
            {owner && <span className="num">Available {wallet === null ? "…" : formatAmount(wallet, 2)}</span>}
          </div>
          <input id={stakeId} inputMode="decimal" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} className="num h-11 w-full rounded-control border border-line bg-bg px-3 text-sm text-ink placeholder:text-muted" />
          {!empty && (gross === null || gross <= 0n) && <p className="mt-1 text-xs text-down">Enter an amount above zero.</p>}
          {collaterals.length > 1 && (
            <div role="group" aria-label="Pay with" className="mt-2 flex flex-wrap items-center gap-1 text-xs">
              <span className="mr-1 text-muted">Pay with</span>
              {collaterals.map((item) => (
                <button key={item.mint} type="button" aria-pressed={item.mint === chosen?.mint} onClick={() => setPay(item.mint)} className={`h-7 cursor-pointer rounded-pill px-3 transition-colors duration-150 ${item.mint === chosen?.mint ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>
                  {item.symbol}
                </button>
              ))}
            </div>
          )}
        </div>

        <dl className="mt-1 flex flex-col gap-2 border-t border-line pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Fee ({fee.bps / 100}%, max {formatAmount(units(fee.cap, decimals), 2)} {symbol})</dt>
            <dd className="num">{show(charge)}</dd>
          </div>
        </dl>

        <SendButton
          intent={intent}
          label={!backed ? "Pick a coin" : empty ? "Enter an amount" : `Back ${backed}`}
          connectLabel="Connect wallet to continue"
          problem={empty || !backed ? "" : problem}
          describe={`Back ${backed} with ${amount} ${symbol}`}
          onDone={() => {
            setAmount("");
            setSent((count) => count + 1);
            props.onSent();
          }}
          className="h-11 rounded-pill bg-accent text-sm font-medium text-accent-ink"
        />
      </form>
    </section>
  );
}

const GROUPS: { id: LotGroup | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Running" },
  { id: "pending", label: "Waiting" },
  { id: "withdrawable", label: "To withdraw" },
  { id: "history", label: "Past" },
];

const STATUS_TONE: Record<LotGroup, string> = {
  withdrawable: "bg-accent/15 text-accent",
  pending: "bg-warn/15 text-warn",
  active: "bg-up/15 text-up",
  history: "bg-surface-2 text-muted",
};

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

function tokenAmount(info: { owner: PublicKey; data: Uint8Array } | null): bigint {
  if (!info || !info.owner.equals(TOKEN_PROGRAM) || info.data.length !== 165) return 0n;
  return new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(64, true);
}

function useEpochVaults(program: string, epochAddress: string | null, refreshKey: number): VaultBalances | null | undefined {
  const { connection } = useConnection();
  const [held, setHeld] = useState<{ key: string; value: VaultBalances | null } | null>(null);
  useEffect(() => {
    if (!epochAddress) return;
    let current = true;
    const programKey = new PublicKey(program);
    const epoch = new PublicKey(epochAddress);
    const seed = (label: string) => PublicKey.findProgramAddressSync([new TextEncoder().encode(label), epoch.toBytes()], programKey)[0];
    connection
      .getMultipleAccountsInfo([seed("vault"), seed("test-vault")])
      .then(([vault, testVault]) => current && setHeld({ key: `${epochAddress}:${refreshKey}`, value: { primary: tokenAmount(vault ?? null), secondary: tokenAmount(testVault ?? null) } }))
      .catch(() => current && setHeld({ key: `${epochAddress}:${refreshKey}`, value: null }));
    return () => {
      current = false;
    };
  }, [connection, program, epochAddress, refreshKey]);
  return held && held.key === `${epochAddress}:${refreshKey}` ? held.value : undefined;
}

function EntryCard({ lot, epoch, now, decimals, program, collaterals, onSent }: { lot: EpochLot; epoch: Epoch | null; now: number; decimals: number; program: string; collaterals: Collateral[]; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(0);
  const view = lotView(lot, epoch, now);
  const since = useEntryMoves(lot, epoch);
  const gross = units(lot.grossStake, decimals);
  const paid = finalPayout(lot, epoch);
  const payout = paid === null ? null : units(paid, decimals);
  const owed = lot.state === "claimable" && paid !== null && paid > 0n;
  const result = payout !== null && !view.refund ? payout - gross : null;
  const vaults = useEpochVaults(program, owed && epoch ? epoch.address : null, sent);
  const source = owed && vaults !== undefined && paid !== null ? withdrawSource(collaterals.map((item) => item.mint), vaults, paid) : null;
  const sourceSymbol = source ? (collaterals[source.index]?.symbol ?? COLLATERAL.symbol) : COLLATERAL.symbol;
  const withdrawLabel = source?.amount ? `Withdraw ${formatAmount(units(source.amount, decimals), 2)} ${sourceSymbol}` : view.refund ? "Withdraw refund" : "Withdraw";
  const change = since.backed?.change ?? null;
  const line = lot.execution
    ? change !== null
      ? `${change > 0 ? "Ahead of" : "Behind"} $CRYPTO by ${pct(Math.abs(change), 2).replace(/^[+−]/, "")} since ${utcTime(lot.execution.timestamp)} UTC${since.basis === "at close" ? " · final" : since.basis ? ` · ${since.basis}` : ""}`
      : `Counting from ${utcTime(lot.execution.timestamp)} UTC`
    : epoch && now >= epoch.closesAt
      ? "Never executed, so it is refunded"
      : "Waiting to execute";
  const payoutText =
    payout !== null
      ? `${formatAmount(payout, 2)} ${COLLATERAL.symbol}${view.refund ? " refund" : ""}`
      : lot.state === "withdrawn"
        ? "Withdrawn"
        : view.group === "active" || view.label === "Waiting to execute" || lot.state === "pending"
          ? "After the close"
          : "Refund due";

  return (
    <li className={`${well} flex flex-col gap-3 p-4`}>
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <CoinIcon id={lot.backedAsset} size={28} />
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold">{lot.backedAsset}</span>
            <span className="num truncate text-[11px] text-muted">{epoch ? windowText(epoch) : `${utcTime(lot.epochOpensAt)} UTC`}</span>
          </span>
        </span>
        <span className={`shrink-0 rounded-pill px-2 py-0.5 text-[11px] ${STATUS_TONE[view.group]}`}>{view.label}</span>
      </div>
      <p className={`num text-xs ${change === null ? "text-muted" : change > 0 ? "text-up" : "text-down"}`}>{line}</p>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <dl className="flex gap-6 text-xs">
          <div className="flex flex-col">
            <dt className="text-[11px] text-muted">Stake</dt>
            <dd className="num font-medium">{formatAmount(gross, 2)} {COLLATERAL.symbol}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-[11px] text-muted">Payout</dt>
            <dd className="num font-medium">
              {payoutText}
              {result !== null && <span className={`ml-1 ${result > 0 ? "text-up" : result < 0 ? "text-down" : "text-muted"}`}>({result >= 0 ? "+" : "−"}{formatAmount(Math.abs(result), 2)})</span>}
            </dd>
          </div>
        </dl>
        {owed && epoch && source ? (
          <SendButton
            intent={{ operation: "epoch-withdraw", opensAt: epoch.opensAt, nonce: lot.nonce, amount: source.amount, collateralMint: source.mint }}
            label={withdrawLabel}
            connectLabel="Connect wallet"
            onDone={() => {
              setSent((count) => count + 1);
              onSent();
            }}
            className="h-9 rounded-pill bg-accent px-4 text-xs font-medium text-white"
          />
        ) : owed ? (
          <span className="text-[11px] text-muted">{vaults === undefined ? "Checking…" : "Not withdrawable yet"}</span>
        ) : null}
      </div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-fit cursor-pointer items-center gap-1 text-[11px] text-muted hover:text-ink">
        {open ? "Hide team" : "Show team"}
        <ChevronDown size={12} aria-hidden="true" className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul className="flex flex-wrap gap-1.5">
          {(since.rows.length > 0 ? since.rows : lot.basket.map((id) => ({ id, change: null }))).map((row) => (
            <li key={row.id} className={`num inline-flex gap-1.5 rounded-pill px-2 py-0.5 text-[11px] ${row.id === lot.backedAsset ? "bg-accent/20 text-accent" : "bg-surface-2 text-muted"}`}>
              {row.id}
              {row.change !== null && <span className={row.id === lot.backedAsset ? "" : row.change > 0 ? "text-up" : row.change < 0 ? "text-down" : ""}>{pct(row.change, 2)}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function YourEntries({ epochs, lots, now, decimals, configuration, collaterals, onSent }: { epochs: Epoch[]; lots: EpochLot[]; now: number; decimals: number; configuration: EpochConfiguration; collaterals: Collateral[]; onSent: () => void }) {
  const { owner } = useAccount();
  const [filter, setFilter] = useState<LotGroup | "all">("all");
  const byOpen = new Map(epochs.map((epoch) => [epoch.opensAt, epoch]));
  const views = lots
    .map((lot) => ({ lot, epoch: byOpen.get(lot.epochOpensAt) ?? null }))
    .map((item) => ({ ...item, view: lotView(item.lot, item.epoch, now) }))
    .sort((a, b) => b.lot.epochOpensAt - a.lot.epochOpensAt || Number(b.lot.nonce) - Number(a.lot.nonce));
  const shown = views.filter((item) => filter === "all" || item.view.group === filter);

  return (
    <section className={`${card} flex flex-col gap-4 p-5`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-base font-semibold">Your entries</h2>
        {lots.length > 0 && (
          <div role="tablist" aria-label="Filter entries" className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
            {GROUPS.map((item) => {
              const on = filter === item.id;
              return (
                <button key={item.id} type="button" role="tab" aria-selected={on} onClick={() => setFilter(item.id)} className={`h-8 shrink-0 cursor-pointer rounded-pill px-3 text-xs font-medium transition-colors duration-150 ${on ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>
                  {item.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {!owner ? (
        <p className="py-6 text-center text-sm text-muted">Connect a wallet to see your entries.</p>
      ) : shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{lots.length === 0 ? "No entries yet." : "Nothing here."}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {shown.map((item) => (
            <EntryCard key={item.lot.address} lot={item.lot} epoch={item.epoch} now={now} decimals={decimals} program={configuration.program} collaterals={collaterals} onSent={onSent} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function EpochsLive({ read, roster, serverNow }: { read: (EpochsSnapshot & { fresh: boolean }) | null; roster: string[]; serverNow: number }) {
  const [kept, setKept] = useState<EpochsSnapshot | null>(read);
  const { shown, staleSince } = latestEpochs(read, kept);
  useEffect(() => {
    if (shown && shown !== kept && (!kept || shown.fetchedAt > kept.fetchedAt)) setKept(shown);
  }, [shown, kept]);
  if (!shown) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-title font-semibold tracking-tight">Epochs</h1>
        <section className="rounded-card border border-line bg-surface p-6 text-sm text-muted shadow-card">Epochs are not available right now.</section>
      </div>
    );
  }
  return <EpochsView overview={shown.overview} roster={roster} serverNow={serverNow} staleSince={staleSince} />;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-2.5 rounded-xl border border-white/[0.08] bg-surface px-4 py-3 text-sm text-muted">
      <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
      <span>{children}</span>
    </p>
  );
}

export function EpochsView({ overview, roster, serverNow, staleSince = null }: { overview: EpochOverview; roster: string[]; serverNow: number; staleSince?: number | null }) {
  const now = useNow(serverNow);
  const { owner, market } = useAccount();
  const decimals = market.decimals || 6;
  const epochs = useMemo(() => [...overview.epochs].sort((a, b) => a.opensAt - b.opensAt), [overview.epochs]);
  const [selected, setSelected] = useState<string | null>(() => pickDefault(epochs, serverNow));
  const [backed, setBacked] = useState<string | null>(null);
  const [chosenMates, setChosenMates] = useState<string[] | null>(null);
  const [lots, setLots] = useState<EpochLot[]>([]);
  const [sheet, setSheet] = useState(false);
  const [explain, setExplain] = useState(false);
  const closeExplain = useCallback(() => setExplain(false), []);
  const epoch = epochs.find((item) => item.address === selected) ?? epochs[0] ?? null;
  const basket = epoch ? epochBasket(epoch) : [];
  const mates = chosenMates ?? (backed ? defaultTeam(basket, backed) : []);
  const pick = (id: string) => {
    setBacked(id === backed ? null : id);
    setChosenMates(null);
  };
  const coins = basket.length > 0 ? basket : [...roster];
  const ranked = rankingEpoch(epochs, now);
  const rankedBasket = ranked ? epochBasket(ranked) : [];
  const rankedCoins = rankedBasket.length > 0 ? rankedBasket : [...roster];
  const stage: Stage | null = epoch ? stageOf(epoch, now) : null;
  const open = stage === "open" && Boolean(epoch?.entriesOpen);
  const next = epochs.find((item) => stageOf(item, now) === "open" && item.entriesOpen) ?? epochs.find((item) => stageOf(item, now) === "upcoming") ?? null;
  const collaterals = useMemo(() => collateralsOf(overview.configuration), [overview.configuration]);

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
        <h1 className="text-3xl font-semibold tracking-tight">Epoch</h1>
        <p className="text-sm text-muted">Your entry counts from its execution to the fixed Epoch close.</p>
      </div>
      <ModeSwitch />
    </header>
  );
  const notices = staleSince !== null && <Notice>Rounds could not be refreshed. Showing them as of {utcTime(staleSince)} UTC.</Notice>;

  if (!epoch || !stage) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        {notices}
        <p className={`${card} p-6 text-sm text-muted`}>No Epochs are scheduled yet.</p>
      </div>
    );
  }

  const entryProps = {
    epoch,
    basket,
    now,
    decimals,
    fee: overview.configuration.entryFee,
    collaterals,
    next,
    backed,
    mates,
    onMates: setChosenMates,
    onSelect: (address: string) => {
      setSelected(address);
      setBacked(null);
      setChosenMates(null);
    },
    onSent: () => void loadLots(),
  };

  return (
    <div className={`relative isolate flex flex-col gap-5 ${open ? "pb-24 xl:pb-0" : ""}`}>
      {header}
      {notices}
      <HeroCard epochs={epochs} ranked={ranked} rankedCoins={rankedCoins} now={now} decimals={decimals} onExplain={() => setExplain(true)} />

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-12">
        <div id="epoch-board" className="min-w-0 xl:col-span-8">
          <CoinBoard epoch={epoch} coins={coins} now={now} backed={backed} canPick={open} onPick={pick} />
        </div>
        <div className={`min-w-0 xl:sticky xl:top-6 xl:col-span-4 ${open ? "hidden xl:block" : ""}`}>
          <EntryPanel {...entryProps} />
        </div>
      </div>

      <YourEntries epochs={epochs} lots={lots} now={now} decimals={decimals} configuration={overview.configuration} collaterals={collaterals} onSent={() => void loadLots()} />

      {open && !sheet && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/[0.06] bg-bg/95 p-3 xl:hidden">
          <button type="button" disabled={!backed} onClick={() => setSheet(true)} className={`${primary} ${backed ? "cursor-pointer" : "cursor-not-allowed opacity-40"}`}>
            {backed ? <>Back {backed} <ChevronRight size={16} aria-hidden="true" /></> : "Tap a coin to back it"}
          </button>
        </div>
      )}
      {sheet && (
        <div className="fixed inset-0 z-50 flex flex-col gap-4 overflow-y-auto bg-bg p-4 xl:hidden">
          <EntryPanel {...entryProps} anchored={false} onClose={() => setSheet(false)} />
          <button type="button" onClick={() => setExplain(true)} className="mx-auto cursor-pointer text-xs text-accent underline-offset-4 hover:underline">How Epoch Works</button>
        </div>
      )}
      {explain && <PayoutModal onClose={closeExplain} />}
    </div>
  );
}
