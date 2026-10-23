import type { Epoch, EpochLot, EpochPhase } from "@eox/app-api";

export const SCORE_DIGITS = 12;

export type Stage = "upcoming" | "live" | "closing" | "settled" | "voided";

export function stageOf(epoch: Epoch, now: number): Stage {
  if (epoch.phase === "voided") return "voided";
  if (epoch.phase === "settled") return "settled";
  if (epoch.phase === "scoring" || epoch.phase === "allocating") return "closing";
  if (epoch.phase === "draft") return "upcoming";
  if (now < epoch.opensAt) return "upcoming";
  if (now < epoch.closesAt) return "live";
  return "closing";
}

export const STAGE_LABEL: Record<Stage, string> = {
  upcoming: "Next",
  live: "Live",
  closing: "Closed",
  settled: "Settled",
  voided: "Refunded",
};

export const PHASE_NOTE: Record<EpochPhase, string> = {
  draft: "Not open yet. It takes entries from its start time.",
  open: "Taking entries until it closes.",
  scoring: "Closed. Scores are being worked out.",
  allocating: "Closed. Payouts are being shared out.",
  settled: "Finished. Winners can withdraw.",
  voided: "Cancelled. Every stake can be withdrawn in full.",
};

export interface BoardRow {
  id: string;
  change: number | null;
  share: number;
}

export function shareBoard(ids: readonly string[], start: Record<string, number> | null, end: Record<string, number> | null): BoardRow[] {
  const gains = ids.map((id) => {
    const from = start?.[id];
    const to = end?.[id];
    const change = from && to && from > 0 ? to / from - 1 : null;
    return { id, change, gain: change !== null && change > 0 ? change : 0 };
  });
  const total = gains.reduce((sum, row) => sum + row.gain, 0);
  return gains
    .map(({ id, change, gain }) => ({ id, change, share: total > 0 ? gain / total : 0 }))
    .sort((a, b) => b.share - a.share || (b.change ?? -Infinity) - (a.change ?? -Infinity) || a.id.localeCompare(b.id));
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

export function lotStatus(lot: EpochLot, epoch: Epoch | null): string {
  if (lot.state === "withdrawn") return "Withdrawn";
  if (lot.state === "claimable") return epoch?.phase === "voided" ? "Refund ready" : "Ready to withdraw";
  if (epoch?.phase === "voided") return "Refund ready";
  if (lot.state === "pending") return "Waiting for its start price";
  if (lot.state === "executed") return "In play";
  return "Scored";
}

export function countdown(seconds: number): string {
  const left = Math.max(0, Math.floor(seconds));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

export function windowText(epoch: Epoch): string {
  const time = (at: number) => new Date(at * 1000).toUTCString().slice(17, 22);
  const day = new Date(epoch.opensAt * 1000).toUTCString().slice(5, 11);
  return `${day} · ${time(epoch.opensAt)}–${time(epoch.closesAt)} UTC`;
}
