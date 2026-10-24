"use client";

import type { Epoch, EpochConfiguration, EpochLot, EpochOverview, PreviewHistory } from "@eox/app-api";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Activity, ArrowLeft, BarChart3, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Clock, Coins, LayoutList, Lock, Plus, X } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { walletEpochLots } from "@/app/actions";
import { parseScaled } from "@/lib/amounts";
import { COLLATERAL } from "@/lib/config";
import { type LotGroup, type Move, type Stage, STAGE_LABEL, type VaultBalances, TIMELINE, basketProblem, countdown, epochBasket, executionReferences, feeOf, finalPayout, lotView, moves, refundStage, scoreOf, stageOf, timelineStep, units, utcTime, windowText, withdrawSource } from "@/lib/epoch";
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
const BASKET_SIZE = 30;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const card = "min-w-0 rounded-[24px] border border-white/[0.06] bg-surface";
const gradient = "bg-[linear-gradient(90deg,#f2622e,#ff8a4c)]";
const primary = `flex h-11 w-full items-center justify-center gap-2 rounded-pill ${gradient} text-sm font-medium text-white`;
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
  unopened: "bg-surface-2 text-muted",
  open: "bg-up/15 text-up",
  closing: "bg-warn/15 text-warn",
  expired: "bg-warn/15 text-warn",
  scoring: "bg-warn/15 text-warn",
  allocating: "bg-warn/15 text-warn",
  settled: "bg-surface-2 text-ink",
  voided: "bg-warn/15 text-warn",
};

