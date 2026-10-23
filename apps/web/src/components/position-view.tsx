"use client";

import type { CoxStatus } from "@eox/app-api";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { costBasis, paidFor } from "@/lib/basis";
import { COLLATERAL } from "@/lib/config";
import { direction, formatAmount, formatSigned, formatUtcTime } from "@/lib/format";
import { expiryAfter } from "@/lib/market";
import { tradesOf } from "@/lib/trades";
import { CRYPTO_CLASS, type ClassView, type Point, type ValuePoint, holdingsOf, nameOf, positionName, positionNote } from "@/lib/view";
import { useAccount } from "./account";
import { LiveFigure, useLive } from "./live";
import { AssetChart, type Series } from "./asset-chart";
import { useOpenBatch } from "./open-batch";
import { RequestList } from "./request-list";
import { SendButton } from "./send-button";
import type { ChartMark } from "./trade-chart";
import { TradeForm } from "./trade-form";

interface PositionProps {
  classId: string;
  claim: ClassView;
  crypto: ClassView;
  values: ValuePoint[];
  reference: Point[];
  price: Point[];
  cutoffs: Record<number, number>;
  status: CoxStatus;
  decimals: number;
}

const tones = { up: "text-up", down: "text-down", flat: "text-muted" };
const sides = { bought: "Bought at", sold: "Sold at", "cashed out": "Cashed out at" };

function Stat({ label, children, tone = "" }: { label: string; children: ReactNode; tone?: string }) {
  return (
    <div className="min-w-32 flex-1 px-4 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`num mt-1 text-sm ${tone}`}>{children}</dd>
    </div>
  );
}

