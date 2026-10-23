import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import type { Methodology } from "./accounts.ts";
import { bytes32, integer, sha256, stringBytes } from "./wire.ts";

export const DYNAMIC_CRYPTO_CLASS = 30;
export const DYNAMIC_MAX_ASSETS = 255;
export const DYNAMIC_UNIVERSE_DOMAIN = "COX/UNIVERSE/OPERATOR-ATTESTED/V1";
export interface DynamicInstrument {
  stableId: string; symbol: string; classId: number; epochId: number; pythProFeedId: number; pythCoreFeedId: Uint8Array;
  tokenMint: PublicKey | null; originalPriceE8: bigint; originalBenchmark: bigint; originalTimestamp: bigint;
}
export interface DynamicCapture {
  priceUniverseDigest: Uint8Array; timestamp: bigint; benchmark: bigint; pricesE8: readonly bigint[];
  signedPayloadDigest: Uint8Array; trustedStorageDigest: Uint8Array; predecessorSequence: bigint; predecessorStateDigest: Uint8Array;
}
export interface DynamicManifest {
  schemaVersion: 1; pool: PublicKey; operator: PublicKey; sourceMethodology: Uint8Array; version: bigint;
  predecessorDigest: Uint8Array; expectedInstruments: number; capture: DynamicCapture; instruments: readonly DynamicInstrument[];
}
function check(condition: boolean): asserts condition { if (!condition) throw new Error("InvalidDynamicManifest"); }
const nonzero = (value: Uint8Array) => value.length === 32 && value.some(byte => byte !== 0);
const vector = (values: readonly Uint8Array[]) => Buffer.concat([integer(BigInt(values.length), 4), ...values]);
export function dynamicClassForAsset(index: number): number {
  check(Number.isInteger(index) && index >= 0 && index < DYNAMIC_MAX_ASSETS);
  return index < DYNAMIC_CRYPTO_CLASS ? index : index + 1;
}
export function dynamicAssetForClass(classId: number, assetCount: number): number | null {
  check(Number.isInteger(assetCount) && assetCount >= 30 && assetCount <= DYNAMIC_MAX_ASSETS);
  check(Number.isInteger(classId) && classId >= 0 && classId <= assetCount);
  return classId === DYNAMIC_CRYPTO_CLASS ? null : classId < DYNAMIC_CRYPTO_CLASS ? classId : classId - 1;
}
function validate(value: DynamicManifest): void {
  const c = value.capture;
  check(value.schemaVersion === 1 && !value.pool.equals(PublicKey.default) && !value.operator.equals(PublicKey.default)
    && nonzero(value.sourceMethodology) && value.version > 0n && value.predecessorDigest.length === 32
    && (value.version === 1n) === !nonzero(value.predecessorDigest)
    && value.expectedInstruments === value.instruments.length && value.instruments.length >= 30 && value.instruments.length <= DYNAMIC_MAX_ASSETS);
  check(c.timestamp > 0n && c.benchmark > 0n && c.pricesE8.length === value.instruments.length && c.pricesE8.every(price => price > 0n)
    && nonzero(c.priceUniverseDigest) && nonzero(c.signedPayloadDigest) && nonzero(c.trustedStorageDigest) && nonzero(c.predecessorStateDigest));
  const ids = new Set<string>(), symbols = new Set<string>(), epochs = new Set<number>(), pro = new Set<number>(), core = new Set<string>(), mints = new Set<string>();
  for (const [index, asset] of value.instruments.entries()) {
    const coreKey = Buffer.from(asset.pythCoreFeedId).toString("hex"), mint = asset.tokenMint?.toBase58();
    check(/^[a-z0-9._:-]{1,64}$/.test(asset.stableId) && /^[A-Z0-9._-]{1,16}$/.test(asset.symbol)
      && asset.classId === dynamicClassForAsset(index) && Number.isInteger(asset.epochId) && asset.epochId >= 0 && asset.epochId < 256
      && Number.isInteger(asset.pythProFeedId) && asset.pythProFeedId > 0 && asset.pythProFeedId <= 0xffffffff
      && nonzero(asset.pythCoreFeedId) && (asset.tokenMint === null || !asset.tokenMint.equals(PublicKey.default))
      && asset.originalPriceE8 > 0n && asset.originalBenchmark > 0n && asset.originalTimestamp > 0n
      && !ids.has(asset.stableId) && !symbols.has(asset.symbol) && !epochs.has(asset.epochId) && !pro.has(asset.pythProFeedId)
      && !core.has(coreKey) && (mint === undefined || !mints.has(mint)));
    ids.add(asset.stableId); symbols.add(asset.symbol); epochs.add(asset.epochId); pro.add(asset.pythProFeedId); core.add(coreKey); if (mint !== undefined) mints.add(mint);
  }
}
export function dynamicManifestBytes(value: DynamicManifest): Buffer {
  validate(value);
  const c = value.capture;
  const out = Buffer.concat([stringBytes(DYNAMIC_UNIVERSE_DOMAIN), integer(1n, 2), value.pool.toBuffer(), value.operator.toBuffer(), bytes32(value.sourceMethodology),
    integer(value.version, 8), bytes32(value.predecessorDigest), integer(BigInt(value.expectedInstruments), 2),
    bytes32(c.priceUniverseDigest), integer(c.timestamp, 8), integer(c.benchmark, 16, true), vector(c.pricesE8.map(price => integer(price, 8))),
    bytes32(c.signedPayloadDigest), bytes32(c.trustedStorageDigest), integer(c.predecessorSequence, 8), bytes32(c.predecessorStateDigest),
    vector(value.instruments.map(asset => Buffer.concat([stringBytes(asset.stableId), stringBytes(asset.symbol), integer(BigInt(asset.classId), 2), integer(BigInt(asset.epochId), 2),
      integer(BigInt(asset.pythProFeedId), 4), bytes32(asset.pythCoreFeedId), asset.tokenMint ? Buffer.concat([integer(1n, 1), asset.tokenMint.toBuffer()]) : integer(0n, 1),
      integer(asset.originalPriceE8, 8), integer(asset.originalBenchmark, 16, true), integer(asset.originalTimestamp, 8)])))]);
  check(out.length <= 131072);
  return out;
}
export function decodeDynamicManifest(bytes: Uint8Array, expectedDigest?: Uint8Array): DynamicManifest {
  const input = Buffer.from(bytes); let offset = 0;
  check(input.length <= 131072);
  const take = (width: number) => { check(offset + width <= input.length); const value = input.subarray(offset, offset + width); offset += width; return value; };
  const number = (width: number, signed = false) => { const bytes = take(width); let value = 0n; for (let i = width - 1; i >= 0; i--) value = value * 256n + BigInt(bytes[i]!); return signed && (bytes[width - 1]! & 128) !== 0 ? value - (1n << BigInt(width * 8)) : value; };
  const text = (maximum: number) => { const length = Number(number(4)); check(length <= maximum); const bytes = take(length), result = bytes.toString("utf8"); check(Buffer.from(result).equals(bytes)); return result; };
  const list = <T>(read: () => T): T[] => { const count = Number(number(4)); check(count >= 30 && count <= DYNAMIC_MAX_ASSETS); return Array.from({ length: count }, read); };
  check(text(64) === DYNAMIC_UNIVERSE_DOMAIN);
  const schemaVersion = Number(number(2)); check(schemaVersion === 1);
  const pool = new PublicKey(take(32)), operator = new PublicKey(take(32)), sourceMethodology = take(32), version = number(8), predecessorDigest = take(32), expectedInstruments = Number(number(2));
  const capture: DynamicCapture = { priceUniverseDigest: take(32), timestamp: number(8), benchmark: number(16, true), pricesE8: list(() => number(8)),
    signedPayloadDigest: take(32), trustedStorageDigest: take(32), predecessorSequence: number(8), predecessorStateDigest: take(32) };
  const instruments = list((): DynamicInstrument => {
    const stableId = text(64), symbol = text(16), classId = Number(number(2)), epochId = Number(number(2)), pythProFeedId = Number(number(4)), pythCoreFeedId = take(32), tag = Number(number(1));
    check(tag === 0 || tag === 1);
    return { stableId, symbol, classId, epochId, pythProFeedId, pythCoreFeedId, tokenMint: tag === 1 ? new PublicKey(take(32)) : null,
      originalPriceE8: number(8), originalBenchmark: number(16, true), originalTimestamp: number(8) };
  });
  const result: DynamicManifest = { schemaVersion, pool, operator, sourceMethodology, version, predecessorDigest, expectedInstruments, capture, instruments };
  check(offset === input.length && dynamicManifestBytes(result).equals(input));
  if (expectedDigest !== undefined) check(sha256(input).equals(bytes32(expectedDigest)));
  return result;
}
export function readDynamicManifest(methodology: Methodology, pool?: PublicKey): DynamicManifest {
  check(methodology.schemaVersion === 3 && methodology.sealed && !methodology.bybit && methodology.canonical.length === methodology.expectedLength);
  const value = decodeDynamicManifest(Buffer.from(methodology.canonical), Buffer.from(methodology.digest));
  check(methodology.origin.toString() === value.instruments[0]!.originalTimestamp.toString() && methodology.roster.length === value.instruments.length
    && methodology.roster.every((id, index) => id === index) && (pool === undefined || value.pool.equals(pool)));
  return value;
}
export function dynamicPositionSpace(classes: number): number { check(Number.isInteger(classes) && classes >= 31 && classes <= 256); return Math.ceil((512 + 80 * classes) / 4096) * 4096; }

