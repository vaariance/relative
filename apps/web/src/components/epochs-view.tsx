"use client";

import type { Epoch, EpochLot, EpochOverview, PreviewHistory } from "@eox/app-api";
import { CircleHelp, Layers, Search, Timer, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { walletEpochLots } from "@/app/actions";
import { parseScaled } from "@/lib/amounts";
import { COLLATERAL } from "@/lib/config";
import { type BoardRow, type Stage, STAGE_LABEL, countdown, feeOf, lotStatus, scoreOf, shareBoard, stageOf, units, windowText } from "@/lib/epoch";
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
const panel = "rounded-card border border-line bg-surface shadow-card";
const field = "num h-11 w-full rounded-control border border-line bg-bg px-3 text-sm text-ink placeholder:text-muted";

function useNow(start: number): number {
  const [now, setNow] = useState(start);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function potOf(epoch: Epoch, decimals: number): number | null {
  if (epoch.settlementPot !== null) return units(epoch.settlementPot, decimals);
  if (!epoch.ledger) return null;
  return units(epoch.ledger.activeNet, decimals) + units(epoch.ledger.pendingGross, decimals);
}

function entriesOf(epoch: Epoch): number {
  if (epoch.nextNonce !== null) return Number(epoch.nextNonce);
  return epoch.lots?.executed ?? 0;
}

function coinsOf(epoch: Epoch, roster: readonly string[]): string[] {
  if (epoch.universe.length > 0) return epoch.universe.map((member) => member.assetId);
  if (epoch.closingReferences.length > 0) return epoch.closingReferences.map((item) => item.assetId);
  return [...roster];
}

function pickDefault(epochs: readonly Epoch[], now: number): string | null {
  const live = epochs.find((epoch) => stageOf(epoch, now) === "live");
  const next = epochs.find((epoch) => stageOf(epoch, now) === "upcoming");
  const last = [...epochs].reverse().find((epoch) => stageOf(epoch, now) !== "upcoming");
  return (live ?? next ?? last ?? epochs[0])?.address ?? null;
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

function useBoard(epoch: Epoch | null, coins: string[], now: number): { rows: BoardRow[]; final: boolean; ready: boolean } {
  const { estimate } = useLive();
  const opening = useOpeningReferences(epoch, now);
  const closing = useMemo(() => {
    if (!epoch || epoch.closingReferences.length === 0) return null;
    return Object.fromEntries(epoch.closingReferences.map((item) => [item.assetId, (Number(BigInt(item.reference)) / 10 ** REFERENCE_DIGITS) * PREVIEW_BASE]));
  }, [epoch]);
  const stage = epoch ? stageOf(epoch, now) : "upcoming";
  const end = closing ?? (stage === "live" ? (estimate?.references ?? null) : null);
  return { rows: shareBoard(coins, opening, end), final: closing !== null, ready: opening !== null && end !== null };
}

function StageDot({ stage }: { stage: Stage }) {
  if (stage === "live") return <span className="size-2 shrink-0 animate-pulse rounded-full bg-down" />;
  if (stage === "upcoming") return <span className="size-2 shrink-0 rounded-full bg-accent" />;
  return <span className="size-2 shrink-0 rounded-full bg-line" />;
}

function RoundList({ epochs, now, selected, onSelect }: { epochs: Epoch[]; now: number; selected: string | null; onSelect: (address: string) => void }) {
  const ordered = [...epochs].sort((a, b) => {
    const rank = (epoch: Epoch) => ({ live: 0, upcoming: 1, closing: 2, settled: 3, voided: 4 })[stageOf(epoch, now)];
    return rank(a) - rank(b) || b.opensAt - a.opensAt;
  });
  return (
    <nav aria-label="Rounds" className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] xl:flex-col xl:gap-1 xl:overflow-visible xl:pb-0">
      <h2 className="hidden px-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-muted xl:block">Rounds</h2>
      {ordered.map((epoch) => {
        const stage = stageOf(epoch, now);
        const on = epoch.address === selected;
        const time = new Date(epoch.opensAt * 1000).toUTCString().slice(17, 22);
        const day = new Date(epoch.opensAt * 1000).toUTCString().slice(5, 11);
        return (
          <button
            key={epoch.address}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(epoch.address)}
            className={`flex shrink-0 cursor-pointer items-center gap-3 rounded-control px-3 py-2.5 text-left transition-colors duration-150 xl:w-full ${on ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface hover:text-ink"} border xl:border-0 ${on ? "border-line" : "border-transparent"}`}
          >
            <StageDot stage={stage} />
            <span className="flex flex-col">
              <span className="text-sm font-medium">{STAGE_LABEL[stage]}</span>
              <span className="num text-[11px] text-muted">{day} · {time} UTC</span>
            </span>
            <span className="num ml-auto pl-3 text-xs text-muted">{entriesOf(epoch)}</span>
          </button>
        );
      })}
    </nav>
  );
}

function RoundHeader({ epoch, now, decimals, onHelp }: { epoch: Epoch; now: number; decimals: number; onHelp: () => void }) {
  const stage = stageOf(epoch, now);
  const pot = potOf(epoch, decimals);
  const timer = stage === "live" ? `Closes in ${countdown(epoch.closesAt - now)}` : stage === "upcoming" ? `Opens in ${countdown(epoch.opensAt - now)}` : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-title font-semibold tracking-tight">Epochs {stage === "live" ? "Live" : ""}</h1>
        <button type="button" onClick={onHelp} className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-pill text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink" aria-label="How it works">
          <CircleHelp size={18} aria-hidden="true" />
        </button>
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <StageDot stage={stage} />
        <span className={stage === "live" ? "font-medium text-down" : "font-medium text-ink"}>{STAGE_LABEL[stage]}</span>
        <span>·</span>
        <span className="num">{windowText(epoch)}</span>
        {timer && (
          <>
            <span>·</span>
            <span className="num flex items-center gap-1 text-ink"><Timer size={14} aria-hidden="true" />{timer}</span>
          </>
        )}
        <span>·</span>
        <span className="num">{pot === null ? "—" : formatAmount(pot)} {COLLATERAL.symbol} pot</span>
        <span>·</span>
        <span className="num">{entriesOf(epoch)} entries</span>
      </p>
    </div>
  );
}

