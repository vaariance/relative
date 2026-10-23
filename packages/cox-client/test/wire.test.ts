import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { decodeState, feePolicyDigest, integer, receiptBytes, receiptRoot, stateBytes, stateDigest, type Receipt, type State } from "../src/wire.ts";

const vectors = JSON.parse(readFileSync(new URL("../../cox/fixtures/state-vectors.json", import.meta.url), "utf8"));
const receipts: Receipt[] = vectors.receipts.map((value: any) => ({ request: Buffer.from(value.request, "hex"), status: value.status, minted: BigInt(value.minted), proceeds: BigInt(value.proceeds) }));
const state: State = {
  ...vectors.state,
  ...Object.fromEntries(["program", "pool", "previousState", "manifest", "snapshot", "receiptRoot"].map(key => [key, Buffer.from(vectors.state[key], "hex")])),
  ...Object.fromEntries(["sequence", "batch", "cutoff", "benchmark", "active", "pending", "payable", "residual"].map(key => [key, BigInt(vectors.state[key])])),
  prices: vectors.state.prices.map(BigInt), references: vectors.state.references.map(BigInt),
  classes: vectors.state.classes.map((value: any) => Object.fromEntries(Object.entries(value).map(([key, amount]) => [key, BigInt(amount as string)])))
};
test("receipt bytes and ordered roots match checked vectors", () => {
  assert.equal(receiptRoot([]).toString("hex"), vectors.emptyReceiptRoot);
  for (let i = 0; i < receipts.length; i++) {
    assert.equal(receiptBytes(receipts[i]!).toString("hex"), vectors.receipts[i].bytes);
    assert.equal(receiptRoot(receipts.slice(0, i + 1)).toString("hex"), vectors.receiptPrefixRoots[i]);
  }
  assert.notDeepEqual(receiptRoot([...receipts].reverse()), receiptRoot(receipts));
});
test("state bytes and digest match checked vector", () => {
  assert.equal(stateBytes(state).toString("hex"), vectors.stateBytes);
  assert.equal(stateDigest(state).toString("hex"), vectors.stateDigest);
  assert.deepEqual(decodeState(stateBytes(state)), state);
  assert.throws(() => decodeState(stateBytes(state).subarray(0, 100)), /TruncatedState/);
  assert.throws(() => decodeState(Buffer.concat([stateBytes(state), Buffer.from([0])])), /TrailingStateBytes/);
  assert.notDeepEqual(stateDigest({ ...state, batch: state.batch + 1n }), stateDigest(state));
  assert.notDeepEqual(stateDigest({ ...state, pending: state.pending + 1n }), stateDigest(state));
});
test("wire integer ranges reject overflow and preserve signed extrema", () => {
  assert.equal(integer(-1n, 16, true).toString("hex"), "ff".repeat(16));
  assert.throws(() => integer(-1n, 8), /IntegerOutOfRange/);
  assert.throws(() => integer(1n << 64n, 8), /IntegerOutOfRange/);
  assert.throws(() => integer(1n << 127n, 16, true), /IntegerOutOfRange/);
  assert.equal(integer(-(1n << 127n), 16, true).toString("hex"), `${"00".repeat(15)}80`);
});