function StageChip({ stage }: { stage: Stage }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-[11px] font-medium ${STAGE_TONE[stage]}`}><span className="size-1.5 rounded-full bg-current" />{STAGE_LABEL[stage]}</span>;
}

function noCloseText(epoch: Epoch): string {
  const empty = epoch.nextNonce === null || epoch.nextNonce === "0";
  return `No closing reference was recorded within 24 hours of the close. ${empty ? "This Epoch had no entries." : "Every entry is refundable in full, fee included."}`;
}

function bannerText(epoch: Epoch, stage: Stage): string {
  switch (stage) {
    case "upcoming":
      return `This Epoch opens at ${utcTime(epoch.opensAt)} UTC. Entries open then.`;
    case "unopened":
      return "This Epoch was scheduled but never opened, so it took no entries.";
    case "expired":
    case "voided":
      return noCloseText(epoch);
    case "open":
      return `Entries are open until ${utcTime(epoch.closesAt)} UTC. Each entry starts from its execution reference, not from your click.`;
    case "closing":
      return `Waiting for the closing reference at ${utcTime(epoch.closesAt)} UTC. A later market price is never substituted.`;
    case "scoring":
    case "allocating":
      return "Scores and payouts are being calculated. Withdrawals open when allocation finishes.";
    case "settled":
      return "This Epoch is settled. Any payout or refund is withdrawable from My entries.";
  }
}

const HOUR = 3600;
const DOME_POINTS = (() => {
  const points: { left: number; top: number; size: number; depth: number }[] = [];
  const count = 44;
  for (let index = 0; index < count; index += 1) {
    const y = 1 - (index / (count - 1)) * 2;
    const radius = Math.sqrt(1 - y * y);
    const theta = index * 2.399963;
    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;
    if (z < 0.15) continue;
    const round = (value: number) => Math.round(value * 100) / 100;
    points.push({ left: round(50 + x * 42), top: round(50 - y * 42), size: Math.round(18 + z * 26), depth: round(z) });
  }
  return points.sort((a, b) => a.depth - b.depth);
})();

function CoinDome({ coins }: { coins: string[] }) {
  if (coins.length === 0) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 right-[-60px] hidden size-[380px] sm:block lg:right-4">
      <div className="absolute inset-[6%] rounded-full bg-[radial-gradient(circle_at_34%_28%,#3a3a40_0%,#1c1c1f_42%,#0d0d0f_100%)] shadow-[inset_-24px_-34px_70px_rgba(0,0,0,0.65),inset_18px_22px_50px_rgba(242,98,46,0.18),0_0_90px_rgba(242,98,46,0.28)]" />
      <div className="absolute inset-[6%] rounded-full bg-[radial-gradient(circle_at_78%_82%,rgba(242,98,46,0.45),transparent_55%)]" />
      {DOME_POINTS.map((point, index) => (
        <span key={index} className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_6px_14px_rgba(0,0,0,0.55)] ring-2 ring-white/15" style={{ left: `${point.left}%`, top: `${point.top}%`, opacity: Math.round((0.55 + point.depth * 0.45) * 100) / 100 }}>
          <CoinIcon id={coins[index % coins.length]!} size={point.size} />
        </span>
      ))}
    </div>
  );
}

function heroClock(epoch: Epoch, stage: Stage, now: number): { label: string; value: string } {
  if (stage === "open") return { label: "Closes in", value: countdown(epoch.closesAt - now) };
  if (stage === "upcoming") return { label: "Opens in", value: countdown(epoch.opensAt - now) };
  if (stage === "unopened") return { label: "Was due to open", value: `${utcTime(epoch.opensAt)} UTC` };
  return { label: "Closed", value: `${utcTime(epoch.closesAt)} UTC` };
}

function HeroCard({ epoch, now, decimals, coins, canEnter, onEnter, onExplain }: { epoch: Epoch; now: number; decimals: number; coins: string[]; canEnter: boolean; onEnter: () => void; onExplain: () => void }) {
  const stage = stageOf(epoch, now);
  const clock = heroClock(epoch, stage, now);
  const settled = epoch.settlementPot !== null && (stage === "allocating" || stage === "settled");
  const pot = settled ? units(epoch.settlementPot!, decimals) : epoch.ledger ? units(epoch.ledger.activeNet, decimals) : null;
  const queued = epoch.ledger ? units(epoch.ledger.pendingGross, decimals) : null;
  const entries = epoch.nextNonce !== null ? Number(epoch.nextNonce) : (epoch.lots?.executed ?? null);
  const day = new Date(epoch.opensAt * 1000).toUTCString().slice(5, 11);
  const stats = [
    { label: clock.label, value: clock.value },
    { label: settled ? "Settlement pot" : "Net stake pot", value: pot === null ? "—" : `${formatAmount(pot, 2)} ${COLLATERAL.symbol}` },
    { label: "Entries", value: entries === null ? "—" : String(entries) },
    { label: "Queued", value: queued === null ? "—" : `${formatAmount(queued, 2)} ${COLLATERAL.symbol}` },
  ];

  return (
    <section className="relative isolate min-h-[260px] overflow-hidden rounded-[28px] border border-white/[0.06] bg-surface p-6 sm:p-9">
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(60%_90%_at_88%_100%,rgba(242,98,46,0.28),transparent_70%),radial-gradient(50%_80%_at_0%_0%,rgba(255,255,255,0.05),transparent_70%)]" />
      <CoinDome coins={coins} />
      <div className="relative flex max-w-xl flex-col gap-4">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-pill bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-ink">
          <span className={`size-1.5 rounded-full ${stage === "open" ? "bg-up" : refundStage(stage) ? "bg-warn" : "bg-muted"}`} />
          {STAGE_LABEL[stage]}
        </span>
        <h2 className="text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
          {day} Epoch
          <span className="mt-1 block text-base font-normal text-muted">{utcTime(epoch.opensAt)}–{utcTime(epoch.closesAt)} UTC</span>
        </h2>
        <p className="max-w-md text-sm leading-relaxed text-muted">{bannerText(epoch, stage)}</p>
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col">
              <dt className="text-[11px] text-muted">{stat.label}</dt>
              <dd className="num text-sm font-semibold text-ink">{stat.value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-1 flex flex-wrap gap-2">
          {canEnter && (
            <button type="button" onClick={onEnter} className="inline-flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-accent px-5 text-sm font-medium text-white shadow-[0_8px_24px_rgba(242,98,46,0.35)] transition-transform duration-150 hover:-translate-y-0.5">
              <Plus size={15} aria-hidden="true" /> New entry
            </button>
          )}
          <button type="button" onClick={onExplain} aria-haspopup="dialog" className={`inline-flex h-11 cursor-pointer items-center rounded-xl px-5 text-sm font-medium transition-transform duration-150 hover:-translate-y-0.5 ${canEnter ? "bg-surface-2 text-ink hover:bg-white/10" : "bg-accent text-white shadow-[0_8px_24px_rgba(242,98,46,0.35)]"}`}>
            How payouts work
          </button>
        </div>
      </div>
    </section>
  );
}

const TILE_TONE: Record<Stage, string> = {
  upcoming: "bg-surface-2 text-ink",
  unopened: "bg-surface-2 text-muted",
  open: "bg-accent/15 text-accent",
  closing: "bg-warn/15 text-warn",
  expired: "bg-warn/15 text-warn",
  scoring: "bg-warn/15 text-warn",
  allocating: "bg-warn/15 text-warn",
  settled: "bg-ink text-bg",
  voided: "bg-warn/15 text-warn",
};

function RoundList({ epochs, selected, now, onSelect }: { epochs: Epoch[]; selected: string; now: number; onSelect: (address: string) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="px-1 text-sm font-medium">Rounds</h3>
      <ul className="flex max-h-[420px] flex-col gap-2 overflow-y-auto pr-1 [scrollbar-width:thin]">
        {[...epochs].reverse().map((item) => {
          const stage = stageOf(item, now);
          const on = item.address === selected;
          const date = new Date(item.opensAt * 1000);
          const chipText = stage === "open" ? countdown(item.closesAt - now).slice(0, 5) : stage === "upcoming" ? `opens ${utcTime(item.opensAt)}` : `${utcTime(item.closesAt)}`;
          return (
            <li key={item.address}>
              <button type="button" onClick={() => onSelect(item.address)} aria-pressed={on} className={`flex w-full cursor-pointer items-center gap-4 rounded-2xl p-3 text-left transition-colors duration-150 ${on ? "bg-accent text-white shadow-[0_10px_24px_rgba(242,98,46,0.3)]" : "hover:bg-white/[0.04]"}`}>
                <span className={`grid h-14 w-12 shrink-0 place-items-center rounded-xl py-1 leading-none shadow-[0_5px_0_rgba(0,0,0,0.28)] ${on ? "bg-white/20 text-white" : TILE_TONE[stage]}`}>
                  <span className="text-[9px] font-medium uppercase tracking-wide opacity-70">{date.toUTCString().slice(0, 3)}</span>
                  <span className="num text-xl font-semibold">{date.getUTCDate()}</span>
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="num truncate text-sm font-medium">{utcTime(item.opensAt)}–{utcTime(item.closesAt)} UTC</span>
                  <span className={`text-[11px] ${on ? "text-white/75" : "text-muted"}`}>{STAGE_LABEL[stage]}</span>
                  <span className={`num w-fit rounded-md px-1.5 py-0.5 text-[10px] ${on ? "bg-white text-accent" : "bg-surface-2 text-muted"}`}>{chipText}</span>
                </span>
                <ChevronRight size={15} aria-hidden="true" className={on ? "text-white" : "text-muted"} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const BAR_TONES = [
  "bg-[linear-gradient(90deg,#f4f4f5,#d4d4d8)] text-[#121214]",
  "bg-[linear-gradient(90deg,rgba(242,98,46,0.45),#f2622e)] text-white",
  "bg-[linear-gradient(90deg,#3a3a40,#55555c)] text-ink",
];

function EntryTimeline({ epoch, lots, now, decimals, connected }: { epoch: Epoch; lots: EpochLot[]; now: number; decimals: number; connected: boolean }) {
  const span = epoch.closesAt - epoch.opensAt;
  const at = (time: number) => Math.min(100, Math.max(0, ((time - epoch.opensAt) / span) * 100));
  const ticks = Array.from({ length: Math.round(span / HOUR) + 1 }, (_, index) => epoch.opensAt + index * HOUR);
  const live = now >= epoch.opensAt && now < epoch.closesAt;
  const nowTick = live ? epoch.opensAt + Math.floor((now - epoch.opensAt) / HOUR) * HOUR : null;
  const mine = lots.filter((lot) => lot.epochOpensAt === epoch.opensAt).sort((a, b) => (a.execution?.timestamp ?? a.admittedAt) - (b.execution?.timestamp ?? b.admittedAt));
  const shown = mine.slice(0, 6);
  const grid = "grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3";

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <h3 className="text-sm font-medium">Entry timeline</h3>
        <span className="text-[11px] text-muted">Each entry counts from its execution to the fixed close</span>
      </div>
      <div className="overflow-x-auto rounded-2xl bg-bg/60 p-4 [scrollbar-width:thin]">
        <div className="flex min-w-[520px] flex-col gap-3">
          <div className={grid}>
            <span className="text-[11px] text-muted">{new Date(epoch.opensAt * 1000).toUTCString().slice(8, 11)}</span>
            <div className="relative h-8">
              {ticks.map((tick, index) => (
                <span key={tick} className={`absolute top-1/2 -translate-y-1/2 ${index === 0 ? "" : index === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ left: `${at(tick)}%` }}>
                  <span className={`num grid h-7 min-w-7 place-items-center rounded-full px-1.5 text-[11px] font-medium ${tick === nowTick ? "bg-accent text-white shadow-[0_0_16px_rgba(242,98,46,0.55)]" : "text-ink/80"}`}>{utcTime(tick)}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="relative flex flex-col gap-3">
            <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-[84px] right-0">
              {ticks.map((tick) => <span key={tick} className="absolute inset-y-0 w-px bg-white/[0.06]" style={{ left: `${at(tick)}%` }} />)}
              {live && <span className="absolute inset-y-[-6px] w-0.5 rounded-full bg-accent shadow-[0_0_10px_rgba(242,98,46,0.7)]" style={{ left: `${at(now)}%` }} />}
            </div>
            <div className={grid}>
              <span className="text-[11px] text-muted">Window</span>
              <div className="relative h-7">
                <span className="absolute inset-y-0 left-0 right-0 overflow-hidden rounded-lg bg-white/[0.07]">
                  <span className={`absolute inset-y-0 left-0 ${gradient}`} style={{ width: `${live ? at(now) : now >= epoch.closesAt ? 100 : 0}%` }} />
                </span>
                <span className="absolute inset-0 flex items-center px-3 text-[11px] font-medium text-white">{live ? "Entries open" : now < epoch.opensAt ? "Not open yet" : "Entries closed"}</span>
              </div>
            </div>
            {shown.map((lot, index) => {
              const start = lot.execution?.timestamp ?? lot.admittedAt;
              const left = at(start);
              const width = Math.max(4, 100 - left);
              return (
                <div key={lot.address} className={grid}>
                  <span className="flex items-center gap-1.5 truncate text-[11px] text-muted"><CoinIcon id={lot.backedAsset} size={16} />{lot.backedAsset}</span>
                  <div className="relative h-7">
                    <span className={`absolute inset-y-0 flex items-center justify-end overflow-hidden rounded-lg px-2.5 text-[10px] font-medium ${lot.execution ? BAR_TONES[index % BAR_TONES.length] : "border border-dashed border-white/30 text-muted"}`} style={{ left: `${left}%`, width: `${width}%` }}>
                      <span className="num truncate">{lot.execution ? `${utcTime(start, true)} · ${formatAmount(units(lot.grossStake, decimals), 2)} ${COLLATERAL.symbol}` : "Awaiting execution"}</span>
                    </span>
                  </div>
                </div>
              );
            })}
            {shown.length === 0 && (
              <div className={grid}>
                <span className="text-[11px] text-muted">Entries</span>
                <p className="py-1.5 text-[11px] text-muted">{connected ? "You have no entries in this Epoch." : "Connect a wallet to see your entries here."}</p>
              </div>
            )}
            {mine.length > shown.length && <p className="pl-[84px] text-[11px] text-muted">+{mine.length - shown.length} more in My entries</p>}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 px-1 text-[11px] text-muted">
        <span className="flex items-center gap-1.5"><span className={`size-2 rounded-full ${gradient}`} />Entry window</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-ink" />Your entries</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-accent" />Now</span>
      </div>
    </div>
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
  { kicker: "Step 4", title: "Share the pot", body: "The pot is the net stake of every executed entry. Each entry is paid its weight's share of the total weight. A score of zero gets nothing back, unless every entry scores zero: then every stake is refunded in full, fee included." },
  { kicker: "Example", title: "Two entries, one pot", body: "Two 100 USDC entries, each with a net stake of 99.98 after the fee. Scores of 10% and 30% split the 199.96 pot 25% / 75%. The first coin beat $CRYPTO, yet that entry gets back 49.99 of its 100.", visual: "split" },
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
  const noResult = stage === "unopened" || refundStage(stage);
  const opening = useOpeningReferences(noResult ? null : epoch, now);
  const closing = useMemo(() => {
    if (epoch.closingReferences.length === 0) return null;
    return Object.fromEntries(epoch.closingReferences.map((item) => [item.assetId, (Number(BigInt(item.reference)) / 10 ** REFERENCE_DIGITS) * PREVIEW_BASE]));
  }, [epoch.closingReferences]);
  const end = closing ?? (stage === "open" ? (estimate?.references ?? null) : null);
  const rows = moves(coins, opening ?? null, end);
  const scored = rows.filter((row) => row.change !== null);
  const largest = Math.max(1e-9, ...scored.map((row) => Math.abs(row.change ?? 0)));
  const ready = opening != null && end !== null && scored.length > 0;
  const leader = scored[0] ?? null;
  const laggard = scored[scored.length - 1] ?? null;
  const above = scored.filter((row) => (row.change ?? 0) > 0).length;
  const below = scored.filter((row) => (row.change ?? 0) < 0).length;
  const focus = (backed ? rows.find((row) => row.id === backed) : null) ?? leader;

  const basis = closing
    ? `Closing reference · ${utcTime(epoch.closesAt, true)} UTC`
    : stage !== "open"
      ? stage === "closing"
        ? "Awaiting closing reference"
        : "No closing reference"
      : freshness === "live" && estimate
        ? `Live estimate · ${utcTime(estimate.at, true)} UTC`
        : estimate
          ? `Estimate paused · ${utcTime(estimate.at, true)} UTC`
          : "Estimate unavailable";
  const liveBadge = stage === "open" && freshness === "live";
  const empty =
    stage === "upcoming"
      ? { title: "Not open yet", text: `Moves appear once this Epoch opens at ${utcTime(epoch.opensAt)} UTC.`, pending: false }
      : stage === "unopened"
        ? { title: "No moves", text: "This Epoch never opened, so it has no moves.", pending: false }
        : refundStage(stage)
          ? { title: "No result", text: "No closing reference was recorded, so this Epoch has no result.", pending: false }
          : stage === "closing"
            ? { title: "Awaiting the close", text: "A later market price is not substituted for the closing reference.", pending: true }
            : opening === undefined
              ? { title: "Loading moves", text: "Reading the estimate at the Epoch start.", pending: true }
              : opening === null
                ? { title: "No market data", text: "The estimate at the Epoch start is not available.", pending: false }
                : { title: "Waiting for prices", text: "Awaiting the live estimate.", pending: true };

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
          {stage !== "upcoming" && stage !== "unopened" && <span className={`num rounded-pill px-2.5 py-1 text-[11px] ${closing ? "bg-surface-2 text-ink" : liveBadge ? "bg-surface-2 text-muted" : "bg-warn/15 text-warn"}`}>{basis}</span>}
        </CardHead>

        {ready && focus && (
          <div className="flex flex-wrap items-end justify-between gap-5">
            <div className="flex flex-col gap-3">
              <span className={`${eyebrow} flex items-center gap-2`}>
                <CoinIcon id={focus.id} size={18} />
                {focus.id} · {focus.id === backed ? "selected" : "leading"} · since the {utcTime(epoch.opensAt)} UTC estimate
              </span>
              <p className={`num text-[2.5rem] font-semibold leading-none tracking-tight ${tone(focus.change)}`}>{pct(focus.change)}</p>
            </div>
            <dl className="flex min-w-0 max-w-xl flex-1 basis-[35rem] divide-x divide-white/[0.06] overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {stats.map((stat) => (
                <div key={stat.label} className="flex min-w-[8.75rem] flex-1 shrink-0 flex-col gap-1.5 px-3 py-2.5">
                  <dt className="whitespace-nowrap text-[11px] text-muted">{stat.label}</dt>
                  <dd className="flex items-center gap-1.5 whitespace-nowrap">
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

      {!ready || stage === "upcoming" ? (
        <EmptyMarket title={empty.title} pending={empty.pending}>
          {empty.text}
        </EmptyMarket>
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
      {refundStage(stage) ? (
        <p className="flex items-start gap-2 text-xs text-warn"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />{noCloseText(epoch)}</p>
      ) : stage === "unopened" ? (
        <p className="flex items-start gap-2 text-xs text-muted"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />This Epoch was scheduled but never opened.</p>
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

function EntryPanel(props: { epoch: Epoch; basket: string[]; now: number; decimals: number; fee: { bps: number; cap: string }; collaterals: Collateral[]; next: Epoch | null; backed: string | null; anchored?: boolean; onBacked: (id: string) => void; onSelect: (address: string) => void; onSent: () => void; onClose?: () => void }) {
  const { epoch, basket: coins, now, decimals, fee, backed, collaterals } = props;
  const { owner } = useAccount();
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState(false);
  const [showBasket, setShowBasket] = useState(false);
  const [sent, setSent] = useState(0);
  const [pay, setPay] = useState<string | null>(null);
  const chosen = collaterals.find((item) => item.mint === pay) ?? collaterals[0] ?? null;
  const symbol = chosen?.symbol ?? COLLATERAL.symbol;
  const wallet = useWalletCollateral(chosen?.mint ?? null, decimals, sent);
  const stage = stageOf(epoch, now);
  const open = stage === "open" && epoch.entriesOpen;
  const gross = amount.trim() === "" ? null : parseScaled(amount, decimals);
  const charge = gross !== null && gross > 0n ? feeOf(gross, fee.bps, BigInt(fee.cap)) : null;
  const net = gross !== null && charge !== null ? gross - charge : null;
  const basketIssue = basketProblem(coins);
  const exact = basketIssue === null;
  const short = wallet !== null && gross !== null && Number(gross) / 10 ** decimals > wallet;
  const problem = !backed ? "Choose the asset to back." : gross === null || gross <= 0n ? "Enter a stake above zero." : basketIssue ? basketIssue : short ? `Your wallet has ${formatAmount(wallet ?? 0, 2)} ${symbol}.` : null;
  const collateralMint = collaterals.length > 1 && chosen ? chosen.mint : undefined;
  const intent: Intent | null = open && problem === null && gross !== null && backed !== null ? { operation: "epoch-entry", opensAt: epoch.opensAt, grossStake: gross.toString(), basket: coins, backedAsset: backed, collateralMint } : null;
  const show = (value: bigint | null) => (value === null ? "—" : `${formatAmount(Number(value) / 10 ** decimals, 2)} ${symbol}`);
  const cap = `${formatAmount(units(fee.cap, decimals), 2)} ${symbol}`;
  const anchor = props.anchored === false ? undefined : "epoch-entry";

  const other = props.next && props.next.address !== epoch.address ? props.next : null;
  const otherOpen = other !== null && stageOf(other, now) === "open" && other.entriesOpen;
  const nextText = other ? (otherOpen ? `Entries are open in the ${windowText(other)} Epoch.` : `The next Epoch runs ${windowText(other)}.`) : "No other Epoch is open or scheduled right now.";
  const closedReason =
    stage === "upcoming"
      ? `This Epoch opens at ${utcTime(epoch.opensAt)} UTC. It is shown for information until entries open.`
      : stage === "open"
        ? "This Epoch is not taking entries right now (for example it is full or paused)."
        : stage === "unopened"
          ? `This Epoch never opened. ${nextText}`
          : `This Epoch has closed. ${nextText}`;

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
      <section id={anchor} className={`${card} flex flex-col gap-4 p-5`}>
        {head}
        <div className={`${well} flex items-start gap-3 text-sm text-muted`}>
          <Clock size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          {closedReason}
        </div>
        {other && stage !== "upcoming" && stage !== "open" && (
          <button type="button" onClick={() => props.onSelect(other.address)} className={quiet}>
            {otherOpen ? "Go to the open Epoch" : "Show the next Epoch"} <ChevronRight size={14} aria-hidden="true" />
          </button>
        )}
      </section>
    );
  }

  if (review && intent && gross !== null && charge !== null && net !== null && backed) {
    return (
      <section id={anchor} className={`${card} flex flex-col gap-4 p-5`}>
        {head}
        <div className={`${well} flex items-center gap-3`}>
          <CoinIcon id={backed} size={32} />
          <span className="text-base font-semibold">{backed}</span>
          <span className="rounded-pill bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">Backed</span>
          <span className="num ml-auto text-xs text-muted">in a 30-coin basket</span>
        </div>
        <dl className="flex flex-col gap-2 text-xs">
          <div className="flex justify-between gap-4"><dt className="text-muted">Gross stake</dt><dd className="num text-right">{show(gross)}</dd></div>
          {collaterals.length > 1 && <div className="flex justify-between gap-4"><dt className="text-muted">Pay with</dt><dd className="num text-right">{symbol}</dd></div>}
          <div className="flex justify-between gap-4"><dt className="text-muted">Entry fee, held</dt><dd className="num text-right">{show(charge)}</dd></div>
          <div className="flex justify-between gap-4 text-sm font-medium"><dt>Net stake</dt><dd className="num text-right">{show(net)}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">Closes</dt><dd className="num text-right">{utcTime(epoch.closesAt)} UTC · in {countdown(epoch.closesAt - now)}</dd></div>
        </dl>
        <ul className={`${well} flex flex-col gap-1.5 text-[11px] text-muted`}>
          <li className="flex gap-2"><Lock size={12} aria-hidden="true" className="mt-0.5 shrink-0" />The backed asset and basket are fixed once submitted. An entry cannot be cancelled or exited early.</li>
          <li className="flex gap-2"><Clock size={12} aria-hidden="true" className="mt-0.5 shrink-0" />Performance starts from the execution reference, not from this click. If the entry has not executed by the close, it is refunded in full.</li>
          <li className="flex gap-2"><Coins size={12} aria-hidden="true" className="mt-0.5 shrink-0" />The fee is kept at settlement. It is refunded if the entry never executes, the Epoch is voided or every entry scores zero.</li>
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
    <section id={anchor} className={`${card} flex flex-col gap-4 p-5`}>
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
            <span className="text-sm">{exact ? `30 coins · 1 backed + 29 comparison` : coins.length > BASKET_SIZE ? `${coins.length} coins offered` : "Asset list not available"}</span>
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
          {owner && <span className="num">Wallet {wallet === null ? "…" : formatAmount(wallet, 2)} {symbol}</span>}
        </div>
        <div className="flex items-center gap-2">
          <input id={props.anchored === false ? undefined : "epoch-stake"} aria-label="Stake" inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} className="num min-w-0 flex-1 bg-transparent text-2xl font-semibold text-ink outline-none placeholder:text-muted/50" />
          <span className="text-xs text-muted">{symbol}</span>
        </div>
        {collaterals.length > 1 && (
          <div role="group" aria-label="Pay with" className="flex flex-wrap items-center gap-1 text-xs">
            <span className="mr-1 text-muted">Pay with</span>
            {collaterals.map((item) => (
              <button key={item.mint} type="button" aria-pressed={item.mint === chosen?.mint} onClick={() => setPay(item.mint)} className={`h-7 cursor-pointer rounded-pill px-3 transition-colors duration-150 ${item.mint === chosen?.mint ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>
                {item.symbol}
              </button>
            ))}
          </div>
        )}
      </div>

      <dl className="flex flex-col gap-1.5 text-xs">
        <div className="flex justify-between gap-4"><dt className="text-muted">Entry fee ({fee.bps / 100}%, max {cap})</dt><dd className="num">{show(charge)}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted">Net stake</dt><dd className="num font-medium text-ink">{show(net)}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-muted">Closes</dt><dd className="num">{utcTime(epoch.closesAt)} UTC</dd></div>
      </dl>
      <p className="-mt-2 text-[11px] text-muted">The fee is held until settlement and then kept. It is refunded if the entry never executes, the Epoch is voided or every entry scores zero.</p>

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

function EntryRow({ lot, epoch, now, decimals, program, collaterals, onSent }: { lot: EpochLot; epoch: Epoch | null; now: number; decimals: number; program: string; collaterals: Collateral[]; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(0);
  const view = lotView(lot, epoch, now);
  const since = useEntryMoves(lot, epoch);
  const gross = units(lot.grossStake, decimals);
  const net = gross - units(lot.fee, decimals);
  const score = scoreOf(lot, epoch);
  const paid = finalPayout(lot, epoch);
  const payout = paid === null ? null : units(paid, decimals);
  const owed = lot.state === "claimable" && paid !== null && paid > 0n;
  const result = payout !== null && !view.refund ? payout - gross : null;
  const vaults = useEpochVaults(program, owed && epoch ? epoch.address : null, sent);
  const source = owed && vaults !== undefined && paid !== null ? withdrawSource(collaterals.map((item) => item.mint), vaults, paid) : null;
  const sourceSymbol = source ? (collaterals[source.index]?.symbol ?? COLLATERAL.symbol) : COLLATERAL.symbol;
  const withdrawLabel = source?.amount
    ? `Withdraw ${formatAmount(units(source.amount, decimals), 4)} ${sourceSymbol}`
    : `${view.refund ? "Withdraw refund" : "Withdraw"}${collaterals.length > 1 ? ` · ${sourceSymbol}` : ""}`;
  const notSettled = view.group === "active" || view.label === "Awaiting execution";
  const executed = lot.execution ? `Executed ${utcTime(lot.execution.timestamp, true)} UTC` : `Entered ${utcTime(lot.admittedAt, true)} UTC · ${epoch && now >= epoch.closesAt ? "not executed" : "awaiting"}`;

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
          <span>{formatAmount(gross, 4)}</span>
          <span className="text-[10px] text-muted">net {formatAmount(net, 4)}</span>
        </span>
        <span className="num flex flex-col">
          <span className="text-muted">{executed}</span>
          {since.backed && since.backed.change !== null && (
            <span className="text-[10px]">
              <span className={tone(since.backed.change)}>{lot.backedAsset} {pct(since.backed.change, 2)}</span>
              <span className="text-muted"> since execution · {since.basis}</span>
            </span>
          )}
        </span>
        <span className="num">{score === null ? "—" : `${formatAmount(score * 100, 2)}%`}</span>
        <span className="num flex flex-col">
          <span>{payout === null ? (lot.state === "withdrawn" ? "Withdrawn" : notSettled ? "Not settled" : "Refund due") : `${formatAmount(payout, 4)}${view.refund ? " refund" : ""}`}</span>
          {(result !== null || (payout !== null && lot.state === "withdrawn")) && (
            <span className="text-[10px]">
              {result !== null && <span className={tone(result)}>{result >= 0 ? "+" : "−"}{formatAmount(Math.abs(result), 4)}</span>}
              {payout !== null && lot.state === "withdrawn" && <span className="text-muted">{result !== null ? " · " : ""}withdrawn</span>}
            </span>
          )}
        </span>
        <span className="flex items-center justify-end gap-2">
          {owed && epoch && source ? (
            <SendButton
              intent={{ operation: "epoch-withdraw", opensAt: epoch.opensAt, nonce: lot.nonce, amount: source.amount, collateralMint: source.mint }}
              label={withdrawLabel}
              connectLabel="Connect wallet"
              onDone={() => {
                setSent((count) => count + 1);
                onSent();
              }}
              className={`h-8 rounded-pill px-3 text-xs font-medium text-white ${gradient}`}
            />
          ) : owed ? (
            <span className="text-[11px] text-muted">{vaults === undefined ? "Checking…" : "Not withdrawable yet"}</span>
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

function MyEntries({ epochs, lots, now, decimals, configuration, collaterals, onSent }: { epochs: Epoch[]; lots: EpochLot[]; now: number; decimals: number; configuration: EpochConfiguration; collaterals: Collateral[]; onSent: () => void }) {
  const { owner } = useAccount();
  const [filter, setFilter] = useState<LotGroup | "all">("all");
  const byOpen = new Map(epochs.map((epoch) => [epoch.opensAt, epoch]));
  const views = lots
    .map((lot) => ({ lot, epoch: byOpen.get(lot.epochOpensAt) ?? null }))
    .map((item) => ({ ...item, view: lotView(item.lot, item.epoch, now) }))
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
            <span>Stake</span>
            <span>Basis</span>
            <span>Score</span>
            <span>Payout</span>
            <span />
          </div>
          <ul>
            {shown.map((item) => (
              <EntryRow key={item.lot.address} lot={item.lot} epoch={item.epoch} now={now} decimals={decimals} program={configuration.program} collaterals={collaterals} onSent={onSent} />
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
  const basket = epoch ? epochBasket(epoch) : [];
  const coins = basket.length > 0 ? basket : [...roster];
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
    basket,
    now,
    decimals,
    fee: overview.configuration.entryFee,
    collaterals,
    next,
    backed,
    onBacked: setBacked,
    onSelect: (address: string) => setSelected(address),
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
    <div className={`relative isolate flex flex-col gap-5 ${open ? "pb-24 xl:pb-0" : ""}`}>
      {header}
      <HeroCard epoch={epoch} now={now} decimals={decimals} coins={coins} canEnter={open} onEnter={enter} onExplain={() => setExplain(true)} />

      <section className={`${card} grid gap-6 p-5 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]`}>
        <RoundList epochs={epochs} selected={epoch.address} now={now} onSelect={(address) => setSelected(address)} />
        <EntryTimeline epoch={epoch} lots={lots} now={now} decimals={decimals} connected={Boolean(owner)} />
      </section>
      {!open && (
        <div className="xl:hidden">
          <EntryPanel {...entryProps} anchored={false} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-8">
          <MovesCard epoch={epoch} coins={coins} now={now} backed={backed} canPick={open} onPick={(id) => setBacked(id)} />
          <MyEntries epochs={epochs} lots={lots} now={now} decimals={decimals} configuration={overview.configuration} collaterals={collaterals} onSent={() => void loadLots()} />
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
          <EntryPanel {...entryProps} anchored={false} onClose={() => setSheet(false)} />
          <button type="button" onClick={() => setExplain(true)} className="mx-auto cursor-pointer text-xs text-accent underline-offset-4 hover:underline">How payouts work</button>
        </div>
      )}
      {explain && <PayoutModal onClose={closeExplain} />}
    </div>
  );
}
