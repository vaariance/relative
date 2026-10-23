"use client";

import type { Epoch, EpochLot, EpochOverview, PreviewHistory } from "@eox/app-api";
import { ArrowLeft, ChevronLeft, ChevronRight, CircleHelp, Trophy, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const LEADERS = 10;
const field = "num h-11 w-full rounded-control border border-line bg-bg px-3 text-sm text-ink placeholder:text-muted";
const primary = "flex h-11 w-full items-center justify-center gap-2 rounded-pill bg-accent text-sm font-medium text-accent-ink";

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

function Ring({ progress, children }: { progress: number; children: ReactNode }) {
  const radius = 54;
  const length = 2 * Math.PI * radius;
  const done = Math.min(1, Math.max(0, progress));
  return (
    <div className="relative grid size-32 place-items-center">
      <svg viewBox="0 0 120 120" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="currentColor" strokeWidth="6" className="text-surface-2" />
        <circle cx="60" cy="60" r={radius} fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeDasharray={length} strokeDashoffset={length * done} className="text-accent transition-[stroke-dashoffset] duration-1000 ease-linear" />
      </svg>
      <div className="relative text-center">{children}</div>
    </div>
  );
}

const PILL: Record<Stage, string> = {
  live: "bg-accent text-accent-ink",
  upcoming: "bg-surface-2 text-ink",
  closing: "bg-surface-2 text-muted",
  settled: "bg-surface-2 text-muted",
  voided: "bg-surface-2 text-muted",
};

function EntryForm({ epoch, coins, decimals, fee, picked, onPick, onBack, onSent }: { epoch: Epoch; coins: string[]; decimals: number; fee: { bps: number; cap: string }; picked: string | null; onPick: (id: string) => void; onBack: () => void; onSent: () => void }) {
  const [amount, setAmount] = useState("");
  const gross = amount.trim() === "" ? null : parseScaled(amount, decimals);
  const charge = gross !== null && gross > 0n ? feeOf(gross, fee.bps, BigInt(fee.cap)) : null;
  const problem = amount.trim() === "" ? "" : gross === null || gross <= 0n ? "Enter an amount above zero." : picked === null ? "Pick a coin first." : coins.length !== 30 ? "This round's coin list cannot be entered from here." : null;
  const intent: Intent | null = problem === null && gross !== null && picked !== null ? { operation: "epoch-entry", opensAt: epoch.opensAt, grossStake: gross.toString(), basket: coins, backedAsset: picked } : null;

  return (
    <div className="flex flex-1 flex-col gap-3">
      <button type="button" onClick={onBack} className="flex w-fit cursor-pointer items-center gap-1 text-xs text-muted transition-colors duration-150 hover:text-ink">
        <ArrowLeft size={14} aria-hidden="true" /> Back
      </button>
      <div>
        <label htmlFor="epoch-coin" className="mb-1 block text-xs text-muted">Your coin</label>
        <div className="relative">
          {picked && (
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2">
              <CoinIcon id={picked} size={20} />
            </span>
          )}
          <select id="epoch-coin" value={picked ?? ""} onChange={(event) => onPick(event.target.value)} className={`${field} cursor-pointer ${picked ? "pl-10" : ""}`}>
            <option value="" disabled>Pick a coin</option>
            {coins.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="epoch-stake" className="mb-1 block text-xs text-muted">Stake</label>
        <div className="relative">
          <input id="epoch-stake" inputMode="decimal" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} className={`${field} pr-16`} />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">{COLLATERAL.symbol}</span>
        </div>
      </div>
      <p className="num text-xs text-muted">
        {charge === null || gross === null ? "A 0.02% fee is taken from the stake." : `${formatAmount(Number(gross - charge) / 10 ** decimals, 4)} ${COLLATERAL.symbol} goes into the pot after a ${formatAmount(Number(charge) / 10 ** decimals, 4)} fee.`}
      </p>
      <div className="mt-auto flex flex-col gap-1">
        <SendButton
          intent={intent}
          label={amount.trim() === "" ? "Enter a stake" : picked ? `Back ${picked}` : "Pick a coin"}
          connectLabel="Connect wallet to enter"
          problem={problem}
          describe={picked && gross !== null ? `You staked ${amount} ${COLLATERAL.symbol} on ${picked} for this round.` : undefined}
          onDone={() => {
            setAmount("");
            onSent();
          }}
          className="h-11 rounded-pill bg-accent text-sm font-medium text-accent-ink"
        />
      </div>
    </div>
  );
}

interface RoundCardProps {
  epoch: Epoch;
  coins: string[];
  now: number;
  decimals: number;
  fee: { bps: number; cap: string };
  selected: boolean;
  entering: boolean;
  picked: string | null;
  claimable: number;
  winner: BoardRow | null;
  onSelect: () => void;
  onEnter: (entering: boolean) => void;
  onPick: (id: string) => void;
  onSent: () => void;
}

function RoundCard(props: RoundCardProps) {
  const { epoch, now, decimals, selected, entering, claimable, winner } = props;
  const stage = stageOf(epoch, now);
  const live = stage === "live";
  const pot = potOf(epoch, decimals);
  const entries = entriesOf(epoch);
  const open = live && epoch.entriesOpen;

  return (
    <article
      onClick={entering ? undefined : props.onSelect}
      data-selected={selected}
      className={`flex min-h-[340px] w-[280px] shrink-0 snap-center flex-col gap-4 rounded-card border bg-surface p-5 shadow-card transition-[opacity,border-color] duration-150 sm:w-[300px] ${entering ? "" : "cursor-pointer"} ${
        live ? "border-accent shadow-[0_12px_40px_-16px_var(--color-accent)]" : selected ? "border-muted" : "border-line opacity-75 hover:opacity-100"
      }`}
    >
      <header className="flex flex-col items-start gap-2">
        <span className={`flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-medium ${PILL[stage]}`}>
          {live && <span className="size-1.5 animate-pulse rounded-full bg-accent-ink" />}
          {STAGE_LABEL[stage]}
        </span>
        <span className="num text-xs text-muted">{windowText(epoch)}</span>
      </header>

      {entering && open ? (
        <EntryForm
          epoch={epoch}
          coins={props.coins}
          decimals={decimals}
          fee={props.fee}
          picked={props.picked}
          onPick={props.onPick}
          onBack={() => props.onEnter(false)}
          onSent={() => {
            props.onEnter(false);
            props.onSent();
          }}
        />
      ) : (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            {live ? (
              <Ring progress={(now - epoch.opensAt) / (epoch.closesAt - epoch.opensAt)}>
                <span className="block text-[11px] text-muted">Closes in</span>
                <span className="num block text-lg font-semibold">{countdown(epoch.closesAt - now)}</span>
              </Ring>
            ) : stage === "upcoming" ? (
              <div>
                <span className="block text-xs text-muted">Opens in</span>
                <span className="num block text-3xl font-semibold">{countdown(epoch.opensAt - now)}</span>
              </div>
            ) : winner && winner.share > 0 ? (
              <div className="flex flex-col items-center gap-2">
                <Trophy size={18} aria-hidden="true" className="text-accent" />
                <CoinIcon id={winner.id} size={44} />
                <span className="text-sm font-medium">{winner.id} led the round</span>
                <span className="num text-xs text-up">{winner.change === null ? "" : `+${formatAmount(winner.change * 100, 2)}% vs $CRYPTO`}</span>
              </div>
            ) : (
              <span className="text-sm text-muted">{stage === "voided" ? "Cancelled. Stakes refunded." : stage === "closing" ? "Round over. Results coming." : "Round over. Select it to see the result."}</span>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded-control bg-surface-2 px-2 py-2">
              <dt className="text-[11px] text-muted">Pot</dt>
              <dd className="num text-sm font-medium">{pot === null ? "—" : `${formatAmount(pot)} ${COLLATERAL.symbol}`}</dd>
            </div>
            <div className="rounded-control bg-surface-2 px-2 py-2">
              <dt className="text-[11px] text-muted">Entries</dt>
              <dd className="num text-sm font-medium">{entries}</dd>
            </div>
          </dl>

          {open ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                props.onSelect();
                props.onEnter(true);
              }}
              className={`${primary} cursor-pointer transition-opacity duration-150 hover:opacity-90`}
            >
              Enter round
            </button>
          ) : claimable > 0 ? (
            <span className="flex h-11 items-center justify-center rounded-pill border border-accent text-sm text-accent">{formatAmount(claimable, 4)} {COLLATERAL.symbol} to collect</span>
          ) : (
            <span className="flex h-11 items-center justify-center rounded-pill border border-line text-sm text-muted">{stage === "upcoming" ? "Not open yet" : live ? "Not taking entries" : "Round over"}</span>
          )}
        </>
      )}
    </article>
  );
}