test("fee receipt commitments include locked terms and reject mixed formats", () => {
  const receipt: Receipt = { request: Buffer.alloc(32, 7), status: 0, minted: 123n, proceeds: 999800n,
    feeTerms: { gross: 1000000n, fee: 200n, feeVersion: 4n, feeBps: 2, feeCap: 2000000n } };
  const bytes = receiptBytes(receipt);
  assert.equal(bytes.length, 91);
  assert.equal(bytes.readBigUInt64LE(57), 1000000n);
  assert.equal(bytes.readBigUInt64LE(65), 200n);
  assert.equal(bytes.readBigUInt64LE(73), 4n);
  assert.equal(bytes.readUInt16LE(81), 2);
  assert.equal(bytes.readBigUInt64LE(83), 2000000n);
  assert.notDeepEqual(receiptRoot([], 1), receiptRoot([], 2));
  assert.notDeepEqual(receiptRoot([receipt]), receiptRoot([{ ...receipt, feeTerms: { ...receipt.feeTerms!, feeVersion: 5n } }]));
  assert.throws(() => receiptRoot([receipt], 1), /ReceiptVersionMismatch/);
  assert.throws(() => receiptRoot([receipt, receipts[0]!]), /ReceiptVersionMismatch/);
});
test("fee state round trips with V1 predecessor and binds treasury and activation", () => {
  const feeState = { fees: 200n, batchFees: 200n, feeVersion: 1n, feeBps: 2, feeCap: 2000000n, feeNextVersion: 3n,
    feePending: true, feePendingVersion: 2n, feePendingBps: 3, feePendingCap: 1000000n,
    feePendingCutoff: 1800086400n, feeInitialScheduled: true, feePolicyDigest: feePolicyDigest(state.manifest) };
  const next: State = { ...state, previousState: stateDigest(state), feeState, receiptRoot: receiptRoot([], 2) };
  assert.deepEqual(decodeState(stateBytes(next)), next);
  assert.notDeepEqual(stateDigest(next), stateDigest({ ...next, feeState: { ...feeState, fees: 201n } }));
  assert.notDeepEqual(stateDigest(next), stateDigest({ ...next, feeState: { ...feeState, feePendingCutoff: feeState.feePendingCutoff + 60n } }));
  assert.throws(() => decodeState(stateBytes({ ...next, feeState: { ...feeState, feePolicyDigest: Buffer.alloc(32) } })), /FeePolicyDigestMismatch/);
  assert.throws(() => decodeState(stateBytes(next).subarray(0, stateBytes(next).length - 1)), /TruncatedState/);
});

test("published V2 vectors reproduce every receipt and the state commitment", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../cox/fixtures/fee-state-vectors.json", import.meta.url), "utf8"));
  const values: Receipt[] = fixture.receipts.map((value: any) => ({ request: Buffer.from(value.request, "hex"), status: value.status, minted: BigInt(value.minted), proceeds: BigInt(value.proceeds),
    feeTerms: { gross: BigInt(value.feeTerms.gross), fee: BigInt(value.feeTerms.fee), feeVersion: BigInt(value.feeTerms.feeVersion), feeBps: value.feeTerms.feeBps, feeCap: BigInt(value.feeTerms.feeCap) } }));
  assert.equal(receiptRoot([], 2).toString("hex"), fixture.emptyReceiptRoot);
  values.forEach((value, i) => {
    assert.equal(receiptBytes(value).toString("hex"), fixture.receipts[i].bytes);
    assert.equal(receiptRoot(values.slice(0, i + 1)).toString("hex"), fixture.receiptPrefixRoots[i]);
  });
  const decoded = decodeState(Buffer.from(fixture.stateBytes, "hex"));
  assert.equal(stateBytes(decoded).toString("hex"), fixture.stateBytes);
  assert.equal(stateDigest(decoded).toString("hex"), fixture.stateDigest);
  assert.equal(Buffer.from(decoded.previousState).toString("hex"), vectors.stateDigest);
  assert.equal(Buffer.from(decoded.receiptRoot).toString("hex"), fixture.receiptPrefixRoots.at(-1));
});

