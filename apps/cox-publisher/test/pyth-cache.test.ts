import assert from "node:assert/strict";
import test from "node:test";
import { PythSnapshotCache, type PythBatch, type PythCachePorts } from "../src/pyth-cache.ts";

function batch(timestampUs: bigint, feeds = ["BTC", "ETH"], salt = 0): PythBatch {
  return { timestampUs, prices: feeds.map((feedId) => ({ feedId, price: 100n, exponent: -8, confidence: 1n })),
    signedSolana: new TextEncoder().encode(`${timestampUs}:${feeds.join(",")}:${salt}`) };
}

function storage() {
  let persisted: readonly PythBatch[] = [];
  let writes = 0;
  let verifications = 0;
  let failSave = false;
  const ports: PythCachePorts = {
    verifySignedPayloadAndParsedBinding: async (value) => {
      verifications++;
      if (value.signedSolana[0] === 0) throw new Error("invalid signed payload");
      if (value.prices.some((price) => price.price === 999n)) throw new Error("parsed data differs from signed data");
    },
    store: {
      load: async () => persisted,
      save: async (batches) => { if (failSave) throw new Error("store unavailable"); writes++; persisted = batches; },
    },
  };
  return { ports, create: (limit = 5) => new PythSnapshotCache(ports, limit),
    writes: () => writes, verifications: () => verifications,
    failSave: (value: boolean) => { failSave = value; },
  };
}

test("cache verifies signed payload bindings and restores verified snapshots after restart", async () => {
  const h = storage();
  const first = h.create();
  await first.ingest(batch(1_000_001n));
  const restored = await h.create().entry(["BTC", "ETH"], 1_000_000n, 1_000_010n, 100n);
  assert.equal(restored?.timestampUs, 1_000_001n);
  assert.equal(h.verifications(), 2);
});

test("entry uses first complete qualifying snapshot, strictly after admission, within age and not future", async () => {
  const h = storage();
  const cache = h.create();
  for (const at of [1_000n, 2_000n, 3_000n, 4_000n]) await cache.ingest(batch(at));
  assert.equal((await cache.entry(["BTC"], 2_000n, 3_000n, 5_000n))?.timestampUs, 3_000n);
  assert.equal(await cache.entry(["BTC"], 3_000n, 3_000n, 5_000n), null);
  assert.equal(await cache.entry(["BTC"], 0n, 10_000n, 1_000n), null);
});

test("closing requires exact oracle microsecond timestamp and never substitutes a later snapshot", async () => {
  const cache = storage().create();
  await cache.ingest(batch(1_000_001n));
  await cache.ingest(batch(2_000_000n));
  assert.equal(await cache.closing(["BTC"], 1_000_000n), null);
  assert.equal((await cache.closing(["BTC"], 1_000_001n))?.timestampUs, 1_000_001n);
});

test("cache never mixes feed sets across timestamped signed messages", async () => {
  const cache = storage().create();
  await cache.ingest(batch(1_000n, ["BTC"]));
  await cache.ingest(batch(2_000n, ["ETH"]));
  assert.equal(await cache.entry(["BTC", "ETH"], 0n, 3_000n, 10_000n), null);
  await cache.ingest(batch(2_000n, ["BTC"]));
  assert.equal(await cache.closing(["BTC", "ETH"], 2_000n), null);
});

test("duplicate signed messages do not produce duplicate persistence writes", async () => {
  const h = storage();
  const cache = h.create();
  await Promise.all([cache.ingest(batch(1_000n)), cache.ingest(batch(1_000n))]);
  assert.equal(h.writes(), 1);
});

test("bad signatures and unbound parsed data cannot enter cache; validation failures do not poison future work", async () => {
  const cache = storage().create();
  await assert.rejects(cache.ingest({ ...batch(1_000n), signedSolana: new Uint8Array([0]) }), /invalid signed payload/);
  const input = batch(1_000n);
  await assert.rejects(cache.ingest({ ...input, prices: [{ ...input.prices[0], price: 999n }] }), /differs from signed/);
  assert.equal(await cache.closing(["BTC"], 1_000n), null);
  await cache.ingest(input);
  assert.ok(await cache.closing(["BTC"], 1_000n));
});

test("cache is bounded, and callers cannot mutate stored prices or signed bytes", async () => {
  const h = storage();
  const cache = h.create(2);
  const input = batch(1_000n);
  await cache.ingest(input);
  input.signedSolana.fill(0);
  const found = await cache.closing(["BTC"], 1_000n);
  assert.ok(found);
  found.signedSolana.fill(0);
  assert.notEqual((await cache.closing(["BTC"], 1_000n))?.signedSolana[0], 0);
  await cache.ingest(batch(2_000n));
  await cache.ingest(batch(3_000n));
  assert.equal(await h.create(2).closing(["BTC"], 1_000n), null);
});

test("failed persistence does not expose a snapshot as cached", async () => {
  const h = storage();
  const cache = h.create();
  h.failSave(true);
  await assert.rejects(cache.ingest(batch(1_000n)), /store unavailable/);
  assert.equal(await cache.closing(["BTC"], 1_000n), null);
  h.failSave(false);
  await cache.ingest(batch(1_000n));
  assert.ok(await cache.closing(["BTC"], 1_000n));
});

test("same-timestamp conflicting prices are rejected and missing feeds never silently disappear", async () => {
  const cache = storage().create();
  await cache.ingest(batch(1_000n));
  const conflict = batch(1_000n, ["BTC"], 1);
  await assert.rejects(cache.ingest({ ...conflict, prices: [{ ...conflict.prices[0], price: 101n }] }), /conflicting/);
  assert.equal(await cache.entry(["SOL"], 0n, 2_000n, 2_000n), null);
  await assert.rejects(cache.entry(["BTC", "BTC"], 0n, 2_000n, 2_000n), /distinct/);
});
