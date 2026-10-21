import { createHash } from "node:crypto";
import { geometricBenchmark } from "@cox/methodology/geometric";
import type { PythBatch } from "./pyth-cache.ts";

export interface BenchmarkAnchor {
  readonly universeDigest: string;
  readonly timestampUs: bigint;
  readonly benchmark: bigint;
  readonly assets: readonly { readonly assetId: string; readonly feedId: string; readonly priceE8: bigint }[];
}
export interface BenchmarkObservation {
  readonly id: string;
  readonly universeDigest: string;
  readonly timestampUs: bigint;
  readonly benchmark: bigint;
  readonly prices: readonly { readonly assetId: string; readonly feedId: string; readonly priceE8: bigint }[];
  readonly signedPayload: Uint8Array;
}
export interface BenchmarkPorts {
  readonly verifyPythBatch: (batch: PythBatch) => Promise<void>;
  readonly history: {
    append(observation: BenchmarkObservation): Promise<void>;
    activate(anchor: BenchmarkAnchor): Promise<void>;
  };
}

function immutableAnchor(anchor: BenchmarkAnchor): BenchmarkAnchor {
  if (!/^[a-f0-9]{64}$/.test(anchor.universeDigest) || anchor.timestampUs < 0n || anchor.benchmark <= 0n
      || anchor.assets.length < 2 || anchor.assets.length > 255
      || new Set(anchor.assets.map(asset => asset.assetId)).size !== anchor.assets.length
      || new Set(anchor.assets.map(asset => asset.feedId)).size !== anchor.assets.length
      || anchor.assets.some(asset => !asset.assetId || !/^[1-9][0-9]*$/.test(asset.feedId) || asset.priceE8 <= 0n || asset.priceE8 > (1n << 64n) - 1n)) {
    throw new Error("InvalidBenchmarkAnchor");
  }
  return Object.freeze({ ...anchor, assets: Object.freeze(anchor.assets.map(asset => Object.freeze({ ...asset }))) });
}

export function pythPriceE8(price: bigint, exponent: number): bigint {
  if (price <= 0n || !Number.isSafeInteger(exponent) || exponent < -18 || exponent > 18) throw new Error("InvalidBenchmarkPrice");
  const shift = exponent + 8;
  const divisor = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  const numerator = shift >= 0 ? price * 10n ** BigInt(shift) : price;
  const rounded = (numerator + divisor / 2n) / divisor;
  if (rounded <= 0n || rounded > (1n << 64n) - 1n) throw new Error("InvalidBenchmarkPrice");
  return rounded;
}

export class ContinuousBenchmark {
  private anchor: BenchmarkAnchor;
  private latest: BenchmarkObservation | null = null;
  private latestFeeds: ReadonlyMap<string, bigint> | null = null;
  private operation: Promise<unknown> = Promise.resolve();
  constructor(anchor: BenchmarkAnchor, private readonly ports: BenchmarkPorts, resumed?: BenchmarkObservation) {
    this.anchor = immutableAnchor(anchor);
    if (resumed) {
      const prices = resumed.prices;
      const expectedId = createHash("sha256").update(JSON.stringify(["RELATIVE/GEOMETRIC-OBSERVATION/V1", resumed.universeDigest,
        resumed.timestampUs.toString(), resumed.benchmark.toString(), prices.map(price => [price.assetId, price.feedId, price.priceE8.toString()])])).digest("hex");
      if (resumed.universeDigest !== anchor.universeDigest || resumed.timestampUs < anchor.timestampUs
          || !resumed.signedPayload.length || resumed.id !== expectedId || prices.length !== anchor.assets.length
          || prices.some((price, index) => price.assetId !== anchor.assets[index]!.assetId || price.feedId !== anchor.assets[index]!.feedId)
          || resumed.benchmark !== geometricBenchmark(anchor.assets.map(asset => asset.priceE8), prices.map(price => price.priceE8), anchor.benchmark)) {
        throw new Error("InvalidBenchmarkResume");
      }
      this.latest = clone(resumed);
      this.latestFeeds = new Map(prices.map(price => [price.feedId, price.priceE8]));
    }
  }

  observe(batch: PythBatch): Promise<BenchmarkObservation> {
    const copied: PythBatch = { timestampUs: batch.timestampUs, prices: batch.prices.map(price => ({ ...price })), signedSolana: new Uint8Array(batch.signedSolana) };
    return this.exclusive(async () => {
      await this.ports.verifyPythBatch(copied);
      if (copied.timestampUs < this.anchor.timestampUs || (this.latest && copied.timestampUs < this.latest.timestampUs)) throw new Error("BenchmarkTimeRegression");
      const prices = this.anchor.assets.map(asset => {
        const price = copied.prices.find(item => item.feedId === asset.feedId);
        if (!price) throw new Error("IncompleteBenchmarkBatch");
        return { assetId: asset.assetId, feedId: asset.feedId, priceE8: pythPriceE8(price.price, price.exponent) };
      });
      const benchmark = geometricBenchmark(this.anchor.assets.map(asset => asset.priceE8), prices.map(price => price.priceE8), this.anchor.benchmark);
      const id = createHash("sha256").update(JSON.stringify(["RELATIVE/GEOMETRIC-OBSERVATION/V1", this.anchor.universeDigest,
        copied.timestampUs.toString(), benchmark.toString(), prices.map(price => [price.assetId, price.feedId, price.priceE8.toString()])])).digest("hex");
      if (this.latest?.timestampUs === copied.timestampUs) {
        if (this.latest.id !== id) throw new Error("ConflictingBenchmarkObservation");
        return clone(this.latest);
      }
      const observation: BenchmarkObservation = { id, universeDigest: this.anchor.universeDigest, timestampUs: copied.timestampUs,
        benchmark, prices, signedPayload: new Uint8Array(copied.signedSolana) };
      const latestFeeds = new Map(copied.prices.map(price => [price.feedId, pythPriceE8(price.price, price.exponent)]));
      await this.ports.history.append(clone(observation));
      this.latest = observation;
      this.latestFeeds = latestFeeds;
      return clone(observation);
    });
  }

  preview(): BenchmarkObservation | null { return this.latest ? clone(this.latest) : null; }

  activate(anchor: BenchmarkAnchor): Promise<void> {
    const checked = immutableAnchor(anchor);
    return this.exclusive(async () => {
      if (!this.latest || checked.timestampUs !== this.latest.timestampUs || checked.benchmark !== this.latest.benchmark
          || checked.universeDigest === this.anchor.universeDigest || checked.timestampUs <= this.anchor.timestampUs
          || this.anchor.assets.some(prior => !checked.assets.some(asset => asset.assetId === prior.assetId && asset.feedId === prior.feedId))) {
        throw new Error("InvalidBenchmarkUniverseTransition");
      }
      for (const prior of this.latest.prices) {
        if (checked.assets.find(asset => asset.assetId === prior.assetId)?.priceE8 !== prior.priceE8) throw new Error("InvalidBenchmarkUniverseTransition");
      }
      if (checked.assets.some(asset => this.latestFeeds?.get(asset.feedId) !== asset.priceE8)) throw new Error("InvalidBenchmarkUniverseTransition");
      await this.ports.history.activate(checked);
      this.anchor = checked;
      this.latest = null;
      this.latestFeeds = null;
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation); this.operation = next.catch(() => {}); return next;
  }
}

function clone(observation: BenchmarkObservation): BenchmarkObservation {
  return { ...observation, prices: observation.prices.map(price => ({ ...price })), signedPayload: new Uint8Array(observation.signedPayload) };
}
