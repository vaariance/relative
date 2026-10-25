import { EPOCH_BASKET_SIZE, type Epoch, type EpochConfiguration, type EpochLot, type EpochOverview } from "@eox/app-api";

export const SCORE_DIGITS = 12;
const SCALE = 10n ** BigInt(SCORE_DIGITS);

export type Stage = "upcoming" | "unopened" | "open" | "closing" | "expired" | "scoring" | "allocating" | "settled" | "voided" | "empty";

export function stageOf(epoch: Epoch, now: number): Stage {
  if (epoch.phase === "voided") return "voided";
  if (epoch.phase === "empty") return "empty";
  if (epoch.phase === "settled") return "settled";
  if (epoch.phase === "scoring") return "scoring";
  if (epoch.phase === "allocating") return "allocating";
  if (epoch.phase === "draft") return now < epoch.opensAt ? "upcoming" : "unopened";
  if (now < epoch.opensAt) return "upcoming";
  if (now < epoch.closesAt) return "open";
  if (now > epoch.closingDeadline) return "expired";
  return "closing";
}

export function epochBasket(epoch: Epoch): string[] {
  const ids = epoch.universe.length > 0 ? epoch.universe.map((member) => member.assetId) : epoch.closingReferences.map((item) => item.assetId);
  return ids.filter((id) => !isUnnamedCoin(id));
}

export const TEAMMATES = EPOCH_BASKET_SIZE - 1;

const UNNAMED = /^#\d+$/;

export function isUnnamedCoin(id: string): boolean {
  return UNNAMED.test(id);
}

export interface EpochsSnapshot {
  overview: EpochOverview;
  fetchedAt: number;
}

export function latestEpochs(read: (EpochsSnapshot & { fresh: boolean }) | null, kept: EpochsSnapshot | null): { shown: EpochsSnapshot | null; staleSince: number | null } {
  if (read?.fresh) return { shown: read, staleSince: null };
  const shown = [read, kept].filter((item): item is EpochsSnapshot => item !== null).sort((a, b) => b.fetchedAt - a.fetchedAt)[0] ?? null;
  return { shown, staleSince: shown ? shown.fetchedAt : null };
}

export function defaultTeam(universe: readonly string[], backed: string): string[] {
  return universe.filter((id) => id !== backed).slice(0, TEAMMATES);
}

