export const EPOCH_SECONDS = 14_400;
export const EPOCH_FEE_BPS = 2n;
export const EPOCH_FEE_CAP_BASE_UNITS = 200_000n;
export const MAX_EXACT_SIMULATION_ENTRIES = 16;
const MAX_AMOUNT = (1n << 64n) - 1n;
const MAX_REFERENCE = (1n << 127n) - 1n;

export interface Fraction { readonly numerator: bigint; readonly denominator: bigint }
export interface SimulatedEpochEntry {
  readonly id: string;
  readonly grossStake: bigint;
  readonly executedAt: number;
  readonly backedAsset: string;
  readonly basket: readonly string[];
  readonly references: ReadonlyMap<string, bigint>;
}
export interface EpochSimulation {
  readonly opensAt: number;
  readonly closesAt: number;
  readonly universe: ReadonlySet<string>;
  readonly entries: readonly SimulatedEpochEntry[];
  readonly closingReferences: ReadonlyMap<string, bigint>;
}
export interface SimulatedEpochReceipt {
  readonly id: string;
  readonly score: Fraction;
  readonly payout: bigint;
  readonly refund: bigint;
  readonly committedFee: bigint;
}
export interface SimulatedEpochResult {
  readonly outcome: "settled" | "all-zero-refund";
  readonly receipts: readonly SimulatedEpochReceipt[];
  readonly grossStake: bigint;
  readonly availablePot: bigint;
  readonly committedFees: bigint;
  readonly residual: bigint;
}

function fraction(numerator: bigint, denominator: bigint): Fraction {
  if (numerator < 0n || denominator <= 0n) throw new Error("InvalidFraction");
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}
function add(a: Fraction, b: Fraction): Fraction {
  return fraction(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}
function reference(values: ReadonlyMap<string, bigint>, asset: string): bigint {
  const value = values.get(asset);
  if (value === undefined || value <= 0n || value > MAX_REFERENCE) throw new Error("InvalidReference:" + asset);
  return value;
}
export function epochFee(gross: bigint): bigint {
  if (gross <= 0n || gross > MAX_AMOUNT) throw new Error("InvalidStake");
  const proportional = gross * EPOCH_FEE_BPS / 10_000n;
  return proportional < EPOCH_FEE_CAP_BASE_UNITS ? proportional : EPOCH_FEE_CAP_BASE_UNITS;
}
export function simulateEpoch(input: EpochSimulation): SimulatedEpochResult {
  if (!Number.isSafeInteger(input.opensAt) || input.opensAt < 0 || input.opensAt % EPOCH_SECONDS !== 0
      || !Number.isSafeInteger(input.closesAt) || input.closesAt !== input.opensAt + EPOCH_SECONDS) throw new Error("InvalidEpochBoundary");
  if (input.universe.size < 30 || input.entries.length === 0 || input.entries.length > MAX_EXACT_SIMULATION_ENTRIES) throw new Error("InvalidSimulationSize");
  const ids = new Set<string>();
  let grossStake = 0n;
  let heldFees = 0n;
  const zero = fraction(0n, 1n);
  const evaluated = input.entries.map(entry => {
    if (!entry.id || ids.has(entry.id)) throw new Error("DuplicateEntry");
    ids.add(entry.id);
    if (!Number.isSafeInteger(entry.executedAt) || entry.executedAt < input.opensAt || entry.executedAt >= input.closesAt) throw new Error("IneligibleEntryTime");
    if (entry.basket.length !== 30 || new Set(entry.basket).size !== 30 || !entry.basket.includes(entry.backedAsset)
        || entry.basket.some(asset => !input.universe.has(asset))) throw new Error("InvalidBasket");
    const fee = epochFee(entry.grossStake);
    grossStake += entry.grossStake;
    heldFees += fee;
    if (grossStake > MAX_AMOUNT) throw new Error("PotOverflow");
    let sum = zero;
    let backed = zero;
    for (const asset of entry.basket) {
      const start = reference(entry.references, asset);
      const end = reference(input.closingReferences, asset);
      const positive = fraction(end > start ? end - start : 0n, start);
      sum = add(sum, positive);
      if (asset === entry.backedAsset) backed = positive;
    }
    const score = sum.numerator === 0n ? zero
      : fraction(backed.numerator * sum.denominator, backed.denominator * sum.numerator);
    const weight = fraction((entry.grossStake - fee) * score.numerator, score.denominator);
    return { entry, fee, score, weight };
  });
  const totalWeight = evaluated.reduce((sum, value) => add(sum, value.weight), zero);
  if (totalWeight.numerator === 0n) return {
    outcome: "all-zero-refund", grossStake, availablePot: 0n, committedFees: 0n, residual: 0n,
    receipts: evaluated.map(({ entry, score }) => ({ id: entry.id, score, payout: 0n, refund: entry.grossStake, committedFee: 0n })),
  };
  const availablePot = grossStake - heldFees;
  const receipts = evaluated.map(({ entry, fee, score, weight }) => ({
    id: entry.id, score, refund: 0n, committedFee: fee,
    payout: availablePot * weight.numerator * totalWeight.denominator / (weight.denominator * totalWeight.numerator),
  }));
  return { outcome: "settled", grossStake, availablePot, committedFees: heldFees, receipts,
    residual: availablePot - receipts.reduce((sum, receipt) => sum + receipt.payout, 0n) };
}

export function amplifiedEpochChange(entryReference: bigint, currentReference: bigint, sensitivity: bigint, scale = 1_000_000_000_000n): bigint {
  if (entryReference <= 0n || currentReference <= 0n || sensitivity < 1n || sensitivity > 100n || scale <= 0n) throw new Error("InvalidChartSensitivity");
  return (currentReference - entryReference) * scale * sensitivity / entryReference;
}
