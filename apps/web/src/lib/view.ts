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
  return classId === CRYPTO_CLASS ? "Tracks the $CRYPTO index of 30 coins." : `Tracks how ${classId} performs against $CRYPTO. You do not own ${classId}.`;
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

export function priceOf(publication: Publication, assetId: string): PublishedPrice {
  const price = publication.prices.find((item) => item.assetId === assetId);
  if (!price) throw new Error(`no price for ${assetId}`);
  return price;
}

export function priceSeries(publications: readonly Publication[], assetId: string): Point[] {
  return publications.map((publication) => ({ cutoff: publication.identity.cutoff, value: toNumber(priceOf(publication, assetId).priceE8, PRICE_DIGITS) }));
}

export function referenceSeries(publications: readonly Publication[], assetId: string): Point[] {
  return publications.map((publication) => {
    const entry = publication.references.find((item) => item.assetId === assetId);
    if (!entry) throw new Error(`no reference for ${assetId}`);
    return { cutoff: publication.identity.cutoff, value: toNumber(entry.reference, SCALE_DIGITS) };
  });
}

export function levelSeries(publications: readonly Publication[]): Point[] {
  return publications.map((publication) => ({ cutoff: publication.identity.cutoff, value: toNumber(publication.benchmark, SCALE_DIGITS) }));
}

export function latest(points: readonly Point[]): number {
  return points[points.length - 1].value;
}

export function standingOf(reference: readonly Point[]): number {
  return reference.length === 0 ? 0 : latest(reference) / 100 - 1;
}

export function changeSince(points: readonly Point[], seconds: number): number {
  const end = points[points.length - 1];
  const start = points.find((point) => point.cutoff >= end.cutoff - seconds) ?? points[0];
  return end.value / start.value - 1;
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
  const view = views.find((item) => item.id === id);
  if (!view) throw new Error(`unknown class ${id}`);
  return view;
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
