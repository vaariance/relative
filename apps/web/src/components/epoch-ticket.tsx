"use client";

import type { Epoch } from "@eox/app-api";
import { CircleHelp, Layers, MinusCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { parseScaled } from "@/lib/amounts";
import { COLLATERAL } from "@/lib/config";
import { basketMode, basketProblem, entryBasket, feeOf } from "@/lib/epoch";
import type { Collateral } from "@/lib/market";
import type { Intent } from "@/lib/requests";
import { useAccount } from "./account";
import { CoinIcon } from "./coin-icon";
import { gradient, pct, tone, useWalletCollateral } from "./epoch-shared";
import { SendButton } from "./send-button";
import { openLogin } from "./signer";

const QUICK = [5, 25, 75];

function asText(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${value / scale}.${fraction}` : `${value / scale}`;
}

function money(value: bigint | null, decimals: number): string {
  if (value === null) return "—";
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${(value / scale).toLocaleString("en-US")}.${fraction}`;
}

function PotHelp({ gross, charge, net, decimals, fee }: { gross: bigint | null; charge: bigint | null; net: bigint | null; decimals: number; fee: { bps: number; cap: string } }) {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const frame = useRef<HTMLSpanElement>(null);
  const open = pinned || hover;
  useEffect(() => {
    if (!pinned) return;
    const away = (event: MouseEvent) => {
      if (frame.current && !frame.current.contains(event.target as Node)) setPinned(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPinned(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [pinned]);
  const line = (label: string, value: string, strong = false) => (
    <div className={`flex items-baseline justify-between gap-4 ${strong ? "font-semibold text-ink" : "text-muted"}`}>
      <span>{label}</span>
      <span className="num shrink-0 whitespace-nowrap">{value}</span>
    </div>
  );
  return (
    <span ref={frame} className="relative inline-flex" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button type="button" onClick={() => setPinned((value) => !value)} aria-expanded={open} aria-controls="pot-help" aria-label="Why this amount goes into the pot" className="grid size-6 cursor-pointer place-items-center rounded-full text-muted transition-colors duration-150 hover:text-ink">
        <CircleHelp size={16} aria-hidden="true" />
      </button>
      {open && (
        <span id="pot-help" role="tooltip" className="absolute bottom-full left-1/2 z-20 mb-2 flex w-64 -translate-x-1/2 flex-col gap-2 rounded-xl border border-white/10 bg-surface-2 p-3 text-xs shadow-card">
          <span className="text-sm font-semibold text-ink">What goes into the pot</span>
          {line("You pay", money(gross, decimals))}
          {line(`Entry fee (${fee.bps / 100}%, max ${money(BigInt(fee.cap), decimals)})`, charge === null ? "—" : `−${money(charge, decimals)}`)}
          <span className="border-t border-white/10" />
          {line("Goes into the pot", money(net, decimals), true)}
        </span>
      )}
    </span>
  );
}

function PickRow({ id, detail, change, onRemove, label }: { id: string; detail: string; change?: number | null; onRemove?: () => void; label?: string }) {
  return (
    <li className="flex items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-bg/60">
        <CoinIcon id={id} size={20} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">{id}</span>
        <span className="truncate text-xs text-muted">{detail}</span>
      </span>
      {change !== undefined && change !== null && <span className={`num text-sm ${tone(change)}`}>{pct(change, 2)}</span>}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={label ?? `Remove ${id}`} className="cursor-pointer text-muted transition-colors duration-150 hover:text-ink">
          <MinusCircle size={20} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

export function EntryTicket(props: { epoch: Epoch; coins: string[]; backed: string; mates: string[]; move: number | null; decimals: number; fee: { bps: number; cap: string }; collaterals: Collateral[]; onClear: () => void; onToggle: (id: string) => void; onSent: () => void }) {
  const { epoch, coins, backed, mates, decimals, fee, collaterals } = props;
  const { owner } = useAccount();
  const [amount, setAmount] = useState("");
  const [sent, setSent] = useState(0);
  const first = useWalletCollateral(collaterals[0]?.mint ?? null, decimals, sent);
  const second = useWalletCollateral(collaterals[1]?.mint ?? null, decimals, sent);
  const balances = [first, second].slice(0, Math.max(1, collaterals.length));
  const gross = amount.trim() === "" ? null : parseScaled(amount, decimals);
  const need = gross !== null ? Number(gross) / 10 ** decimals : 0;
  const payIndex = balances.findIndex((balance) => balance !== null && balance >= need);
  const chosen = collaterals[payIndex === -1 ? 0 : payIndex] ?? null;
  const symbol = chosen?.symbol ?? COLLATERAL.symbol;
  const known = balances.every((balance) => balance !== null);
  const wallet = known ? Math.max(...balances.map((balance) => balance ?? 0)) : null;
  const largest = balances.indexOf(wallet);
  const shownIndex = gross !== null && gross > 0n && payIndex !== -1 ? payIndex : largest === -1 ? 0 : largest;
  const shownBalance = balances[shownIndex] ?? null;
  const shownSymbol = collaterals[shownIndex]?.symbol ?? COLLATERAL.symbol;
  const charge = gross !== null && gross > 0n ? feeOf(gross, fee.bps, BigInt(fee.cap)) : null;
  const net = gross !== null && charge !== null ? gross - charge : null;
  const basketIssue = basketProblem(coins, backed, mates);
  const short = known && gross !== null && gross > 0n && payIndex === -1;
  const empty = amount.trim() === "";
  const problem = basketIssue ? basketIssue : gross === null || gross <= 0n ? "Enter an amount above zero." : short ? "Not enough USDC or rlUSD." : null;
  const intent: Intent | null = problem === null && gross !== null ? { operation: "epoch-entry", opensAt: epoch.opensAt, grossStake: gross.toString(), basket: entryBasket(coins, backed, mates), backedAsset: backed, collateralMint: collaterals.length > 1 && chosen ? chosen.mint : undefined } : null;
  const mode = basketMode(coins);
  const left = coins.filter((id) => id !== backed && !mates.includes(id));
  const listed = mode === "pick" ? mates : left;
  const preset = (dollars: number) => setAmount(String(dollars));
  const max = () => {
    if (wallet === null) return;
    setAmount(asText(parseScaled(wallet.toFixed(decimals), decimals) ?? 0n, decimals));
  };

  return (
    <section className="flex flex-col rounded-[24px] bg-surface">
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <Layers size={20} aria-hidden="true" className="text-accent" />
            <span className="text-base font-semibold">Entry</span>
            <span className="text-base text-muted">{`${backed} + ${mates.length}`}</span>
          </span>
          <button type="button" onClick={props.onClear} className="cursor-pointer text-sm font-medium text-ink transition-colors duration-150 hover:text-accent">
            Clear all
          </button>
        </div>
        <ul className="flex max-h-72 flex-col gap-4 overflow-y-auto pr-1">
          <PickRow id={backed} detail="Performer" change={props.move} onRemove={props.onClear} label={`Remove ${backed} and start over`} />
          {listed.map((id) => (
            <PickRow key={id} id={id} detail={mode === "pick" ? "In basket" : "Left out of basket"} onRemove={() => props.onToggle(id)} label={mode === "pick" ? `Remove ${id}` : `Put ${id} back`} />
          ))}
        </ul>
      </div>

      <div className="border-t border-dashed border-white/10" />

      <div className="flex flex-col gap-5 p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="epoch-stake" className="text-base font-semibold">
              Available Amount
            </label>
            {owner && <span className="num text-sm text-muted">{shownBalance === null ? "…" : `${shownBalance.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${shownSymbol}`}</span>}
          </div>
          <span className="flex min-w-0 items-baseline text-5xl font-semibold">
            <span className={amount ? "text-ink" : "text-muted"}>$</span>
            <input id="epoch-stake" inputMode="decimal" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} size={Math.max(1, amount.length)} className="num w-auto min-w-[1ch] max-w-[6ch] bg-transparent text-right text-ink outline-none placeholder:text-muted" />
          </span>
        </div>
        {!empty && (gross === null || gross <= 0n) && <p className="-mt-3 text-right text-xs text-down">Enter an amount above zero.</p>}

        <div className="grid grid-cols-4 gap-1 text-base font-medium">
          {QUICK.map((value) => (
            <button key={value} type="button" onClick={() => preset(value)} aria-pressed={amount === String(value)} className="h-10 cursor-pointer rounded-control text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink aria-pressed:bg-surface-2 aria-pressed:text-ink">
              ${value}
            </button>
          ))}
          <button type="button" onClick={max} disabled={wallet === null} className="h-10 cursor-pointer rounded-control text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40">
            Max
          </button>
        </div>

        <div className="flex items-center justify-between gap-4">
          {net !== null && gross !== null && gross > 0n ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="num whitespace-nowrap text-xl font-semibold">{money(net, decimals)}</span>
              <PotHelp gross={gross} charge={charge} net={net} decimals={decimals} fee={fee} />
            </div>
          ) : (
            <span />
          )}
          <div className="min-w-0 max-w-44 flex-1">
            {owner && short ? (
              <Link href="/faucet" className={`grid h-12 w-full place-items-center rounded-2xl ${gradient} text-base font-semibold text-white`}>
                Deposit
              </Link>
            ) : owner ? (
              <SendButton
                intent={intent}
                label={basketIssue ? "Finish basket" : empty ? "Enter amount" : "Enter round"}
                quiet
                connectLabel="Connect wallet"
                problem={empty || basketIssue ? "" : problem}
                describe={`${backed} Epoch entry of ${amount} ${symbol}`}
                onDone={() => {
                  setAmount("");
                  setSent((count) => count + 1);
                  props.onSent();
                }}
                className={`h-12 w-full rounded-2xl ${gradient} text-base font-semibold text-white`}
              />
            ) : (
              <button type="button" onClick={openLogin} className={`h-12 w-full cursor-pointer rounded-2xl ${gradient} text-base font-semibold text-white`}>
                Log in
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
