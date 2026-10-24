import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { assertMarketActive, currentEpochWindow, marketGenerationKey, marketLifecycle } from "../src/lifecycle.ts";

test("versioned lifecycle preserves legacy reads and rejects unsupported or closed admission", () => {
  assert.equal(marketLifecycle({ lifecycleVersion: 0, lifecycle: { preparing: {} } }), "active");
  assert.doesNotThrow(() => assertMarketActive({ lifecycleVersion: 1, lifecycle: { active: {} } }));
  assert.throws(() => assertMarketActive({ lifecycleVersion: 1, lifecycle: { preparing: {} } }), /MarketPreparing/);
  assert.throws(() => assertMarketActive({ lifecycleVersion: 1, lifecycle: { archived: {} } }), /MarketArchived/);
  assert.throws(() => marketLifecycle({ lifecycleVersion: 2, lifecycle: { active: {} } }), /UnsupportedLifecycleVersion/);
  assert.throws(() => marketLifecycle({ lifecycleVersion: 1, lifecycle: { active: {}, archived: {} } }), /InvalidLifecycleState/);
});

test("round boundaries do not depend on previous settlement or account creation", () => {
  assert.deepEqual(currentEpochWindow(1792832399n), { opensAt: 1792828800n, closesAt: 1792843200n });
  assert.deepEqual(currentEpochWindow(1792843200n), { opensAt: 1792843200n, closesAt: 1792857600n });
  assert.deepEqual(currentEpochWindow(1792843201n), currentEpochWindow(1792843200n));
  assert.throws(() => currentEpochWindow(-1n));
  assert.throws(() => currentEpochWindow((1n << 64n) - 1n));
});

test("generation cache identity isolates pool, config and registry without relying on symbols", () => {
  const key = (value: number) => new PublicKey(Uint8Array.from({ length: 32 }, () => value));
  const identity = { generation: Uint8Array.from({ length: 32 }, () => 1), assetRegistry: key(2), basicPool: key(3), epochConfig: key(4) };
  const first = marketGenerationKey(identity);
  assert.notEqual(first, marketGenerationKey({ ...identity, epochConfig: key(5) }));
  assert.notEqual(first, marketGenerationKey({ ...identity, generation: Uint8Array.from({ length: 32 }, () => 6) }));
  assert.throws(() => marketGenerationKey({ ...identity, generation: new Uint8Array(32) }), /InvalidMarketGeneration/);
  assert.throws(() => marketGenerationKey({ ...identity, basicPool: PublicKey.default }), /InvalidMarketGeneration/);
});
