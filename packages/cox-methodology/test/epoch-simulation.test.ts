import { test } from "node:test";
import assert from "node:assert/strict";
import { amplifiedEpochChange, epochFee, simulateEpoch, type EpochSimulation, type SimulatedEpochEntry } from "../src/epoch-simulation.ts";

const assets = Array.from({ length: 31 }, (_, i) => "asset" + i);
const basket = assets.slice(0, 30);
const refs = (values: Readonly<Record<string, bigint>> = {}) => new Map(assets.map(asset => [asset, values[asset] ?? 100n]));
const entry = (id: string, overrides: Partial<SimulatedEpochEntry> = {}): SimulatedEpochEntry => ({
  id, grossStake: 10_000_000n, executedAt: 1, backedAsset: assets[0]!, basket, references: refs(), ...overrides,
});
const input = (entries: readonly SimulatedEpochEntry[], overrides: Partial<EpochSimulation> = {}): EpochSimulation => ({
  opensAt: 0, closesAt: 14_400, universe: new Set(assets), entries,
  closingReferences: refs({ asset0: 110n, asset1: 120n }), ...overrides,
});

test("Epoch proportional scoring uses exact fractions and one provisional fee per lot", () => {
  const result = simulateEpoch(input([entry("a"), entry("b", { backedAsset: assets[1]! })]));
  assert.equal(result.outcome, "settled");
  assert.deepEqual(result.receipts.map(r => r.score), [{ numerator: 1n, denominator: 3n }, { numerator: 2n, denominator: 3n }]);
  assert.deepEqual(result.receipts.map(r => r.payout), [6_665_333n, 13_330_666n]);
  assert.equal(result.committedFees, 4_000n);
  assert.equal(result.residual, 1n);
  assert.equal(result.receipts.reduce((s, r) => s + r.payout, 0n) + result.residual + result.committedFees, result.grossStake);
});
test("Epoch fee is 2 bps capped at 0.20 with six collateral decimals", () => {
  assert.equal(epochFee(10_000_000n), 2_000n);
  assert.equal(epochFee(1_000_000_000n), 200_000n);
  assert.equal(epochFee(10_000_000_000n), 200_000n);
  assert.equal(epochFee(1n), 0n);
  assert.throws(() => epochFee(0n), /InvalidStake/);
});
test("all zero scores return full principal including every held fee", () => {
  const result = simulateEpoch(input([entry("a"), entry("b")], { closingReferences: refs() }));
  assert.equal(result.outcome, "all-zero-refund");
  assert.equal(result.committedFees, 0n);
  assert.equal(result.receipts.reduce((s, r) => s + r.refund, 0n), result.grossStake);
  const zeroBacked = simulateEpoch(input([entry("a", { backedAsset: assets[2]! })]));
  assert.equal(zeroBacked.outcome, "all-zero-refund");
});
test("identical backed assets can have different scores from baskets and entry references", () => {
  const result = simulateEpoch(input([
    entry("original"),
    entry("different-basket", { basket: [assets[0]!, ...assets.slice(2)] }),
    entry("later-lot", { executedAt: 10_000, references: refs({ asset0: 110n }) }),
  ]));
  assert.deepEqual(result.receipts.map(r => r.score), [
    { numerator: 1n, denominator: 3n }, { numerator: 1n, denominator: 1n }, { numerator: 0n, denominator: 1n },
  ]);
  assert.equal(result.receipts[2]!.payout, 0n);
});
test("execution is strictly before closing and basket members come from frozen universe", () => {
  for (const invalid of [
    entry("a", { executedAt: 14_400 }), entry("a", { executedAt: -1 }),
    entry("a", { basket: basket.slice(1) }), entry("a", { basket: Array(30).fill(assets[0]) }),
    entry("a", { backedAsset: "absent" }), entry("a", { basket: [...basket.slice(0, 29), "unlisted"] }),
  ]) assert.throws(() => simulateEpoch(input([invalid])), /IneligibleEntryTime|InvalidBasket/);
  assert.throws(() => simulateEpoch(input([entry("a"), entry("a")])), /DuplicateEntry/);
  assert.throws(() => simulateEpoch(input([entry("a")], { closesAt: 14_401 })), /InvalidEpochBoundary/);
  assert.throws(() => simulateEpoch(input([entry("a", { references: refs({ asset0: 0n }) })])), /InvalidReference/);
});
test("quiet tiny moves can allocate the full pot and crowded winners need not profit", () => {
  const highRefs = new Map(assets.map(asset => [asset, 1_000_000_000_000n]));
  const closing = new Map(highRefs);
  closing.set(assets[0]!, 1_000_000_000_001n);
  const result = simulateEpoch(input([entry("a", { references: highRefs }), entry("b", { references: highRefs })], { closingReferences: closing }));
  assert.equal(result.outcome, "settled");
  for (const receipt of result.receipts) {
    assert.equal(receipt.score.numerator, receipt.score.denominator);
    assert.ok(receipt.payout < 10_000_000n);
  }
});
test("chart sensitivity changes displayed signal only and never changes settlement inputs", () => {
  assert.equal(amplifiedEpochChange(100_000n, 100_150n, 20n), 30_000_000_000n);
  assert.equal(amplifiedEpochChange(100n, 90n, 10n), -1_000_000_000_000n);
  const state = input([entry("a")]);
  const before = simulateEpoch(state);
  amplifiedEpochChange(100n, 110n, 10n);
  assert.deepEqual(simulateEpoch(state), before);
});
