import type { Preview, PreviewPortfolio } from "@eox/app-api";
import { CRYPTO_CLASS, unitDigits } from "./view";

export const STALE_SECONDS = 10;

export interface Estimate {
  at: number;
  benchmark: number;
  prices: Record<string, number>;
  references: Record<string, number>;
  unitValues: Record<string, number | null> | null;
  basis: number | null;
}

export type Freshness = "live" | "stale" | "none";

function digitsOf(scale: number | string): number {
  const text = String(scale);
  if (!/^10*$/.test(text)) throw new Error(`scale ${text} is not a power of ten`);
  return text.length - 1;
}

function scaled(value: string, digits: number): number {
  return Number(BigInt(value)) / 10 ** digits;
}

export function estimateOf(preview: Preview, decimals: number): Estimate {
  const { record } = preview;
  const price = digitsOf(record.scales.price);
  const reference = digitsOf(record.scales.reference);
  const prices: Record<string, number> = {};
  const references: Record<string, number> = {};
  const classIds = new Map<number, string>([[record.cryptoClass, CRYPTO_CLASS]]);
  for (const asset of record.assets) {
    prices[asset.assetId] = scaled(asset.priceE8, price);
    references[asset.assetId] = scaled(asset.reference, reference);
    classIds.set(asset.classId, asset.assetId);
  }
  const projection = record.basicProjection;
  let unitValues: Record<string, number | null> | null = null;
  if (projection) {
    unitValues = {};
    for (const row of projection.classes) {
      const id = classIds.get(row.classId);
      if (!id) continue;
      const units = scaled(row.units, unitDigits(decimals));
      unitValues[id] = units > 0 ? scaled(row.backing, decimals) / units : null;
    }
  }
  return {
    at: record.timestamp,
    benchmark: scaled(record.benchmark, reference),
    prices,
    references,
    unitValues,
    basis: projection ? Number(projection.sequence) : null,
  };
}

export function freshnessOf(preview: Preview | null, now: number): Freshness {
  if (!preview) return "none";
  if (preview.stale || now - preview.record.timestamp > STALE_SECONDS) return "stale";
  return "live";
}

export function ageText(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

export interface WalletEstimate {
  total: number | null;
  byClass: Record<string, number | null>;
}

export function walletEstimateOf(portfolio: PreviewPortfolio, decimals: number, latestSequence: number | null): WalletEstimate | null {
  if (portfolio.unavailable !== null) return null;
  if (latestSequence !== null && portfolio.basisSequence !== null && portfolio.basisSequence !== latestSequence) return null;
  const byClass: Record<string, number | null> = {};
  for (const position of portfolio.positions) byClass[position.classId] = position.estimatedValue === null ? null : scaled(position.estimatedValue, decimals);
  return { total: portfolio.estimatedValue === null ? null : scaled(portfolio.estimatedValue, decimals), byClass };
}

export const HISTORY_SECONDS = 4 * 3600;

export function appendHistory(history: readonly Estimate[], estimate: Estimate, keepSeconds = HISTORY_SECONDS): Estimate[] {
  const last = history[history.length - 1];
  if (last && estimate.at <= last.at) return history as Estimate[];
  const start = estimate.at - keepSeconds;
  let first = 0;
  while (first < history.length && history[first].at <= start) first += 1;
  return [...history.slice(first), estimate];
}

export type SeriesKind = "price" | "reference" | "level" | "unitValue";

export interface SeriesPoint {
  cutoff: number;
  value: number;
}

export function seriesOf(history: readonly Estimate[], kind: SeriesKind, id?: string, basis: number | null = null): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (const estimate of history) {
    let value: number | null | undefined;
    if (kind === "level") value = estimate.benchmark;
    else if (id === undefined) value = undefined;
    else if (kind === "price") value = estimate.prices[id];
    else if (kind === "reference") value = estimate.references[id];
    else value = basis !== null && estimate.basis === basis ? estimate.unitValues?.[id] : undefined;
    if (value !== undefined && value !== null) points.push({ cutoff: estimate.at, value });
  }
  return points;
}

export function sampled<T>(points: readonly T[], limit: number): T[] {
  if (points.length <= limit || limit < 2) return [...points];
  const out: T[] = [];
  const step = (points.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) out.push(points[Math.round(index * step)]);
  return out;
}

export function spanOf(points: readonly SeriesPoint[]): number {
  return points.length > 1 ? points[points.length - 1].cutoff - points[0].cutoff : 0;
}

export function perMinute(points: readonly SeriesPoint[]): SeriesPoint[] {
  if (points.length === 0) return [];
  const open = Math.floor(points[points.length - 1].cutoff / 60);
  const out: SeriesPoint[] = [];
  for (const point of points) {
    const minute = Math.floor(point.cutoff / 60);
    if (minute >= open) break;
    const last = out[out.length - 1];
    if (last && Math.floor(last.cutoff / 60) === minute) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}
