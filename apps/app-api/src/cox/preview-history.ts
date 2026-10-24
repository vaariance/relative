import type { PreviewHistory as PreviewHistoryData, PreviewHistoryPoint, PreviewRecord } from "@eox/app-api";
import { parsePreview, PreviewInvalid, type PreviewIdentity, type PreviewStore } from "./preview.js";
import { ChainChangeInvalid } from "./chain-changes.js";

export const HISTORY_STEPS = [1, 60, 300, 3600] as const;
export type HistoryStep = (typeof HISTORY_STEPS)[number];
export const MAX_HISTORY_POINTS = 1_440;
const SECOND_RETENTION = 3_600;
const MINUTE_RETENTION = 7 * 24 * 3_600;
const BACKFILL_CONCURRENCY = 16;
const SETTLE_SECONDS = 5;

type Point = Omit<PreviewHistoryPoint, "end"> & { assets: readonly string[] };
type Result = { data: PreviewHistoryData; complete: boolean };

export class HistoryRangeError extends Error {}

export interface PreviewHistoryOptions {
  store: PreviewStore;
  identity: PreviewIdentity;
  earlier?: (methodologyDigest: string) => Promise<PreviewIdentity | null>;
  now: () => number;
  onError?: (error: unknown) => void;
}

const minuteEnd = (timestamp: number): number => Math.ceil(timestamp / 60) * 60;

const sameAssets = (a: readonly string[], b: readonly string[]): boolean => a === b || (a.length === b.length && a.every((asset, i) => asset === b[i]));

function methodologyOf(text: string): string | null {
  try {
    const value = JSON.parse(text) as { methodologyDigest?: unknown } | null;
    return typeof value?.methodologyDigest === "string" ? value.methodologyDigest : null;
  } catch {
    return null;
  }
}

export class PreviewHistory {
  private readonly seconds = new Map<number, Point>();
  private readonly minutes = new Map<number, Point>();
  private readonly identities = new Map<string, Promise<PreviewIdentity | null>>();
  private backfilledFrom: number | null = null;
  private prunedAt = 0;

  constructor(private readonly options: PreviewHistoryOptions) {}

  add(record: PreviewRecord): void {
    const point: Point = {
      assets: record.assets.map((asset) => asset.assetId),
      timestamp: record.timestamp,
      benchmark: record.benchmark,
      prices: record.assets.map((asset) => asset.priceE8),
      references: record.assets.map((asset) => asset.reference),
    };
    this.seconds.set(point.timestamp, point);
    const end = minuteEnd(point.timestamp);
    const current = this.minutes.get(end);
    if (!current || current.timestamp < point.timestamp) this.minutes.set(end, point);
    this.prune(this.options.now());
  }

  private prune(now: number): void {
    if (now - this.prunedAt < 60) return;
    this.prunedAt = now;
    for (const key of this.seconds.keys()) if (key <= now - SECOND_RETENTION) this.seconds.delete(key);
    for (const key of this.minutes.keys()) if (key <= now - MINUTE_RETENTION) this.minutes.delete(key);
  }

  async backfill(): Promise<void> {
    const now = this.options.now();
    const from = now - MINUTE_RETENTION;
    const listed = await this.options.store.list(from, now);
    const wanted = new Map<number, number>();
    for (const timestamp of listed) {
      const end = minuteEnd(timestamp);
      if ((wanted.get(end) ?? -1) < timestamp) wanted.set(end, timestamp);
    }
    const reads = new Set<number>([...wanted.values(), ...listed.filter((timestamp) => timestamp > now - SECOND_RETENTION)]);
    const queue = [...reads].filter((timestamp) => !this.seconds.has(timestamp) && (this.minutes.get(minuteEnd(timestamp))?.timestamp ?? -1) < timestamp);
    const worker = async () => {
      for (let timestamp = queue.pop(); timestamp !== undefined; timestamp = queue.pop()) {
        try {
          const text = await this.options.store.read(timestamp);
          if (text !== null) this.add(await this.parse(text, timestamp));
        } catch (error) {
          if (!(error instanceof PreviewInvalid) && !(error instanceof ChainChangeInvalid)) throw error;
          this.options.onError?.(error);
        }
      }
    };
    await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, worker));
    this.backfilledFrom = from;
  }

  query(from: number, to: number, step: number): Result {
    const assets = this.options.identity.assets;
    return this.collect(from, to, step, assets, (point) => (sameAssets(point.assets, assets) ? point : null));
  }

  window(from: number, to: number, step: number, assets: readonly string[]): Result {
    return this.collect(from, to, step, assets, (point) => {
      const positions = assets.map((asset) => point.assets.indexOf(asset));
      if (positions.some((position) => position < 0)) return null;
      return { ...point, assets, prices: positions.map((i) => point.prices[i]!), references: positions.map((i) => point.references[i]!) };
    });
  }

  private collect(from: number, to: number, step: number, assets: readonly string[], project: (point: Point) => Point | null): Result {
    const now = this.options.now();
    if (!HISTORY_STEPS.includes(step as HistoryStep)) throw new HistoryRangeError(`step must be one of ${HISTORY_STEPS.join(", ")}`);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) throw new HistoryRangeError("to must be after from");
    if ((to - from) / step > MAX_HISTORY_POINTS) throw new HistoryRangeError(`a response holds at most ${MAX_HISTORY_POINTS} steps`);
    const retention = step === 1 ? SECOND_RETENTION : MINUTE_RETENTION;
    if (from < now - retention) throw new HistoryRangeError(step === 1 ? "one-second history covers the last hour" : "history covers the last seven days");
    const points: PreviewHistoryPoint[] = [];
    for (let end = Math.floor(from / step) * step + step; end <= to; end += step) {
      const found = this.at(end, step);
      const point = found ? project(found) : null;
      if (point) points.push({ end, timestamp: point.timestamp, benchmark: point.benchmark, prices: point.prices, references: point.references });
    }
    const complete = to + SETTLE_SECONDS < now && this.backfilledFrom !== null && this.backfilledFrom <= from;
    return { data: { assets: [...assets], step, from, to, points }, complete };
  }

  private async parse(text: string, timestamp: number): Promise<PreviewRecord> {
    const digest = methodologyOf(text);
    if (digest === null || digest === this.options.identity.methodologyDigest || !this.options.earlier) return parsePreview(text, timestamp, this.options.identity);
    let identity = this.identities.get(digest);
    if (!identity) {
      identity = this.options.earlier(digest);
      this.identities.set(digest, identity);
    }
    const found = await identity.catch((error: unknown) => {
      throw new PreviewInvalid(`methodology ${digest} could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    });
    return parsePreview(text, timestamp, found ?? this.options.identity);
  }

  private at(end: number, step: number): Point | null {
    if (step === 1) return this.seconds.get(end) ?? null;
    for (let minute = end; minute > end - step; minute -= 60) {
      const point = this.minutes.get(minute);
      if (point) return point;
    }
    return null;
  }
}
