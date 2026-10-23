"use client";

import { COLLATERAL } from "@/lib/config";
import { costBasis, paidFor } from "@/lib/basis";
import { direction, formatAmount, formatSigned } from "@/lib/format";
import { holdingsOf, positionName, positionNote } from "@/lib/view";
import { useAccount } from "./account";
import { useLive } from "./live";

export function MyPosition({ classId, unitValue, decimals }: { classId: string; unitValue: number | null; decimals: number }) {
  const { portfolio, owner, live, loading } = useAccount();
  const { wallet } = useLive();
  const holding = holdingsOf(portfolio, decimals)?.find((item) => item.classId === classId);
  const estimated = wallet?.byClass[classId];
  const worth = holding ? (estimated ?? (unitValue !== null ? holding.units * unitValue : null)) : null;
  const paid = holding ? paidFor(costBasis(portfolio?.requests ?? [], decimals), classId, holding.units) : null;
  const change = worth === null || paid === null ? null : worth - paid;
  const tone = change === null ? "" : { up: "text-up", down: "text-down", flat: "text-muted" }[direction(change)];
  const none = loading ? "Loading your position." : live && !owner ? "Connect a wallet to see your position." : `You have no ${positionName(classId)}.`;

  return (
    <section className="rounded-card border border-line bg-surface p-4 shadow-card">
      <h2 className="text-sm font-medium">Your position</h2>
      <p className="mt-1 text-xs text-muted">{positionNote(classId)}</p>
      {holding ? (
        <dl className="mt-3 flex flex-col gap-2 text-sm">
          <div className="flex justify-between"><dt className="text-muted">Position units</dt><dd className="num">{formatAmount(holding.units, 4)}</dd></div>
          <div className="flex justify-between"><dt className="text-muted">Locked in requests</dt><dd className="num">{formatAmount(holding.locked, 4)}</dd></div>
          {paid !== null && (
            <div className="flex justify-between"><dt className="text-muted">Paid</dt><dd className="num">{formatAmount(paid, 4)} {COLLATERAL.symbol}</dd></div>
          )}
          <div className="flex justify-between border-t border-line pt-2">
            <dt className="text-muted">Worth now, about{estimated == null ? " (settled)" : " (live estimate)"}</dt>
            <dd className="num">{worth === null ? "n/a" : `${formatAmount(worth, 6)} ${COLLATERAL.symbol}`}</dd>
          </div>
          {change !== null && (
            <div className="flex justify-between">
              <dt className="text-muted">Gain or loss</dt>
              <dd className={`num ${tone}`}>{formatSigned(change, 6)} {COLLATERAL.symbol}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="mt-3 text-sm text-muted">{none}</p>
      )}
    </section>
  );
}
