export interface CoinGeckoCoin {
  id: string;
  symbol: string;
  current_price: number | null;
  market_cap: number | null;
}

export const PRICE_TOLERANCE = { low: 0.8, high: 1.25 };

export function tickerSymbol(assetId: string): string {
  const parts = assetId.split(".");
  return parts[parts.length - 1].toLowerCase();
}

export function matchCoin(assetId: string, livePrice: number, coins: readonly CoinGeckoCoin[]): string | null {
  if (!(livePrice > 0)) return null;
  const symbol = tickerSymbol(assetId);
  const matches = coins.filter((coin) => {
    if (coin.symbol.toLowerCase() !== symbol || !coin.current_price || coin.current_price <= 0) return false;
    const ratio = coin.current_price / livePrice;
    return ratio >= PRICE_TOLERANCE.low && ratio <= PRICE_TOLERANCE.high;
  });
  if (matches.length === 0) return null;
  return matches.reduce((best, coin) => ((coin.market_cap ?? 0) > (best.market_cap ?? 0) ? coin : best)).id;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}