function CoinRow({ row, rank, live, picked, onPick }: { row: BoardRow; rank: number; live: boolean; picked: boolean; onPick: () => void }) {
  const tone = row.change === null ? "text-muted" : row.change > 0 ? "text-up" : row.change < 0 ? "text-down" : "text-muted";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_110px_150px_140px]">
      <span className="flex min-w-0 items-center gap-3">
        <span className="num w-5 shrink-0 text-right text-xs text-muted">{rank}</span>
        <CoinIcon id={row.id} size={28} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{row.id}</span>
          <span className={`num text-xs sm:hidden ${tone}`}>{row.change === null ? "—" : `${row.change > 0 ? "+" : ""}${formatAmount(row.change * 100, 2)}%`} · {formatAmount(row.share * 100, 1)}% share</span>
        </span>
      </span>
      <span className={`num hidden text-right text-sm sm:block ${tone}`}>{row.change === null ? "—" : `${row.change > 0 ? "+" : ""}${formatAmount(row.change * 100, 2)}%`}</span>
      <span className="hidden items-center justify-end gap-2 sm:flex">
        <span className="h-1.5 w-16 overflow-hidden rounded-pill bg-surface-2">
          <span className="block h-full rounded-pill bg-accent" style={{ width: `${Math.round(row.share * 100)}%` }} />
        </span>
        <span className="num w-12 text-right text-sm">{formatAmount(row.share * 100, 1)}%</span>
      </span>
      <button
        type="button"
        disabled={!live}
        onClick={onPick}
        aria-pressed={picked}
        className={`num flex h-10 w-[120px] items-center justify-between rounded-control border px-3 text-sm font-medium transition-colors duration-150 sm:w-full ${
          picked ? "border-accent bg-accent text-accent-ink" : "border-line bg-surface-2 text-ink"
        } ${live ? "cursor-pointer hover:border-accent" : "cursor-not-allowed opacity-50"}`}
      >
        <span>{row.id}</span>
        <span className={picked ? "" : "text-muted"}>{formatAmount(row.share * 100, 1)}%</span>
      </button>
    </div>
  );
}

