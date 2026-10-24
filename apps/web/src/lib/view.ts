import type { ClassValuation, CoxAsset, CoxDeployment, CoxStatus, Portfolio, PriceVenue, Publication, PublishedPrice } from "@eox/app-api";

import { COLLATERAL } from "./config";

export const PRICE_DIGITS = 8;
export const SCALE_DIGITS = 12;

export function unitDigits(decimals: number): number {
  return SCALE_DIGITS + decimals;
}
export const CRYPTO_CLASS = "CRYPTO";
export const CRYPTO_NAME = "$CRYPTO";

export function nameOf(classId: string): string {
  return classId === CRYPTO_CLASS ? CRYPTO_NAME : classId;
}

export function positionName(classId: string): string {
  return classId === CRYPTO_CLASS ? `${CRYPTO_NAME} index position` : `${classId} performance position`;
}

export function positionNote(classId: string): string {
  return classId === CRYPTO_CLASS ? "Tracks the $CRYPTO index: every listed coin, weighted equally." : `Tracks how ${classId} performs against $CRYPTO. You do not own ${classId}.`;
}
const DEFAULT_DECIMALS = 0;
const BATCH_SECONDS = 60;

export function decimalsOf(deployment: CoxDeployment): number {
  return deployment.collateralDecimals ?? DEFAULT_DECIMALS;
}

export function batchCutoff(status: CoxStatus, batch: number): number | null {
  if (status.currentBatch) return status.currentBatch.cutoff + (batch - status.currentBatch.batch) * BATCH_SECONDS;
  if (status.latestBatch !== null && status.latestCutoff !== null) return status.latestCutoff + (batch - status.latestBatch) * BATCH_SECONDS;
  return null;
}

export interface Point {
  cutoff: number;
  value: number;
}

export interface ClassView {
  id: string;
  backing: number;
  units: number;
  unitValue: number | null;
}

export function toNumber(value: string, digits: number): number {
  return Number(BigInt(value)) / 10 ** digits;
}

export function feeIncluded(fee: string, decimals: number): string {
  const shown = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: decimals }).format(toNumber(fee, decimals));
  return `${shown} ${COLLATERAL.symbol} fee included`;
}

export function currentOf(publications: readonly Publication[]): Publication | null {
  return publications[publications.length - 1] ?? null;
}

export function priceOf(publication: Publication, assetId: string): PublishedPrice | null {
  return publication.prices.find((item) => item.assetId === assetId) ?? null;
}

export function priceSeries(publications: readonly Publication[], assetId: string): Point[] {
  return publications.flatMap((publication) => {
    const price = priceOf(publication, assetId);
    return price ? [{ cutoff: publication.identity.cutoff, value: toNumber(price.priceE8, PRICE_DIGITS) }] : [];
  });
}

export function referenceSeries(publications: readonly Publication[], assetId: string): Point[] {
  return publications.flatMap((publication) => {
    const entry = publication.references.find((item) => item.assetId === assetId);
    return entry ? [{ cutoff: publication.identity.cutoff, value: toNumber(entry.reference, SCALE_DIGITS) }] : [];
  });
}

export function levelSeries(publications: readonly Publication[]): Point[] {
  return publications.map((publication) => ({ cutoff: publication.identity.cutoff, value: toNumber(publication.benchmark, SCALE_DIGITS) }));
}

export function latest(points: readonly Point[]): number | null {
  return points[points.length - 1]?.value ?? null;
}

export function standingOf(reference: readonly Point[]): number | null {
  const value = latest(reference);
  return value === null ? null : value / 100 - 1;
}

export interface Standing {
  id: string;
  standing: number;
  points: Point[];
}

export function standings(publications: readonly Publication[], ids: readonly string[]): Standing[] {
  return ids
    .flatMap((id) => {
      const points = referenceSeries(publications, id);
      const standing = standingOf(points);
      return standing === null ? [] : [{ id, standing, points }];
    })
    .sort((left, right) => right.standing - left.standing);
}

export interface MarketRow {
  id: string;
  price: number | null;
  reference: number | null;
  standing: number | null;
  points: Point[];
  backing: number;
}

export function marketRow(publications: readonly Publication[], classes: readonly ClassView[], id: string): MarketRow {
  const current = currentOf(publications);
  const points = referenceSeries(publications, id);
  const price = current ? priceOf(current, id) : null;
  return { id, price: price ? toNumber(price.priceE8, PRICE_DIGITS) : null, reference: latest(points), standing: standingOf(points), points, backing: findClass(classes, id).backing };
}

export function priceDigits(value: number | null): number {
  return value === null || value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
}

export function changeSince(points: readonly Point[], seconds: number): number | null {
  const end = points[points.length - 1];
  if (!end) return null;
  const start = points.find((point) => point.cutoff >= end.cutoff - seconds) ?? points[0]!;
  return start.value === 0 ? null : end.value / start.value - 1;
}

function classView(valuation: ClassValuation, decimals: number): ClassView {
  const backing = toNumber(valuation.final.backing, decimals);
  const units = toNumber(valuation.final.units, unitDigits(decimals));
  return { id: valuation.classId, backing, units, unitValue: units > 0 ? backing / units : null };
}

export function classViews(publication: Publication | null, assets: readonly CoxAsset[], decimals: number): ClassView[] {
  if (publication) return publication.classes.map((valuation) => classView(valuation, decimals));
  return [...assets.map((asset) => asset.assetId), CRYPTO_CLASS].map((id) => ({ id, backing: 0, units: 0, unitValue: null }));
}

export function findClass(views: readonly ClassView[], id: string): ClassView {
  return views.find((item) => item.id === id) ?? { id, backing: 0, units: 0, unitValue: null };
}

const venues: Record<PriceVenue, string> = { kraken: "Kraken", coinbase: "Coinbase", bybit: "Bybit", pyth: "Pyth" };

export function venueName(venue: PriceVenue): string {
  return venues[venue];
}

export function tradeAge(minutes: number): string {
  if (minutes === 0) return "traded in the cutoff minute";
  return `last trade ${minutes} min before the cutoff`;
}

export interface Holding {
  classId: string;
  units: number;
  locked: number;
}

export function holdingsOf(portfolio: Portfolio | null, decimals: number): Holding[] | null {
  if (!portfolio) return null;
  return portfolio.positions.map((position) => ({ classId: position.classId, units: toNumber(position.units, unitDigits(decimals)), locked: toNumber(position.locked, unitDigits(decimals)) }));
}

export function unlockedProblem(holdings: readonly Holding[] | null, classId: string, wanted: number): string | null {
  if (holdings === null) return null;
  const holding = holdings.find((item) => item.classId === classId);
  if (!holding || holding.units === 0) return `You hold no ${nameOf(classId)} units.`;
  const free = holding.units - holding.locked;
  if (wanted <= free) return null;
  if (holding.locked > 0) return `Only ${free.toFixed(2)} of your ${nameOf(classId)} units are free. ${holding.locked.toFixed(2)} are locked in another request.`;
  return `You hold ${free.toFixed(2)} ${nameOf(classId)} units.`;
}

export interface ValuePoint extends Point {
  sequence: number;
}

export function unitValueSeries(publications: readonly Publication[], classId: string, decimals: number): ValuePoint[] {
  return publications.flatMap((publication) => {
    const valuation = publication.classes.find((item) => item.classId === classId);
    if (!valuation) return [];
    const view = classView(valuation, decimals);
    return view.unitValue === null ? [] : [{ sequence: publication.identity.sequence, cutoff: publication.identity.cutoff, value: view.unitValue }];
  });
}
