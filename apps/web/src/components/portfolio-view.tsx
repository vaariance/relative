"use client";

import type { CoxStatus } from "@eox/app-api";
import { ArrowDownToLine, Clock, Undo2, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { shortAddress } from "@/lib/address";
import { COLLATERAL } from "@/lib/config";
import { costBasis, paidFor } from "@/lib/basis";
import { direction, formatAmount, formatSigned } from "@/lib/format";
import { expiryAfter } from "@/lib/market";
import { CRYPTO_CLASS, type ClassView, nameOf, positionName, toNumber, unitDigits } from "@/lib/view";
import { useAccount } from "./account";
import { useOpenBatch } from "./open-batch";
import { RequestList } from "./request-list";
import { SendButton } from "./send-button";
import { Figure, StatCard } from "./stat-card";

export function PortfolioView({ classes, status, decimals }: { classes: ClassView[]; status: CoxStatus; decimals: number }) {
  const { portfolio, owner, live, loading, market } = useAccount();
  const [receive, setReceive] = useState<string | null>(null);
  const receiveIn = market.collaterals.find((item) => item.mint === receive) ?? market.collaterals.find((item) => item.primary) ?? null;
  const router = useRouter();
  const open = useOpenBatch(status.currentBatch);
  const expiryBatch = open.batch ? expiryAfter(open.batch.batch, market.interval) : null;
  const book = costBasis(portfolio?.requests ?? [], decimals);
  const rows = (portfolio?.positions ?? []).map((position) => {
    const units = toNumber(position.units, unitDigits(decimals));
    const unitValue = classes.find((item) => item.id === position.classId)?.unitValue ?? null;
    const redeemable = unitValue === null ? null : units * unitValue;
    const paid = paidFor(book, position.classId, units);
    const free = BigInt(position.units) - BigInt(position.locked);
    return { free: free > 0n ? free.toString() : null, classId: position.classId, units, locked: toNumber(position.locked, unitDigits(decimals)), unitValue, redeemable, paid, change: redeemable === null || paid === null ? null : redeemable - paid };
  });
  const redeemable = rows.reduce((sum, row) => sum + (row.redeemable ?? 0), 0);
  const total = rows.length > 0 && rows.every((row) => row.change !== null) ? rows.reduce((sum, row) => sum + (row.change ?? 0), 0) : null;
  const tone = (value: number | null) => (value === null ? "text-muted" : { up: "text-up", down: "text-down", flat: "text-muted" }[direction(value)]);
  const payable = portfolio?.payable ?? "0";
  const cards = [
    { label: "Worth now, about", icon: Wallet, value: redeemable, note: total === null ? null : `Gain or loss so far: ${formatSigned(total, 6)} ${COLLATERAL.symbol}` },
    { label: "Pending buys", icon: Clock, value: toNumber(portfolio?.pending ?? "0", decimals), note: null },
    { label: "Refundable", icon: Undo2, value: toNumber(portfolio?.refundable ?? "0", decimals), note: null },
  ];
  const who = !live
    ? "This is fixture data, so it shows a demo wallet."
    : !owner
      ? "Connect a wallet to see its positions."
      : loading
        ? `Loading ${shortAddress(owner)}.`
        : portfolio
          ? `Showing ${shortAddress(owner)}.`
          : `${shortAddress(owner)} has no positions or requests yet.`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-title font-semibold tracking-tight">Portfolio</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          {who}
        </p>      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <StatCard key={card.label} icon={card.icon} title={card.label} value={<Figure text={formatAmount(card.value, 4)} unit={COLLATERAL.symbol} />} caption={card.note} />
        ))}
        <StatCard icon={ArrowDownToLine} title="Ready to withdraw" value={<Figure text={formatAmount(toNumber(payable, decimals))} unit={COLLATERAL.symbol} />}>
          <div className="mt-3 flex flex-col gap-2">
            {market.collaterals.length > 1 && (
              <label className="flex items-center justify-between gap-2 text-xs text-muted">
                Receive as
                <select value={receiveIn?.mint ?? ""} onChange={(event) => setReceive(event.target.value)} className="h-8 cursor-pointer rounded-control border border-line bg-bg px-2 text-xs text-ink">
                  {market.collaterals.map((item) => (
                    <option key={item.mint} value={item.mint}>
                      {item.symbol}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <SendButton
              intent={BigInt(payable) > 0n ? { operation: "withdraw", amount: payable, ...(market.collaterals.length > 1 && receiveIn ? { collateralMint: receiveIn.mint } : {}) } : null}
              label={BigInt(payable) > 0n ? "Withdraw all" : "Nothing to withdraw"}
              connectLabel="Login to withdraw"
              className="h-10 w-full rounded-pill bg-accent text-sm font-medium text-accent-ink"
              hideSuccess
            />
          </div>
        </StatCard>
      </div>

      <section className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
        <h2 className="border-b border-line px-4 py-3 text-sm font-medium">Performance positions</h2>
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">No positions yet.</p>
        ) : (
          <table className="w-full min-w-[940px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th scope="col" className="px-4 py-3 font-normal">Position</th>
                <th scope="col" className="px-4 py-3 text-right font-normal">Position units</th>
                <th scope="col" className="px-4 py-3 text-right font-normal">Locked in requests</th>
                <th scope="col" className="px-4 py-3 text-right font-normal">Unit value</th>
                <th scope="col" className="px-4 py-3 text-right font-normal">Paid ({COLLATERAL.symbol})</th>
                <th scope="col" className="px-4 py-3 text-right font-normal">Worth now, about ({COLLATERAL.symbol})</th>
                <th scope="col" className="px-4 py-3 text-right font-normal">Gain or loss</th>
                <th scope="col" className="px-4 py-3 text-right font-normal"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.classId} onClick={(event) => !(event.target as HTMLElement).closest("button, a, [role=status]") && router.push(`/portfolio/${row.classId}`)} className="cursor-pointer border-b border-line transition-colors duration-150 last:border-b-0 hover:bg-surface-2">
                  <th scope="row" className="px-4 py-3 text-left font-medium">
                    <Link href={`/portfolio/${row.classId}`} className="underline-offset-4 hover:underline">{positionName(row.classId)}</Link>
                    <span className="mt-0.5 block text-xs font-normal text-muted">{row.classId === CRYPTO_CLASS ? "Tracks the index" : `${row.classId} vs $CRYPTO`}</span>
                  </th>
                  <td className="num px-4 py-3 text-right">{formatAmount(row.units, 4)}</td>
                  <td className="num px-4 py-3 text-right">{formatAmount(row.locked, 4)}</td>
                  <td className="num px-4 py-3 text-right">{row.unitValue === null ? "n/a" : formatAmount(row.unitValue, 6)}</td>
                  <td className="num px-4 py-3 text-right">{row.paid === null ? "—" : formatAmount(row.paid, 4)}</td>
                  <td className="num px-4 py-3 text-right">{row.redeemable === null ? "n/a" : formatAmount(row.redeemable, 6)}</td>
                  <td className={`num px-4 py-3 text-right ${tone(row.change)}`}>{row.change === null ? "—" : formatSigned(row.change, 6)}</td>
                  <td className="px-4 py-2 text-right">
                    {row.classId === CRYPTO_CLASS && (
                    <span className="inline-flex flex-col items-end gap-1">
                      <SendButton
                        trading
                        intent={row.free !== null && expiryBatch !== null ? { operation: "redeem", fromClass: row.classId, units: row.free, minimumProceeds: "0", expiryBatch } : null}
                        describe={`Cash out your ${nameOf(row.classId)} position to ${COLLATERAL.symbol}`}
                        label="Cash out"
                        connectLabel="Cash out"
                        className="h-9 rounded-pill border border-line px-3 text-xs"
                        quiet
                      />
                    </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <RequestList status={status} decimals={decimals} />
    </div>
  );
}
