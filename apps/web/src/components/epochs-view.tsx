"use client";

import type { Epoch, EpochLot, EpochOverview, PreviewHistory } from "@eox/app-api";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleDot, Clock, Hourglass, Lock, Plus, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { walletEpochLots } from "@/app/actions";
import { parseScaled } from "@/lib/amounts";
import { COLLATERAL } from "@/lib/config";
import { type LotGroup, type Move, type Stage, STAGE_LABEL, TIMELINE, countdown, feeOf, lotView, moves, scoreOf, stageOf, timelineStep, units, utcTime, windowText } from "@/lib/epoch";
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
const panel = "rounded-card border border-line bg-surface shadow-card";
const field = "num h-11 w-full rounded-control border border-line bg-bg px-3 text-sm text-ink placeholder:text-muted";
const primary = "flex h-11 w-full items-center justify-center gap-2 rounded-pill bg-accent text-sm font-medium text-accent-ink";
const quiet = "flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-pill border border-line text-sm transition-colors duration-150 hover:bg-surface-2";

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

function ModeSwitch() {
  return (
    <div role="tablist" aria-label="Mode" className="inline-flex rounded-pill border border-line bg-surface p-1">
      <Link href="/markets" role="tab" aria-selected={false} className="rounded-pill px-4 py-1.5 text-sm text-muted transition-colors duration-150 hover:text-ink">Basic</Link>
      <span role="tab" aria-selected className="rounded-pill bg-surface-2 px-4 py-1.5 text-sm font-medium text-ink">Epoch</span>
    </div>
  );
}

const STAGE_STYLE: Record<Stage, { className: string; icon: typeof CircleDot }> = {
  upcoming: { className: "border-line text-muted", icon: Clock },
  open: { className: "border-accent text-accent", icon: CircleDot },
  closing: { className: "border-warn text-warn", icon: Hourglass },
  scoring: { className: "border-warn text-warn", icon: Hourglass },
  allocating: { className: "border-warn text-warn", icon: Hourglass },
  settled: { className: "border-line text-ink", icon: Check },
  voided: { className: "border-warn text-warn", icon: CircleAlert },
};

