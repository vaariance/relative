"use client";

import { type Epoch, type PreviewHistory } from "@eox/app-api";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { ChevronRight, Clock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type Move, moves, refundStage, stageOf, utcTime, windowText } from "@/lib/epoch";
import { historyEstimates } from "@/lib/estimate";
import { formatAmount } from "@/lib/format";
import { useAccount } from "./account";
import { useLive } from "./live";

export const REFERENCE_DIGITS = 12;
export const PREVIEW_BASE = 100;
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const card = "min-w-0 rounded-[24px] border border-white/[0.06] bg-surface";
export const gradient = "bg-[linear-gradient(90deg,#f2622e,#ff8a4c)]";
export const primary = `flex h-11 w-full items-center justify-center gap-2 rounded-pill ${gradient} text-sm font-medium text-white`;
export const well = "rounded-xl bg-bg/70 p-3";

export function useNow(start: number): number {
  const [now, setNow] = useState(start);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function pct(value: number | null, digits = 3): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatAmount(Math.abs(value) * 100, digits)}%`;
}

export function tone(value: number | null): string {
  return value === null || value === 0 ? "text-muted" : value > 0 ? "text-up" : "text-down";
}

export function pickDefault(epochs: readonly Epoch[], now: number): string | null {
  const open = epochs.find((epoch) => stageOf(epoch, now) === "open");
  const next = epochs.find((epoch) => stageOf(epoch, now) === "upcoming");
  const last = [...epochs].reverse().find((epoch) => stageOf(epoch, now) !== "upcoming");
  return (open ?? next ?? last ?? epochs[0])?.address ?? null;
}

export function useOpeningReferences(epoch: Epoch | null, now: number): Record<string, number> | null | undefined {
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
  return held && held.key === opensAt ? held.references : undefined;
}

export function useWalletCollateral(mint: string | null, decimals: number, refreshKey: number): number | null {
  const { connection } = useConnection();
  const { owner } = useAccount();
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    setBalance(null);
    if (!owner || !mint) return;
    let current = true;
    const wallet = new PublicKey(owner);
    const account = PublicKey.findProgramAddressSync([wallet.toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
    connection
      .getAccountInfo(account)
      .then((info) => {
        if (!current) return;
        const amount = info && info.owner.equals(TOKEN_PROGRAM) && info.data.length === 165 ? new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(64, true) : 0n;
        setBalance(Number(amount) / 10 ** decimals);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [connection, owner, mint, decimals, refreshKey]);
  return balance;
}

export function closingMap(epoch: Epoch): Record<string, number> | null {
  if (epoch.closingReferences.length === 0) return null;
  return Object.fromEntries(epoch.closingReferences.map((item) => [item.assetId, (Number(BigInt(item.reference)) / 10 ** REFERENCE_DIGITS) * PREVIEW_BASE]));
}

export function ordered(rows: readonly Move[], order: "strong" | "weak" | "name"): Move[] {
  if (order === "name") return [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const sign = order === "strong" ? -1 : 1;
  return [...rows].sort((a, b) => (a.change === null ? 1 : b.change === null ? -1 : sign * (a.change - b.change)) || a.id.localeCompare(b.id));
}

export function useRoundMoves(epoch: Epoch, coins: string[], now: number): { rows: Move[]; opening: Record<string, number> | null | undefined; end: Record<string, number> | null } {
  const { estimate } = useLive();
  const stage = stageOf(epoch, now);
  const noResult = stage === "unopened" || stage === "empty" || refundStage(stage);
  const opening = useOpeningReferences(noResult ? null : epoch, now);
  const closing = useMemo(() => closingMap(epoch), [epoch]);
  const end = closing ?? (stage === "open" ? (estimate?.references ?? null) : null);
  return { rows: moves(coins, opening ?? null, end), opening, end };
}

export function EntryClosed({ epoch, now, next, marketClosed, onSelect }: { epoch: Epoch; now: number; next: Epoch | null; marketClosed: string | null; onSelect: (address: string) => void }) {
  const stage = stageOf(epoch, now);
  const other = next && next.address !== epoch.address ? next : null;
  const otherOpen = other !== null && stageOf(other, now) === "open" && other.entriesOpen;
  const reason =
    marketClosed ??
    (stage === "upcoming"
      ? `Entries open at ${utcTime(epoch.opensAt)} UTC.`
      : stage === "open"
        ? "This round is not taking entries right now."
        : other
          ? otherOpen
            ? `This round is closed. Entries are open in the ${windowText(other)} round.`
            : `This round is closed. The next one runs ${windowText(other)}.`
          : "This round is closed. No other round is open or scheduled.");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="flex items-start gap-2 text-sm text-muted">
        <Clock size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        {reason}
      </p>
      {other && marketClosed === null && stage !== "upcoming" && stage !== "open" && (
        <button type="button" onClick={() => onSelect(other.address)} className="flex h-9 shrink-0 cursor-pointer items-center gap-1 rounded-pill bg-surface-2 px-4 text-xs transition-colors duration-150 hover:bg-white/10">
          {otherOpen ? "Go to the open round" : "Show the next round"} <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
