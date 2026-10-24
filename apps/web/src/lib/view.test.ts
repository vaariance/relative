import type { Publication } from "@eox/app-api";
import { describe, expect, it } from "vitest";
import { changeSince, classViews, currentOf, feeIncluded, findClass, latest, marketRow, priceDigits, priceSeries, referenceSeries, standingOf, standings } from "./view";

describe("fee display", () => {
  it("shows a quoted fee in collateral", () => {
    expect(feeIncluded("200", 6)).toBe("0.0002 USDC fee included");
    expect(feeIncluded("50000", 6)).toBe("0.05 USDC fee included");
    expect(feeIncluded("2000000", 6)).toBe("2.00 USDC fee included");
  });
});


const E8 = 10n ** 8n;
const E12 = 10n ** 12n;

function publication(sequence: number, coins: Record<string, { price: number; reference: number; backing?: number }>): Publication {
  const ids = Object.keys(coins);
  return {
    identity: { sequence, cutoff: 1_000 + sequence * 60 },
    prices: ids.map((assetId) => ({ assetId, priceE8: (BigInt(Math.round(coins[assetId]!.price * 100)) * E8 / 100n).toString() })),
    benchmark: (100n * E12).toString(),
    references: ids.map((assetId) => ({ assetId, reference: (BigInt(Math.round(coins[assetId]!.reference * 100)) * E12 / 100n).toString() })),
    classes: [...ids, "CRYPTO"].map((classId) => ({ classId, final: { backing: String((coins[classId]?.backing ?? 0) * 1_000_000), units: "0" } })),
  } as unknown as Publication;
}

const before = [
  publication(0, { BTC: { price: 60_000, reference: 100 }, ETH: { price: 3_000, reference: 100 } }),
  publication(1, { BTC: { price: 61_000, reference: 101 }, ETH: { price: 2_900, reference: 98 } }),
];
const after = [...before, publication(2, { BTC: { price: 61_500, reference: 102 }, ETH: { price: 2_950, reference: 99 }, LIT: { price: 3.08, reference: 100.5, backing: 5 } })];

describe("a coin added to the market later", () => {
  it("starts the coin's history at its first publication instead of throwing", () => {
    expect(referenceSeries(after, "LIT")).toEqual([{ cutoff: 1_120, value: 100.5 }]);
    expect(priceSeries(after, "LIT")).toEqual([{ cutoff: 1_120, value: 3.08 }]);
    expect(referenceSeries(after, "BTC")).toHaveLength(3);
  });

  it("ranks the new coin with the others", () => {
    const ranked = standings(after, ["BTC", "ETH", "LIT"]);
    expect(ranked.map((item) => item.id)).toEqual(["BTC", "LIT", "ETH"]);
    expect(ranked[1]!.standing).toBeCloseTo(0.005);
  });

  it("builds every Markets row, the new coin included", () => {
    const classes = classViews(currentOf(after), [], 6);
    const row = marketRow(after, classes, "LIT");
    expect(row).toMatchObject({ id: "LIT", price: 3.08, reference: 100.5, backing: 5 });
    expect(row.standing).toBeCloseTo(0.005);
    expect(() => ["BTC", "ETH", "LIT"].map((id) => marketRow(after, classes, id))).not.toThrow();
  });
});

describe("a coin listed before its first publication", () => {
  const classes = classViews(currentOf(before), [], 6);

  it("has no data and no class yet, without throwing", () => {
    expect(marketRow(before, classes, "LIT")).toEqual({ id: "LIT", price: null, reference: null, standing: null, points: [], backing: 0 });
    expect(findClass(classes, "LIT")).toEqual({ id: "LIT", backing: 0, units: 0, unitValue: null });
  });

  it("is left out of the ranking until it has a reference", () => {
    expect(standings(before, ["BTC", "ETH", "LIT"]).map((item) => item.id)).toEqual(["BTC", "ETH"]);
  });

  it("returns nothing for an empty history", () => {
    expect(latest([])).toBeNull();
    expect(standingOf([])).toBeNull();
    expect(changeSince([], 3_600)).toBeNull();
    expect(priceDigits(null)).toBe(2);
  });
});
