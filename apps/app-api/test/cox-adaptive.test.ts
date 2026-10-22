import { createHash } from "node:crypto";
import anchor from "@coral-xyz/anchor";
import type { Methodology, Pool, Registry } from "@cox/client";
import type { ChainPublication } from "../src/cox/chain.js";
import { describe, expect, it } from "vitest";
import { classIds, parseManifest, toPublication } from "../src/cox/chain.js";
import { feesMigrated, tradingStatus } from "../src/cox/live-source.js";

const ORIGIN = 1_792_623_921n;
const OPENS_AT = 1_792_670_400;

const u32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const u64 = (value: bigint) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
};
const text = (value: string) => Buffer.concat([u32(Buffer.byteLength(value)), Buffer.from(value)]);
const vec = (items: Buffer[]) => Buffer.concat([u32(items.length), ...items]);

function canonical(roster: number[], feeds: number[], domain = "COX/METHODOLOGY/ADAPTIVE/V1", trailing = Buffer.alloc(0)): Buffer {
  return Buffer.concat([
    text(domain),
    text("relative-adaptive-1"),
    vec(roster.map((id) => Buffer.from([id]))),
    vec(feeds.map(u32)),
    u64(ORIGIN),
    vec(roster.map((_, i) => u64(1_000_000n + BigInt(i)))),
    Buffer.alloc(32, 7),
    Buffer.alloc(32, 8),
    u64(2_000n),
    u64(10_000n),
    Buffer.alloc(32, 9),
    text("policy"),
    trailing,
  ]);
}

function methodology(bytes: Buffer, roster: number[], origin = ORIGIN): Methodology {
  return {
    schemaVersion: 2,
    bump: 255,
    digest: [...createHash("sha256").update(bytes).digest()],
    canonical: [...bytes],
    sealed: true,
    activationBatch: new anchor.BN(0),
    expectedLength: bytes.length,
    roster,
    origin: new anchor.BN(origin.toString()),
    bybit: false,
  };
}

describe("adaptive methodology", () => {
  it("reads the sealed roster, Pyth feed ids and the non-minute origin from the canonical bytes", () => {
    const roster = [0, 1, 2, 29];
    const manifest = parseManifest(methodology(canonical(roster, [1, 2, 6, 99]), roster));
    expect(manifest).toMatchObject({ mode: "adaptive", version: "relative-adaptive-1", origin: Number(ORIGIN), sealed: true });
    expect(manifest.assets.map((a) => [a.assetId, a.pythFeedId, a.weightNumerator, a.weightDenominator])).toEqual([
      ["BTC", 1, "1", "4"], ["ETH", 2, "1", "4"], ["SOL", 6, "1", "4"], ["W", 99, "1", "4"],
    ]);
    expect(manifest.assets.every((a) => Object.values(a.venues).every((v) => v === null))).toBe(true);
    expect(classIds(manifest)).toEqual(["BTC", "ETH", "SOL", "W", "CRYPTO"]);
  });

  it("refuses a foreign domain, trailing bytes, an unsorted roster or a roster that disagrees with the account", () => {
    expect(() => parseManifest(methodology(canonical([0, 1], [1, 2], "COX/METHODOLOGY/V1"), [0, 1]))).toThrow("ManifestDomainInvalid");
    expect(() => parseManifest(methodology(canonical([0, 1], [1, 2], undefined, Buffer.from([0])), [0, 1]))).toThrow("ManifestTrailingBytes");
    expect(() => parseManifest(methodology(canonical([1, 0], [1, 2]), [1, 0]))).toThrow("ManifestRosterInvalid");
    expect(() => parseManifest(methodology(canonical([0, 1], [1, 2]), [0, 2]))).toThrow("ManifestAccountMismatch");
    expect(() => parseManifest(methodology(canonical([0, 1], [1, 2]), [0, 1], ORIGIN + 1n))).toThrow("ManifestAccountMismatch");
  });
});

describe("adaptive trading gate", () => {
  const pool = (overrides: Partial<Pool> = {}) => ({ schemaVersion: 4, initialized: true, tradingOpensAt: new anchor.BN(OPENS_AT), ...overrides }) as Pool;
  const registry = (paused: boolean) => ({ paused }) as Registry;

  it("opens only after the first publication, with the registry unpaused, at the scheduled time", () => {
    expect(tradingStatus(pool(), registry(false), OPENS_AT)).toEqual({ open: true, gate: "open", opensAt: OPENS_AT });
    expect(tradingStatus(pool(), registry(false), OPENS_AT - 1)).toEqual({ open: false, gate: "before-opening", opensAt: OPENS_AT });
    expect(tradingStatus(pool({ initialized: false }), registry(false), OPENS_AT)).toMatchObject({ open: false, gate: "not-initialized" });
    expect(tradingStatus(pool({ initialized: false }), registry(true), OPENS_AT)).toMatchObject({ open: false, gate: "paused" });
    expect(tradingStatus(pool({ schemaVersion: 3 }), registry(true), OPENS_AT)).toEqual({ open: false, gate: "retired", opensAt: null });
    expect(tradingStatus(pool({ schemaVersion: 2 }), registry(false), 0)).toEqual({ open: true, gate: "open", opensAt: null });
  });

  it("treats adaptive and migrated pools as fee-aware", () => {
    expect([1, 2, 3, 4].map((schemaVersion) => feesMigrated(pool({ schemaVersion })))).toEqual([false, true, false, true]);
  });
});

describe("adaptive publications", () => {
  it("lists no missed batches across idle seconds", () => {
    const roster = [0, 1];
    const manifest = parseManifest(methodology(canonical(roster, [1, 2]), roster));
    const n = (value: number | bigint) => new anchor.BN(value.toString());
    const side = { preBacking: n(0), preUnits: n(0), postBacking: n(0), postUnits: n(0) };
    const publication = {
      prices: roster.map(() => ({ priceE8: n(100), venue: 3, step: 0, candleStart: n(0), tradeAgeMinutes: 0 })),
      stateDigest: [...Buffer.alloc(32, 1)],
      committedAt: n(ORIGIN + 43_320n),
      state: {
        prices: [n(100), n(100)], sequence: 1n, batch: 43_320n, cutoff: ORIGIN + 43_320n, manifest: [...Buffer.alloc(32)], snapshot: [...Buffer.alloc(32)], benchmark: 1n,
        references: [1n, 1n, 1n], classes: [side, side, side], active: 0n, pending: 0n, payable: 0n, residual: 0n,
        executed: 0, rejected: 0, receiptRoot: [...Buffer.alloc(32)], feeState: null,
      },
    } as unknown as ChainPublication;
    const result = toPublication(publication, null, { program: "p", poolId: "2", manifest, predecessorBatch: 0, finalization: { transaction: null, slot: 1, finalized: false } });
    expect(result.identity).toMatchObject({ sequence: 1, batch: 43_320, predecessorBatch: 0, missedBatches: [] });
    expect(result.prices.map((p) => [p.venue, p.step])).toEqual([["pyth", 0], ["pyth", 0]]);
  });
});