function Leaders({ rows, final, ready, live, stage, picked, onPick }: { rows: BoardRow[]; final: boolean; ready: boolean; live: boolean; stage: Stage; picked: string | null; onPick: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, LEADERS);
  const top = rows[0]?.share ?? 0;

  if (stage === "upcoming") return null;
  if (!ready) {
    return <p className="text-sm text-muted">{stage === "live" ? "Loading the leaders…" : "The result appears once the closing prices are in."}</p>;
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{final ? "Final result" : "Leaders now"}</h2>
          <p className="text-xs text-muted">{final ? "Each coin's share of the gains, from open to close." : "If the round ended now, an entry on each coin would score its share of the gains."}</p>
        </div>
        {live && <span className="hidden text-xs text-muted sm:block">Tap a coin to back it</span>}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {shown.map((row, index) => {
          const tone = row.change === null ? "text-muted" : row.change > 0 ? "text-up" : row.change < 0 ? "text-down" : "text-muted";
          const chosen = live && picked === row.id;
          return (
            <button
              key={row.id}
              type="button"
              disabled={!live}
              onClick={() => onPick(row.id)}
              className={`flex flex-col gap-2 rounded-card border bg-surface p-3 text-left transition-colors duration-150 ${live ? "cursor-pointer hover:bg-surface-2" : "cursor-default"} ${chosen ? "border-accent" : "border-line"} ${row.share === 0 ? "opacity-60" : ""}`}
            >
              <span className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <CoinIcon id={row.id} size={24} />
                  <span className="text-sm font-medium">{row.id}</span>
                </span>
                <span className="num text-[11px] text-muted">#{index + 1}</span>
              </span>
              <span className="num text-xl font-semibold">{formatAmount(row.share * 100, 1)}%</span>
              <span className="h-1 overflow-hidden rounded-pill bg-surface-2">
                <span className="block h-full rounded-pill bg-accent" style={{ width: `${top > 0 ? Math.round((row.share / top) * 100) : 0}%` }} />
              </span>
              <span className={`num text-xs ${tone}`}>{row.change === null ? "—" : `${row.change > 0 ? "+" : ""}${formatAmount(row.change * 100, 2)}% vs $CRYPTO`}</span>
            </button>
          );
        })}
      </div>
      {rows.length > LEADERS && (
        <button type="button" onClick={() => setAll(!all)} className="mx-auto h-9 cursor-pointer rounded-pill border border-line px-4 text-xs transition-colors duration-150 hover:bg-surface-2">
          {all ? "Show top 10" : `Show all ${rows.length} coins`}
        </button>
      )}
    </section>
  );
}

