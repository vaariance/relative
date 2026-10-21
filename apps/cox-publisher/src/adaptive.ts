export type AdaptivePool = "basic" | "epoch";

export interface PendingExecution {
  readonly kind: "basic-request" | "epoch-prediction";
  readonly id: string;
  readonly eligibleAfterMs: number;
  readonly assetIds: readonly string[];
}

export interface PendingEpochClose {
  readonly kind: "epoch-close";
  readonly id: string;
  readonly closingTimestampMs: number;
  readonly assetIds: readonly string[];
}

export type AdaptiveWork = PendingExecution | PendingEpochClose;

export interface AdaptiveMaintenance { readonly id: string; readonly pool: AdaptivePool }

export interface AdaptiveChainState {
  readonly stateId: string;
  readonly methodologyId: string;
  readonly nextSequence: bigint;
  readonly requiredAssetIds: readonly string[];
  readonly pending: readonly AdaptiveWork[];
  readonly maintenance?: readonly AdaptiveMaintenance[];
  readonly nextClosingDeadlineMs: number | null;
}

export interface AdaptiveSnapshot {
  readonly id: string;
  readonly previousStateId: string;
  readonly sequence: bigint;
  readonly oracleTimestampMs: number;
  readonly methodologyId: string;
  readonly benchmark: bigint;
  readonly prices: readonly { readonly assetId: string; readonly price: bigint }[];
  readonly oracleEvidence: Uint8Array;
}

export interface AdaptivePlan {
  readonly stateId: string;
  readonly methodologyId: string;
  readonly sequence: bigint;
  readonly work: readonly AdaptiveWork[];
  readonly requiredAssetIds: readonly string[];
  readonly closingTimestampMs: number | null;
}

export interface PreparedAdaptivePublication {
  readonly id: string;
  readonly transaction: Uint8Array;
}

export interface AdaptiveCheckpoint {
  readonly nextAttemptAtMs: number;
  readonly nextPool: AdaptivePool;
  readonly nextWork: "entries" | "closing";
  readonly inFlight: PreparedAdaptivePublication | null;
}

export interface AdaptivePorts {
  readonly clock: { nowMs(): number };
  readonly chain: { read(): Promise<AdaptiveChainState> };
  readonly snapshots: { select(plan: AdaptivePlan): Promise<AdaptiveSnapshot | null> };
  readonly executor: {
    prepare(plan: AdaptivePlan, snapshot: AdaptiveSnapshot): Promise<PreparedAdaptivePublication>;
    prepareMaintenance?(state: AdaptiveChainState, work: AdaptiveMaintenance): Promise<PreparedAdaptivePublication>;
    submit(publication: PreparedAdaptivePublication): Promise<void>;
    reconcile(publication: PreparedAdaptivePublication): Promise<"pending" | "accepted" | "expired">;
  };
  readonly checkpoint: {
    load(): Promise<AdaptiveCheckpoint | null>;
    save(checkpoint: AdaptiveCheckpoint): Promise<void>;
  };
}

export interface AdaptiveOptions {
  readonly maxBatchSize: number;
  readonly maxEntrySnapshotAgeMs: number;
}

export interface AdaptiveTick {
  readonly status: "idle" | "waiting" | "in-flight" | "submitted";
  readonly nextWakeAtMs: number | null;
}

const CADENCE_MS = 1_000;

export class AdaptivePublisher {
  private readonly ports: AdaptivePorts;
  private readonly options: AdaptiveOptions;
  private checkpoint: AdaptiveCheckpoint | null = null;
  private running: Promise<AdaptiveTick> | null = null;
  private wakeVersion = 0;

