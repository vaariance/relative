import type { Epoch, EpochLot } from "@eox/app-api";

export const SCORE_DIGITS = 12;

export type Stage = "upcoming" | "open" | "closing" | "scoring" | "allocating" | "settled" | "voided";

export function stageOf(epoch: Epoch, now: number): Stage {
  if (epoch.phase === "voided") return "voided";
  if (epoch.phase === "settled") return "settled";
  if (epoch.phase === "scoring") return "scoring";
  if (epoch.phase === "allocating") return "allocating";
  if (epoch.phase === "draft" || now < epoch.opensAt) return "upcoming";
  if (now < epoch.closesAt) return "open";
  return "closing";
}

export const STAGE_LABEL: Record<Stage, string> = {
  upcoming: "Scheduled",
  open: "Open",
  closing: "Closing",
  scoring: "Scoring",
  allocating: "Allocating payouts",
  settled: "Settled",
  voided: "Refunded",
};

export const TIMELINE = ["Open", "Closing reference", "Scoring", "Allocating payouts", "Withdrawable"] as const;

export function timelineStep(stage: Stage): number {
  return { upcoming: -1, open: 0, closing: 1, scoring: 2, allocating: 3, settled: 4, voided: -1 }[stage];
}

export interface Move {
  id: string;
  change: number | null;
}

export function moves(ids: readonly string[], start: Record<string, number> | null, end: Record<string, number> | null): Move[] {
  return ids
    .map((id) => {
      const from = start?.[id];
      const to = end?.[id];
      return { id, change: from && to && from > 0 ? to / from - 1 : null };
    })
    .sort((a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity) || a.id.localeCompare(b.id));
}

export function scoreOf(lot: EpochLot): number | null {
  return lot.score === null ? null : Number(BigInt(lot.score)) / 10 ** SCORE_DIGITS;
}

export function units(value: string, decimals: number): number {
  return Number(BigInt(value)) / 10 ** decimals;
}

export function feeOf(gross: bigint, bps: number, cap: bigint): bigint {
  const fee = (gross * BigInt(bps)) / 10_000n;
  return fee > cap ? cap : fee;
}

export type LotGroup = "pending" | "active" | "withdrawable" | "history";

export interface LotView {
  group: LotGroup;
  label: string;
  refund: boolean;
}

export function lotView(lot: EpochLot, epoch: Epoch | null): LotView {
  const refund = epoch?.phase === "voided" || epoch?.allZero === true || lot.execution === null;
  const owed = lot.claimable !== null && BigInt(lot.claimable) > 0n;
  if (lot.state === "withdrawn") return { group: "history", label: "Withdrawn", refund };
  if (owed) return { group: "withdrawable", label: refund ? "Refund withdrawable" : "Payout withdrawable", refund };
  if (lot.state === "claimable") return { group: "history", label: "Settled · no payout", refund };
  if (epoch?.phase === "voided") return { group: "pending", label: "Awaiting refund", refund: true };
  if (lot.state === "pending") return { group: "pending", label: "Awaiting execution", refund };
  if (lot.state === "scored") return { group: "active", label: "Scored", refund };
  return { group: "active", label: "Active", refund };
}

export function countdown(seconds: number): string {
  const left = Math.max(0, Math.floor(seconds));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function utcTime(at: number, seconds = false): string {
  return new Date(at * 1000).toUTCString().slice(17, seconds ? 25 : 22);
}

export function windowText(epoch: Epoch): string {
  const day = new Date(epoch.opensAt * 1000).toUTCString().slice(5, 11);
  return `${day} · ${utcTime(epoch.opensAt)}–${utcTime(epoch.closesAt)} UTC`;
}
