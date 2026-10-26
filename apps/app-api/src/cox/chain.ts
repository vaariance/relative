import { readFileSync } from "node:fs";
import anchor, { type Idl, type Program } from "@coral-xyz/anchor";
import { dynamicCryptoClass, readDynamicManifest, type Batch as BatchAccount, type checkedPublication, type Methodology as MethodologyAccount } from "@cox/client";
import type { Connection } from "@solana/web3.js";
import { COX_FEE_POLICY, CRYPTO_CLASS, type ClassState, type FallbackStep, type FeeConfiguration, type PoolMode, type PriceVenue, type Publication, type VenueSymbols } from "@eox/app-api";

const VENUES: readonly PriceVenue[] = ["kraken", "coinbase", "bybit", "pyth"];
const ASSET_ID = /^[A-Z0-9]{1,12}$/;
const WEIGHT = /^[1-9][0-9]{0,17}$/;
const ADAPTIVE_DOMAIN = "COX/METHODOLOGY/ADAPTIVE/V1";
export const PROTOCOL_ASSET_IDS = [
  "BTC", "ETH", "SOL", "XRP", "BNB", "TRX", "AVAX", "DOT", "NEAR", "SUI", "APT", "UNI", "ARB",
  "OP", "INJ", "AAVE", "ZEC", "STRK", "HYPE", "TAO", "WLD", "ONDO", "ENA", "ZRO", "FET", "JUP",
  "AERO", "RENDER", "TIA", "W",
] as const;
const NO_VENUES: VenueSymbols = { krakenWs: null, krakenRest: null, coinbase: null, bybit: null };

type Integer = { toString(): string };

export interface ManifestAsset {
  assetId: string;
  venues: VenueSymbols;
  weightNumerator: string;
  weightDenominator: string;
  pythFeedId: number | null;
  classIndex: number;
  epochId: number | null;
}

export interface Manifest {
  digest: string;
  version: string;
  sealed: boolean;
  assets: ManifestAsset[];
  classes: string[];
  cryptoClass: number;
  origin: number;
  mode: PoolMode;
  dynamic: boolean;
}

export function classTable(assets: readonly ManifestAsset[], cryptoClass: number): string[] {
  const size = Math.max(cryptoClass, ...assets.map((a) => a.classIndex)) + 1;
  const classes: (string | undefined)[] = Array.from({ length: size }, () => undefined);
  for (const [index, id] of [...assets.map((a) => [a.classIndex, a.assetId] as const), [cryptoClass, CRYPTO_CLASS] as const]) {
    if (!Number.isSafeInteger(index) || index < 0 || classes[index] !== undefined) throw new Error("ManifestClassesInvalid");
    classes[index] = id;
  }
  if (classes.some((id) => id === undefined)) throw new Error("ManifestClassesInvalid");
  return classes as string[];
}

export type ChainPublication = ReturnType<typeof checkedPublication>;

export function loadProgram(connection: Connection, idlPath: string): Program {
  const idl = JSON.parse(readFileSync(idlPath, "utf8")) as Idl;
  return new anchor.Program(idl, { connection } as anchor.Provider);
}

const hex = (bytes: Uint8Array | number[]): string => Buffer.from(bytes).toString("hex");
const text = (value: Integer | bigint): string => value.toString();

function symbol(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 32) throw new Error("ManifestVenueSymbolInvalid");
  return value;
}

class BorshReader {
  private offset = 0;

  constructor(private readonly bytes: Buffer) {}

  private take(length: number): Buffer {
    if (length < 0 || this.offset + length > this.bytes.length) throw new Error("ManifestTruncated");
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  u32(): number {
    return this.take(4).readUInt32LE(0);
  }

  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }

  bytes32(): Buffer {
    return this.take(32);
  }

  string(): string {
    return this.take(this.u32()).toString("utf8");
  }

