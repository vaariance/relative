import type { Preview, PreviewHistory, PreviewPortfolio } from "@eox/app-api";
import { describe, expect, it } from "vitest";
import { ageText, withLiveMinute, appendHistory, estimateOf, freshnessOf, historyEstimates, historyStep, joinHistory, preferEstimates, perMinute, sampled, seriesOf, spanOf, trimHistory, walletEstimateOf } from "./estimate";

const preview: Preview = {
  ageSeconds: 1,
  stale: false,
  record: {
    schema: "relative.preview/v1",
    status: "estimate",
    timestamp: 1792732703,
    network: "solana-devnet",
    program: "G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF",
    pool: "HPnHZGLeQ8oisu3V8ZEBfPRT2Sai8XWnpfQmcZ8sTZE4",
    methodologyDigest: "2b8360bed080095ebd1a0a8ca81479010580d24d771881b59b6b86557964bdba",
    universeDigest: "e70abb064a5650366edf36a14131b7c347b5136d2be4a667a2c0dc8f20317559",
    scales: { price: "100000000", reference: "1000000000000", collateral: "1000000" },
    benchmark: "95664187206378",
    assets: [
      { classId: 0, assetId: "BTC", priceE8: "8173892922187", reference: "101377214348832" },
      { classId: 1, assetId: "ETH", priceE8: "312500000000", reference: "99000000000000" },
    ],
    cryptoClass: 30,
    cryptoReference: "100000000000000",
    basicProjection: {
      sequence: 4,
      stateDigest: "ab8efa8ef619a691defae52ad1262e8792b7949ad27d88503ac69f96a32324e6",
      publicationTimestamp: 1792694175,
      addedResidual: "0",
      classes: [
        { classId: 0, backing: "2000000", units: "1000000000000000000" },
        { classId: 1, backing: "0", units: "0" },
        { classId: 30, backing: "5000000", units: "5000000000000000000" },
      ],
    },
  },
} as unknown as Preview;

describe("preview estimates", () => {
  it("reads prices, references and the $CRYPTO level at the record's own scales", () => {
    const estimate = estimateOf(preview, 6);
    expect(estimate.at).toBe(1792732703);
    expect(estimate.prices.BTC).toBeCloseTo(81738.92922187, 6);
    expect(estimate.references.BTC).toBeCloseTo(101.377214348832, 9);
    expect(estimate.references.ETH).toBe(99);
    expect(estimate.benchmark).toBeCloseTo(95.664187206378, 9);
  });

  it("gives projected unit values per class, with no value for an empty class", () => {
    const estimate = estimateOf(preview, 6);
    expect(estimate.basis).toBe(4);
    expect(estimate.unitValues).toEqual({ BTC: 2, ETH: null, CRYPTO: 1 });
  });

  it("has no unit values without a projection", () => {
    const bare = { ...preview, record: { ...preview.record, basicProjection: null } } as Preview;
    expect(estimateOf(bare, 6).unitValues).toBeNull();
  });

  it("is stale when the API says so or the record is over ten seconds old", () => {
    expect(freshnessOf(null, 0)).toBe("none");
    expect(freshnessOf(preview, 1792732710)).toBe("live");
    expect(freshnessOf(preview, 1792732714)).toBe("stale");
    expect(freshnessOf({ ...preview, stale: true }, 1792732704)).toBe("stale");
  });

  it("writes short ages", () => {
    expect(ageText(3.7)).toBe("3s ago");
    expect(ageText(125)).toBe("2 min ago");
    expect(ageText(7300)).toBe("2 h ago");
  });
});

describe("wallet estimates", () => {
  const portfolio: PreviewPortfolio = {
    owner: "GpgFFekDm7oHg6gD3AHyqVCbJWhKTDnBmxZBi9hnnepN",
    timestamp: 1792732703,
    stale: false,
    basisSequence: 4,
    unavailable: null,
    positions: [
      { classId: "BTC", units: "500000000000000000", locked: "0", estimatedValue: "1000000" },
      { classId: "ETH", units: "0", locked: "0", estimatedValue: null },
    ],
    estimatedValue: "1000000",
  };

  it("converts base units to collateral", () => {
    expect(walletEstimateOf(portfolio, 6, 4)).toEqual({ total: 1, byClass: { BTC: 1, ETH: null } });
  });

  it("is withheld when the API cannot project or the basis is an older publication", () => {
    expect(walletEstimateOf({ ...portfolio, unavailable: "basis-mismatch" }, 6, 4)).toBeNull();
    expect(walletEstimateOf(portfolio, 6, 5)).toBeNull();
  });
});

