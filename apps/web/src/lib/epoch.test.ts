import type { Epoch } from "@eox/app-api";
import { describe, expect, it } from "vitest";
import { countdown, feeOf, shareBoard, stageOf } from "./epoch";

const epoch = (phase: Epoch["phase"]): Epoch => ({ address: "x", opensAt: 1000, closesAt: 2000, phase, sealed: true, entriesOpen: false, universe: [], nextNonce: null, lots: null, totalWeight: null, settlementPot: null, allZero: null, closingReferences: [], ledger: null });

describe("epoch stage", () => {
  it("follows the clock while the program says open", () => {
    expect(stageOf(epoch("open"), 500)).toBe("upcoming");
    expect(stageOf(epoch("open"), 1500)).toBe("live");
    expect(stageOf(epoch("open"), 2500)).toBe("closing");
  });

  it("uses the program's phase once the round is closed", () => {
    expect(stageOf(epoch("draft"), 1500)).toBe("upcoming");
    expect(stageOf(epoch("allocating"), 2500)).toBe("closing");
    expect(stageOf(epoch("settled"), 2500)).toBe("settled");
    expect(stageOf(epoch("voided"), 2500)).toBe("voided");
  });
});

describe("share of gains", () => {
  it("splits the gains among coins that rose, like the program's score", () => {
    const rows = shareBoard(["A", "B", "C"], { A: 100, B: 100, C: 100 }, { A: 103, B: 101, C: 95 });
    expect(rows.map((row) => row.id)).toEqual(["A", "B", "C"]);
    expect(rows[0]!.share).toBeCloseTo(0.75);
    expect(rows[1]!.share).toBeCloseTo(0.25);
    expect(rows[2]!.share).toBe(0);
    expect(rows[2]!.change).toBeCloseTo(-0.05);
  });

  it("gives every coin zero when nothing rose or prices are missing", () => {
    expect(shareBoard(["A", "B"], { A: 100, B: 100 }, { A: 99, B: 98 }).every((row) => row.share === 0)).toBe(true);
    expect(shareBoard(["A"], null, { A: 101 })[0]).toEqual({ id: "A", change: null, share: 0 });
  });
});

describe("entry fee and countdown", () => {
  it("charges 2 bps capped at the cap", () => {
    expect(feeOf(10_000_000n, 2, 200_000n)).toBe(2_000n);
    expect(feeOf(5_000_000_000_000n, 2, 200_000n)).toBe(200_000n);
  });

  it("shows hours and minutes, then minutes and seconds", () => {
    expect(countdown(3 * 3600 + 5 * 60)).toBe("3h 05m");
    expect(countdown(125)).toBe("2m 05s");
    expect(countdown(-4)).toBe("0m 00s");
  });
});