export function PositionView({ classId, claim, crypto, values, reference, price, cutoffs, status, decimals }: PositionProps) {
  const { portfolio, owner, live, loading, market } = useAccount();
  const { wallet } = useLive();
  const open = useOpenBatch(status.currentBatch);
  const holding = holdingsOf(portfolio, decimals)?.find((item) => item.classId === classId) ?? null;
  const position = portfolio?.positions.find((item) => item.classId === classId) ?? null;
  const requests = portfolio?.requests ?? [];
  const trades = tradesOf(requests, classId, decimals);
  const units = holding?.units ?? 0;
  const unitValue = values[values.length - 1]?.value ?? null;
  const estimated = wallet?.byClass[classId];
  const worth = holding ? (estimated ?? (unitValue !== null ? units * unitValue : null)) : null;
  const paid = holding ? paidFor(costBasis(requests, decimals), classId, units) : null;
  const entry = paid !== null && units > 0 ? paid / units : null;
  const change = worth === null || paid === null ? null : worth - paid;
  const percent = change === null || paid === null || paid === 0 ? null : (change / paid) * 100;
  const tone = change === null ? "" : tones[direction(change)];
  const lastBuy = trades.find((trade) => trade.side === "bought") ?? null;
  const lastExit = trades.find((trade) => trade.side !== "bought") ?? null;
  const since = lastBuy === null ? values : values.filter((point) => point.sequence >= lastBuy.sequence);
  const free = position ? BigInt(position.units) - BigInt(position.locked) : 0n;
  const expiryBatch = open.batch ? expiryAfter(open.batch.batch, market.interval) : null;
  const when = (sequence: number) => (cutoffs[sequence] === undefined ? "—" : formatUtcTime(cutoffs[sequence]));
  const marks: ChartMark[] = trades.flatMap((trade) =>
    cutoffs[trade.sequence] === undefined ? [] : [{ cutoff: cutoffs[trade.sequence], side: trade.side === "bought" ? ("buy" as const) : ("sell" as const), label: `${sides[trade.side]} ${trade.price === null ? "n/a" : formatAmount(trade.price, 6)}` }],
  );
  const series: Series[] = [
    {
      id: "unit",
      label: `${nameOf(classId)} unit value`,
      points: values,
      digits: 6,
      marks,
      compare: entry ?? undefined,
      lines: [...(entry === null ? [] : [{ value: entry, label: `Bought at ${formatAmount(entry, 6)}`, tone: "ink" as const }])],
      live: { kind: "unitValue", id: classId, realtime: true },
    },
    ...(holding && since.length > 1
      ? [{ id: "worth", label: `Worth (${COLLATERAL.symbol})`, points: since.map((point) => ({ cutoff: point.cutoff, value: point.value * units })), digits: 6, compare: paid ?? undefined, lines: paid === null ? [] : [{ value: paid, label: `Paid ${formatAmount(paid, 4)}`, tone: "ink" as const }], live: { kind: "unitValue" as const, id: classId, scale: units, realtime: true } }]
      : []),
    ...(reference.length > 1 ? [{ id: "reference", label: "Relative reference", points: reference, digits: 4, marks, live: classId === CRYPTO_CLASS ? undefined : { kind: "reference" as const, id: classId } }] : []),
    ...(price.length > 1 ? [{ id: "price", label: "Price (USD)", points: price, digits: price[price.length - 1].value >= 1 ? 2 : 6, marks, live: { kind: "price" as const, id: classId } }] : []),
  ];
  const empty = loading ? "Loading your position." : live && !owner ? "Connect a wallet to see your position." : `You have no ${positionName(classId)} right now.`;

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted">
        <Link href="/portfolio" className="hover:text-ink">Portfolio</Link>
        <ChevronRight size={12} aria-hidden="true" />
        <span className="text-ink">{positionName(classId)}</span>
      </nav>

      <section className="rounded-card border border-line bg-surface shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="font-display text-2xl font-semibold tracking-tight">{positionName(classId)}</h1>
            <span className="num text-2xl">{unitValue === null ? "—" : formatAmount(unitValue, 6)}</span>
            {percent !== null && change !== null && (
              <span className={`num text-sm ${tone}`}>{formatSigned(change, 6)} {COLLATERAL.symbol} ({formatSigned(percent, 3)}%)</span>
            )}
            <span className="text-xs text-muted">Unit value</span>
            <p className="w-full text-xs text-muted">{positionNote(classId)}</p>
          </div>
          {holding && classId === CRYPTO_CLASS && (
            <span className="flex flex-col items-end gap-1">
              <SendButton
                trading
                intent={free > 0n && expiryBatch !== null ? { operation: "redeem", fromClass: classId, units: free.toString(), minimumProceeds: "0", expiryBatch } : null}
                describe={`Cash out your ${nameOf(classId)} position to ${COLLATERAL.symbol}`}
                label="Cash out position"
                connectLabel="Cash out position"
                className="h-10 rounded-pill bg-accent px-4 text-sm font-medium text-accent-ink"
                quiet
              />
            </span>
          )}
        </div>
        {holding ? (
          <dl className="flex flex-wrap divide-x divide-line border-t border-line">
            <Stat label="Bought at">{entry === null ? "—" : formatAmount(entry, 6)}</Stat>
            <Stat label={lastExit ? sides[lastExit.side] : "Sold at"}>{lastExit?.price == null ? "—" : formatAmount(lastExit.price, 6)}</Stat>
            <Stat label="Position units">{formatAmount(units, 4)}</Stat>
            <Stat label={`Paid (${COLLATERAL.symbol})`}>{paid === null ? "—" : formatAmount(paid, 4)}</Stat>
            <Stat label={`Worth now (${COLLATERAL.symbol}, ${estimated == null ? "settled" : "estimate"})`}>{worth === null ? "n/a" : formatAmount(worth, 6)}</Stat>
            <Stat label="Gain or loss" tone={tone}>{change === null ? "—" : `${formatSigned(change, 6)}${percent === null ? "" : ` (${formatSigned(percent, 3)}%)`}`}</Stat>
            {price.length > 0 && <Stat label={`${classId} price (USD)`}><LiveFigure kind="price" id={classId} committed={price[price.length - 1].value} plain /></Stat>}
          </dl>
        ) : (
          <p className="border-t border-line px-4 py-3 text-sm text-muted">{empty}</p>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          {values.length > 1 ? (
            <AssetChart series={series} height={460} />
          ) : (
            <p className="rounded-card border border-line bg-surface p-6 text-sm text-muted shadow-card">The chart starts once this class has had backing for two publications.</p>
          )}

          <section className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
            <h2 className="border-b border-line px-4 py-3 text-sm font-medium">Your trades</h2>
            {trades.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">{loading ? "Loading your trades." : "No filled trades in this position yet."}</p>
            ) : (
              <table className="w-full min-w-[620px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th scope="col" className="px-4 py-2.5 font-normal">Time (UTC)</th>
                    <th scope="col" className="px-4 py-2.5 font-normal">Side</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-normal">Price</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-normal">Units</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-normal">Value ({COLLATERAL.symbol})</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade) => (
                    <tr key={trade.requestId} className="border-b border-line last:border-b-0">
                      <td className="num px-4 py-2.5 text-muted">{when(trade.sequence)}</td>
                      <td className={`px-4 py-2.5 font-medium ${trade.side === "bought" ? "text-up" : "text-down"}`}>{sides[trade.side]}</td>
                      <td className="num px-4 py-2.5 text-right">{trade.price === null ? "n/a" : formatAmount(trade.price, 6)}</td>
                      <td className="num px-4 py-2.5 text-right">{formatAmount(trade.units, 4)}</td>
                      <td className="num px-4 py-2.5 text-right">{formatAmount(trade.value, 6)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <RequestList classId={classId} status={status} decimals={decimals} />
        </div>

        <div className="flex flex-col gap-4">
          {classId === CRYPTO_CLASS ? (
            <section className="rounded-card border border-line bg-surface p-4 shadow-card">
              <h2 className="text-sm font-medium">Trade</h2>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Link href="/swap" className="flex h-11 items-center justify-center rounded-pill bg-accent text-sm font-medium text-accent-ink transition-opacity duration-150 hover:opacity-90">Swap</Link>
                <Link href="/markets" className="flex h-11 items-center justify-center rounded-pill border border-line text-sm transition-colors duration-150 hover:bg-surface-2">Markets</Link>
              </div>
            </section>
          ) : (
            <TradeForm claim={claim} crypto={crypto} nextBatch={status.currentBatch} decimals={decimals} />
          )}
        </div>
      </div>
    </div>
  );
}
