import type { CoxDeployment, TradingStatus } from "@eox/app-api";

export const VALID_SECONDS = 180;

export interface Market {
  trading: TradingStatus | null;
  interval: number;
  decimals: number;
}

export const NO_MARKET: Market = { trading: null, interval: 60, decimals: 0 };

export function marketOf(deployment: CoxDeployment | null, trading: TradingStatus | null): Market {
  const interval = deployment?.publicationIntervalSeconds;
  return { trading, interval: Number.isSafeInteger(interval) && interval! > 0 ? interval! : 60, decimals: deployment?.collateralDecimals ?? 0 };
}

export function batchesFor(interval: number, seconds = VALID_SECONDS): number {
  if (!Number.isSafeInteger(interval) || interval < 1) return 1;
  return Math.max(1, Math.ceil(seconds / interval));
}

export function expiryAfter(target: number, interval: number): number {
  return target + batchesFor(interval) - 1;
}

function clock(unixSeconds: number, now: number): string {
  const date = new Date(unixSeconds * 1000);
  const time = date.toISOString().slice(11, 16);
  const sameDay = new Date(now * 1000).toISOString().slice(0, 10) === date.toISOString().slice(0, 10);
  if (sameDay) return `${time} UTC`;
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

export function tradingClosed(trading: TradingStatus | null): boolean {
  return trading !== null && !trading.open;
}

export function closedLabel(trading: TradingStatus | null, now: number): string | null {
  if (!trading || trading.open) return null;
  if (trading.gate === "before-opening" && trading.opensAt !== null) return `Opens at ${clock(trading.opensAt, now)}`;
  if (trading.gate === "retired") return "Market retired";
  if (trading.gate === "not-initialized") return "Not open yet";
  return "Trading paused";
}

export function closedNote(trading: TradingStatus | null, now: number): string | null {
  if (!trading || trading.open) return null;
  if (trading.gate === "before-opening" && trading.opensAt !== null) return `Trading opens at ${clock(trading.opensAt, now)}.`;
  if (trading.gate === "retired") return "This market is retired. Earlier positions were paid out to their owners.";
  if (trading.gate === "not-initialized") return "This market has not opened yet.";
  return "Trading is paused. You can still withdraw what is ready.";
}
