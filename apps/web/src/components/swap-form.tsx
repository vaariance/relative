"use client";

import type { Batch } from "@eox/app-api";
import { ArrowDownUp } from "lucide-react";
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

const field = "num h-11 w-full rounded-control border border-line bg-bg px-3 text-sm text-ink placeholder:text-muted";
const fixed = "flex h-11 w-full items-center rounded-control border border-line bg-bg px-3 text-sm text-ink";

export function SwapForm({ crypto, nextBatch, decimals }: { crypto: ClassView; nextBatch: Batch | null; decimals: number }) {
  const { portfolio, market } = useAccount();
  const holdings = holdingsOf(portfolio, decimals);
  const open = useOpenBatch(nextBatch);
  const [buying, setBuying] = useState(true);
  const [amount, setAmount] = useState("");

  const parsed = Number(amount);
  const empty = amount.trim() === "";
  const valid = Number.isFinite(parsed) && parsed > 0;
  const held = buying || holdings === null ? null : (holdings.find((item) => item.classId === CRYPTO_CLASS)?.units ?? 0);
  const unitsProblem = valid && !buying ? unlockedProblem(holdings, CRYPTO_CLASS, parsed) : null;
  const planned = planRequest({
    operation: buying ? "deposit" : "redeem",
    fromClass: buying ? null : CRYPTO_CLASS,
    toClass: buying ? CRYPTO_CLASS : null,
    amount,
    minimum: "",
    validForBatches: batchesFor(market.interval),
    targetBatch: open.batch?.batch ?? null,
    collateralDecimals: decimals,
  });
  const { quote, pending, problem } = useQuote(planned.intent);
  const quoted = quote === null ? null : buying ? (quote.mintedUnits === null ? null : toNumber(quote.mintedUnits, unitDigits(decimals))) : toNumber(quote.proceeds ?? quote.net, decimals);
  const blocked = unitsProblem ? QUOTE_MESSAGES.balance : problem ? QUOTE_MESSAGES[problem] : null;
  const give = buying ? COLLATERAL.symbol : "$CRYPTO";
  const get = buying ? "$CRYPTO" : COLLATERAL.symbol;

  return (
    <section className="flex h-full flex-col rounded-card border border-line bg-surface p-4 shadow-card">
      <form className="flex flex-1 flex-col gap-3" onSubmit={(event) => event.preventDefault()}>
        <div className="rounded-control bg-surface-2 p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-muted">
            <label htmlFor="swap-amount">You give</label>
            {held !== null && <span className="num">You hold {formatAmount(held)} $CRYPTO</span>}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <input id="swap-amount" inputMode="decimal" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} className={field} />
            <span className={fixed}>{give}</span>
          </div>
        </div>

        <div className="flex justify-center">
          <button type="button" onClick={() => setBuying(!buying)} aria-label="Swap the two sides" className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-pill border border-line bg-surface transition-colors duration-150 hover:bg-surface-2">
            <ArrowDownUp size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="rounded-control bg-surface-2 p-3">
          <div className="mb-2 block text-xs text-muted">You get (estimate)</div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
            <output htmlFor="swap-amount" className={`${fixed} num`}>{pending ? <Dots /> : quoted === null ? <span className="text-muted">0</span> : <span key={quoted} className="slot-in">≈ {formatAmount(quoted, 4)}</span>}</output>
            <span className={fixed}>{get}</span>
          </div>
          <div className="mt-2">
            <FeeNote pending={pending} quote={quote} decimals={decimals} />
          </div>
        </div>



        <div className="mt-auto flex flex-col gap-2">
          <SendButton trading describe={`Swap ${amount} ${give} for ${get}`} intent={planned.intent} label={empty ? "Enter an amount" : pending ? "Calculating" : "Swap"} connectLabel="Connect wallet to swap" problem={empty ? "" : (planned.problem ?? blocked ?? (pending ? "" : null))} className="h-11 rounded-pill bg-accent text-sm font-medium text-accent-ink" />
        </div>
      </form>
    </section>
  );
}
