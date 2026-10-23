import type { Epoch, EpochLot } from "@eox/app-api";
import { describe, expect, it } from "vitest";
import { countdown, feeOf, lotView, moves, stageOf, timelineStep } from "./epoch";

const epoch = (phase: Epoch["phase"], extra: Partial<Epoch> = {}): Epoch => ({ address: "x", opensAt: 1000, closesAt: 2000, phase, sealed: true, entriesOpen: false, universe: [], nextNonce: null, lots: null, totalWeight: null, settlementPot: null, allZero: null, closingReferences: [], ledger: null, ...extra });
const lot = (extra: Partial<EpochLot>): EpochLot => ({ address: "l", epochOpensAt: 1000, nonce: "0", owner: "o", grossStake: "100000000", fee: "20000", admittedAt: 1100, basket: [], backedAsset: "ETH", execution: { timestamp: 1101, references: [] }, state: "executed", score: null, weight: null, claimable: null, ...extra });

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
});

describe("relative moves", () => {
  it("ranks by move against $CRYPTO and keeps missing values as gaps", () => {
    const rows = moves(["A", "B", "C"], { A: 100, B: 100 }, { A: 99, B: 102, C: 101 });
    expect(rows.map((row) => row.id)).toEqual(["B", "A", "C"]);
    expect(rows[0]!.change).toBeCloseTo(0.02);
    expect(rows[2]!.change).toBeNull();
  });
});

describe("entry states", () => {
  it("separates waiting, active, withdrawable and history", () => {
    expect(lotView(lot({ state: "pending", execution: null }), epoch("open")).label).toBe("Awaiting execution");
    expect(lotView(lot({}), epoch("open")).group).toBe("active");
    expect(lotView(lot({ state: "claimable", claimable: "149970000" }), epoch("settled"))).toEqual({ group: "withdrawable", label: "Payout withdrawable", refund: false });
    expect(lotView(lot({ state: "claimable", claimable: "0" }), epoch("settled")).group).toBe("history");
    expect(lotView(lot({ state: "withdrawn", claimable: "0" }), epoch("settled")).label).toBe("Withdrawn");
  });

  it("calls it a refund when the round was voided, nobody rose, or the entry never executed", () => {
    expect(lotView(lot({ state: "claimable", claimable: "100000000" }), epoch("voided")).label).toBe("Refund withdrawable");
    expect(lotView(lot({ state: "claimable", claimable: "100000000" }), epoch("settled", { allZero: true })).refund).toBe(true);
    expect(lotView(lot({ state: "claimable", claimable: "100000000", execution: null }), epoch("settled")).refund).toBe(true);
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
