import { describe, expect, it } from "vitest";
import { byPopularity } from "./popularity";

const id = (value: string) => value;

describe("byPopularity", () => {
  it("orders by market-cap rank, most popular first", () => {
    expect(byPopularity(["SOL", "BTC", "ETH"], id, { BTC: 1, ETH: 2, SOL: 5 })).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("puts unranked coins last in their original order", () => {
    expect(byPopularity(["SIREN", "ETH", "ZZZ", "BTC"], id, { BTC: 1, ETH: 2 })).toEqual(["BTC", "ETH", "SIREN", "ZZZ"]);
  });

  it("keeps the original order when ranks tie or are missing", () => {
    expect(byPopularity(["B", "A"], id, { A: 3, B: 3 })).toEqual(["B", "A"]);
    expect(byPopularity(["B", "A"], id, {})).toEqual(["B", "A"]);
  });

  it("reads ids from objects and does not change the input", () => {
    const input = [{ assetId: "ETH" }, { assetId: "BTC" }];
    expect(byPopularity(input, (asset) => asset.assetId, { BTC: 1, ETH: 2 }).map((asset) => asset.assetId)).toEqual(["BTC", "ETH"]);
    expect(input.map((asset) => asset.assetId)).toEqual(["ETH", "BTC"]);
  });
});