test("operator geometric state uses a distinct domain and retains verified fee commitments", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../cox/fixtures/fee-state-vectors.json", import.meta.url), "utf8"));
  const decoded = decodeState(Buffer.from(fixture.stateBytes, "hex"));
  const adaptive: State = { ...decoded, benchmarkMode: "operator-geometric", tradingOpensAt: 1_792_627_200n, testCollateralMint: null };
  assert.deepEqual(decodeState(stateBytes(adaptive)), adaptive);
  assert.notDeepEqual(stateDigest(adaptive), stateDigest(decoded));
  const encoded = stateBytes(adaptive);
  assert.equal(encoded.readBigUInt64LE(encoded.length - 9), adaptive.tradingOpensAt);
  assert.equal(encoded.length, stateBytes(decoded).length + 18);
  assert.notDeepEqual(stateDigest(adaptive), stateDigest({ ...adaptive, tradingOpensAt: adaptive.tradingOpensAt! + 1n }));
  assert.throws(() => decodeState(encoded.subarray(0, encoded.length - 8)), /TruncatedState/);
  assert.throws(() => stateBytes({ ...adaptive, tradingOpensAt: undefined }), /AdaptiveStateRequiresTradingTime/);
  assert.throws(() => stateBytes({ ...adaptive, tradingOpensAt: -1n }), /IntegerOutOfRange/);
  assert.throws(() => stateBytes({ ...adaptive, tradingOpensAt: 1n << 64n }), /IntegerOutOfRange/);
  assert.throws(() => stateBytes({ ...decoded, tradingOpensAt: 0n }), /UnexpectedAdaptiveTradingTime/);
  assert.throws(() => stateBytes({ ...adaptive, feeState: undefined }), /AdaptiveStateRequiresFeeFields/);
});

test("adaptive full roster snapshot matches the native publisher commitment and rejects malformed inputs", async () => {
  const { adaptiveSnapshotDigest } = await import("../src/wire.ts");
  const snapshot = { timestamp: 1800000017n, benchmark: 110000000000000n,
    roster: Array.from({ length: 30 }, (_, index) => index), prices: Array.from({ length: 30 }, (_, index) => 100000000n + BigInt(index)) };
  assert.equal(adaptiveSnapshotDigest(snapshot).toString("hex"), "da1985b0aa8be1c68f1bafa82a76a25da4ff5b3c21b6f7f6ac843fb13302d558");
  assert.notDeepEqual(adaptiveSnapshotDigest(snapshot), adaptiveSnapshotDigest({ ...snapshot, benchmark: snapshot.benchmark + 1n }));
  assert.throws(() => adaptiveSnapshotDigest({ ...snapshot, roster: [1, 0] }), /InvalidAdaptiveSnapshot/);
  assert.throws(() => adaptiveSnapshotDigest({ ...snapshot, prices: [] }), /InvalidAdaptiveSnapshot/);
});

test("dynamic state supports 255 assets and reserves a distinct publication domain", () => {
  const feeState = { fees: 0n, batchFees: 0n, feeVersion: 1n, feeBps: 2, feeCap: 200000n, feeNextVersion: 2n,
    feePending: false, feePendingVersion: 0n, feePendingBps: 0, feePendingCap: 0n, feePendingCutoff: 0n,
    feeInitialScheduled: true, feePolicyDigest: feePolicyDigest(state.manifest) };
  const dynamic: State = { ...state, benchmarkMode: "operator-geometric-dynamic", tradingOpensAt: 1000n, testCollateralMint: null, feeState,
    prices: Array(255).fill(100n), references: Array(256).fill(100000000000000n),
    classes: Array.from({ length: 256 }, () => ({ preBacking: 0n, preUnits: 0n, postBacking: 0n, postUnits: 0n })) };
  const bytes = stateBytes(dynamic);
  assert.equal(bytes.subarray(4, 24).toString(), "COX/STATE/DYNAMIC/V1");
  assert.deepEqual(decodeState(bytes), dynamic);
  assert.throws(() => stateBytes({ ...dynamic, prices: Array(256).fill(100n) }), /InvalidDynamicState/);
  assert.throws(() => stateBytes({ ...dynamic, references: [] }), /InvalidDynamicState/);
  const legacyDomain = Buffer.from(bytes); legacyDomain.writeUInt32LE(12, 0);
  assert.throws(() => decodeState(legacyDomain), /InvalidStateDomain/);
});
