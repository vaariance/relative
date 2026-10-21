import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdaptivePlan, AdaptiveSnapshot } from "./adaptive.ts";
import { ContinuousBenchmark, type BenchmarkAnchor, type BenchmarkObservation } from "./benchmark.ts";
import { atomicWrite } from "./journal.ts";
import type { PythBatch } from "./pyth-cache.ts";

interface StoredObservation {
  id: string; universeDigest: string; timestampUs: string; benchmark: string;
  prices: { assetId: string; feedId: string; priceE8: string }[]; signedPayload: string;
}
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const encode = (value: BenchmarkObservation): StoredObservation => ({ ...value,
  timestampUs: value.timestampUs.toString(), benchmark: value.benchmark.toString(),
  prices: value.prices.map(price => ({ ...price, priceE8: price.priceE8.toString() })),
  signedPayload: Buffer.from(value.signedPayload).toString("base64") });
function decode(value: StoredObservation): BenchmarkObservation {
  if (!value || !digest(value.id) || !digest(value.universeDigest) || !/^(0|[1-9][0-9]*)$/.test(value.timestampUs)
      || !/^[1-9][0-9]*$/.test(value.benchmark) || !Array.isArray(value.prices) || value.prices.length < 2
      || typeof value.signedPayload !== "string") throw new Error("InvalidBenchmarkArchive");
  const signedPayload = Buffer.from(value.signedPayload, "base64");
  if (!signedPayload.length || signedPayload.toString("base64") !== value.signedPayload
      || value.prices.some(price => !price || typeof price.assetId !== "string" || !price.assetId
        || !/^[1-9][0-9]*$/.test(price.feedId) || !/^[1-9][0-9]*$/.test(price.priceE8))
      || new Set(value.prices.map(price => price.assetId)).size !== value.prices.length
      || new Set(value.prices.map(price => price.feedId)).size !== value.prices.length) throw new Error("InvalidBenchmarkArchive");
  const result = { ...value, timestampUs: BigInt(value.timestampUs), benchmark: BigInt(value.benchmark),
    prices: value.prices.map(price => ({ ...price, priceE8: BigInt(price.priceE8) })), signedPayload };
  const id = createHash("sha256").update(JSON.stringify(["RELATIVE/GEOMETRIC-OBSERVATION/V1", result.universeDigest,
    result.timestampUs.toString(), result.benchmark.toString(), result.prices.map(price => [price.assetId, price.feedId, price.priceE8.toString()])])).digest("hex");
  if (id !== result.id) throw new Error("BenchmarkArchiveDigestMismatch");
  return result;
}
async function readOptional<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export class BenchmarkArchive {
  constructor(readonly directory: string) {}
  private path(universe: string, timestampUs: bigint): string {
    if (!digest(universe) || timestampUs < 0n) throw new Error("InvalidBenchmarkArchiveKey");
    return join(this.directory, universe, (timestampUs / 3_600_000_000n).toString(), `${timestampUs}.json`);
  }
  async append(value: BenchmarkObservation): Promise<void> {
    const stored = encode(value); decode(stored);
    const path = this.path(value.universeDigest, value.timestampUs);
    const existing = await readOptional<StoredObservation>(path);
    if (existing && JSON.stringify(existing) !== JSON.stringify(stored)) throw new Error("ConflictingBenchmarkArchive");
    if (!existing) await atomicWrite(path, stored);
    await atomicWrite(join(this.directory, "latest.json"), stored);
  }
  async latest(): Promise<BenchmarkObservation | null> {
    const stored = await readOptional<StoredObservation>(join(this.directory, "latest.json"));
    return stored ? decode(stored) : null;
  }
  async exact(universe: string, timestampUs: bigint): Promise<BenchmarkObservation | null> {
    const stored = await readOptional<StoredObservation>(this.path(universe, timestampUs));
    if (!stored) return null;
    const value = decode(stored);
    if (value.timestampUs !== timestampUs || value.universeDigest !== universe) throw new Error("BenchmarkArchiveIdentityMismatch");
    return value;
  }
  async activate(anchor: BenchmarkAnchor): Promise<void> {
    await atomicWrite(join(this.directory, "anchor.json"), { ...anchor, timestampUs: anchor.timestampUs.toString(),
      benchmark: anchor.benchmark.toString(), assets: anchor.assets.map(asset => ({ ...asset, priceE8: asset.priceE8.toString() })) });
  }
  async verifyAnchor(anchor: BenchmarkAnchor): Promise<void> {
    const expected = { ...anchor, timestampUs: anchor.timestampUs.toString(), benchmark: anchor.benchmark.toString(),
      assets: anchor.assets.map(asset => ({ ...asset, priceE8: asset.priceE8.toString() })) };
    const stored = await readOptional(join(this.directory, "anchor.json"));
    if (stored === null) await this.activate(anchor);
    else if (JSON.stringify(stored) !== JSON.stringify(expected)) throw new Error("BenchmarkArchiveAnchorMismatch");
  }
}

export interface SnapshotServiceOptions {
  readonly anchor: BenchmarkAnchor;
  readonly methodologyId: string;
  readonly maxEntryAgeMs: number;
  readonly nowMs: () => number;
  readonly verifyPythBatch: (batch: PythBatch) => Promise<void>;
  readonly archive: BenchmarkArchive;
}

export class AdaptiveSnapshots {
  private constructor(private readonly options: SnapshotServiceOptions, private readonly benchmark: ContinuousBenchmark) {}
  static async open(options: SnapshotServiceOptions): Promise<AdaptiveSnapshots> {
    if (!options.methodologyId || !Number.isSafeInteger(options.maxEntryAgeMs) || options.maxEntryAgeMs < 0) throw new Error("InvalidSnapshotServiceConfiguration");
    await options.archive.verifyAnchor(options.anchor);
    const latest = await options.archive.latest();
    const benchmark = new ContinuousBenchmark(options.anchor, { verifyPythBatch: options.verifyPythBatch,
      history: options.archive }, latest ?? undefined);
    return new AdaptiveSnapshots(options, benchmark);
  }
  ingest(batch: PythBatch): Promise<BenchmarkObservation> { return this.benchmark.observe(batch); }
  preview(): BenchmarkObservation | null { return this.benchmark.preview(); }
  async select(plan: AdaptivePlan): Promise<AdaptiveSnapshot | null> {
    if (plan.methodologyId !== this.options.methodologyId) throw new Error("SnapshotMethodologyMismatch");
    const value = plan.closingTimestampMs === null ? this.preview()
      : await this.options.archive.exact(this.options.anchor.universeDigest, BigInt(plan.closingTimestampMs) * 1000n);
    if (!value) return null;
    if (value.timestampUs % 1000n !== 0n || value.timestampUs / 1000n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const timestamp = Number(value.timestampUs / 1000n), now = this.options.nowMs();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("InvalidSnapshotClock");
    if (timestamp > now || (plan.closingTimestampMs === null && (now - timestamp > this.options.maxEntryAgeMs
      || plan.work.some(work => work.kind !== "epoch-close" && timestamp <= work.eligibleAfterMs)))) return null;
    const prices = new Map(value.prices.map(price => [price.assetId, price.priceE8]));
    if (plan.requiredAssetIds.some(asset => !prices.has(asset))) return null;
    return { id: value.id, previousStateId: plan.stateId, sequence: plan.sequence, oracleTimestampMs: timestamp,
      methodologyId: this.options.methodologyId, benchmark: value.benchmark,
      prices: value.prices.map(price => ({ assetId: price.assetId, price: price.priceE8 })), oracleEvidence: new Uint8Array(value.signedPayload) };
  }
}