export function byMove(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export function leaveOutCount(universe: readonly string[]): number {
  return Math.max(0, universe.length - EPOCH_BASKET_SIZE);
}

export function leavesOut(universe: readonly string[]): boolean {
  return leaveOutCount(universe) <= TEAMMATES;
}

export function toggleMate(universe: readonly string[], backed: string, draft: readonly string[], id: string): string[] {
  if (id === backed || !universe.includes(id)) return [...draft];
  if (draft.includes(id)) {
    const out = universe.length - 1 - draft.length;
    if (leavesOut(universe) && out >= leaveOutCount(universe)) return [...draft];
    return draft.filter((item) => item !== id);
  }
  if (!leavesOut(universe) && draft.length >= TEAMMATES) return [...draft];
  return [...draft, id];
}

export function mateLocked(universe: readonly string[], draft: readonly string[], id: string): boolean {
  const on = draft.includes(id);
  if (leavesOut(universe)) return on && universe.length - 1 - draft.length >= leaveOutCount(universe);
  return !on && draft.length >= TEAMMATES;
}

export function entryBasket(universe: readonly string[], backed: string, mates: readonly string[]): string[] {
  return universe.filter((id) => id === backed || mates.includes(id));
}

export function basketProblem(universe: readonly string[], backed: string, mates: readonly string[]): string | null {
  if (universe.length < EPOCH_BASKET_SIZE) return "This Epoch's asset list is not available yet.";
  if (!universe.includes(backed) || mates.some((id) => id === backed || !universe.includes(id)) || new Set(mates).size !== mates.length) return "Your team has a coin that is not in this round.";
  if (mates.length < TEAMMATES) return `Add ${TEAMMATES - mates.length} more to your team.`;
  if (mates.length > TEAMMATES) return `Remove ${mates.length - TEAMMATES} from your team.`;
  return null;
}

export function heroRounds(epochs: readonly Epoch[], now: number): Epoch[] {
  const last = [...epochs].reverse().find((item) => ["settled", "allocating", "scoring"].includes(stageOf(item, now))) ?? null;
  const live = epochs.find((item) => stageOf(item, now) === "open") ?? epochs.find((item) => stageOf(item, now) === "upcoming") ?? null;
  return [last, live].filter((item): item is Epoch => item !== null);
}

export function refundStage(stage: Stage): boolean {
  return stage === "voided" || stage === "expired";
}

export const STAGE_LABEL: Record<Stage, string> = {
  upcoming: "Scheduled",
  unopened: "Not opened",
  open: "Open",
  closing: "Closing",
  expired: "Not closed",
  scoring: "Scoring",
  allocating: "Allocating payouts",
  settled: "Settled",
  voided: "Refunded",
  empty: "No entries",
};

export function marketClosedReason(configuration: EpochConfiguration): string | null {
  if (configuration.lifecycle === "preparing") return "Epoch is being set up. Entries open once it is ready.";
  if (configuration.lifecycle === "archived") return "Epoch has closed and takes no new entries. You can still withdraw payouts and refunds.";
  return null;
}

export const TIMELINE = ["Open", "Closing reference", "Scoring", "Allocating payouts", "Withdrawable"] as const;

export function timelineStep(stage: Stage): number {
  return { upcoming: -1, unopened: -1, open: 0, closing: 1, expired: -1, scoring: 2, allocating: 3, settled: 4, voided: -1, empty: -1 }[stage];
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

export function executionReferences(lot: EpochLot, base: number): Record<string, number> | null {
  const references = lot.execution?.references;
  if (!references || references.length !== lot.basket.length) return null;
  return Object.fromEntries(lot.basket.map((id, index) => [id, (Number(BigInt(references[index]!)) / 10 ** SCORE_DIGITS) * base]));
}

export function basketScore(entry: readonly bigint[], close: readonly bigint[], backedIndex: number): bigint | null {
  if (entry.length !== close.length || backedIndex < 0 || backedIndex >= entry.length) return null;
  let sum = 0n;
  let backed = 0n;
  for (let index = 0; index < entry.length; index += 1) {
    const from = entry[index]!;
    const to = close[index]!;
    if (from <= 0n || to <= 0n) return null;
    const rise = to > from ? ((to - from) * SCALE) / from : 0n;
    sum += rise;
    if (index === backedIndex) backed = rise;
  }
  return sum === 0n ? 0n : (backed * SCALE) / sum;
}

export function finalScore(lot: EpochLot, epoch: Epoch | null): bigint | null {
  if (lot.score !== null) return BigInt(lot.score);
  const references = lot.execution?.references;
  if (!epoch || !references || references.length !== lot.basket.length || epoch.closingReferences.length === 0) return null;
  const closing = new Map(epoch.closingReferences.map((item) => [item.assetId, BigInt(item.reference)]));
  const close: bigint[] = [];
  for (const id of lot.basket) {
    const value = closing.get(id);
    if (value === undefined) return null;
    close.push(value);
  }
  return basketScore(references.map((value) => BigInt(value)), close, lot.basket.indexOf(lot.backedAsset));
}

export function finalPayout(lot: EpochLot, epoch: Epoch | null): bigint | null {
  if (lot.claimable !== null) return BigInt(lot.claimable);
  if (lot.state !== "withdrawn") return null;
  const gross = BigInt(lot.grossStake);
  if (lot.execution === null || epoch?.phase === "voided") return gross;
  if (!epoch || (epoch.phase !== "allocating" && epoch.phase !== "settled")) return null;
  if (epoch.allZero) return gross;
  if (epoch.settlementPot === null || epoch.totalWeight === null) return null;
  const total = BigInt(epoch.totalWeight);
  const score = finalScore(lot, epoch);
  if (total === 0n || score === null) return null;
  return (BigInt(epoch.settlementPot) * (gross - BigInt(lot.fee)) * score) / total;
}

export function refundMint(mints: readonly string[], vaults: VaultBalances | null, owed: bigint): { mint?: string; index: number } | null {
  const source = withdrawSource(mints, vaults, owed);
  return source === null || source.amount !== undefined ? null : { mint: source.mint, index: source.index };
}

export interface VaultBalances {
  primary: bigint;
  secondary: bigint;
}

export interface WithdrawSource {
  mint?: string;
  amount?: string;
  index: number;
}

export function withdrawSource(mints: readonly string[], vaults: VaultBalances | null, owed: bigint): WithdrawSource | null {
  if (mints.length < 2 || vaults === null) return { index: 0 };
  if (vaults.primary >= owed) return { mint: mints[0], index: 0 };
  if (vaults.secondary >= owed) return { mint: mints[1], index: 1 };
  if (vaults.primary > 0n) return { mint: mints[0], amount: vaults.primary.toString(), index: 0 };
  if (vaults.secondary > 0n) return { mint: mints[1], amount: vaults.secondary.toString(), index: 1 };
  return null;
}

export function scoreOf(lot: EpochLot, epoch: Epoch | null = null): number | null {
  const score = finalScore(lot, epoch);
  return score === null ? null : Number(score) / 10 ** SCORE_DIGITS;
}

export function units(value: string | bigint, decimals: number): number {
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

export function lotView(lot: EpochLot, epoch: Epoch | null, now: number): LotView {
  const stage = epoch ? stageOf(epoch, now) : null;
  const afterClose = epoch !== null && now >= epoch.closesAt;
  const refund = lot.refund !== null || (stage !== null && refundStage(stage)) || epoch?.allZero === true || lot.execution === null;
  const owed = lot.claimable !== null && BigInt(lot.claimable) > 0n;
  if (lot.state === "withdrawn") return { group: "history", label: "Withdrawn", refund };
  if (lot.refund !== null) return { group: "withdrawable", label: "Refund ready", refund: true };
  if (owed) return { group: "withdrawable", label: refund ? "Refund withdrawable" : "Payout withdrawable", refund };
  if (lot.state === "claimable") return { group: "history", label: "Settled · no payout", refund };
  if (stage === "expired") return { group: "pending", label: "Round not closed", refund: true };
  if (stage === "voided") return { group: "pending", label: "Awaiting refund", refund: true };
  if (lot.state === "pending") return afterClose ? { group: "pending", label: "Not executed · refund due", refund: true } : { group: "pending", label: "Awaiting execution", refund };
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