function StagePill({ stage }: { stage: Stage }) {
  const style = STAGE_STYLE[stage];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${style.className}`}>
      <style.icon size={12} aria-hidden="true" />
      {STAGE_LABEL[stage]}
    </span>
  );
}

function ClockStrip({ epochs, epoch, now, onSelect }: { epochs: Epoch[]; epoch: Epoch; now: number; onSelect: (address: string) => void }) {
  const mounted = useMounted();
  const stage = stageOf(epoch, now);
  const index = epochs.findIndex((item) => item.address === epoch.address);
  const previous = epochs[index - 1];
  const next = epochs[index + 1];
  const local = mounted ? new Date(epoch.closesAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  const timer =
    stage === "upcoming" ? `Opens in ${countdown(epoch.opensAt - now)}` : stage === "open" ? `Closes in ${countdown(epoch.closesAt - now)}` : stage === "closing" ? "Awaiting closing reference" : null;
  const arrow = "grid size-9 shrink-0 cursor-pointer place-items-center rounded-pill border border-line text-muted transition-colors duration-150 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30";

  return (
    <section className={`${panel} flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between`}>
      <div className="flex items-center gap-3">
        <button type="button" className={arrow} disabled={!previous} onClick={() => previous && onSelect(previous.address)} aria-label="Previous Epoch">
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <div className="flex flex-col gap-1">
          <span className="num text-base font-semibold">{windowText(epoch)}</span>
          <span className="num text-xs text-muted">Closes {utcTime(epoch.closesAt)} UTC{local ? ` · ${local} your time` : ""}</span>
        </div>
        <button type="button" className={arrow} disabled={!next} onClick={() => next && onSelect(next.address)} aria-label="Next Epoch">
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="flex items-center gap-3 sm:justify-end">
        <StagePill stage={stage} />
        {timer && <span className="num text-sm font-medium">{timer}</span>}
      </div>
    </section>
  );
}

function Comparison({ epoch, coins, now, backed, canPick, onPick }: { epoch: Epoch; coins: string[]; now: number; backed: string | null; canPick: boolean; onPick: (id: string) => void }) {
  const { estimate, freshness } = useLive();
  const stage = stageOf(epoch, now);
  const opening = useOpeningReferences(epoch, now);
  const closing = useMemo(() => {
    if (epoch.closingReferences.length === 0) return null;
    return Object.fromEntries(epoch.closingReferences.map((item) => [item.assetId, (Number(BigInt(item.reference)) / 10 ** REFERENCE_DIGITS) * PREVIEW_BASE]));
  }, [epoch.closingReferences]);
  const end = closing ?? (stage === "open" ? (estimate?.references ?? null) : null);
  const rows = moves(coins, opening, end);
  const largest = Math.max(1e-9, ...rows.map((row) => Math.abs(row.change ?? 0)));
  const ready = opening !== null && end !== null;

  const basis = closing
    ? `Closing reference · ${utcTime(epoch.closesAt, true)} UTC`
    : freshness === "live" && estimate
      ? `Live estimate · as of ${utcTime(estimate.at, true)} UTC`
      : estimate
        ? `Estimate paused · last update ${utcTime(estimate.at, true)} UTC`
        : "Estimate unavailable";

  return (
    <section className={`${panel} min-w-0`}>
      <header className="flex flex-wrap items-end justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Relative moves since Epoch start</h2>
          <p className="text-xs text-muted">Each asset against $CRYPTO from the opening reference at {utcTime(epoch.opensAt)} UTC.</p>
        </div>
        {stage !== "upcoming" && (
          <span className={`num rounded-pill border px-2 py-0.5 text-[11px] ${closing ? "border-line text-ink" : freshness === "live" ? "border-dashed border-line text-muted" : "border-warn text-warn"}`}>{basis}</span>
        )}
      </header>

      {stage === "upcoming" ? (
        <p className="px-4 py-10 text-center text-sm text-muted">Moves appear once this Epoch opens at {utcTime(epoch.opensAt)} UTC.</p>
      ) : !ready ? (
        <p className="px-4 py-10 text-center text-sm text-muted">{stage === "open" ? "Loading the opening references…" : "Awaiting the closing reference. A later market price is not substituted."}</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <MoveRow key={row.id} row={row} largest={largest} backed={row.id === backed} canPick={canPick} onPick={() => onPick(row.id)} />
          ))}
        </ul>
      )}
      <p className="border-t border-line px-4 py-3 text-xs text-muted">0% means matching $CRYPTO over the interval, not an unchanged USD price. This ranks assets, not entries or payouts.</p>
    </section>
  );
}

function MoveRow({ row, largest, backed, canPick, onPick }: { row: Move; largest: number; backed: boolean; canPick: boolean; onPick: () => void }) {
  const width = row.change === null ? 0 : Math.round((Math.abs(row.change) / largest) * 50);
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2.5">
        <CoinIcon id={row.id} size={22} />
        <span className="truncate text-sm font-medium">{row.id}</span>
        {backed && <span className="rounded-pill bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent-ink">Backed</span>}
      </span>
      <span className="relative hidden h-2 sm:block" aria-hidden="true">
        <span className="absolute inset-y-0 left-1/2 w-px bg-line" />
        {row.change !== null && (
          <span
            className={`absolute inset-y-0 rounded-pill ${backed ? "bg-accent" : row.change >= 0 ? "bg-up/70" : "bg-down/70"}`}
            style={row.change >= 0 ? { left: "50%", width: `${width}%` } : { right: "50%", width: `${width}%` }}
          />
        )}
      </span>
      <span className={`num text-right text-sm ${tone(row.change)}`}>{pct(row.change)}</span>
    </>
  );
  const grid = `grid w-full grid-cols-[minmax(0,1fr)_88px] items-center gap-4 px-4 py-2.5 text-left sm:grid-cols-[160px_minmax(0,1fr)_88px] ${backed ? "bg-accent/5" : ""}`;
  return (
    <li>
      {canPick ? (
        <button type="button" onClick={onPick} className={`${grid} cursor-pointer transition-colors duration-150 hover:bg-surface-2`} aria-label={`Back ${row.id}`}>
          {content}
        </button>
      ) : (
        <div className={grid}>{content}</div>
      )}
    </li>
  );
}

function PotCard({ epoch, now, decimals }: { epoch: Epoch; now: number; decimals: number }) {
  const stage = stageOf(epoch, now);
  const step = timelineStep(stage);
  const settled = epoch.settlementPot !== null && (stage === "allocating" || stage === "settled");
  const net = settled ? units(epoch.settlementPot!, decimals) : epoch.ledger ? units(epoch.ledger.activeNet, decimals) : null;
  const queued = epoch.ledger ? units(epoch.ledger.pendingGross, decimals) : null;
  const entries = epoch.nextNonce !== null ? Number(epoch.nextNonce) : (epoch.lots?.executed ?? null);

  return (
    <section className={`${panel} flex flex-col gap-4 p-4`}>
      <dl className="grid grid-cols-3 gap-2">
        <div>
          <dt className="text-[11px] text-muted">{settled ? "Settlement pot" : "Net stake pot"}</dt>
          <dd className="num text-sm font-semibold">{net === null ? "—" : formatAmount(net, 2)} <span className="text-xs font-normal text-muted">{COLLATERAL.symbol}</span></dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted">Queued, not executed</dt>
          <dd className="num text-sm">{queued === null ? "—" : formatAmount(queued, 2)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-muted">Entries</dt>
          <dd className="num text-sm">{entries ?? "—"}</dd>
        </div>
      </dl>
      {stage === "voided" ? (
        <p className="flex items-start gap-2 text-xs text-warn"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />No qualifying closing data within 24 hours of the close. Every entry is refundable in full.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {TIMELINE.map((label, index) => {
            const done = index < step;
            const current = index === step;
            return (
              <li key={label} className={`flex items-center gap-2 text-xs ${current ? "font-medium text-ink" : done ? "text-muted" : "text-muted/60"}`}>
                <span className={`grid size-4 shrink-0 place-items-center rounded-full border ${done ? "border-up bg-up/15 text-up" : current ? "border-accent text-accent" : "border-dashed border-line"}`}>
                  {done && <Check size={10} aria-hidden="true" />}
                  {current && <span className="size-1.5 rounded-full bg-accent" />}
                </span>
                {label}
                {current && label === "Closing reference" && <span className="num text-muted">· {utcTime(epoch.closesAt, true)} UTC</span>}
                {current && label === "Scoring" && epoch.lots && <span className="num text-muted">· {epoch.lots.scored} of {epoch.lots.executed}</span>}
                {current && label === "Allocating payouts" && epoch.lots && <span className="num text-muted">· {epoch.lots.allocated} of {epoch.lots.executed}</span>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function PayoutExplainer({ open: initial = false }: { open?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className={panel}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left text-sm font-semibold">
        How your payout works
        <ChevronDown size={16} aria-hidden="true" className={`text-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-4 py-4 text-xs text-muted">
          <p className="text-sm text-ink">Your backed asset&apos;s positive relative move is compared with all positive relative moves in your basket. Your score is weighted by your net stake. The shared pot is distributed according to those weights across all entries.</p>
          <pre className="num overflow-x-auto rounded-control bg-surface-2 p-3 text-[11px] leading-5 text-ink">{`Member move = closing reference / entry reference − 1
Score       = positive backed-asset move / sum of positive basket moves
Weight      = net stake × score
Payout      = available pot × entry weight / total entry weight`}</pre>
          <p>The score is zero when no basket member rose. Negative moves add nothing to the denominator. A score is not a win probability and not your share of the pot: other entries&apos; stakes, baskets, entry times and scores decide the money. Several entries can be paid.</p>
          <p>Example: two 100 {COLLATERAL.symbol} entries have net stakes of 99.98 each. Scores of 10% and 30% split the 199.96 pot 25% / 75%: payouts of 49.99 and 149.97. The first entry rose against $CRYPTO and still lost money.</p>
          <p>If every score is zero, every entry is refunded in full, held fee included. These formulas explain the rules; the protocol decides the actual scores, rounding and payouts.</p>
        </div>
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

  const header = (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-semibold">{review ? "Review entry" : "Create your entry"}</h2>
      {props.onClose && (
        <button type="button" onClick={props.onClose} aria-label="Close" className="grid size-8 cursor-pointer place-items-center rounded-pill text-muted hover:bg-surface-2 hover:text-ink">
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );

  if (!open) {
    return (
      <section className={`${panel} flex flex-col gap-3 p-4`}>
        {header}
        <p className="text-sm text-muted">{closedReason}</p>
      </section>
    );
  }

  if (review && intent && gross !== null && charge !== null && net !== null && backed) {
    return (
      <section className={`${panel} flex flex-col gap-4 p-4`}>
        {header}
        <div className="flex items-center gap-3 rounded-control bg-surface-2 p-3">
          <CoinIcon id={backed} size={32} />
          <span className="text-base font-semibold">{backed}</span>
          <span className="rounded-pill bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent-ink">Backed</span>
        </div>
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-muted">Basket</dt><dd className="num text-right">30 assets · 1 backed + 29 comparison</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">Gross stake</dt><dd className="num text-right">{show(gross)}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">Entry fee, held</dt><dd className="num text-right">{show(charge)}</dd></div>
          <div className="flex justify-between gap-4 font-medium"><dt>Net stake</dt><dd className="num text-right">{show(net)}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">Closes</dt><dd className="num text-right">{windowText(epoch).split(" · ")[0]} · {utcTime(epoch.closesAt)} UTC</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-muted">Time left</dt><dd className="num text-right">{countdown(epoch.closesAt - now)}</dd></div>
        </dl>
        <ul className="flex flex-col gap-1.5 rounded-control border border-line p-3 text-xs text-muted">
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
            className="h-11 rounded-pill bg-accent text-sm font-medium text-accent-ink"
          />
          <button type="button" onClick={() => setReview(false)} className={quiet}><ArrowLeft size={14} aria-hidden="true" /> Edit</button>
        </div>
      </section>
    );
  }

  return (
    <section className={`${panel} flex flex-col gap-4 p-4`}>
      {header}

      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted">Backed asset</span>
        <div className="flex items-center gap-3 rounded-control border border-line bg-bg p-3">
          {backed ? <CoinIcon id={backed} size={32} /> : <span className="grid size-8 place-items-center rounded-full border border-dashed border-line text-muted"><Plus size={14} aria-hidden="true" /></span>}
          <span className="flex flex-col">
            <span className="text-base font-semibold">{backed ?? "Choose an asset"}</span>
            {backed && <span className="w-fit rounded-pill bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent-ink">Backed</span>}
          </span>
          <select aria-label="Backed asset" value={backed ?? ""} onChange={(event) => props.onBacked(event.target.value)} className="ml-auto h-9 cursor-pointer rounded-control border border-line bg-surface px-2 text-xs">
            <option value="" disabled>Choose</option>
            {coins.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>
        <span className="text-[11px] text-muted">Or pick one from the list.</span>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">Basket</span>
          <span className="num text-xs">{coins.length} / {BASKET_SIZE}</span>
        </div>
        <div className="rounded-control border border-line p-3 text-xs">
          <p className="text-ink">{exact ? "30 assets · 1 backed + 29 comparison" : "Asset list not available"}</p>
          {exact && <p className="mt-1 text-muted">All 30 eligible assets are included this Epoch. The basket is a comparison set, not tokens bought for you.</p>}
          {exact && (
            <button type="button" onClick={() => setShowBasket(!showBasket)} className="mt-2 cursor-pointer text-accent underline-offset-4 hover:underline">{showBasket ? "Hide basket" : "View basket"}</button>
          )}
          {showBasket && (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {coins.map((id) => (
                <li key={id} className={`num rounded-pill border px-2 py-0.5 ${id === backed ? "border-accent text-accent" : "border-line text-muted"}`}>{id}</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs text-muted">
          <label htmlFor="epoch-stake">Stake</label>
          {owner && <span className="num">Wallet {wallet === null ? "…" : formatAmount(wallet, 2)} {COLLATERAL.symbol}</span>}
        </div>
        <div className="relative">
          <input id="epoch-stake" inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} className={`${field} pr-16`} />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">{COLLATERAL.symbol}</span>
        </div>
        <dl className="flex flex-col gap-1.5 text-xs">
          <div className="flex justify-between"><dt className="text-muted">Entry fee ({fee.bps / 100}%, held until settlement)</dt><dd className="num">{show(charge)}</dd></div>
          <div className="flex justify-between font-medium"><dt>Net stake</dt><dd className="num">{show(net)}</dd></div>
        </dl>
      </div>

      <div className="flex flex-col gap-2">
        <button type="button" disabled={problem !== null} onClick={() => setReview(true)} className={`${primary} ${problem === null ? "cursor-pointer hover:opacity-90" : "cursor-not-allowed opacity-50"}`}>
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

function EntryCard({ lot, epoch, decimals, onSent }: { lot: EpochLot; epoch: Epoch | null; decimals: number; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const view = lotView(lot, epoch);
  const gross = units(lot.grossStake, decimals);
  const net = units(lot.grossStake, decimals) - units(lot.fee, decimals);
  const score = scoreOf(lot);
  const claimable = lot.claimable === null ? null : units(lot.claimable, decimals);
  const owed = claimable !== null && claimable > 0 && lot.state !== "withdrawn";
  const result = claimable !== null && lot.state !== "withdrawn" ? claimable - gross : null;
  const tag = view.group === "withdrawable" ? "border-accent text-accent" : view.group === "pending" ? "border-warn text-warn" : view.group === "active" ? "border-up text-up" : "border-line text-muted";

  return (
    <li className="flex flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-center gap-2">
          <CoinIcon id={lot.backedAsset} size={28} />
          <span className="text-sm font-semibold">{lot.backedAsset}</span>
          <span className="rounded-pill bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent-ink">Backed</span>
        </span>
        <span className={`rounded-pill border px-2 py-0.5 text-[11px] ${tag}`}>{view.label}</span>
        <span className="num ml-auto text-xs text-muted">Entry #{lot.nonce}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <div><dt className="text-muted">Gross / net stake</dt><dd className="num">{formatAmount(gross, 2)} / {formatAmount(net, 2)} {COLLATERAL.symbol}</dd></div>
        <div>
          <dt className="text-muted">Performance basis</dt>
          <dd className="num">{lot.execution ? `Since your execution · ${utcTime(lot.execution.timestamp, true)} UTC` : `Awaiting execution · entered ${utcTime(lot.admittedAt, true)} UTC`}</dd>
        </div>
        <div><dt className="text-muted">Score</dt><dd className="num">{score === null ? "Not scored yet" : `${formatAmount(score * 100, 2)}%`}</dd></div>
        <div>
          <dt className="text-muted">{view.refund ? "Refund" : "Payout"}</dt>
          <dd className="num">
            {claimable === null ? "Not settled" : `${formatAmount(claimable, 4)} ${COLLATERAL.symbol}`}
            {result !== null && !view.refund && <span className={`ml-1 ${tone(result)}`}>({result >= 0 ? "+" : "−"}{formatAmount(Math.abs(result), 4)})</span>}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setOpen(!open)} className="cursor-pointer text-xs text-accent underline-offset-4 hover:underline">{open ? "Hide basket" : "View basket"}</button>
        {owed && epoch && (
          <span className="ml-auto w-full sm:w-56">
            <SendButton
              intent={{ operation: "epoch-withdraw", opensAt: epoch.opensAt, nonce: lot.nonce }}
              label={`${view.refund ? "Withdraw refund" : "Withdraw payout"} · ${formatAmount(claimable ?? 0, 4)}`}
              connectLabel="Connect wallet"
              onDone={onSent}
              className="h-10 w-full rounded-pill bg-accent text-xs font-medium text-accent-ink"
            />
          </span>
        )}
      </div>
      {open && (
        <ul className="flex flex-wrap gap-1.5 text-[11px]">
          {lot.basket.map((id) => (
            <li key={id} className={`num rounded-pill border px-2 py-0.5 ${id === lot.backedAsset ? "border-accent text-accent" : "border-line text-muted"}`}>{id}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function MyEntries({ epochs, lots, decimals, onSent }: { epochs: Epoch[]; lots: EpochLot[]; decimals: number; onSent: () => void }) {
  const { owner } = useAccount();
  const [filter, setFilter] = useState<LotGroup | "all">("all");
  const byOpen = new Map(epochs.map((epoch) => [epoch.opensAt, epoch]));
  const views = lots.map((lot) => ({ lot, epoch: byOpen.get(lot.epochOpensAt) ?? null })).map((item) => ({ ...item, view: lotView(item.lot, item.epoch) }));
  const counts = Object.fromEntries(GROUPS.map((group) => [group.id, views.filter((item) => item.view.group === group.id).length])) as Record<LotGroup, number>;
  const shown = views.filter((item) => filter === "all" || item.view.group === filter);
  const grouped = [...new Set(shown.map((item) => item.lot.epochOpensAt))].sort((a, b) => b - a);
  const tab = (on: boolean) => `num h-8 cursor-pointer rounded-pill px-3 text-xs transition-colors duration-150 ${on ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">My entries</h2>
        <div role="tablist" aria-label="Filter entries" className="flex flex-wrap gap-1">
          <button type="button" role="tab" aria-selected={filter === "all"} onClick={() => setFilter("all")} className={tab(filter === "all")}>All {lots.length}</button>
          {GROUPS.map((group) => (
            <button key={group.id} type="button" role="tab" aria-selected={filter === group.id} onClick={() => setFilter(group.id)} className={tab(filter === group.id)}>{group.label} {counts[group.id]}</button>
          ))}
        </div>
      </div>
      {!owner ? (
        <p className={`${panel} p-6 text-sm text-muted`}>Connect a wallet to see your entries.</p>
      ) : shown.length === 0 ? (
        <p className={`${panel} p-6 text-sm text-muted`}>{lots.length === 0 ? "No entries yet. Create one while an Epoch is open." : "No entries in this group."}</p>
      ) : (
        grouped.map((opensAt) => {
          const epoch = byOpen.get(opensAt) ?? null;
          return (
            <div key={opensAt} className={panel}>
              <div className="num border-b border-line px-4 py-2.5 text-xs text-muted">{epoch ? windowText(epoch) : `Epoch ${utcTime(opensAt)} UTC`}</div>
              <ul className="divide-y divide-line">
                {shown.filter((item) => item.lot.epochOpensAt === opensAt).map((item) => (
                  <EntryCard key={item.lot.address} lot={item.lot} epoch={item.epoch} decimals={decimals} onSent={onSent} />
                ))}
              </ul>
            </div>
          );
        })
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

  if (!epoch) {
    return (
      <div className="flex flex-col gap-4">
        <ModeSwitch />
        <h1 className="font-display text-title font-semibold tracking-tight">Epoch</h1>
        <p className={`${panel} p-6 text-sm text-muted`}>No Epochs are scheduled yet.</p>
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

  return (
    <div className={`flex flex-col gap-6 ${open ? "pb-24 lg:pb-0" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ModeSwitch />
        <span className="rounded-pill border border-line px-2.5 py-1 text-[11px] uppercase tracking-wider text-muted">Devnet</span>
      </div>
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-title font-semibold tracking-tight">Epoch</h1>
        <p className="max-w-2xl text-sm text-muted">Four-hour performance predictions. Back one asset within a basket of 30. Your entry starts from its execution reference and settles at the fixed Epoch close.</p>
      </div>

      <ClockStrip epochs={epochs} epoch={epoch} now={now} onSelect={(address) => setSelected(address)} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Comparison epoch={epoch} coins={coins} now={now} backed={backed} canPick={open} onPick={(id) => setBacked(id)} />
          <PayoutExplainer />
        </div>
        <div className="flex flex-col gap-6 lg:sticky lg:top-6 lg:self-start">
          <div className="hidden lg:block">
            <EntryPanel {...entryProps} />
          </div>
          <PotCard epoch={epoch} now={now} decimals={decimals} />
        </div>
      </div>

      <MyEntries epochs={epochs} lots={lots} decimals={decimals} onSent={() => void loadLots()} />

      {open && !sheet && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 p-3 backdrop-blur lg:hidden">
          <button type="button" onClick={() => setSheet(true)} className={`${primary} cursor-pointer`}>
            <Plus size={16} aria-hidden="true" /> New entry{backed ? ` · ${backed}` : ""}
          </button>
        </div>
      )}
      {sheet && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-bg p-4 lg:hidden">
          <EntryPanel {...entryProps} onClose={() => setSheet(false)} />
          <div className="mt-4">
            <PayoutExplainer />
          </div>
        </div>
      )}
    </div>
  );
}