export function dynamicInstrumentIdentitiesDigest(instruments: readonly DynamicInstrument[]): Buffer {
  check(instruments.length >= 30 && instruments.length <= DYNAMIC_MAX_ASSETS);
  return sha256(Buffer.concat([stringBytes("COX/UNIVERSE/IDENTITIES/V1"), vector(instruments.map(asset => Buffer.concat([
    stringBytes(asset.stableId), stringBytes(asset.symbol), integer(BigInt(asset.classId), 2), integer(BigInt(asset.epochId), 2),
    integer(BigInt(asset.pythProFeedId), 4), bytes32(asset.pythCoreFeedId), asset.tokenMint ? Buffer.concat([integer(1n, 1), asset.tokenMint.toBuffer()]) : integer(0n, 1),
  ])))]));
}
export function dynamicSnapshotDigest(timestamp: bigint, benchmark: bigint, universeDigest: Uint8Array, instruments: readonly DynamicInstrument[], pricesE8: readonly bigint[]): Buffer {
  check(timestamp > 0n && benchmark > 0n && instruments.length === pricesE8.length && instruments.length >= 30 && instruments.length <= DYNAMIC_MAX_ASSETS && pricesE8.every(value => value > 0n));
  return sha256(Buffer.concat([stringBytes("COX/SNAPSHOT/DYNAMIC/V1"), integer(timestamp, 8), integer(benchmark, 16, true), bytes32(universeDigest),
    vector(instruments.map((asset, index) => Buffer.concat([integer(BigInt(asset.classId), 2), integer(BigInt(asset.epochId), 2), integer(BigInt(asset.pythProFeedId), 4), integer(pricesE8[index]!, 8)])))]));
}
