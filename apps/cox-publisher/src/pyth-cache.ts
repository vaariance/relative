import { createHash } from "node:crypto";

export interface PythBatch {
  readonly timestampUs: bigint;
  readonly prices: readonly {
    readonly feedId: string;
    readonly price: bigint;
    readonly exponent: number;
    readonly confidence: bigint;
  }[];
  readonly signedSolana: Uint8Array;
}

export interface CachedPythBatch extends PythBatch {
  readonly id: string;
}

export interface PythCachePorts {
  readonly verifySignedPayloadAndParsedBinding: (batch: PythBatch) => Promise<void>;
  readonly store: {
    load(): Promise<readonly PythBatch[]>;
    save(batches: readonly PythBatch[]): Promise<void>;
  };
}

export class PythSnapshotCache {
  private readonly ports: PythCachePorts;
  private readonly maxBatches: number;
  private batches: readonly CachedPythBatch[] | null = null;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(ports: PythCachePorts, maxBatches: number) {
    if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) {
      throw new Error("maxBatches must be a positive safe integer");
    }
    this.ports = ports;
    this.maxBatches = maxBatches;
  }

  ingest(batch: PythBatch): Promise<void> {
    const input = cloneBatch(batch);
    return this.exclusive(async () => {
      await this.load();
      const validated = await this.validate(input);
      if (this.batches!.some((item) => item.id === validated.id)) return;
      assertConsistent(this.batches!, validated);
      const next = [...this.batches!, validated].sort(compareBatches).slice(-this.maxBatches);
      await this.ports.store.save(next.map(cloneBatch));
      this.batches = next;
    });
  }

  entry(feedIds: readonly string[], afterTimestampUs: bigint, nowUs: bigint, maxAgeUs: bigint): Promise<CachedPythBatch | null> {
    if (afterTimestampUs < 0n || nowUs < 0n || maxAgeUs < 0n) {
      return Promise.reject(new Error("invalid entry timestamp bounds"));
    }
    return this.select(feedIds, (batch) => batch.timestampUs > afterTimestampUs
      && batch.timestampUs <= nowUs && nowUs - batch.timestampUs <= maxAgeUs);
  }

  closing(feedIds: readonly string[], closingTimestampUs: bigint): Promise<CachedPythBatch | null> {
    if (closingTimestampUs < 0n) return Promise.reject(new Error("invalid closing timestamp"));
    return this.select(feedIds, (batch) => batch.timestampUs === closingTimestampUs);
  }

  private select(feedIds: readonly string[], eligible: (batch: CachedPythBatch) => boolean): Promise<CachedPythBatch | null> {
    const required = new Set(feedIds);
    if (required.size === 0 || required.size !== feedIds.length || feedIds.some((id) => !id)) {
      return Promise.reject(new Error("required feed set must be nonempty and distinct"));
    }
    return this.exclusive(async () => {
      await this.load();
      const batch = this.batches!.find((candidate) => eligible(candidate)
        && [...required].every((feedId) => candidate.prices.some((price) => price.feedId === feedId)));
      return batch ? { ...cloneBatch(batch), id: batch.id } : null;
    });
  }

  private async load(): Promise<void> {
    if (this.batches) return;
    const stored = await this.ports.store.load();
    const batches: CachedPythBatch[] = [];
    for (const batch of stored) {
      const validated = await this.validate(cloneBatch(batch));
      assertConsistent(batches, validated);
      if (!batches.some((prior) => prior.id === validated.id)) batches.push(validated);
    }
    this.batches = batches.sort(compareBatches).slice(-this.maxBatches);
  }

  private async validate(batch: PythBatch): Promise<CachedPythBatch> {
    if (batch.timestampUs < 0n || batch.signedSolana.length === 0 || batch.prices.length === 0) {
      throw new Error("invalid Pyth batch");
    }
    const seen = new Set<string>();
    for (const price of batch.prices) {
      if (!price.feedId || seen.has(price.feedId) || price.price <= 0n || price.confidence < 0n
        || !Number.isSafeInteger(price.exponent)) throw new Error("invalid Pyth price");
      seen.add(price.feedId);
    }
    await this.ports.verifySignedPayloadAndParsedBinding(cloneBatch(batch));
    return { ...batch, id: createHash("sha256").update(batch.signedSolana).digest("hex") };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation);
    this.operation = next.catch(() => {});
    return next;
  }
}

function compareBatches(a: CachedPythBatch, b: CachedPythBatch): number {
  return a.timestampUs === b.timestampUs ? a.id.localeCompare(b.id) : a.timestampUs < b.timestampUs ? -1 : 1;
}

function assertConsistent(batches: readonly CachedPythBatch[], batch: CachedPythBatch): void {
  for (const existing of batches) {
    if (existing.timestampUs !== batch.timestampUs) continue;
    for (const price of batch.prices) {
      const prior = existing.prices.find((item) => item.feedId === price.feedId);
      if (prior && (prior.price !== price.price || prior.exponent !== price.exponent || prior.confidence !== price.confidence)) {
        throw new Error("conflicting Pyth prices at the same timestamp");
      }
    }
  }
}

function cloneBatch(batch: PythBatch): PythBatch {
  return { timestampUs: batch.timestampUs, prices: batch.prices.map((price) => ({ ...price })),
    signedSolana: new Uint8Array(batch.signedSolana) };
}