  constructor(ports: AdaptivePorts, options: AdaptiveOptions) {
    if (!Number.isSafeInteger(options.maxBatchSize) || options.maxBatchSize < 1) {
      throw new Error("maxBatchSize must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.maxEntrySnapshotAgeMs) || options.maxEntrySnapshotAgeMs < 0) {
      throw new Error("maxEntrySnapshotAgeMs must be a nonnegative safe integer");
    }
    this.ports = ports;
    this.options = Object.freeze({ ...options });
  }

  wake(): Promise<AdaptiveTick> {
    this.wakeVersion += 1;
    return this.tick();
  }

  tick(): Promise<AdaptiveTick> {
    if (this.running) return this.running;
    const version = this.wakeVersion;
    this.running = this.run().then((result) => {
      if (version === this.wakeVersion) return result;
      return { ...result, nextWakeAtMs: Math.min(result.nextWakeAtMs ?? Infinity, this.ports.clock.nowMs()) };
    }).finally(() => { this.running = null; });
    return this.running;
  }

  private async save(checkpoint: AdaptiveCheckpoint): Promise<void> {
    await this.ports.checkpoint.save(checkpoint);
    this.checkpoint = checkpoint;
  }

  private async run(): Promise<AdaptiveTick> {
    this.checkpoint ??= await this.ports.checkpoint.load() ?? {
      nextAttemptAtMs: 0, nextPool: "basic", nextWork: "closing", inFlight: null,
    };
    const nowMs = this.ports.clock.nowMs();
    if (this.checkpoint.inFlight) {
      const status = await this.ports.executor.reconcile(this.checkpoint.inFlight);
      if (status === "pending") {
        return { status: "in-flight", nextWakeAtMs: nowMs + CADENCE_MS };
      }
      await this.save({ ...this.checkpoint, inFlight: null });
    }
    const state = await this.ports.chain.read();
    const maintenance = state.maintenance?.[0];
    if (maintenance) {
      if (nowMs < this.checkpoint.nextAttemptAtMs) return { status: "waiting", nextWakeAtMs: this.checkpoint.nextAttemptAtMs };
      if (!this.ports.executor.prepareMaintenance) throw new Error("AdaptiveMaintenanceExecutorRequired");
      await this.save({ ...this.checkpoint, nextAttemptAtMs: nowMs + CADENCE_MS });
      const prepared = await this.ports.executor.prepareMaintenance(state, maintenance);
      await this.save({ ...this.checkpoint!, inFlight: prepared });
      await this.ports.executor.submit(prepared);
      return { status: "submitted", nextWakeAtMs: nowMs + CADENCE_MS };
    }
    const unique = new Map<string, AdaptiveWork>();
    for (const work of state.pending) {
      const key = `${work.kind}:${work.id}`;
      if (unique.has(key)) throw new Error("duplicate authoritative work identity");
      unique.set(key, work);
    }
    const eligible = [...unique.values()].filter((work) => work.kind === "epoch-close"
      ? work.closingTimestampMs <= nowMs : work.eligibleAfterMs < nowMs);
    const future = [...unique.values()].map((work) => work.kind === "epoch-close"
      ? work.closingTimestampMs : work.eligibleAfterMs + 1).filter((at) => at > nowMs);
    const deadline = state.nextClosingDeadlineMs;
    const nextDeadline = Math.min(...future, deadline !== null && deadline > nowMs ? deadline : Infinity);
    if (eligible.length === 0) {
      return { status: "idle", nextWakeAtMs: Number.isFinite(nextDeadline) ? nextDeadline : null };
    }
    if (nowMs < this.checkpoint.nextAttemptAtMs) {
      return { status: "waiting", nextWakeAtMs: Math.min(this.checkpoint.nextAttemptAtMs, nextDeadline) };
    }
    const selected = selectWork(eligible, this.options.maxBatchSize, this.checkpoint.nextPool, this.checkpoint.nextWork);
    const plan: AdaptivePlan = {
      stateId: state.stateId,
      methodologyId: state.methodologyId,
      sequence: state.nextSequence,
      work: selected.work,
      requiredAssetIds: [...new Set([...state.requiredAssetIds, ...selected.work.flatMap((work) => work.assetIds)])].sort(),
      closingTimestampMs: selected.work.find((work) => work.kind === "epoch-close")?.closingTimestampMs ?? null,
    };
    await this.save({ ...this.checkpoint, nextAttemptAtMs: nowMs + CADENCE_MS });
    const snapshot = await this.ports.snapshots.select(plan);
    if (!snapshot) return { status: "waiting", nextWakeAtMs: nowMs + CADENCE_MS };
    validateSnapshot(snapshot, plan, nowMs, this.options.maxEntrySnapshotAgeMs);
    const prepared = await this.ports.executor.prepare(plan, snapshot);
    await this.save({ ...this.checkpoint!, nextPool: selected.nextPool, nextWork: selected.nextWork, inFlight: prepared });
    await this.ports.executor.submit(prepared);
    return { status: "submitted", nextWakeAtMs: Math.min(nowMs + CADENCE_MS, nextDeadline) };
  }
}

function selectWork(work: readonly AdaptiveWork[], limit: number, nextPool: AdaptivePool, nextWork: "entries" | "closing"): {
  work: AdaptiveWork[]; nextPool: AdaptivePool; nextWork: "entries" | "closing";
} {
  const closes = work.filter((item): item is PendingEpochClose => item.kind === "epoch-close")
    .sort((a, b) => a.closingTimestampMs - b.closingTimestampMs || a.id.localeCompare(b.id));
  if (closes.length && (nextWork === "closing" || work.every((item) => item.kind === "epoch-close"))) {
    return { work: closes.filter((item) => item.closingTimestampMs === closes[0].closingTimestampMs).slice(0, limit),
      nextPool, nextWork: "entries" };
  }
  const queues = {
    basic: work.filter((item): item is PendingExecution => item.kind === "basic-request"),
    epoch: work.filter((item): item is PendingExecution => item.kind === "epoch-prediction"),
  };
  for (const queue of Object.values(queues)) {
    queue.sort((a, b) => a.eligibleAfterMs - b.eligibleAfterMs || a.id.localeCompare(b.id));
  }
  const selected: AdaptiveWork[] = [];
  let pool = nextPool;
  while (selected.length < limit && (queues.basic.length || queues.epoch.length)) {
    const item = queues[pool].shift();
    if (item) selected.push(item);
    pool = pool === "basic" ? "epoch" : "basic";
  }
  return { work: selected, nextPool: pool, nextWork: "closing" };
}

function validateSnapshot(snapshot: AdaptiveSnapshot, plan: AdaptivePlan, nowMs: number, maxAgeMs: number): void {
  if (snapshot.previousStateId !== plan.stateId || snapshot.sequence !== plan.sequence) {
    throw new Error("snapshot predecessor or sequence mismatch");
  }
  if (snapshot.benchmark <= 0n || snapshot.methodologyId !== plan.methodologyId || !snapshot.id) {
    throw new Error("invalid benchmark snapshot");
  }
  if (!Number.isSafeInteger(snapshot.oracleTimestampMs) || snapshot.oracleTimestampMs > nowMs) {
    throw new Error("invalid snapshot timestamp");
  }
  if (plan.closingTimestampMs !== null) {
    if (snapshot.oracleTimestampMs !== plan.closingTimestampMs) throw new Error("closing timestamp mismatch");
  } else if (nowMs - snapshot.oracleTimestampMs > maxAgeMs || plan.work.some((work) =>
    work.kind !== "epoch-close" && snapshot.oracleTimestampMs <= work.eligibleAfterMs)) {
    throw new Error("ineligible entry snapshot");
  }
  const assets = new Set<string>();
  for (const price of snapshot.prices) {
    if (price.price <= 0n || assets.has(price.assetId)) throw new Error("invalid or duplicate asset price");
    assets.add(price.assetId);
  }
  if (plan.requiredAssetIds.some((id) => !assets.has(id))) throw new Error("missing required asset price");
}
