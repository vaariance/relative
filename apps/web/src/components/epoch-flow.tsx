"use client";

import { EPOCH_BASKET_SIZE, type Epoch, type EpochOverview } from "@eox/app-api";
import { ChevronLeft, ChevronRight, Trophy } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { type Move, TEAMMATES, basketMode, basketProblem, epochBasket, marketClosedReason, mateLocked, stageOf } from "@/lib/epoch";
import { collateralsOf } from "@/lib/market";
import { useAccount } from "./account";
import { CoinIcon } from "./coin-icon";
import { EntryTicket } from "./epoch-ticket";
import { useEpochPicks } from "./epoch-picks";
import { CoinBadge, EntryClosed, card, ordered, pct, pickDefault, primary, tone, useNow, useRoundMoves } from "./epoch-shared";
import { openLogin } from "./signer";

export function entryRound(epochs: readonly Epoch[], now: number): Epoch | null {
  return epochs.find((epoch) => stageOf(epoch, now) === "open" && epoch.entriesOpen) ?? null;
}

function basketStatus(coins: string[], backed: string, mates: string[]): { text: string; ready: boolean } {
  if (basketProblem(coins, backed, mates) === null) return { text: "Basket ready", ready: true };
  return { text: `Pick ${TEAMMATES - mates.length} more`, ready: false };
}

