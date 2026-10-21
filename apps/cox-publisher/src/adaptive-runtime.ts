import type { AdaptivePublisher, AdaptiveTick } from "./adaptive.ts";
import type { ChainWake, FeedHandle, FeedStatus, UnverifiedPythUpdate } from "./live-feeds.ts";
import type { PythBatch } from "./pyth-cache.ts";

export interface AdaptiveRuntimePorts {
  readonly publisher: Pick<AdaptivePublisher, "tick">;
  readonly prices: { ingest(batch: PythBatch): Promise<unknown> };
  readonly feeds: {
    prices(update: (value: UnverifiedPythUpdate) => void, status: (value: FeedStatus) => void): Promise<FeedHandle>;
    chain(wake: (value: ChainWake) => void, status: (value: FeedStatus) => void): Promise<FeedHandle>;
  };
  readonly clock: { nowMs(): number };
  readonly timers: { set(callback: () => void, delayMs: number): unknown; clear(timer: unknown): void };
  readonly report: (event: "tick" | "publisher-error" | "price-error" | "price-backpressure" | "stream-unavailable", tick?: AdaptiveTick) => void;
}
export interface AdaptiveRuntimeOptions { readonly idleReconcileMs: number; readonly retryMs: number; readonly maxQueuedPrices: number }

export class AdaptiveRuntime {
  private stopped = true;
  private timer: unknown;
  private scheduledAt = Infinity;
  private handles: FeedHandle[] = [];
  private running: Promise<void> | null = null;
  private again = false;
  private priceOperation: Promise<void> = Promise.resolve();
  private queuedPrices = 0;
  constructor(private readonly ports: AdaptiveRuntimePorts, private readonly options: AdaptiveRuntimeOptions) {
    if ([options.idleReconcileMs, options.retryMs, options.maxQueuedPrices].some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error("InvalidAdaptiveRuntimeOptions");
    }
  }
  async start(): Promise<void> {
    if (!this.stopped) throw new Error("AdaptiveRuntimeAlreadyStarted");
    this.stopped = false;
    try {
      const prices = await this.ports.feeds.prices(update => this.ingest(update.batch), value => this.status(value));
      if (this.stopped) { prices.stop(); return; }
      this.handles.push(prices);
      try {
        const chain = await this.ports.feeds.chain(value => {
          if (value.transaction || value.reconcile) this.wake();
        }, value => this.status(value));
        if (this.stopped) chain.stop(); else this.handles.push(chain);
      } catch { this.report("stream-unavailable"); }
      await this.wake();
    } catch (error) { await this.stop(); throw error; }
  }
  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.clearTimer();
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again && !this.stopped) { this.again = false; this.schedule(this.ports.clock.nowMs()); }
    });
    return this.running;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    for (const handle of this.handles.splice(0)) handle.stop();
    await this.running;
    await this.priceOperation;
  }
  private ingest(batch: PythBatch): void {
    if (this.stopped) return;
    if (this.queuedPrices >= this.options.maxQueuedPrices) { this.report("price-backpressure"); return; }
    const copied: PythBatch = { timestampUs: batch.timestampUs, prices: batch.prices.map(value => ({ ...value })), signedSolana: new Uint8Array(batch.signedSolana) };
    this.queuedPrices++;
    this.priceOperation = this.priceOperation.then(async () => {
      try { await this.ports.prices.ingest(copied); }
      catch { this.report("price-error"); }
      finally { this.queuedPrices--; }
    });
  }
  private async run(): Promise<void> {
    try {
      const tick = await this.ports.publisher.tick();
      if (this.stopped) return;
      this.report("tick", tick);
      this.schedule(Math.min(tick.nextWakeAtMs ?? Infinity, this.ports.clock.nowMs() + this.options.idleReconcileMs));
    } catch {
      if (!this.stopped) { this.report("publisher-error"); this.schedule(this.ports.clock.nowMs() + this.options.retryMs); }
    }
  }
  private status(value: FeedStatus): void {
    if (this.stopped) return;
    if (value === "unavailable") { this.report("stream-unavailable"); this.schedule(this.ports.clock.nowMs() + this.options.retryMs); }
  }
  private schedule(at: number): void {
    if (this.stopped || at >= this.scheduledAt) return;
    this.clearTimer();
    this.scheduledAt = at;
    this.timer = this.ports.timers.set(() => { this.timer = undefined; this.scheduledAt = Infinity; void this.wake(); }, Math.max(0, at - this.ports.clock.nowMs()));
  }
  private clearTimer(): void {
    if (this.timer !== undefined) this.ports.timers.clear(this.timer);
    this.timer = undefined;
    this.scheduledAt = Infinity;
  }
  private report(event: Parameters<AdaptiveRuntimePorts["report"]>[0], tick?: AdaptiveTick): void { try { this.ports.report(event, tick); } catch {} }
}
