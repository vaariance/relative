"use client";

import { EPOCH_BASKET_SIZE, type Epoch, type EpochOverview } from "@eox/app-api";
import { Check, ChevronLeft, ChevronRight, Trophy } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { TEAMMATES, basketMode, basketProblem, epochBasket, leaveOutCount, marketClosedReason, mateLocked, stageOf, windowText } from "@/lib/epoch";
import { collateralsOf } from "@/lib/market";
import { useAccount } from "./account";
import { CoinIcon } from "./coin-icon";
import { AssetRows, useEpochSeries } from "./epoch-market";
import { EntryTicket } from "./epoch-ticket";
import { useEpochPicks } from "./epoch-picks";
import { EntryClosed, card, pct, pickDefault, primary, tone, useNow, useRoundMoves } from "./epoch-shared";
import { openLogin } from "./signer";

export function entryRound(epochs: readonly Epoch[], now: number): Epoch | null {
  return epochs.find((epoch) => stageOf(epoch, now) === "open" && epoch.entriesOpen) ?? null;
}

function basketStatus(coins: string[], backed: string, mates: string[]): { text: string; ready: boolean } {
  if (basketProblem(coins, backed, mates) === null) return { text: "Basket ready", ready: true };
  const mode = basketMode(coins);
  if (mode === "leave-out") return { text: `Leave out ${mates.length - TEAMMATES} more`, ready: false };
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
      <Link href={back.href} className="flex w-fit items-center gap-1 text-xs text-muted hover:text-ink">
        <ChevronLeft size={14} aria-hidden="true" /> {back.label}
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
  const series = useEpochSeries(shown, now);
  const pick = (id: string) => {
    if (!owner) return openLogin();
    picks.setPerformer(id);
    router.push("/epochs/basket");
  };

  return (
    <div className="flex flex-col gap-5">
      <StepHeader step={1} title="Pick your performer" text="The asset you think will beat the market this round. Moves are against the benchmark since the round opened." back={{ href: "/epochs", label: "Epoch" }} />
      {!epoch && (
        <section className={`${card} p-5`}>
          <EntryClosed epoch={shown} now={now} next={next} marketClosed={marketClosed} onSelect={() => router.push("/epochs")} />
        </section>
      )}
      <AssetRows
        rows={rows}
        series={series}
        title={epoch ? windowText(epoch) : "Assets in this round"}
        onRow={epoch ? (row) => pick(row.id) : undefined}
        rowLabel={(row) => `Pick ${row.id} as your performer, ${pct(row.change, 2)} against the benchmark`}
        action={(row) =>
          !epoch ? null : picks.backed === row.id ? (
            <span className="inline-flex h-8 items-center gap-1 rounded-pill bg-accent px-3 text-xs font-medium text-white">
              <Check size={12} strokeWidth={3} aria-hidden="true" /> Picked
            </span>
          ) : (
            <span className="inline-flex h-8 items-center rounded-pill bg-accent/15 px-3 text-xs font-medium text-accent">Pick</span>
          )
        }
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
  const series = useEpochSeries(shown, now);
  const collaterals = useMemo(() => collateralsOf(overview.configuration), [overview.configuration]);

  useEffect(() => {
    if (picks.ready && (!epoch || !picks.backed)) router.replace(epoch ? "/epochs/pick" : "/epochs");
  }, [picks.ready, picks.backed, epoch, router]);

  if (!epoch || !picks.backed) return <p className="py-16 text-center text-sm text-muted">Loading your entry…</p>;

  const backed = picks.backed;
  const mode = basketMode(coins);
  const leave = leaveOutCount(coins);
  const others = rows.filter((row) => row.id !== backed);
  const status = basketStatus(coins, backed, picks.mates);
  const move = rows.find((row) => row.id === backed)?.change ?? null;
  const title = mode === "fixed" ? `Your basket of ${EPOCH_BASKET_SIZE}` : mode === "leave-out" ? `Leave out ${leave} ${leave === 1 ? "coin" : "coins"}` : `Pick ${TEAMMATES} coins`;
  const text =
    mode === "fixed"
      ? `${backed} is compared against the other ${TEAMMATES} coins in this round.`
      : mode === "leave-out"
        ? `Your basket is ${backed} and every other coin except the ${leave === 1 ? "one" : leave} you leave out. Coins behind the benchmark at the close score zero, which raises ${backed}'s share.`
        : `Choose the ${TEAMMATES} coins ${backed} is compared against. Coins behind the benchmark at the close score zero, which raises ${backed}'s share.`;

  return (
    <div className="flex flex-col gap-5 pb-24 xl:pb-0">
      <StepHeader step={2} title={title} text={text} back={{ href: "/epochs/pick", label: "Change performer" }} />
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_350px]">
        <div className="min-w-0">
          <AssetRows
            rows={others}
            series={series}
            onRow={mode === "fixed" ? undefined : (row) => !mateLocked(coins, picks.mates, row.id) && picks.toggleBasket(row.id)}
            rowLabel={(row) => (picks.mates.includes(row.id) ? (mode === "pick" ? `Remove ${row.id}` : `Leave out ${row.id}`) : mode === "pick" ? `Add ${row.id}` : `Put ${row.id} back`)}
            action={(row) => {
              const included = picks.mates.includes(row.id);
              const locked = mateLocked(coins, picks.mates, row.id);
              if (mode === "fixed") return <span className="inline-flex h-8 items-center rounded-pill bg-surface-2 px-3 text-xs text-muted">In</span>;
              if (mode === "pick") return <span className={`inline-flex h-8 items-center gap-1 rounded-pill px-3 text-xs font-medium ${included ? "bg-accent text-white" : locked ? "bg-surface-2 text-muted/50" : "bg-surface-2 text-muted"}`}>{included ? <><Check size={12} strokeWidth={3} aria-hidden="true" /> Added</> : "Add"}</span>;
              return <span className={`inline-flex h-8 items-center rounded-pill px-3 text-xs font-medium ${included ? (locked ? "bg-surface-2 text-muted/50" : "bg-surface-2 text-ink") : "border border-dashed border-white/25 text-muted"}`}>{included ? "In" : "Left out"}</span>;
            }}
          />
        </div>

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
            onToggle={picks.toggleBasket}
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
