import type { Epoch, EpochLot } from "@eox/app-api";
import { describe, expect, it } from "vitest";
import settled from "../../test/fixtures/epoch-2026-10-23-0800.json";
import { CLOSING_GRACE_SECONDS, basketProblem, basketScore, defaultTeam, entryBasket, epochBasket, countdown, executionReferences, feeOf, finalPayout, finalScore, lotView, moves, stageOf, timelineStep, withdrawSource } from "./epoch";

const epoch = (phase: Epoch["phase"], extra: Partial<Epoch> = {}): Epoch => ({ address: "x", opensAt: 1000, closesAt: 2000, phase, sealed: true, entriesOpen: false, universe: [], nextNonce: null, lots: null, totalWeight: null, settlementPot: null, allZero: null, closingReferences: [], closingDeadline: 88_400, voidable: false, ledger: null, ...extra });
const lot = (extra: Partial<EpochLot>): EpochLot => ({ address: "l", epochOpensAt: 1000, nonce: "0", owner: "o", grossStake: "100000000", fee: "20000", admittedAt: 1100, basket: [], backedAsset: "ETH", execution: { timestamp: 1101, references: [] }, state: "executed", score: null, weight: null, claimable: null, refund: null, ...extra });

describe("epoch stage", () => {
  it("shows Closing at zero rather than Settled", () => {
    expect(stageOf(epoch("open"), 500)).toBe("upcoming");
    expect(stageOf(epoch("open"), 1500)).toBe("open");
    expect(stageOf(epoch("open"), 2000)).toBe("closing");
    expect(timelineStep(stageOf(epoch("open"), 2000))).toBe(1);
  });

  it("follows the program once scoring starts", () => {
    expect(stageOf(epoch("scoring"), 2500)).toBe("scoring");
    expect(stageOf(epoch("allocating"), 2500)).toBe("allocating");
    expect(stageOf(epoch("settled"), 2500)).toBe("settled");
    expect(stageOf(epoch("voided"), 2500)).toBe("voided");
  });

  it("stops waiting for a closing reference once the 24-hour window has passed", () => {
    expect(stageOf(epoch("open"), 2000 + CLOSING_GRACE_SECONDS)).toBe("closing");
    expect(stageOf(epoch("open"), 2001 + CLOSING_GRACE_SECONDS)).toBe("expired");
    expect(timelineStep("expired")).toBe(-1);
  });

  it("calls a draft that missed its opening not opened, not scheduled", () => {
    expect(stageOf(epoch("draft"), 500)).toBe("upcoming");
    expect(stageOf(epoch("draft"), 1000)).toBe("unopened");
  });
});

describe("relative moves", () => {
  it("ranks by move against $CRYPTO and keeps missing values as gaps", () => {
    const rows = moves(["A", "B", "C"], { A: 100, B: 100 }, { A: 99, B: 102, C: 101 });
    expect(rows.map((row) => row.id)).toEqual(["B", "A", "C"]);
    expect(rows[0]!.change).toBeCloseTo(0.02);
    expect(rows[2]!.change).toBeNull();
  });
});

describe("moves since an entry executed", () => {
  it("rebases each basket member to its own execution reference", () => {
    const entry = lot({ basket: ["A", "B"], execution: { timestamp: 1101, references: ["1000000000000", "2000000000000"] } });
    const start = executionReferences(entry, 100);
    expect(start).toEqual({ A: 100, B: 200 });
    const rows = moves(entry.basket, start, { A: 103, B: 198 });
    expect(rows[0]!.id).toBe("A");
    expect(rows[0]!.change).toBeCloseTo(0.03);
    expect(rows[1]!.change).toBeCloseTo(-0.01);
  });

  it("has no starting point before execution or when the references do not match the basket", () => {
    expect(executionReferences(lot({ basket: ["A"], execution: null }), 100)).toBeNull();
    expect(executionReferences(lot({ basket: ["A", "B"], execution: { timestamp: 1101, references: ["1"] } }), 100)).toBeNull();
  });
});