  vec<T>(item: () => T): T[] {
    const length = this.u32();
    if (length > 256) throw new Error("ManifestVectorTooLong");
    return Array.from({ length }, item);
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  end(): void {
    if (this.offset !== this.bytes.length) throw new Error("ManifestTrailingBytes");
  }
}

function parseAdaptiveManifest(account: MethodologyAccount): Manifest {
  const reader = new BorshReader(Buffer.from(account.canonical));
  if (reader.string() !== ADAPTIVE_DOMAIN) throw new Error("ManifestDomainInvalid");
  const version = reader.string();
  const roster = reader.vec(() => reader.u8());
  const feeds = reader.vec(() => reader.u32());
  const origin = reader.u64();
  const originPrices = reader.vec(() => reader.u64());
  reader.bytes32();
  reader.bytes32();
  reader.u64();
  reader.u64();
  reader.bytes32();
  reader.string();
  reader.end();
  if (roster.length < 2 || roster.length > PROTOCOL_ASSET_IDS.length || feeds.length !== roster.length || originPrices.length !== roster.length) throw new Error("ManifestRosterInvalid");
  if (roster.some((id, i) => id >= PROTOCOL_ASSET_IDS.length || (i > 0 && roster[i - 1]! >= id))) throw new Error("ManifestRosterInvalid");
  if (Buffer.compare(Buffer.from(roster), Buffer.from(account.roster)) !== 0 || origin.toString() !== account.origin.toString()) throw new Error("ManifestAccountMismatch");
  const originSeconds = Number(origin);
  if (!Number.isSafeInteger(originSeconds) || originSeconds <= 0) throw new Error("ManifestOriginInvalid");
  const assets = roster.map((id, i): ManifestAsset => ({
    assetId: PROTOCOL_ASSET_IDS[id]!,
    venues: NO_VENUES,
    weightNumerator: "1",
    weightDenominator: String(roster.length),
    pythFeedId: feeds[i]!,
    classIndex: i,
    epochId: id,
  }));
  return { digest: hex(account.digest), version, sealed: account.sealed, assets, classes: classTable(assets, assets.length), cryptoClass: assets.length, origin: originSeconds, mode: "adaptive", dynamic: false };
}

function parseDynamicManifest(account: MethodologyAccount): Manifest {
  const manifest = readDynamicManifest(account);
  const count = String(manifest.instruments.length);
  const assets = manifest.instruments.map((instrument): ManifestAsset => ({
    assetId: instrument.symbol,
    venues: NO_VENUES,
    weightNumerator: "1",
    weightDenominator: count,
    pythFeedId: instrument.pythProFeedId,
    classIndex: instrument.classId,
    epochId: instrument.epochId,
  }));
  const origin = Number(account.origin.toString());
  if (!Number.isSafeInteger(origin) || origin <= 0) throw new Error("ManifestOriginInvalid");
  const cryptoClass = dynamicCryptoClass(manifest.schemaVersion);
  return {
    digest: hex(account.digest),
    version: manifest.version.toString(),
    sealed: account.sealed,
    assets,
    classes: classTable(assets, cryptoClass),
    cryptoClass,
    origin,
    mode: "adaptive",
    dynamic: true,
  };
}

export function parseManifest(account: MethodologyAccount): Manifest {
  if (account.schemaVersion === 3) return parseDynamicManifest(account);
  if (account.schemaVersion === 2) return parseAdaptiveManifest(account);
  const canonical = JSON.parse(Buffer.from(account.canonical).toString("utf8")) as unknown;
  if (!Array.isArray(canonical) || canonical[0] !== "COX/METHODOLOGY/V1" || typeof canonical[1] !== "string") throw new Error("ManifestDomainInvalid");
  const tuples = canonical[4];
  if (!Array.isArray(tuples) || tuples.length !== account.roster.length) throw new Error("ManifestRosterInvalid");
  const assets = tuples.map((tuple: unknown, classIndex): ManifestAsset => {
    if (!Array.isArray(tuple) || tuple.length !== 7) throw new Error("ManifestAssetInvalid");
    const [assetId, krakenWs, krakenRest, coinbase, bybit, numerator, denominator] = tuple as unknown[];
    if (typeof assetId !== "string" || !ASSET_ID.test(assetId) || assetId === CRYPTO_CLASS) throw new Error("ManifestAssetInvalid");
    if (typeof numerator !== "string" || typeof denominator !== "string" || !WEIGHT.test(numerator) || !WEIGHT.test(denominator)) throw new Error("ManifestWeightInvalid");
    return { assetId, venues: { krakenWs: symbol(krakenWs), krakenRest: symbol(krakenRest), coinbase: symbol(coinbase), bybit: symbol(bybit) }, weightNumerator: numerator, weightDenominator: denominator, pythFeedId: null, classIndex, epochId: null };
  });
  if (new Set(assets.map((a) => a.assetId)).size !== assets.length) throw new Error("ManifestAssetDuplicate");
  const origin = Number(account.origin.toString());
  if (!Number.isSafeInteger(origin) || origin % 60 !== 0) throw new Error("ManifestOriginInvalid");
  return { digest: hex(account.digest), version: canonical[1], sealed: account.sealed, assets, classes: classTable(assets, assets.length), cryptoClass: assets.length, origin, mode: "minute", dynamic: false };
}

export function classIds(manifest: Manifest): string[] {
  return manifest.classes;
}

export function adoptionProblem(current: Manifest, next: Manifest): string | null {
  if (!next.sealed) return "the new methodology is not sealed";
  if (next.mode !== current.mode || next.dynamic !== current.dynamic) return "the new methodology changes the pool mode";
  if (next.origin !== current.origin) return "the new methodology changes the origin";
  if (next.cryptoClass !== current.cryptoClass) return "the new methodology moves CRYPTO";
  if (next.assets.length <= current.assets.length) return "the new methodology adds no assets";
  for (const [i, asset] of current.assets.entries()) {
    const kept = next.assets[i]!;
    if (kept.assetId !== asset.assetId || kept.classIndex !== asset.classIndex || kept.epochId !== asset.epochId || kept.pythFeedId !== asset.pythFeedId) return `the new methodology changes ${asset.assetId}`;
  }
  if (current.classes.some((id, i) => next.classes[i] !== id)) return "the new methodology reorders the classes";
  const ids = new Set(next.assets.map((asset) => asset.assetId));
  if (ids.size !== next.assets.length) return "the new methodology repeats an asset";
  const epochIds = next.assets.flatMap((asset) => (asset.epochId === null ? [] : [asset.epochId]));
  if (new Set(epochIds).size !== epochIds.length) return "the new methodology repeats an Epoch asset id";
  return null;
}

function venue(code: number): PriceVenue {
  const value = VENUES[code];
  if (!value) throw new Error("PublicationVenueInvalid");
  return value;
}

function step(value: number): FallbackStep {
  if (value !== 0 && value !== 1 && value !== 2 && value !== 3 && value !== 4) throw new Error("PublicationStepInvalid");
  return value;
}

const classState = (backing: Integer | bigint, units: Integer | bigint): ClassState => ({ backing: text(backing), units: text(units) });

export interface PublicationContext {
  program: string;
  poolId: string;
  manifest: Manifest;
  predecessorBatch: number | null;
  finalization: { transaction: string | null; slot: number | null; finalized: boolean };
}

type FeeFields = {
  feeVersion: Integer | bigint;
  feeBps: number;
  feeCap: Integer | bigint;
  feePending: boolean;
  feePendingVersion: Integer | bigint;
  feePendingBps: number;
  feePendingCap: Integer | bigint;
  feePendingCutoff: Integer | bigint;
};

export function feeConfiguration(fields: FeeFields, migrated: boolean): FeeConfiguration {
  return {
    policy: migrated ? COX_FEE_POLICY : null,
    active: { version: text(fields.feeVersion), bps: fields.feeBps, cap: text(fields.feeCap) },
    scheduled: fields.feePending
      ? { version: text(fields.feePendingVersion), bps: fields.feePendingBps, cap: text(fields.feePendingCap), activationCutoff: Number(text(fields.feePendingCutoff)) }
      : null,
  };
}

export function batchOf(publication: ChainPublication, batch: BatchAccount | null): BatchAccount | null {
  if (!batch || batch.phase !== 2) return null;
  if (text(batch.batchId) !== text(publication.state.batch) || text(batch.sequence) !== text(publication.state.sequence)) return null;
  if (hex(batch.snapshotDigest) !== hex(publication.state.snapshot)) throw new Error("PublicationBatchMismatch");
  if (text(batch.fees) !== text(publication.state.feeState?.batchFees ?? 0n)) throw new Error("PublicationBatchFeeMismatch");
  return batch;
}

export function toPublication(publication: ChainPublication, batch: BatchAccount | null, context: PublicationContext): Publication {
  const { state } = publication;
  const ids = classIds(context.manifest);
  const assetCount = context.manifest.assets.length;
  if (state.prices.length !== assetCount || state.references.length !== ids.length || state.classes.length !== ids.length || (batch && batch.fixed.length !== ids.length)) {
    throw new Error("PublicationShapeMismatch");
  }
  const sequence = Number(state.sequence);
  const scheduled = Number(state.batch);
  const missedBatches: number[] = [];
  if (context.predecessorBatch !== null && context.manifest.mode === "minute") for (let b = context.predecessorBatch + 1; b < scheduled; b += 1) missedBatches.push(b);
  const feeState = state.feeState ?? null;
  const committedFees = feeState?.fees ?? 0n;
  const batchFees = feeState?.batchFees ?? 0n;
  let flows: { acceptedDeposits: string; newPayable: string; transferResidual: string; flowResidual: string } | null = null;
  if (batch) {
    const fixedTotal = batch.fixed.reduce((sum, c) => sum + BigInt(c.backing.toString()), 0n);
    const accepted = BigInt(batch.acceptedDeposits.toString());
    const newPayable = BigInt(batch.newPayable.toString());
    const flowResidual = fixedTotal + accepted - newPayable - batchFees - state.active;
    if (flowResidual < 0n) throw new Error("PublicationFlowMismatch");
    flows = { acceptedDeposits: text(accepted), newPayable: text(newPayable), transferResidual: text(batch.transferResidual), flowResidual: text(flowResidual) };
  }
  const vault = state.active + state.pending + state.payable + state.residual + committedFees;
  return {
    identity: {
      program: context.program,
      poolId: context.poolId,
      sequence,
      batch: scheduled,
      predecessorSequence: context.predecessorBatch === null ? null : sequence - 1,
      predecessorBatch: context.predecessorBatch,
      missedBatches,
      cutoff: Number(state.cutoff),
      manifestDigest: hex(state.manifest),
      snapshotDigest: hex(state.snapshot),
      stateDigest: hex(publication.stateDigest),
      committedAt: Number(publication.committedAt.toString()),
      finalization: context.finalization,
    },
    prices: publication.prices.map((p, i) => ({
      assetId: context.manifest.assets[i]!.assetId,
      priceE8: text(p.priceE8),
      venue: venue(p.venue),
      step: step(p.step),
      candleStart: Number(p.candleStart.toString()),
      tradeAgeMinutes: p.tradeAgeMinutes,
    })),
    benchmarkGross: null,
    benchmark: text(state.benchmark),
    references: context.manifest.assets.map((a) => ({ assetId: a.assetId, gross: null, reference: text(state.references[a.classIndex]!) })),
    classes: ids.map((classId, i) => {
      const c = state.classes[i]!;
      const fixed = batch ? batch.fixed[i]! : null;
      return {
        classId,
        classIndex: i,
        transferFactor: null,
        preRevaluation: classState(c.preBacking, c.preUnits),
        fixed: fixed ? classState(fixed.backing, fixed.units) : null,
        final: classState(c.postBacking, c.postUnits),
      };
    }),
    flows: {
      acceptedDeposits: flows?.acceptedDeposits ?? null,
      newPayable: flows?.newPayable ?? null,
      transferResidual: flows?.transferResidual ?? null,
      flowResidual: flows?.flowResidual ?? null,
      fees: text(batchFees),
      executed: state.executed,
      rejected: state.rejected,
    },
    ledger: { active: text(state.active), pending: text(state.pending), refundable: null, payable: text(state.payable), residual: text(state.residual), fees: text(committedFees), vault: text(vault) },
    fees: feeState ? feeConfiguration(feeState, true) : null,
    receiptRoot: hex(state.receiptRoot),
  };
}
