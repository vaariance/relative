import { Buffer } from "buffer";
import { sha256 as hash } from "@noble/hashes/sha256";

export const sha256 = (bytes: Uint8Array): Buffer => Buffer.from(hash(bytes));
export function integer(value: bigint, width: number, signed = false): Buffer {
  const bits = BigInt(width * 8);
  const bound = 1n << (signed ? bits - 1n : bits);
  if (value < (signed ? -bound : 0n) || value >= bound) throw new Error("IntegerOutOfRange");
  const out = Buffer.alloc(width);
  const encoded = value < 0n ? value + (1n << bits) : value;
  for (let i = 0; i < width; i++) out[i] = Number(encoded >> BigInt(i * 8) & 255n);
  return out;
}
export function bytes32(value: Uint8Array): Buffer {
  if (value.length !== 32) throw new Error("InvalidBytes32");
  return Buffer.from(value);
}
export function stringBytes(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([integer(BigInt(bytes.length), 4), bytes]);
}
export const discriminator = (kind: "global" | "account" | "event", name: string): Buffer => sha256(Buffer.from(`${kind}:${name}`, "utf8")).subarray(0, 8);
export const ReceiptStatus = Object.freeze({ Filled: 0, ConditionFailed: 1, Expired: 2, ZeroValueClass: 3, SafetyRejected: 4 });
export interface ReceiptFees { gross: bigint; fee: bigint; feeVersion: bigint; feeBps: number; feeCap: bigint }
export interface Receipt { feeTerms?: ReceiptFees; request: Uint8Array; status: 0 | 1 | 2 | 3 | 4; minted: bigint; proceeds: bigint }
export function receiptBytes(receipt: Receipt): Buffer {
  if (!Number.isInteger(receipt.status) || receipt.status < 0 || receipt.status > 4) throw new Error("InvalidReceiptStatus");
  return Buffer.concat([bytes32(receipt.request), integer(BigInt(receipt.status), 1), integer(receipt.minted, 16), integer(receipt.proceeds, 8), ...(receipt.feeTerms ? [integer(receipt.feeTerms.gross, 8), integer(receipt.feeTerms.fee, 8), integer(receipt.feeTerms.feeVersion, 8), integer(BigInt(receipt.feeTerms.feeBps), 2), integer(receipt.feeTerms.feeCap, 8)] : [])]);
}
export function receiptRoot(receipts: readonly Receipt[], version: 1 | 2 = receipts.some(receipt => receipt.feeTerms !== undefined) ? 2 : 1): Buffer {
  if (receipts.some(receipt => (receipt.feeTerms !== undefined) !== (version === 2))) throw new Error("ReceiptVersionMismatch");
  return receipts.reduce((previous, receipt) => sha256(Buffer.concat([previous, receiptBytes(receipt)])), sha256(stringBytes(`COX/RECEIPTS/V${version}`)));
}
export interface StateClass { preBacking: bigint; preUnits: bigint; postBacking: bigint; postUnits: bigint }
export interface FeeState {
  fees: bigint; batchFees: bigint; feeVersion: bigint; feeBps: number; feeCap: bigint; feeNextVersion: bigint;
  feePending: boolean; feePendingVersion: bigint; feePendingBps: number; feePendingCap: bigint; feePendingCutoff: bigint; feeInitialScheduled: boolean; feePolicyDigest: Uint8Array;
}
export const feePolicyDigest = (manifest: Uint8Array): Buffer => sha256(Buffer.concat([stringBytes("COX/FEES/V1"), bytes32(manifest), integer(100n, 2), integer(2000000n, 8), integer(86400n, 8)]));
export interface State {
  benchmarkMode?: "operator-geometric" | "operator-geometric-dynamic";
  tradingOpensAt?: bigint;
  testCollateralMint?: Uint8Array | null;
  feeState?: FeeState;
  program: Uint8Array; pool: Uint8Array; sequence: bigint; batch: bigint; cutoff: bigint;
  previousState: Uint8Array; manifest: Uint8Array; snapshot: Uint8Array; benchmark: bigint;
  prices: readonly bigint[]; references: readonly bigint[]; classes: readonly StateClass[];
  executed: number; rejected: number; active: bigint; pending: bigint; payable: bigint; residual: bigint; receiptRoot: Uint8Array;
}
const vector = <T>(values: readonly T[], encode: (value: T) => Uint8Array): Buffer => Buffer.concat([integer(BigInt(values.length), 4), ...values.map(value => Buffer.from(encode(value)))]);
function dynamicShape(state: State): void {
  if (state.benchmarkMode === "operator-geometric-dynamic" && (state.prices.length < 30 || state.prices.length > 255 || state.references.length !== state.prices.length + 1 || state.classes.length !== state.references.length)) throw new Error("InvalidDynamicState");
}
export function stateBytes(state: State): Buffer {
  dynamicShape(state);
  if (![state.executed, state.rejected].every(value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)) throw new Error("InvalidReceiptCount");
  if (state.benchmarkMode && !state.feeState) throw new Error("AdaptiveStateRequiresFeeFields");
  if (state.benchmarkMode && state.tradingOpensAt === undefined) throw new Error("AdaptiveStateRequiresTradingTime");
  if (!state.benchmarkMode && state.tradingOpensAt !== undefined) throw new Error("UnexpectedAdaptiveTradingTime");
  return Buffer.concat([
    stringBytes(state.benchmarkMode === "operator-geometric-dynamic" ? "COX/STATE/DYNAMIC/V1" : state.benchmarkMode ? "COX/STATE/ADAPTIVE/V1" : state.feeState ? "COX/STATE/V2" : "COX/STATE/V1"), bytes32(state.program), bytes32(state.pool), integer(state.sequence, 8), integer(state.batch, 8), integer(state.cutoff, 8),
    bytes32(state.previousState), bytes32(state.manifest), bytes32(state.snapshot), integer(state.benchmark, 16, true),
    vector(state.prices, value => integer(value, 8)), vector(state.references, value => integer(value, 16, true)),
    vector(state.classes, value => Buffer.concat([integer(value.preBacking, 8), integer(value.preUnits, 16), integer(value.postBacking, 8), integer(value.postUnits, 16)])),
    integer(BigInt(state.executed), 4), integer(BigInt(state.rejected), 4), integer(state.active, 8), integer(state.pending, 8), integer(state.payable, 8), integer(state.residual, 8), bytes32(state.receiptRoot),
    ...(state.feeState ? [integer(state.feeState.fees, 8), integer(state.feeState.batchFees, 8), integer(state.feeState.feeVersion, 8), integer(BigInt(state.feeState.feeBps), 2), integer(state.feeState.feeCap, 8), integer(state.feeState.feeNextVersion, 8), integer(state.feeState.feePending ? 1n : 0n, 1), integer(state.feeState.feePendingVersion, 8), integer(BigInt(state.feeState.feePendingBps), 2), integer(state.feeState.feePendingCap, 8), integer(state.feeState.feePendingCutoff, 8), integer(state.feeState.feeInitialScheduled ? 1n : 0n, 1), bytes32(state.feeState.feePolicyDigest)] : []),
    ...(state.benchmarkMode ? [integer(state.tradingOpensAt!, 8), ...(state.testCollateralMint ? [integer(1n,1),bytes32(state.testCollateralMint)] : [integer(0n,1)])] : [])
  ]);
}
export const stateDigest = (state: State): Buffer => sha256(stateBytes(state));
export function decodeState(bytes: Uint8Array): State {
  const input = Buffer.from(bytes);
  let offset = 0;
  const take = (length: number): Buffer => {
    if (offset + length > input.length) throw new Error("TruncatedState");
    const value = input.subarray(offset, offset + length); offset += length; return value;
  };
  const number = (width: number, signed = false): bigint => {
    const value = take(width);
    let result = 0n;
    for (let i = width - 1; i >= 0; i--) result = result * 256n + BigInt(value[i]!);
    return signed && (value[width - 1]! & 128) !== 0 ? result - (1n << BigInt(width * 8)) : result;
  };
  const list = <T>(read: () => T): T[] => {
    const count = Number(number(4));
    if (count > (domain === "COX/STATE/DYNAMIC/V1" ? 256 : 31)) throw new Error("StateVectorLimit");
    return Array.from({ length: count }, read);
  };
  const domainLength = Number(number(4));
  if (domainLength !== 12 && domainLength !== 21 && domainLength !== 20) throw new Error("InvalidStateDomain");
  const domain = take(domainLength).toString("utf8");
  if (domain !== "COX/STATE/V1" && domain !== "COX/STATE/V2" && domain !== "COX/STATE/ADAPTIVE/V1" && domain !== "COX/STATE/DYNAMIC/V1") throw new Error("InvalidStateDomain");
  const state: State = {
    program: take(32), pool: take(32), sequence: number(8), batch: number(8), cutoff: number(8), previousState: take(32), manifest: take(32), snapshot: take(32), benchmark: number(16, true),
    prices: list(() => number(8)), references: list(() => number(16, true)),
    classes: list(() => ({ preBacking: number(8), preUnits: number(16), postBacking: number(8), postUnits: number(16) })),
    executed: Number(number(4)), rejected: Number(number(4)), active: number(8), pending: number(8), payable: number(8), residual: number(8), receiptRoot: take(32)
  };
  if (domain === "COX/STATE/DYNAMIC/V1") state.benchmarkMode = "operator-geometric-dynamic";
  if (domain === "COX/STATE/ADAPTIVE/V1") state.benchmarkMode = "operator-geometric";
  if (domain === "COX/STATE/V2" || domain === "COX/STATE/ADAPTIVE/V1" || domain === "COX/STATE/DYNAMIC/V1") {
    const boolean = () => { const value = number(1); if (value !== 0n && value !== 1n) throw new Error("InvalidStateBoolean"); return value === 1n; };
    state.feeState = { fees: number(8), batchFees: number(8), feeVersion: number(8), feeBps: Number(number(2)), feeCap: number(8), feeNextVersion: number(8), feePending: boolean(), feePendingVersion: number(8), feePendingBps: Number(number(2)), feePendingCap: number(8), feePendingCutoff: number(8), feeInitialScheduled: boolean(), feePolicyDigest: take(32) };
    if (!Buffer.from(state.feeState.feePolicyDigest).equals(feePolicyDigest(state.manifest))) throw new Error("FeePolicyDigestMismatch");
  }
  if (domain === "COX/STATE/ADAPTIVE/V1" || domain === "COX/STATE/DYNAMIC/V1") { state.tradingOpensAt = number(8); const tag=number(1); if(tag!==0n&&tag!==1n)throw new Error("InvalidCollateralPolicy");state.testCollateralMint=tag===1n?take(32):null; }
  if (offset !== input.length) throw new Error("TrailingStateBytes");
  dynamicShape(state);
  return state;
}

export interface AdaptiveSnapshot {
  timestamp: bigint; benchmark: bigint; roster: readonly number[]; prices: readonly bigint[];
}
export function adaptiveSnapshotBytes(snapshot: AdaptiveSnapshot): Buffer {
  const { timestamp, benchmark, roster, prices } = snapshot;
  if (benchmark <= 0n || timestamp < 0n || roster.length < 2 || roster.length > 30 || roster.length !== prices.length
    || roster.some((id, index) => !Number.isInteger(id) || id < 0 || id >= 30 || index > 0 && id <= roster[index - 1]!)
    || prices.some(price => price <= 0n)) throw new Error("InvalidAdaptiveSnapshot");
  return Buffer.concat([stringBytes("COX/ADAPTIVE-SNAPSHOT/V1"), integer(timestamp, 8), integer(benchmark, 16, true),
    vector(roster, id => integer(BigInt(id), 1)), ...prices.map(price => integer(price, 8))]);
}
export const adaptiveSnapshotDigest = (snapshot: AdaptiveSnapshot): Buffer => sha256(adaptiveSnapshotBytes(snapshot));
