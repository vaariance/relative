"use client";

import type { Epoch, EpochLot, EpochOverview, PreviewHistory } from "@eox/app-api";
import { Clock, Coins, Trophy, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { walletEpochLots } from "@/app/actions";
import { parseScaled } from "@/lib/amounts";
import { COLLATERAL } from "@/lib/config";
import { type Stage, PHASE_NOTE, STAGE_LABEL, countdown, feeOf, lotStatus, scoreOf, shareBoard, stageOf, units, windowText } from "@/lib/epoch";
import { historyEstimates } from "@/lib/estimate";
import { formatAmount } from "@/lib/format";
import type { Intent } from "@/lib/requests";
import { useAccount } from "./account";
import { CoinIcon } from "./coin-icon";
import { useLive } from "./live";
import { SendButton } from "./send-button";

const card = "rounded-card border border-line bg-surface shadow-card";
const field = "num h-11 w-full rounded-control border border-line bg-bg px-3 text-sm text-ink placeholder:text-muted";
const REFERENCE_DIGITS = 12;
const PREVIEW_BASE = 100;
const LOTS_MS = 20_000;

const STAGE_TONE: Record<Stage, string> = {
  upcoming: "bg-surface-2 text-ink",
  live: "bg-accent text-accent-ink",
  closing: "bg-surface-2 text-ink",
  settled: "bg-surface-2 text-muted",
  voided: "bg-surface-2 text-muted",
};

function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
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

function entriesOf(epoch: Epoch): number | null {
  if (epoch.nextNonce !== null) return Number(epoch.nextNonce);
  return epoch.lots?.executed ?? null;
}

function pickDefault(epochs: readonly Epoch[], now: number): string | null {
  const sorted = [...epochs].sort((a, b) => a.opensAt - b.opensAt);
  const live = sorted.find((epoch) => stageOf(epoch, now) === "live");
  const next = sorted.find((epoch) => stageOf(epoch, now) === "upcoming");
  const last = [...sorted].reverse().find((epoch) => stageOf(epoch, now) !== "upcoming");
  return (live ?? next ?? last ?? sorted[0])?.address ?? null;
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

function coinsOf(epoch: Epoch, roster: readonly string[]): string[] {
  if (epoch.universe.length > 0) return epoch.universe.map((member) => member.assetId);
  if (epoch.closingReferences.length > 0) return epoch.closingReferences.map((item) => item.assetId);
  return [...roster];
}

function RoundCard({ epoch, now, decimals, selected, onSelect }: { epoch: Epoch; now: number; decimals: number; selected: boolean; onSelect: () => void }) {
  const stage = stageOf(epoch, now);
  const pot = potOf(epoch, decimals);
  const entries = entriesOf(epoch);
  const timer = stage === "live" ? `Closes in ${countdown(epoch.closesAt - now)}` : stage === "upcoming" ? `Opens in ${countdown(epoch.opensAt - now)}` : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-60 shrink-0 cursor-pointer flex-col gap-3 rounded-card border bg-surface p-4 text-left shadow-card transition-colors duration-150 ${selected ? "border-accent ring-1 ring-accent" : "border-line hover:bg-surface-2"}`}
    >
      <div className="flex items-center justify-between">
        <span className={`rounded-pill px-2 py-0.5 text-xs font-medium ${STAGE_TONE[stage]}`}>{STAGE_LABEL[stage]}</span>
        <span className="num text-xs text-muted">{timer ?? ""}</span>
      </div>
      <span className="num text-sm">{windowText(epoch)}</span>
      <div className="flex justify-between text-xs text-muted">
        <span className="num">Pot {pot === null ? "—" : `${formatAmount(pot)} ${COLLATERAL.symbol}`}</span>
        <span className="num">{entries === null ? "" : `${entries} ${entries === 1 ? "entry" : "entries"}`}</span>
      </div>
    </button>
  );
}

function HowItWorks() {
  const steps = [
    { icon: Coins, title: "Pick and stake", text: `Choose one coin and stake ${COLLATERAL.symbol} while a round is live. A 0.02% fee is taken from the stake.` },
    { icon: Clock, title: "Wait for the close", text: "Your entry starts from the next price after you enter. The round closes at the end of its four hours." },
    { icon: Trophy, title: "Share the pot", text: "Coins that rose against $CRYPTO split the pot by their share of the total gains. Your payout follows your coin's share and your stake." },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {steps.map((step, index) => (
        <div key={step.title} className={`${card} flex gap-3 p-4`}>
          <span className="grid size-8 shrink-0 place-items-center rounded-pill bg-surface-2 text-accent">
            <step.icon size={16} aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-sm font-medium">{index + 1}. {step.title}</h3>
            <p className="mt-1 text-xs text-muted">{step.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function Board({ epoch, coins, now, picked, onPick }: { epoch: Epoch; coins: string[]; now: number; picked: string | null; onPick: (id: string) => void }) {
  const { estimate } = useLive();
  const stage = stageOf(epoch, now);
  const ids = coins;
  const opening = useOpeningReferences(epoch, now);
  const closing = useMemo(() => {
    if (epoch.closingReferences.length === 0) return null;
    return Object.fromEntries(epoch.closingReferences.map((item) => [item.assetId, (Number(BigInt(item.reference)) / 10 ** REFERENCE_DIGITS) * PREVIEW_BASE]));
  }, [epoch.closingReferences]);
  const end = closing ?? (stage === "live" ? (estimate?.references ?? null) : null);
  const rows = shareBoard(ids, opening, end);
  const final = closing !== null;
  const choosing = stage === "live" && epoch.entriesOpen;

  return (
    <section className={`${card} min-w-0 overflow-hidden`}>
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium">{final ? "Final board" : "Live board"}</h2>
        <p className="mt-1 text-xs text-muted">
          {stage === "upcoming"
            ? "The board fills in once the round opens."
            : !final && stage !== "live"
              ? "This round has ended. The board shows the final moves once its closing prices are recorded."
              : final
              ? "How each coin moved against $CRYPTO from the open to the close, and its share of all the gains."
              : "How each coin has moved against $CRYPTO since the round opened. Share of gains is what an entry on that coin would score if the round ended now."}
        </p>
      </div>
      {(stage === "live" || final) && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th scope="col" className="px-4 py-2 font-normal">Coin</th>
              <th scope="col" className="px-4 py-2 text-right font-normal">vs $CRYPTO</th>
              <th scope="col" className="px-4 py-2 text-right font-normal">Share of gains</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const tone = row.change === null ? "text-muted" : row.change > 0 ? "text-up" : row.change < 0 ? "text-down" : "text-muted";
              return (
                <tr key={row.id} onClick={choosing ? () => onPick(row.id) : undefined} className={`border-b border-line last:border-b-0 ${choosing ? "cursor-pointer hover:bg-surface-2" : ""} ${picked === row.id && choosing ? "bg-surface-2" : ""}`}>
                  <th scope="row" className="px-4 py-2.5 text-left font-normal">
                    <span className="flex items-center gap-2.5">
                      <CoinIcon id={row.id} size={22} />
                      <span className="font-medium text-ink">{row.id}</span>
                    </span>
                  </th>
                  <td className={`num px-4 py-2.5 text-right ${tone}`}>{row.change === null ? "—" : `${row.change > 0 ? "+" : ""}${formatAmount(row.change * 100, 2)}%`}</td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center justify-end gap-2">
                      <span className="hidden h-1.5 w-20 overflow-hidden rounded-pill bg-surface-2 sm:block">
                        <span className="block h-full bg-accent" style={{ width: `${Math.round(row.share * 100)}%` }} />
                      </span>
                      <span className="num w-14 text-right">{formatAmount(row.share * 100, 1)}%</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function EntryBox({ epoch, coins, now, decimals, fee, picked, onPick, onSent }: { epoch: Epoch; coins: string[]; now: number; decimals: number; fee: { bps: number; cap: string }; picked: string | null; onPick: (id: string) => void; onSent: () => void }) {
  const [amount, setAmount] = useState("");
  const stage = stageOf(epoch, now);
  const ids = coins;
  const open = stage === "live" && epoch.entriesOpen;
  const gross = amount.trim() === "" ? null : parseScaled(amount, decimals);
  const charge = gross !== null && gross > 0n ? feeOf(gross, fee.bps, BigInt(fee.cap)) : null;
  const problem = amount.trim() === "" ? "" : gross === null || gross <= 0n ? "Enter an amount above zero." : picked === null ? "Pick a coin first." : ids.length !== 30 ? "This round's coin list cannot be entered from here." : null;
  const intent: Intent | null = open && problem === null && gross !== null && picked !== null ? { operation: "epoch-entry", opensAt: epoch.opensAt, grossStake: gross.toString(), basket: ids, backedAsset: picked } : null;

  if (!open) {
    const text =
      stage === "upcoming"
        ? `Entries open in ${countdown(epoch.opensAt - now)}.`
        : stage === "live"
          ? "This round is full or not taking entries right now."
          : PHASE_NOTE[epoch.phase];
    return (
      <section className={`${card} p-4`}>
        <h2 className="text-sm font-medium">Enter this round</h2>
        <p className="mt-2 text-sm text-muted">{text}</p>
      </section>
    );
  }

  return (
    <section className={`${card} flex flex-col gap-3 p-4`}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Enter this round</h2>
        <span className="num text-xs text-muted">Closes in {countdown(epoch.closesAt - now)}</span>
      </div>
      <div>
        <label htmlFor="epoch-coin" className="mb-1 block text-xs text-muted">Your coin</label>
        <div className="flex items-center gap-2">
          {picked && <CoinIcon id={picked} size={28} />}
          <select id="epoch-coin" value={picked ?? ""} onChange={(event) => onPick(event.target.value)} className={`${field} cursor-pointer`}>
            <option value="" disabled>Pick a coin, or tap one on the board</option>
            {ids.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="epoch-stake" className="mb-1 block text-xs text-muted">Stake ({COLLATERAL.symbol})</label>
        <input id="epoch-stake" inputMode="decimal" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} className={field} />
      </div>
      <dl className="flex flex-col gap-1.5 border-t border-line pt-3 text-xs">
        <div className="flex justify-between">
          <dt className="text-muted">Fee</dt>
          <dd className="num">{charge === null ? "—" : `${formatAmount(Number(charge) / 10 ** decimals, 4)} ${COLLATERAL.symbol}`}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Goes into the pot</dt>
          <dd className="num">{charge === null || gross === null ? "—" : `${formatAmount(Number(gross - charge) / 10 ** decimals, 4)} ${COLLATERAL.symbol}`}</dd>
        </div>
      </dl>
      <SendButton
        intent={intent}
        label={amount.trim() === "" ? "Enter an amount" : picked ? `Enter with ${picked}` : "Pick a coin"}
        connectLabel="Connect wallet to enter"
        problem={problem}
        describe={picked && gross !== null ? `You staked ${amount} ${COLLATERAL.symbol} on ${picked} for this round.` : undefined}
        onDone={() => {
          setAmount("");
          onSent();
        }}
        className="h-11 rounded-pill bg-accent text-sm font-medium text-accent-ink"
      />
      <p className="text-xs text-muted">If no coin rises against $CRYPTO, every stake is returned in full, fee included.</p>
    </section>
  );
}

function YourEntries({ epoch, lots, decimals, onSent }: { epoch: Epoch; lots: EpochLot[]; decimals: number; onSent: () => void }) {
  const { owner } = useAccount();
  const mine = lots.filter((lot) => lot.epochOpensAt === epoch.opensAt);
  return (
    <section className={`${card} p-4`}>
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Users size={14} aria-hidden="true" className="text-muted" /> Your entries
      </h2>
      {!owner ? (
        <p className="mt-2 text-sm text-muted">Connect a wallet to see your entries.</p>
      ) : mine.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No entries in this round.</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-line">
          {mine.map((lot) => {
            const score = scoreOf(lot);
            const claimable = lot.claimable === null ? null : units(lot.claimable, decimals);
            const withdrawable = lot.state !== "withdrawn" && lot.claimable !== null && BigInt(lot.claimable) > 0n;
            return (
              <li key={lot.address} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <CoinIcon id={lot.backedAsset} size={22} />
                    <span className="text-sm font-medium">{lot.backedAsset}</span>
                    <span className="num text-xs text-muted">{formatAmount(units(lot.grossStake, decimals))} {COLLATERAL.symbol}</span>
                  </span>
                  <span className="text-xs text-muted">{lotStatus(lot, epoch)}</span>
                </div>
                {(score !== null || claimable !== null) && (
                  <div className="flex justify-between text-xs">
                    <span className="num text-muted">{score === null ? "" : `Score ${formatAmount(score * 100, 1)}%`}</span>
                    <span className="num">{claimable === null ? "" : `${formatAmount(claimable, 4)} ${COLLATERAL.symbol}`}</span>
                  </div>
                )}
                {withdrawable && (
                  <SendButton
                    intent={{ operation: "epoch-withdraw", opensAt: epoch.opensAt, nonce: lot.nonce }}
                    label={`Withdraw ${formatAmount(claimable ?? 0, 4)} ${COLLATERAL.symbol}`}
                    connectLabel="Connect wallet to withdraw"
                    onDone={onSent}
                    className="h-10 rounded-pill bg-accent text-sm font-medium text-accent-ink"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function EpochsView({ overview, roster }: { overview: EpochOverview; roster: string[] }) {
  const now = useNow();
  const { owner, market } = useAccount();
  const decimals = market.decimals || 6;
  const epochs = useMemo(() => [...overview.epochs].sort((a, b) => a.opensAt - b.opensAt), [overview.epochs]);
  const [selected, setSelected] = useState<string | null>(() => pickDefault(overview.epochs, Math.floor(Date.now() / 1000)));
  const [picked, setPicked] = useState<string | null>(null);
  const [lots, setLots] = useState<EpochLot[]>([]);
  const epoch = epochs.find((item) => item.address === selected) ?? epochs[0] ?? null;

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
    return <section className={`${card} p-6 text-sm text-muted`}>No rounds are scheduled yet. Check back soon.</section>;
  }

  return (
    <div className="flex flex-col gap-6">
      <HowItWorks />

      <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        <div className="flex gap-3">
          {epochs.map((item) => (
            <RoundCard key={item.address} epoch={item} now={now} decimals={decimals} selected={item.address === epoch.address} onSelect={() => setSelected(item.address)} />
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Board epoch={epoch} coins={coinsOf(epoch, roster)} now={now} picked={picked} onPick={setPicked} />
        <div className="flex flex-col gap-4">
          <EntryBox epoch={epoch} coins={coinsOf(epoch, roster)} now={now} decimals={decimals} fee={overview.configuration.entryFee} picked={picked} onPick={setPicked} onSent={() => void loadLots()} />
          <YourEntries epoch={epoch} lots={lots} decimals={decimals} onSent={() => void loadLots()} />
        </div>
      </div>
    </div>
  );
}