describe("entry states", () => {
  it("separates waiting, active, withdrawable and history", () => {
    expect(lotView(lot({ state: "pending", execution: null }), epoch("open"), 1500).label).toBe("Awaiting execution");
    expect(lotView(lot({}), epoch("open"), 1500).group).toBe("active");
    expect(lotView(lot({ state: "claimable", claimable: "149970000" }), epoch("settled"), 2500)).toEqual({ group: "withdrawable", label: "Payout withdrawable", refund: false });
    expect(lotView(lot({ state: "claimable", claimable: "0" }), epoch("settled"), 2500).group).toBe("history");
    expect(lotView(lot({ state: "withdrawn", claimable: "0" }), epoch("settled"), 2500).label).toBe("Withdrawn");
  });

  it("calls it a refund when the round was voided, nobody rose, or the entry never executed", () => {
    expect(lotView(lot({ state: "claimable", claimable: "100000000" }), epoch("voided"), 2500).label).toBe("Refund withdrawable");
    expect(lotView(lot({ state: "claimable", claimable: "100000000" }), epoch("settled", { allZero: true }), 2500).refund).toBe(true);
    expect(lotView(lot({ state: "claimable", claimable: "100000000", execution: null }), epoch("settled"), 2500).refund).toBe(true);
  });

  it("never says awaiting execution after the close", () => {
    expect(lotView(lot({ state: "pending", execution: null }), epoch("open"), 2000)).toEqual({ group: "pending", label: "Not executed · refund due", refund: true });
    expect(lotView(lot({}), epoch("open"), 2001 + CLOSING_GRACE_SECONDS)).toEqual({ group: "pending", label: "Awaiting refund", refund: true });
  });
});

describe("final score and payout", () => {
  const real = settled as unknown as { epoch: Epoch; lots: EpochLot[] };

  it("reproduces the contract's scores, total weight and recorded payouts from on-chain values", () => {
    const [btc, eth] = real.lots;
    expect(btc!.state).toBe("withdrawn");
    expect(btc!.score).toBeNull();
    expect(finalScore(btc!, real.epoch)).toBe(6_761_883_418n);
    expect(finalScore(eth!, real.epoch)).toBe(25_546_651_148n);
    const weight = real.lots.reduce((sum, item) => sum + (BigInt(item.grossStake) - BigInt(item.fee)) * finalScore(item, real.epoch)!, 0n);
    expect(weight).toBe(BigInt(real.epoch.totalWeight!));
    expect(finalPayout(btc!, real.epoch)).toBe(41_849n);
    expect(finalPayout(eth!, real.epoch)).toBe(158_110n);
  });

  it("counts only rises against $CRYPTO and scores zero when nothing rose", () => {
    expect(basketScore([100n, 100n, 100n], [110n, 130n, 90n], 0)).toBe(250_000_000_000n);
    expect(basketScore([100n, 100n], [90n, 100n], 0)).toBe(0n);
    expect(basketScore([100n], [110n, 120n], 0)).toBeNull();
  });

  it("uses the program's values while they exist and refunds the gross stake when there is no result", () => {
    expect(finalScore(lot({ state: "scored", score: "500000000000" }), null)).toBe(500_000_000_000n);
    expect(finalPayout(lot({ state: "claimable", claimable: "7" }), null)).toBe(7n);
    expect(finalPayout(lot({ state: "executed" }), epoch("settled"))).toBeNull();
    expect(finalPayout(lot({ state: "withdrawn", execution: null }), epoch("settled"))).toBe(100_000_000n);
    expect(finalPayout(lot({ state: "withdrawn" }), epoch("voided"))).toBe(100_000_000n);
    expect(finalPayout(lot({ state: "withdrawn" }), epoch("settled", { allZero: true }))).toBe(100_000_000n);
    expect(finalPayout(lot({ state: "withdrawn" }), epoch("settled", { totalWeight: "0", settlementPot: "0" }))).toBeNull();
  });
});