describe("live history", () => {
  const at = (seconds: number) => ({ ...estimateOf(preview, 6), at: seconds });

  it("appends only newer seconds and drops what is older than the window", () => {
    let history = appendHistory([], at(100), 10);
    history = appendHistory(history, at(100), 10);
    history = appendHistory(history, at(99), 10);
    expect(history.map((item) => item.at)).toEqual([100]);
    history = appendHistory(history, at(105), 10);
    history = appendHistory(history, at(111), 10);
    expect(history.map((item) => item.at)).toEqual([105, 111]);
  });

  it("reads one series out of the history", () => {
    const history = [at(1), at(2)];
    expect(seriesOf(history, "level")).toEqual([{ cutoff: 1, value: history[0].benchmark }, { cutoff: 2, value: history[1].benchmark }]);
    expect(seriesOf(history, "price", "BTC")[0].value).toBeCloseTo(81738.92922187, 6);
    expect(seriesOf(history, "reference", "DOGE")).toEqual([]);
  });

  it("thins long series to a fixed number of points, keeping both ends", () => {
    const points = Array.from({ length: 1000 }, (_, index) => index);
    const thin = sampled(points, 5);
    expect(thin).toEqual([0, 250, 500, 749, 999]);
    expect(sampled([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it("measures how much time a series covers", () => {
    expect(spanOf([{ cutoff: 10, value: 1 }, { cutoff: 70, value: 2 }])).toBe(60);
    expect(spanOf([{ cutoff: 10, value: 1 }])).toBe(0);
  });
});

describe("minute points", () => {
  it("keeps the last point of each finished minute and leaves out the minute in progress", () => {
    const points = [59, 60, 90, 119, 120, 150, 185].map((cutoff) => ({ cutoff, value: cutoff }));
    expect(perMinute(points).map((point) => point.cutoff)).toEqual([59, 119, 150]);
    expect(perMinute([])).toEqual([]);
  });
});

describe("preview history", () => {
  const at = (seconds: number) => ({ ...estimateOf(preview, 6), at: seconds });
  const history: PreviewHistory = {
    assets: ["BTC", "ETH"],
    step: 60,
    from: 1792738440,
    to: 1792738680,
    points: [
      { end: 1792738620, timestamp: 1792738619, benchmark: "95000000000000", prices: ["8100000000000", "300000000000"], references: ["101000000000000", "99500000000000"] },
      { end: 1792738500, timestamp: 1792738500, benchmark: "95901037991028", prices: ["8179816644724", "240603676191"], references: ["101200126709690", "101221951975233"] },
      { end: 1792738680, timestamp: 1792738660, benchmark: "96000000000000", prices: ["8200000000000"], references: ["102000000000000"] },
    ],
  };

  it("reads each point at the preview scales in roster order, oldest first", () => {
    const estimates = historyEstimates(history);
    expect(estimates.map((item) => item.at)).toEqual([1792738500, 1792738619]);
    expect(estimates[0].prices.BTC).toBeCloseTo(81798.16644724, 6);
    expect(estimates[0].references.ETH).toBeCloseTo(101.221951975233, 9);
    expect(estimates[1].benchmark).toBe(95);
    expect(estimates[1].unitValues).toBeNull();
    expect(estimates[1].basis).toBeNull();
  });

  it("leaves a malformed point out instead of filling it", () => {
    expect(historyEstimates(history).some((item) => item.at === 1792738660)).toBe(false);
  });

  it("keeps a missing step as a gap", () => {
    const series = seriesOf(historyEstimates(history), "level");
    expect(series.map((point) => point.cutoff)).toEqual([1792738500, 1792738619]);
  });

  it("puts older history before live previews and never repeats a time", () => {
    const older = historyEstimates(history);
    const recent = [at(1792738619), at(1792738620)];
    expect(joinHistory(older, recent).map((item) => item.at)).toEqual([1792738500, 1792738619, 1792738620]);
    expect(joinHistory(older, []).map((item) => item.at)).toEqual([1792738500, 1792738619]);
    expect(joinHistory([], recent)).toBe(recent);
  });

  it("trims to the kept window", () => {
    expect(trimHistory([at(1), at(50), at(100)], 60).map((item) => item.at)).toEqual([50, 100]);
    expect(trimHistory([])).toEqual([]);
  });

  it("asks for wider steps on longer ranges", () => {
    expect(historyStep(3600)).toBe(60);
    expect(historyStep(4 * 3600)).toBe(60);
    expect(historyStep(86400)).toBe(300);
    expect(historyStep(7 * 86400)).toBe(3600);
  });

  it("prefers estimates when they cover more time or hold more points than settled values", () => {
    const points = (...cutoffs: number[]) => cutoffs.map((cutoff) => ({ cutoff, value: 1 }));
    expect(preferEstimates(points(10, 20, 30, 40), points(0, 100))).toBe(true);
    expect(preferEstimates(points(0, 100), points(10, 20, 30))).toBe(true);
    expect(preferEstimates(points(50, 60), points(0, 30, 100))).toBe(false);
    expect(preferEstimates(points(50), points())).toBe(false);
  });
});

describe("live minute", () => {
  const points = (...cutoffs: number[]) => cutoffs.map((cutoff) => ({ cutoff, value: cutoff }));

  it("keeps finished minutes at one point and every second of the minute in progress", () => {
    expect(withLiveMinute(points(59, 60, 90, 119, 120, 150, 185, 186, 190)).map((point) => point.cutoff)).toEqual([59, 119, 150, 185, 186, 190]);
  });

  it("can keep only the latest point of the minute in progress", () => {
    expect(withLiveMinute(points(59, 60, 90, 185, 190), false).map((point) => point.cutoff)).toEqual([59, 90, 190]);
  });

  it("ends on the latest value", () => {
    expect(withLiveMinute(points(10, 20, 30)).map((point) => point.cutoff)).toEqual([10, 20, 30]);
    expect(withLiveMinute([])).toEqual([]);
  });
});