function HowItWorks({ onClose }: { onClose: () => void }) {
  const steps = [
    ["Pick and stake", `While a round is live, back one coin with ${COLLATERAL.symbol}. A 0.02% fee is taken.`],
    ["Wait for the close", "Your entry starts from the next price. The round closes after four hours."],
    ["Share the pot", "Coins that rose against $CRYPTO split the pot by their share of the gains, weighted by stake. If none rose, everyone is refunded."],
  ];
  return (
    <div className="relative grid gap-4 rounded-card border border-line bg-surface p-4 pr-10 shadow-card sm:grid-cols-3">
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

function YourEntries({ epochs, lots, decimals, onSent }: { epochs: Epoch[]; lots: EpochLot[]; decimals: number; onSent: () => void }) {
  if (lots.length === 0) return null;
  const byOpen = new Map(epochs.map((epoch) => [epoch.opensAt, epoch]));
  const sorted = [...lots].sort((a, b) => b.epochOpensAt - a.epochOpensAt || Number(b.nonce) - Number(a.nonce));
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Your entries</h2>
      <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        {sorted.map((lot) => {
          const epoch = byOpen.get(lot.epochOpensAt) ?? null;
          const score = scoreOf(lot);
          const claimable = lot.claimable === null ? null : units(lot.claimable, decimals);
          const withdrawable = lot.state !== "withdrawn" && lot.claimable !== null && BigInt(lot.claimable) > 0n;
          return (
            <div key={lot.address} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-b-0">
              <span className="flex min-w-[100px] items-center gap-2">
                <CoinIcon id={lot.backedAsset} size={24} />
                <span className="text-sm font-medium">{lot.backedAsset}</span>
              </span>
              <span className="num text-xs text-muted">{epoch ? windowText(epoch) : ""}</span>
              <span className="num text-xs">{formatAmount(units(lot.grossStake, decimals))} {COLLATERAL.symbol} staked</span>
              {score !== null && <span className="num text-xs text-muted">Score {formatAmount(score * 100, 1)}%</span>}
              <span className="ml-auto flex items-center gap-3">
                <span className="text-xs text-muted">{lotStatus(lot, epoch)}</span>
                {withdrawable && epoch && (
                  <SendButton
                    intent={{ operation: "epoch-withdraw", opensAt: epoch.opensAt, nonce: lot.nonce }}
                    label={`Collect ${formatAmount(claimable ?? 0, 4)}`}
                    connectLabel="Connect"
                    onDone={onSent}
                    className="h-9 rounded-pill bg-accent px-4 text-xs font-medium text-accent-ink"
                  />
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function EpochsView({ overview, roster, serverNow }: { overview: EpochOverview; roster: string[]; serverNow: number }) {
  const now = useNow(serverNow);
  const { owner, market } = useAccount();
  const decimals = market.decimals || 6;
  const epochs = useMemo(() => [...overview.epochs].sort((a, b) => a.opensAt - b.opensAt), [overview.epochs]);
  const [selected, setSelected] = useState<string | null>(() => pickDefault(epochs, serverNow));
  const [entering, setEntering] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [lots, setLots] = useState<EpochLot[]>([]);
  const [help, setHelp] = useState(false);
  const track = useRef<HTMLDivElement>(null);
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

  const centred = useRef(false);
  useEffect(() => {
    const strip = track.current;
    const card = strip?.querySelector<HTMLElement>('[data-selected="true"]');
    if (!strip || !card) return;
    const left = card.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
    strip.scrollTo({ left: left - (strip.clientWidth - card.offsetWidth) / 2, behavior: centred.current ? "smooth" : "auto" });
    centred.current = true;
  }, [selected]);

  const scroll = (way: number) => track.current?.scrollBy({ left: way * 316, behavior: "smooth" });
  const pick = (id: string) => {
    setPicked(id);
    if (live) setEntering(true);
  };
  const claimableIn = (opensAt: number) =>
    lots.filter((lot) => lot.epochOpensAt === opensAt && lot.state !== "withdrawn" && lot.claimable !== null).reduce((sum, lot) => sum + units(lot.claimable!, decimals), 0);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm text-muted">Four-hour rounds. Back the coin you think beats $CRYPTO the most. Coins that rose share the pot.</p>
          <button type="button" onClick={() => setHelp(!help)} aria-expanded={help} className="flex h-9 cursor-pointer items-center gap-1.5 rounded-pill border border-line px-3 text-xs transition-colors duration-150 hover:bg-surface-2">
            <CircleHelp size={14} aria-hidden="true" /> How it works
          </button>
        </div>
        {help && <HowItWorks onClose={() => setHelp(false)} />}
      </div>

      {epochs.length === 0 ? (
        <section className="rounded-card border border-line bg-surface p-6 text-sm text-muted shadow-card">No rounds are scheduled yet. Check back soon.</section>
      ) : (
        <div className="relative">
          <div ref={track} className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 py-2 [scrollbar-width:none] sm:mx-0 sm:px-12">
            {epochs.map((item) => (
              <RoundCard
                key={item.address}
                epoch={item}
                coins={coinsOf(item, roster)}
                now={now}
                decimals={decimals}
                fee={overview.configuration.entryFee}
                selected={item.address === epoch?.address}
                entering={entering && item.address === epoch?.address}
                picked={picked}
                claimable={claimableIn(item.opensAt)}
                winner={item.address === epoch?.address && board.final ? (board.rows[0] ?? null) : null}
                onSelect={() => {
                  if (item.address !== epoch?.address) setEntering(false);
                  setSelected(item.address);
                }}
                onEnter={setEntering}
                onPick={setPicked}
                onSent={() => void loadLots()}
              />
            ))}
          </div>
          {epochs.length > 1 && (
            <>
              <button type="button" onClick={() => scroll(-1)} aria-label="Earlier rounds" className="absolute left-0 top-1/2 hidden size-9 -translate-y-1/2 cursor-pointer place-items-center rounded-pill border border-line bg-surface text-muted shadow-card hover:text-ink sm:grid">
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <button type="button" onClick={() => scroll(1)} aria-label="Later rounds" className="absolute right-0 top-1/2 hidden size-9 -translate-y-1/2 cursor-pointer place-items-center rounded-pill border border-line bg-surface text-muted shadow-card hover:text-ink sm:grid">
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}

      {epoch && <Leaders rows={board.rows} final={board.final} ready={board.ready} live={live} stage={stage} picked={picked} onPick={pick} />}

      <YourEntries epochs={epochs} lots={lots} decimals={decimals} onSent={() => void loadLots()} />
    </div>
  );
}