describe("withdrawal vault", () => {
  const mints = ["usdc", "rlusd"];

  it("takes the whole amount from the first vault that can pay it", () => {
    expect(withdrawSource(mints, { primary: 50n, secondary: 0n }, 40n)).toEqual({ mint: "usdc", index: 0 });
    expect(withdrawSource(mints, { primary: 0n, secondary: 41n }, 40n)).toEqual({ mint: "rlusd", index: 1 });
  });

  it("withdraws part of it when neither vault holds the whole amount", () => {
    expect(withdrawSource(mints, { primary: 30n, secondary: 20n }, 40n)).toEqual({ mint: "usdc", amount: "30", index: 0 });
    expect(withdrawSource(mints, { primary: 0n, secondary: 0n }, 40n)).toBeNull();
  });

  it("sends no mint with a single collateral or when the vaults could not be read", () => {
    expect(withdrawSource(["usdc"], null, 40n)).toEqual({ index: 0 });
    expect(withdrawSource(mints, null, 40n)).toEqual({ index: 0 });
  });
});

describe("fee and countdown", () => {
  it("charges 2 bps capped at the cap", () => {
    expect(feeOf(100_000_000n, 2, 200_000n)).toBe(20_000n);
    expect(feeOf(5_000_000_000_000n, 2, 200_000n)).toBe(200_000n);
  });

  it("counts down as hours, minutes and seconds", () => {
    expect(countdown(1 * 3600 + 42 * 60 + 17)).toBe("01:42:17");
    expect(countdown(-4)).toBe("00:00:00");
  });
});

describe("Epoch basket", () => {
  const thirty = Array.from({ length: 30 }, (_, index) => `C${index}`);
  const member = (assetId: string, id: number) => ({ id, assetId, originPrice: "1" });

  it("comes from the Epoch's own list, never from the market's", () => {
    expect(epochBasket(epoch("open", { universe: thirty.map(member) }))).toEqual(thirty);
    expect(epochBasket(epoch("settled", { closingReferences: thirty.map((assetId) => ({ assetId, reference: "1" })) }))).toEqual(thirty);
    expect(epochBasket(epoch("open"))).toEqual([]);
  });

  it("fills a 30-coin round with every other coin", () => {
    const mates = defaultTeam(thirty, "C5");
    expect(mates).toHaveLength(29);
    expect(mates).not.toContain("C5");
    expect(entryBasket(thirty, "C5", mates)).toEqual(thirty);
    expect(basketProblem(thirty, "C5", mates)).toBeNull();
  });

  it("starts a larger round with the first 29 other coins in the round's order", () => {
    const universe = [...thirty, "LIT"];
    const mates = defaultTeam(universe, "C0");
    expect(mates).toEqual(thirty.slice(1));
    expect(entryBasket(universe, "C0", mates)).toEqual(thirty);
    const swapped = [...mates.filter((id) => id !== "C3"), "LIT"];
    expect(entryBasket(universe, "C0", swapped)).toEqual([...thirty.filter((id) => id !== "C3"), "LIT"]);
    expect(basketProblem(universe, "C0", swapped)).toBeNull();
  });

  it("only allows a team of exactly 30 coins from the round, the backed coin included", () => {
    const universe = [...thirty, "LIT"];
    expect(basketProblem([], "C0", [])).toBe("This Epoch's asset list is not available yet.");
    expect(basketProblem(universe, "C0", thirty.slice(1, 28))).toBe("Add 2 more to your team.");
    expect(basketProblem(universe, "C0", [...thirty.slice(1), "LIT"])).toBe("Remove 1 from your team.");
    expect(basketProblem(universe, "C0", [...thirty.slice(1, 29), "C0"])).toBe("Your team has a coin that is not in this round.");
    expect(basketProblem(universe, "C0", [...thirty.slice(1, 29), "DOGE"])).toBe("Your team has a coin that is not in this round.");
    expect(basketProblem(universe, "DOGE", thirty.slice(1))).toBe("Your team has a coin that is not in this round.");
  });
});
