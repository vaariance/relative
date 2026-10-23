"use client";

import type { Batch } from "@eox/app-api";
import Link from "next/link";
import { useState } from "react";
import { COLLATERAL } from "@/lib/config";
import { formatAmount } from "@/lib/format";
import { batchesFor } from "@/lib/market";
import { planRequest } from "@/lib/requests";
import { CRYPTO_CLASS, type ClassView, holdingsOf, toNumber, unitDigits, unlockedProblem } from "@/lib/view";
import { useAccount } from "./account";
import { Dots, FeeNote } from "./fee-note";
import { useOpenBatch } from "./open-batch";
import { SendButton } from "./send-button";
import { QUOTE_MESSAGES, useQuote } from "./use-quote";

type Side = "buy" | "sell";
type Pay = string;

const CRYPTO_PAY = "crypto";

const sides: { id: Side; label: string }[] = [
  { id: "buy", label: "Buy" },
  { id: "sell", label: "Sell" },
];

const field = "num h-11 w-full rounded-control border border-line bg-bg px-3 text-sm text-ink placeholder:text-muted";

export function TradeForm({ claim, crypto, nextBatch, decimals }: { claim: ClassView; crypto: ClassView; nextBatch: Batch | null; decimals: number }) {
  const { portfolio, owner, live, market } = useAccount();
  const holdings = holdingsOf(portfolio, decimals);
  const open = useOpenBatch(nextBatch);
  const [side, setSide] = useState<Side>("buy");
  const [pay, setPay] = useState<Pay>("primary");
  const [amount, setAmount] = useState("");
  const [minimum, setMinimum] = useState("");

  const buying = side === "buy";
  const options = market.collaterals.length > 0 ? market.collaterals : [{ mint: "primary", symbol: COLLATERAL.symbol, name: COLLATERAL.name, primary: true }];
  const chosen = pay === CRYPTO_PAY ? null : (options.find((item) => item.mint === pay) ?? options.find((item) => item.primary) ?? options[0]!);
  const direct = buying && chosen !== null;
  const pays = direct ? chosen.symbol : "$CRYPTO";
  const collateralMint = direct && market.collaterals.length > 1 ? chosen.mint : undefined;
  const from = buying ? CRYPTO_CLASS : claim.id;
  const to = buying ? claim.id : CRYPTO_CLASS;
  const parsed = Number(amount);
  const empty = amount.trim() === "";
  const valid = Number.isFinite(parsed) && parsed > 0;
  const held = holdings?.find((item) => item.classId === from);
  const available = direct ? null : held ? held.units - held.locked : holdings === null ? null : 0;
  const unitsProblem = valid && !direct ? unlockedProblem(holdings, from, parsed) : null;
  const planned = planRequest({ operation: direct ? "deposit" : "switch", fromClass: direct ? null : from, toClass: to, amount, minimum, validForBatches: batchesFor(market.interval), targetBatch: open.batch?.batch ?? null, collateralDecimals: decimals, collateralMint });
  const { quote, pending, problem } = useQuote(planned.intent);
  const quoted = quote === null || quote.mintedUnits === null ? null : toNumber(quote.mintedUnits, unitDigits(decimals));
  const blocked = unitsProblem ? QUOTE_MESSAGES.balance : problem ? QUOTE_MESSAGES[problem] : null;
  const receives = buying ? `${claim.id} position units` : "$CRYPTO";
  const needsCrypto = buying && !direct && live && owner !== null && available === 0;

  return (
    <section className="rounded-card border border-line bg-surface p-4 shadow-card">
      <div role="group" aria-label="Buy or sell" className="mb-4 grid grid-cols-2 gap-1 rounded-control bg-surface-2 p-1">
        {sides.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={side === item.id}
            onClick={() => setSide(item.id)}
            className={`h-10 cursor-pointer rounded-control text-sm transition-colors duration-150 ${side === item.id ? "bg-accent font-medium text-accent-ink" : "text-muted hover:text-ink"}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <form className="flex flex-col gap-3" onSubmit={(event) => event.preventDefault()}>
        <div>
          <div className="mb-1 flex items-center justify-between text-xs text-muted">
            <label htmlFor="trade-amount">{buying ? `You pay (${pays})` : `You give (${claim.id} units)`}</label>
            {available !== null && <span className="num">Available {formatAmount(available)}</span>}
          </div>
          <input id="trade-amount" inputMode="decimal" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} className={field} />
          {!empty && !valid && <p className="mt-1 text-xs text-down">Enter an amount above zero.</p>}
          {buying && (
            <div role="group" aria-label="Pay with" className="mt-2 flex items-center gap-1 text-xs">
              <span className="mr-1 text-muted">Pay with</span>
              {[...options.map((item) => ({ id: item.mint, label: item.symbol, on: chosen?.mint === item.mint })), { id: CRYPTO_PAY, label: "$CRYPTO", on: chosen === null }].map((item) => (
                <button key={item.id} type="button" aria-pressed={item.on} onClick={() => setPay(item.id)} className={`h-7 cursor-pointer rounded-pill px-3 transition-colors duration-150 ${item.on ? "bg-surface-2 text-ink" : "text-muted hover:text-ink"}`}>
                  {item.label}
                </button>
              ))}
            </div>
          )}
          {needsCrypto && (
            <p className="mt-1 text-xs text-muted">
              You have no $CRYPTO yet. <Link href="/swap" className="text-accent underline">Swap USDC for $CRYPTO</Link> first.
            </p>
          )}
        </div>
        <div>
          <label htmlFor="trade-condition" className="mb-1 block text-xs text-muted">Minimum to receive</label>
          <input id="trade-condition" inputMode="decimal" placeholder="Optional" value={minimum} onChange={(event) => setMinimum(event.target.value)} className={field} />
        </div>

        <dl className="mt-1 flex flex-col gap-2 border-t border-line pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">You receive</dt>
            <dd className="num">{pending ? <Dots /> : quoted === null ? <span className="text-muted">0 {receives}</span> : <span key={quoted} className="slot-in inline-block">≈ {formatAmount(quoted, 4)} {receives}</span>}</dd>
          </div>
          <FeeNote pending={pending} quote={quote} decimals={decimals} />
        </dl>


        <SendButton trading describe={buying ? `Buy ${claim.id} with ${amount} ${pays}` : `Sell ${amount} ${claim.id} units for $CRYPTO`} intent={planned.intent} label={empty ? "Enter an amount" : pending ? "Calculating" : buying ? `Buy ${claim.id}` : `Sell ${claim.id}`} connectLabel="Connect wallet to continue" problem={empty ? "" : (planned.problem ?? (needsCrypto ? "" : blocked) ?? (pending ? "" : null))} className="h-11 rounded-pill bg-accent text-sm font-medium text-accent-ink" />
      </form>
    </section>
  );
}