export function PerformerPrompt({ epoch, coins, now, next, marketClosed, active, onSelect }: { epoch: Epoch; coins: string[]; now: number; next: Epoch | null; marketClosed: string | null; active: boolean; onSelect: (address: string) => void }) {
  const picks = useEpochPicks(epoch, coins);
  const open = active && marketClosed === null && stageOf(epoch, now) === "open" && epoch.entriesOpen;
  const { rows } = useRoundMoves(epoch, coins, now);

  if (!open) {
    return (
      <section className={`${card} flex flex-col items-center gap-4 px-6 py-12 text-center`}>
        <Trophy size={32} aria-hidden="true" className="text-white/15" />
        <h2 className="max-w-md text-xl font-semibold">Which performer do you think will beat the market?</h2>
        <div className="max-w-lg">
          <EntryClosed epoch={epoch} now={now} next={next} marketClosed={marketClosed} onSelect={onSelect} />
        </div>
      </section>
    );
  }

  if (!picks.ready) return <section aria-busy="true" aria-label="Loading your entry" className={`${card} min-h-[18rem] animate-pulse`} />;

  if (picks.backed) {
    const status = basketStatus(coins, picks.backed, picks.mates);
    const move = rows.find((row) => row.id === picks.backed)?.change ?? null;
    return (
      <section className={`${card} flex flex-col gap-5 p-6 sm:flex-row sm:items-center`}>
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <CoinIcon id={picks.backed} size={44} />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-muted">Your performer</span>
            <span className="flex items-baseline gap-2">
              <span className="text-xl font-semibold">{picks.backed}</span>
              <span className={`num text-sm ${tone(move)}`}>{pct(move, 2)}</span>
            </span>
            <span className={`text-xs ${status.ready ? "text-up" : "text-muted"}`}>{status.text}</span>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:w-64">
          <Link href="/epochs/basket" className={`${primary} cursor-pointer`}>
            Continue your entry <ChevronRight size={16} aria-hidden="true" />
          </Link>
          <button type="button" onClick={picks.clear} className="h-9 cursor-pointer text-xs text-muted hover:text-ink">
            Start over
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={`${card} flex flex-col items-center gap-4 px-6 py-14 text-center`}>
      <span className="grid size-14 place-items-center rounded-full bg-accent/10">
        <Trophy size={26} aria-hidden="true" className="text-accent" />
      </span>
      <h2 className="max-w-md text-xl font-semibold">Which performer do you think will beat the market?</h2>
      <p className="max-w-md text-sm text-muted">Pick your performer then curate a basket around it.</p>
      <Link href="/epochs/pick" className={`${primary} mt-2 max-w-xs cursor-pointer`}>
        Pick your performer <ChevronRight size={16} aria-hidden="true" />
      </Link>
    </section>
  );
}

function StepHeader({ step, title, text, back }: { step: number; title: string; text: string; back: { href: string; label: string } }) {
  return (
    <header className="flex flex-col gap-3">
      <Link href={back.href} className="group flex w-fit items-center gap-2 text-sm text-muted transition-colors duration-150 hover:text-ink">
        <span className="grid size-8 place-items-center rounded-full bg-surface-2 text-ink transition-colors duration-150 group-hover:bg-white/15">
          <ChevronLeft size={16} aria-hidden="true" />
        </span>
        {back.label}
      </Link>
      <div className="flex items-center gap-2 text-xs">
        {[1, 2].map((item) => (
          <span key={item} className={`h-1 w-10 rounded-pill ${item <= step ? "bg-accent" : "bg-surface-2"}`} />
        ))}
        <span className="ml-1 text-muted">Step {step} of 2</span>
      </div>
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted">{text}</p>
    </header>
  );
}

function useFlow(overview: EpochOverview, roster: string[], serverNow: number) {
  const now = useNow(serverNow);
  const epochs = useMemo(() => [...overview.epochs].sort((a, b) => a.opensAt - b.opensAt), [overview.epochs]);
  const epoch = entryRound(epochs, now);
  const shown = epoch ?? epochs.find((item) => item.address === pickDefault(epochs, serverNow)) ?? epochs[0]!;
  const basket = epochBasket(shown);
  const coins = basket.length > 0 ? basket : roster;
  const marketClosed = marketClosedReason(overview.configuration);
  const next = epochs.find((item) => stageOf(item, now) === "upcoming") ?? null;
  return { now, epoch: overview.configuration.lifecycle === "active" && marketClosed === null ? epoch : null, shown, coins, marketClosed, next };
}

export function PickPerformerView({ overview, roster, serverNow }: { overview: EpochOverview; roster: string[]; serverNow: number }) {
  const router = useRouter();
  const { owner } = useAccount();
  const { now, epoch, shown, coins, marketClosed, next } = useFlow(overview, roster, serverNow);
  const picks = useEpochPicks(epoch, coins);
  const { rows } = useRoundMoves(shown, coins, now);
  const pick = (id: string) => {
    if (!owner) return openLogin();
    picks.setPerformer(id);
    router.push("/epochs/basket");
  };

  return (
    <div className="flex flex-col gap-5">
      <StepHeader step={1} title="Pick your performer" text="The asset you think will beat the market this round." back={{ href: "/epochs", label: "Epoch" }} />
      {!epoch && (
        <section className={`${card} p-5`}>
          <EntryClosed epoch={shown} now={now} next={next} marketClosed={marketClosed} onSelect={() => router.push("/epochs")} />
        </section>
      )}
      <CoinGrid
        rows={rows}
        count={`${rows.length} coins in this round`}
        selected={(id) => picks.backed === id}
        label={(id) => `Pick ${id} as your performer`}
        onPick={epoch ? pick : undefined}
      />
    </div>
  );
}

export function BasketView({ overview, roster, serverNow }: { overview: EpochOverview; roster: string[]; serverNow: number }) {
  const router = useRouter();
  const { market } = useAccount();
  const { now, epoch, shown, coins } = useFlow(overview, roster, serverNow);
  const picks = useEpochPicks(epoch, coins);
  const { rows } = useRoundMoves(shown, coins, now);
  const collaterals = useMemo(() => collateralsOf(overview.configuration), [overview.configuration]);

  useEffect(() => {
    if (picks.ready && (!epoch || !picks.backed)) router.replace(epoch ? "/epochs/pick" : "/epochs");
  }, [picks.ready, picks.backed, epoch, router]);

  if (!epoch || !picks.backed) return <p className="py-16 text-center text-sm text-muted">Loading your entry…</p>;

  const backed = picks.backed;
  const mode = basketMode(coins);
  const status = basketStatus(coins, backed, picks.mates);
  const move = rows.find((row) => row.id === backed)?.change ?? null;
  const full = picks.mates.length >= TEAMMATES;
  const title = mode === "fixed" ? `Your basket of ${EPOCH_BASKET_SIZE}` : "Review your basket";
  const text = mode === "fixed" ? `${backed} is compared against the other ${TEAMMATES} coins in this round.` : `We filled your basket with ${TEAMMATES} coins to go with ${backed}. Swap any of them, or enter as it is.`;

  return (
    <div className="flex flex-col gap-5 pb-24 xl:pb-0">
      <StepHeader step={2} title={title} text={text} back={{ href: "/epochs/pick", label: "Change performer" }} />
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_350px]">
        <CoinGrid
          rows={rows.filter((row) => row.id !== backed)}
          count={mode === "fixed" ? `All ${TEAMMATES} coins in` : `${picks.mates.length} of ${TEAMMATES} in your basket`}
          hint={mode === "pick" && full ? "Remove a coin to add another." : undefined}
          action={mode === "pick" && picks.edited ? { label: "Reset basket", onClick: picks.resetBasket } : undefined}
          checkbox
          selected={(id) => mode === "fixed" || picks.mates.includes(id)}
          disabled={(id) => mateLocked(coins, picks.mates, id)}
          label={(id) => (picks.mates.includes(id) ? `Remove ${id} from your basket` : `Add ${id} to your basket`)}
          onPick={mode === "fixed" ? undefined : picks.toggleBasket}
        />

        <aside id="epoch-stake-panel" className="min-w-0 xl:sticky xl:top-6">
          <EntryTicket
            epoch={epoch}
            coins={coins}
            backed={backed}
            mates={picks.mates}
            move={move}
            decimals={market.decimals || 6}
            fee={overview.configuration.entryFee}
            collaterals={collaterals}
            onClear={() => {
              picks.clear();
              router.push("/epochs/pick");
            }}
            onSent={() => {
              picks.clear();
              router.push("/epochs");
            }}
          />
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/[0.06] bg-bg/95 p-3 xl:hidden">
        <button type="button" onClick={() => document.getElementById("epoch-stake-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })} className={`${primary} cursor-pointer`}>
          {status.ready ? `Stake on ${backed}` : `${backed} · ${status.text}`} <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function useSteadyOrder(rows: Move[]): Move[] {
  const [order, setOrder] = useState<string[]>([]);
  const ids = rows.map((row) => row.id).sort().join(",");
  const priced = rows.some((row) => row.change !== null);
  const [key, setKey] = useState("");
  const next = `${ids}|${priced}`;
  if (next !== key) {
    setKey(next);
    setOrder(ordered(rows, "strong").map((row) => row.id));
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return order.map((id) => byId.get(id)).filter((row): row is Move => row !== undefined);
}

function CoinGrid({ rows, count, hint, action, checkbox = false, selected, disabled, label, onPick }: { rows: Move[]; count: string; hint?: string; action?: { label: string; onClick: () => void }; checkbox?: boolean; selected: (id: string) => boolean; disabled?: (id: string) => boolean; label?: (id: string) => string; onPick?: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const term = query.trim().toUpperCase();
  const shown = useSteadyOrder(rows).filter((row) => row.id.toUpperCase().includes(term));

  return (
    <section className={`${card} flex flex-col gap-4 p-4 sm:p-5`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex flex-col gap-0.5">
          <span className="num text-sm font-medium">{count}</span>
          {hint && <span className="text-xs text-muted">{hint}</span>}
        </span>
        {action && (
          <button type="button" onClick={action.onClick} className="h-9 cursor-pointer rounded-control px-3 text-xs font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink">
            {action.label}
          </button>
        )}
        {onPick && rows.length > 12 && (
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search coins" aria-label="Search coins" className="ml-auto h-9 min-w-0 flex-1 rounded-control border border-line bg-bg px-3 text-xs text-ink placeholder:text-muted sm:max-w-64" />
        )}
      </div>
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{term ? `No coin matches “${query.trim()}”.` : "No coins in this round yet."}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          {shown.map((row) => (
            <li key={row.id}>
              <CoinBadge id={row.id} change={row.change} selected={selected(row.id)} disabled={disabled?.(row.id)} checkbox={checkbox} onClick={onPick ? () => onPick(row.id) : undefined} label={label?.(row.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
