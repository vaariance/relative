import { describe, expect, it } from "vitest";
import { type CoinGeckoCoin, chunk, matchCoin, tickerSymbol } from "./coingecko-match";

const coin = (id: string, symbol: string, price: number | null, cap: number | null = null): CoinGeckoCoin => ({ id, symbol, current_price: price, market_cap: cap });

describe("matchCoin", () => {
  it("picks the coin whose price matches ours", () => {
    const coins = [coin("hastra-prime", "prime", 1.067, 5_000_000), coin("echelon-prime", "prime", 0.172, 90_000_000)];
    expect(matchCoin("PRIME", 0.17195, coins)).toBe("echelon-prime");
  });

  it("rejects a coin whose price is more than 20 percent away", () => {
    expect(matchCoin("AI", 0.01797, [coin("artificial-inu-3", "ai", 0.077142, 1)])).toBeNull();
    expect(matchCoin("X", 1, [coin("x", "x", 0.79)])).toBeNull();
    expect(matchCoin("X", 1, [coin("x", "x", 1.26)])).toBeNull();
  });

  it("takes the largest market cap when several coins match the price", () => {
    const coins = [coin("small", "s", 1.01, 10), coin("big", "s", 0.99, 1_000), coin("none", "s", 1, null)];
    expect(matchCoin("S", 1, coins)).toBe("big");
  });

  it("ignores other tickers, missing prices and no live price", () => {
    expect(matchCoin("A", 1, [coin("b", "b", 1), coin("a", "a", null)])).toBeNull();
    expect(matchCoin("A", 0, [coin("a", "a", 1)])).toBeNull();
    expect(matchCoin("A", Number.NaN, [coin("a", "a", 1)])).toBeNull();
  });

  it("compares tickers without case and after the last dot", () => {
    expect(tickerSymbol("VELODROME.VELO")).toBe("velo");
    expect(matchCoin("VELODROME.VELO", 0.02, [coin("velodrome-finance", "VELO", 0.021)])).toBe("velodrome-finance");
  });
});

describe("chunk", () => {
  it("splits into fixed sizes", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 50)).toEqual([]);
  });
});