function CoinSection({ title, rows, offset, live, picked, onPick }: { title: string; rows: BoardRow[]; offset: number; live: boolean; picked: string | null; onPick: (id: string) => void }) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <div className="hidden grid-cols-[minmax(0,1fr)_110px_150px_140px] items-end gap-3 px-4 sm:grid">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-right text-[11px] font-medium uppercase tracking-wider text-muted">vs $CRYPTO</span>
        <span className="text-right text-[11px] font-medium uppercase tracking-wider text-muted">Share of gains</span>
        <span className="text-center text-[11px] font-medium uppercase tracking-wider text-muted">Back</span>
      </div>
      <h2 className="px-1 text-base font-semibold sm:hidden">{title}</h2>
      <div className={`${panel} divide-y divide-line`}>
        {rows.map((row, index) => (
          <CoinRow key={row.id} row={row} rank={offset + index + 1} live={live} picked={picked === row.id} onPick={() => onPick(row.id)} />
        ))}
      </div>
    </section>
  );
}

function Slip(props: { epoch: Epoch; coins: string[]; live: boolean; decimals: number; fee: { bps: number; cap: string }; picked: string | null; share: number | null; onClear: () => void; onSent: () => void }) {
  const { epoch, coins, live, decimals, fee, picked, share } = props;
  const [amount, setAmount] = useState("");
  const gross = amount.trim() === "" ? null : parseScaled(amount, decimals);
  const charge = gross !== null && gross > 0n ? feeOf(gross, fee.bps, BigInt(fee.cap)) : null;
  const problem = amount.trim() === "" ? "" : gross === null || gross <= 0n ? "Enter an amount above zero." : coins.length !== 30 ? "This round's coin list cannot be entered from here." : null;
  const intent: Intent | null = live && picked !== null && problem === null && gross !== null ? { operation: "epoch-entry", opensAt: epoch.opensAt, grossStake: gross.toString(), basket: coins, backedAsset: picked } : null;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-5 pt-5">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Layers size={16} aria-hidden="true" className="text-accent" /> Entry
        </span>
        <span className="text-sm text-muted">{picked ? "1 pick" : "Pick 1 coin"}</span>
      </div>
      {picked === null ? (
        <div className="flex flex-col items-center gap-3 px-5 py-14 text-center text-muted">
          <Layers size={40} aria-hidden="true" className="opacity-30" />
          <span className="text-sm">{live ? "No coin picked yet" : "Entries open when a round is live"}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-3 rounded-control bg-surface-2 p-3">
            <CoinIcon id={picked} size={32} />
            <span className="flex flex-col">
              <span className="text-sm font-medium">{picked}</span>
              <span className="num text-xs text-muted">{share === null ? "Beats $CRYPTO the most" : `Scores ${formatAmount(share * 100, 1)}% if it ended now`}</span>
            </span>
            <button type="button" onClick={props.onClear} aria-label="Remove pick" className="ml-auto grid size-8 cursor-pointer place-items-center rounded-pill text-muted hover:bg-surface hover:text-ink">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="relative">
            <input aria-label="Stake" inputMode="decimal" placeholder="Stake" value={amount} onChange={(event) => setAmount(event.target.value)} className={`${field} pr-16`} />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">{COLLATERAL.symbol}</span>
          </div>
          <dl className="flex flex-col gap-1.5 text-xs">
            <div className="flex justify-between">
              <dt className="text-muted">Fee (0.02%)</dt>
              <dd className="num">{charge === null ? "—" : `${formatAmount(Number(charge) / 10 ** decimals, 4)} ${COLLATERAL.symbol}`}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Into the pot</dt>
              <dd className="num">{charge === null || gross === null ? "—" : `${formatAmount(Number(gross - charge) / 10 ** decimals, 4)} ${COLLATERAL.symbol}`}</dd>
            </div>
          </dl>
          <SendButton
            intent={intent}
            label={!live ? "Round not live" : amount.trim() === "" ? "Enter a stake" : `Back ${picked}`}
            connectLabel="Connect wallet to enter"
            problem={live ? problem : "This round is not taking entries."}
            describe={gross !== null ? `You staked ${amount} ${COLLATERAL.symbol} on ${picked} for this round.` : undefined}
            onDone={() => {
              setAmount("");
              props.onSent();
            }}
            className="h-11 rounded-pill bg-accent text-sm font-medium text-accent-ink"
          />
        </div>
      )}
    </div>
  );
}

