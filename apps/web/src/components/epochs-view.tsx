"use client";

import { type Epoch, type EpochConfiguration, type EpochLot, type EpochOverview } from "@eox/app-api";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { ChevronLeft, ChevronRight, Info, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { walletEpochLots } from "@/app/actions";
import { COLLATERAL } from "@/lib/config";
import { type LotGroup, type Move, type Stage, STAGE_LABEL, type VaultBalances, type EpochsSnapshot, heroRounds, latestEpochs, countdown, epochBasket, estimatedScore, executionReferences, finalPayout, lotView, marketClosedReason, moves, refundMint, refundStage, scoreOf, stageOf, units, utcTime, windowText, withdrawSource } from "@/lib/epoch";
import { formatAmount } from "@/lib/format";
import { clock, type Collateral, collateralsOf } from "@/lib/market";
import { useAccount } from "./account";
import { CoinIcon } from "./coin-icon";
import { useLive } from "./live";
import { SendButton } from "./send-button";
import { useSigner } from "./signer";
import { PerformerPrompt } from "./epoch-flow";
import { CoinBadge, PREVIEW_BASE, REFERENCE_DIGITS, TOKEN_PROGRAM, card, gradient, pct, pickDefault, tone, useNow, useOpeningReferences, well } from "./epoch-shared";
import { TradeModes } from "./trade-modes";

const LOTS_MS = 20_000;
const lotsCache = new Map<string, EpochLot[]>();








function useHeroRanking(epoch: Epoch, coins: string[], now: number): { rows: Move[]; empty: string | null } {
  const { estimate } = useLive();
  const stage = stageOf(epoch, now);
  const noResult = stage === "upcoming" || stage === "unopened" || stage === "empty" || refundStage(stage);
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
    <div aria-roledescription="carousel" aria-label="Ranking against the benchmark" className="min-w-0 lg:pt-12">
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
  { kicker: "Step 1", title: "Pick an asset", body: "Choose the asset whose performance you think will beat the benchmark. Your entry counts from when it executes until the round closes." },
  { kicker: "Step 2", title: "Add to basket", body: "Curate a basket around your position. It is locked for a four-hour round, so choose your basket wisely." },
  { kicker: "Step 3", title: "Get a score", body: "Your score is your asset's gain over the benchmark as a share of the gains of every coin in your basket. Coins behind the benchmark count as zero." },
  { kicker: "Step 4", title: "Share the pot", body: "The pot is every stake after fees, split by stake × score. If your asset is behind the benchmark at the close, you get nothing back. If every entry scores zero, everyone is refunded in full, fee included." },
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

function TeamCard({ lot, epoch, now, decimals, entriesOpen }: { lot: EpochLot; epoch: Epoch; now: number; decimals: number; entriesOpen: boolean }) {
  const since = useEntryMoves(lot, epoch);
  const view = lotView(lot, epoch, now);
  const rows = since.rows.length > 0 ? since.rows : lot.basket.map((id) => ({ id, change: null }));
  const performer = rows.find((row) => row.id === lot.backedAsset) ?? { id: lot.backedAsset, change: null };
  const team = rows.filter((row) => row.id !== lot.backedAsset);
  const filled = lot.execution !== null;
  const settled = scoreOf(lot, epoch);
  const score = settled ?? (since.basis && since.basis !== "at close" ? estimatedScore(since.rows, lot.backedAsset) : null);
  const paid = finalPayout(lot, epoch);
  const gross = units(lot.grossStake, decimals);
  const payout = paid === null ? null : units(paid, decimals);
  const result = payout !== null && !view.refund ? payout - gross : null;

  return (
    <section id="your-team" className={`${card} flex scroll-mt-4 flex-col gap-5 p-5 sm:p-6`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Your team</h2>
        <span className="flex items-center gap-2">
          {since.basis && <span className="text-xs text-muted">{since.basis}</span>}
          <span className={`rounded-pill px-2.5 py-0.5 text-[11px] ${STATUS_TONE[view.group]}`}>{view.label}</span>
        </span>
      </div>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3 rounded-2xl border border-accent/50 bg-accent/10 p-4">
          <div className="flex items-center gap-3">
            <CoinIcon id={performer.id} size={36} />
            <span className="flex min-w-0 flex-col">
              <span className="text-[11px] uppercase tracking-wide text-accent">Performer</span>
              <span className="text-xl font-semibold">{performer.id}</span>
            </span>
          </div>
          {filled && score !== null && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] uppercase tracking-wide text-accent">Score</span>
              <span className="num text-2xl font-semibold">{formatAmount(score * 100, 2)}%</span>
            </div>
          )}
          {payout !== null && (
            <div className="flex flex-col gap-0.5 text-xs">
              <span className="text-muted">{view.refund ? "Refund" : "Payout"}</span>
              <span className="num text-sm font-medium">
                {formatAmount(payout, 2)} {COLLATERAL.symbol}
                {result !== null && <span className={`ml-1 ${tone(result)}`}>({result >= 0 ? "+" : "−"}{formatAmount(Math.abs(result), 2)})</span>}
              </span>
            </div>
          )}
        </div>
        <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-5">
          {team.map((row) => (
            <li key={row.id}>
              <CoinBadge id={row.id} change={row.change} />
            </li>
          ))}
        </ul>
      </div>
      {entriesOpen && (
        <Link href="/epochs/pick" className="flex h-10 w-fit items-center gap-1 self-end rounded-pill bg-surface-2 px-4 text-xs transition-colors duration-150 hover:bg-white/10">
          Enter another performer <ChevronRight size={14} aria-hidden="true" />
        </Link>
      )}
    </section>
  );
}

function EntryCard({ lot, epoch, now, decimals, program, collaterals, selected, onSelect, onSent }: { lot: EpochLot; epoch: Epoch | null; now: number; decimals: number; program: string; collaterals: Collateral[]; selected: boolean; onSelect: (() => void) | null; onSent: () => void }) {
  const [sent, setSent] = useState(0);
  const view = lotView(lot, epoch, now);
  const gross = units(lot.grossStake, decimals);
  const paid = finalPayout(lot, epoch);
  const payout = paid === null ? null : units(paid, decimals);
  const owed = lot.state === "claimable" && paid !== null && paid > 0n;
  const refundable = lot.refund !== null && lot.state !== "withdrawn";
  const cancellable = !refundable && lot.state !== "withdrawn" && lot.execution !== null && epoch?.voidable === true;
  const result = payout !== null && !view.refund ? payout - gross : null;
  const vaults = useEpochVaults(program, (owed || refundable) && epoch ? epoch.address : null, sent);
  const mints = collaterals.map((item) => item.mint);
  const source = owed && vaults !== undefined && paid !== null ? withdrawSource(mints, vaults, paid) : null;
  const refundFrom = refundable && vaults !== undefined ? refundMint(mints, vaults, BigInt(lot.grossStake)) : null;
  const done = () => {
    setSent((count) => count + 1);
    onSent();
  };
  const sourceSymbol = source ? (collaterals[source.index]?.symbol ?? COLLATERAL.symbol) : COLLATERAL.symbol;
  const withdrawLabel = source?.amount ? `Withdraw ${formatAmount(units(source.amount, decimals), 2)} ${sourceSymbol}` : view.refund ? "Withdraw refund" : "Withdraw";
  const payoutText = refundable
    ? `${formatAmount(gross, 2)} ${COLLATERAL.symbol} refund`
    : payout !== null
      ? `${formatAmount(payout, 2)} ${COLLATERAL.symbol}${view.refund ? " refund" : ""}`
      : lot.state === "withdrawn"
        ? "Withdrawn"
        : view.group === "active" || view.label === "Waiting to execute" || lot.state === "pending"
          ? "After the close"
          : "Refund due";

  return (
    <li
      onClick={(event) => {
        if (onSelect && !(event.target as HTMLElement).closest("button, a")) onSelect();
      }}
      className={`${well} flex flex-col gap-3 p-4 ring-1 transition-colors duration-150 ${selected ? "ring-accent/60" : "ring-transparent"} ${onSelect ? "cursor-pointer hover:ring-white/15" : ""} ${selected && onSelect ? "hover:ring-accent/60" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <CoinIcon id={lot.backedAsset} size={28} />
          <span className="flex min-w-0 flex-col">
            {onSelect ? (
              <button type="button" onClick={onSelect} aria-pressed={selected} className="w-fit cursor-pointer text-left text-sm font-semibold">
                {lot.backedAsset}
                <span className="sr-only"> — show this team</span>
              </button>
            ) : (
              <span className="text-sm font-semibold">{lot.backedAsset}</span>
            )}
            <span className="num truncate text-[11px] text-muted">{epoch ? windowText(epoch) : `${utcTime(lot.epochOpensAt)} UTC`}</span>
          </span>
        </span>
        <span className={`shrink-0 rounded-pill px-2 py-0.5 text-[11px] ${STATUS_TONE[view.group]}`}>{view.label}</span>
      </div>
      {cancellable && <p className="text-xs text-muted">This round missed its closing time. Cancel it to get your full stake back.</p>}
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
        {refundable && epoch && refundFrom ? (
          <SendButton
            intent={{ operation: "epoch-refund", opensAt: epoch.opensAt, nonce: lot.nonce, collateralMint: refundFrom.mint }}
            label="Get refund"
            connectLabel="Connect wallet"
            onDone={done}
            className="h-9 rounded-pill bg-accent px-4 text-xs font-medium text-white"
          />
        ) : refundable ? (
          <span className="text-[11px] text-muted">{vaults === undefined ? "Checking…" : "Not refundable yet"}</span>
        ) : cancellable && epoch ? (
          <SendButton
            intent={{ operation: "epoch-void", opensAt: epoch.opensAt }}
            label="Cancel round"
            connectLabel="Connect wallet"
            onDone={done}
            className="h-9 rounded-pill bg-accent px-4 text-xs font-medium text-white"
          />
        ) : owed && epoch && source ? (
          <SendButton
            intent={{ operation: "epoch-withdraw", opensAt: epoch.opensAt, nonce: lot.nonce, amount: source.amount, collateralMint: source.mint }}
            label={withdrawLabel}
            connectLabel="Connect wallet"
            onDone={done}
            className="h-9 rounded-pill bg-accent px-4 text-xs font-medium text-white"
          />
        ) : owed ? (
          <span className="text-[11px] text-muted">{vaults === undefined ? "Checking…" : "Not withdrawable yet"}</span>
        ) : null}
      </div>
    </li>
  );
}

function YourEntries({ epochs, lots, now, decimals, configuration, collaterals, teamLot, onShowTeam, onSent }: { epochs: Epoch[]; lots: EpochLot[]; now: number; decimals: number; configuration: EpochConfiguration; collaterals: Collateral[]; teamLot: string | null; onShowTeam: (lot: EpochLot) => void; onSent: () => void }) {
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
            <EntryCard
              key={item.lot.address}
              lot={item.lot}
              epoch={item.epoch}
              now={now}
              decimals={decimals}
              program={configuration.program}
              collaterals={collaterals}
              selected={item.lot.address === teamLot}
              onSelect={item.epoch ? () => onShowTeam(item.lot) : null}
              onSent={onSent}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function EpochsLive({
  read,
  roster,
  serverNow,
  marketOpensAt = null,
}: {
  read: (EpochsSnapshot & { fresh: boolean }) | null;
  roster: string[];
  serverNow: number;
  marketOpensAt?: number | null;
}) {
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
  return <EpochsView overview={shown.overview} roster={roster} serverNow={serverNow} staleSince={staleSince} marketOpensAt={marketOpensAt} />;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-2.5 rounded-xl border border-white/[0.08] bg-surface px-4 py-3 text-sm text-muted">
      <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
      <span>{children}</span>
    </p>
  );
}

export function EpochsView({
  overview,
  roster,
  serverNow,
  staleSince = null,
  marketOpensAt = null,
}: {
  overview: EpochOverview;
  roster: string[];
  serverNow: number;
  staleSince?: number | null;
  marketOpensAt?: number | null;
}) {
  const now = useNow(serverNow);
  const { owner, market } = useAccount();
  const { connecting } = useSigner();
  const decimals = market.decimals || 6;
  const epochs = useMemo(() => [...overview.epochs].sort((a, b) => a.opensAt - b.opensAt), [overview.epochs]);
  const [selected, setSelected] = useState<string | null>(() => pickDefault(epochs, serverNow));
  const [held, setHeld] = useState<{ owner: string; lots: EpochLot[] } | null>(() => (owner && lotsCache.has(owner) ? { owner, lots: lotsCache.get(owner)! } : null));
  const cached = owner ? lotsCache.get(owner) : undefined;
  const lots = owner ? (held?.owner === owner ? held.lots : (cached ?? null)) : [];
  const [explain, setExplain] = useState(false);
  const closeExplain = useCallback(() => setExplain(false), []);
  const epoch = epochs.find((item) => item.address === selected) ?? epochs[0] ?? null;
  const basket = epoch ? epochBasket(epoch) : [];
  const coins = basket.length > 0 ? basket : [...roster];
  const ranked = rankingEpoch(epochs, now);
  const rankedBasket = ranked ? epochBasket(ranked) : [];
  const rankedCoins = rankedBasket.length > 0 ? rankedBasket : [...roster];
  const stage: Stage | null = epoch ? stageOf(epoch, now) : null;
  const next = epochs.find((item) => stageOf(item, now) === "open" && item.entriesOpen) ?? epochs.find((item) => stageOf(item, now) === "upcoming") ?? null;
  const collaterals = useMemo(() => collateralsOf(overview.configuration), [overview.configuration]);

  const loadLots = useCallback(async () => {
    if (!owner) return;
    const result = await walletEpochLots(owner, epochs.map((item) => item.opensAt));
    if (!result.ok) return;
    lotsCache.set(owner, result.value);
    setHeld({ owner, lots: result.value });
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
      <TradeModes current="epoch" />
    </header>
  );
  const marketClosed = marketClosedReason(overview.configuration);
  const entriesKnown = owner ? lots !== null : !connecting;
  const [chosenLot, setChosenLot] = useState<string | null>(null);
  const roundLot = epoch && lots ? ([...lots].filter((item) => item.epochOpensAt === epoch.opensAt && item.owner === owner).sort((a, b) => Number(b.nonce) - Number(a.nonce))[0] ?? null) : null;
  const pickedLot = lots?.find((item) => item.address === chosenLot && item.owner === owner) ?? null;
  const pickedEpoch = pickedLot ? (epochs.find((item) => item.opensAt === pickedLot.epochOpensAt) ?? null) : null;
  const teamLot = pickedLot && pickedEpoch ? pickedLot : roundLot;
  const teamEpoch = pickedLot && pickedEpoch ? pickedEpoch : epoch;
  const showTeam = useCallback((lot: EpochLot) => {
    setChosenLot(lot.address);
    requestAnimationFrame(() => document.getElementById("your-team")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);
  const notices = (
    <>
      {marketClosed && <Notice>{marketClosed}</Notice>}
      {staleSince !== null && <Notice>Rounds could not be refreshed. Showing them as of {utcTime(staleSince)} UTC.</Notice>}
    </>
  );

  if (!epoch || !stage) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        {notices}
        <p className={`${card} p-6 text-sm text-muted`}>
          No Epochs are scheduled yet.
          {marketOpensAt !== null && marketOpensAt > now && ` The market opens at ${clock(marketOpensAt, now)}.`}
        </p>
      </div>
    );
  }


  return (
    <div className="relative isolate flex flex-col gap-5">
      {header}
      {notices}
      <HeroCard epochs={epochs} ranked={ranked} rankedCoins={rankedCoins} now={now} decimals={decimals} onExplain={() => setExplain(true)} />

      {!entriesKnown ? (
        <section aria-busy="true" aria-label="Loading your entry" className={`${card} min-h-[18rem] animate-pulse`} />
      ) : teamLot && teamEpoch ? (
        <TeamCard key={teamLot.address} lot={teamLot} epoch={teamEpoch} now={now} decimals={decimals} entriesOpen={stageOf(teamEpoch, now) === "open" && teamEpoch.entriesOpen && marketClosed === null && overview.configuration.lifecycle === "active"} />
      ) : (
        <PerformerPrompt epoch={epoch} coins={coins} now={now} next={next} marketClosed={marketClosed} active={overview.configuration.lifecycle === "active"} onSelect={setSelected} />
      )}

      <YourEntries epochs={epochs} lots={lots ?? []} now={now} decimals={decimals} configuration={overview.configuration} collaterals={collaterals} teamLot={teamLot?.address ?? null} onShowTeam={showTeam} onSent={() => void loadLots()} />

      {explain && <PayoutModal onClose={closeExplain} />}
    </div>
  );
}