function YourEntries({ epochs, lots, decimals, onSent }: { epochs: Epoch[]; lots: EpochLot[]; decimals: number; onSent: () => void }) {
  const { owner } = useAccount();
  const byOpen = new Map(epochs.map((epoch) => [epoch.opensAt, epoch]));
  const sorted = [...lots].sort((a, b) => b.epochOpensAt - a.epochOpensAt || Number(b.nonce) - Number(a.nonce));
  return (
    <div className="flex flex-col gap-3 border-t border-line p-5">
      <span className="text-sm font-semibold">Your entries</span>
      {!owner ? (
        <span className="text-xs text-muted">Connect a wallet to see your entries.</span>
      ) : sorted.length === 0 ? (
        <span className="text-xs text-muted">None yet.</span>
      ) : (
        <ul className="flex flex-col gap-3">
          {sorted.map((lot) => {
            const epoch = byOpen.get(lot.epochOpensAt) ?? null;
            const score = scoreOf(lot);
            const claimable = lot.claimable === null ? null : units(lot.claimable, decimals);
            const withdrawable = lot.state !== "withdrawn" && lot.claimable !== null && BigInt(lot.claimable) > 0n;
            return (
              <li key={lot.address} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <CoinIcon id={lot.backedAsset} size={22} />
                  <span className="text-sm font-medium">{lot.backedAsset}</span>
                  <span className="num text-xs text-muted">{formatAmount(units(lot.grossStake, decimals))} {COLLATERAL.symbol}</span>
                  <span className="ml-auto text-xs text-muted">{lotStatus(lot, epoch)}</span>
                </div>
                <div className="num flex justify-between text-[11px] text-muted">
                  <span>{epoch ? windowText(epoch) : ""}</span>
                  <span>{score === null ? "" : `Score ${formatAmount(score * 100, 1)}%`}</span>
                </div>
                {withdrawable && epoch && (
                  <SendButton
                    intent={{ operation: "epoch-withdraw", opensAt: epoch.opensAt, nonce: lot.nonce }}
                    label={`Collect ${formatAmount(claimable ?? 0, 4)} ${COLLATERAL.symbol}`}
                    connectLabel="Connect"
                    onDone={onSent}
                    className="h-9 rounded-pill bg-accent text-xs font-medium text-accent-ink"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function HowItWorks({ onClose }: { onClose: () => void }) {
  const steps = [
    ["Pick and stake", `While a round is live, back one coin with ${COLLATERAL.symbol}. A 0.02% fee is taken.`],
    ["Wait for the close", "Your entry starts from the next price. The round closes after four hours."],
    ["Share the pot", "Coins that rose against $CRYPTO split the pot by their share of the gains, weighted by stake. If none rose, everyone is refunded."],
  ];
  return (
    <div className={`${panel} relative grid gap-4 p-4 pr-10 sm:grid-cols-3`}>
      <button type="button" onClick={onClose} aria-label="Close" className="absolute right-2 top-2 grid size-8 cursor-pointer place-items-center rounded-pill text-muted hover:bg-surface-2 hover:text-ink">
        <X size={14} aria-hidden="true" />
      </button>
      {steps.map(([title, text], index) => (
        <div key={title}>
          <h3 className="text-sm font-medium"><span className="text-accent">{index + 1}.</span> {title}</h3>
          <p className="mt-1 text-xs text-muted">{text}</p>
        </div>
      ))}
    </div>
  );
}

export function EpochsView({ overview, roster, serverNow }: { overview: EpochOverview; roster: string[]; serverNow: number }) {
  const now = useNow(serverNow);
  const { owner, market } = useAccount();
  const decimals = market.decimals || 6;
  const epochs = useMemo(() => [...overview.epochs].sort((a, b) => a.opensAt - b.opensAt), [overview.epochs]);
  const [selected, setSelected] = useState<string | null>(() => pickDefault(epochs, serverNow));
  const [picked, setPicked] = useState<string | null>(null);
  const [lots, setLots] = useState<EpochLot[]>([]);
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState("");
  const epoch = epochs.find((item) => item.address === selected) ?? epochs[0] ?? null;
  const coins = epoch ? coinsOf(epoch, roster) : [];
  const board = useBoard(epoch, coins, now);
  const stage: Stage = epoch ? stageOf(epoch, now) : "upcoming";
  const live = stage === "live" && Boolean(epoch?.entriesOpen);

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
        <h1 className="font-display text-title font-semibold tracking-tight">Epochs</h1>
        <section className={`${panel} p-6 text-sm text-muted`}>No rounds are scheduled yet. Check back soon.</section>
      </div>
    );
  }

  const rows = board.ready ? board.rows : coins.map((id) => ({ id, change: null, share: 0 }));
  const shown = rows.filter((row) => row.id.toLowerCase().includes(query.trim().toLowerCase()));
  const ahead = board.ready ? shown.filter((row) => (row.change ?? 0) > 0) : [];
  const behind = board.ready ? shown.filter((row) => (row.change ?? 0) <= 0) : shown;
  const share = picked ? (board.rows.find((row) => row.id === picked)?.share ?? null) : null;
  const choose = (id: string) => setPicked(picked === id ? null : id);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[200px_minmax(0,1fr)_320px]">
      <aside className="min-w-0 xl:sticky xl:top-6 xl:self-start">
        <RoundList epochs={epochs} now={now} selected={epoch.address} onSelect={(address) => {
          setSelected(address);
          setPicked(null);
        }} />
      </aside>

      <div className="flex min-w-0 flex-col gap-6">
        <RoundHeader epoch={epoch} now={now} decimals={decimals} onHelp={() => setHelp(!help)} />
        {help && <HowItWorks onClose={() => setHelp(false)} />}

        <label className="relative">
          <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search coins" aria-label="Search coins" className={`${field} pl-9`} />
        </label>

        {stage === "upcoming" && <p className="text-sm text-muted">This round opens in {countdown(epoch.opensAt - now)}. Moves and shares fill in once it starts.</p>}
        {stage === "closing" && !board.final && <p className="text-sm text-muted">This round has ended. Final shares appear once its closing prices are recorded.</p>}

        <CoinSection title={board.final ? "Finished ahead of $CRYPTO" : "Ahead of $CRYPTO"} rows={ahead} offset={0} live={live} picked={picked} onPick={choose} />
        <CoinSection title={board.ready ? (board.final ? "Finished behind $CRYPTO" : "Behind $CRYPTO") : "Coins"} rows={behind} offset={ahead.length} live={live} picked={picked} onPick={choose} />
        {shown.length === 0 && <p className="text-sm text-muted">No coin matches “{query}”.</p>}
      </div>

      <aside className={`${panel} hidden self-start xl:sticky xl:top-6 xl:block`}>
        <Slip epoch={epoch} coins={coins} live={live} decimals={decimals} fee={overview.configuration.entryFee} picked={picked} share={share} onClear={() => setPicked(null)} onSent={() => {
          setPicked(null);
          void loadLots();
        }} />
        <YourEntries epochs={epochs} lots={lots} decimals={decimals} onSent={() => void loadLots()} />
      </aside>

      <div className="xl:hidden">
        <div className={panel}>
          <YourEntries epochs={epochs} lots={lots} decimals={decimals} onSent={() => void loadLots()} />
        </div>
      </div>

      {picked && (
        <div className="fixed inset-x-0 bottom-0 z-40 max-h-[80vh] overflow-y-auto rounded-t-card border-t border-line bg-surface shadow-card xl:hidden">
          <Slip epoch={epoch} coins={coins} live={live} decimals={decimals} fee={overview.configuration.entryFee} picked={picked} share={share} onClear={() => setPicked(null)} onSent={() => {
            setPicked(null);
            void loadLots();
          }} />
        </div>
      )}
    </div>
  );
}
