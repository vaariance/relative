import { describe, expect, it } from "vitest";
import { batchesFor, closedLabel, closedNote, collateralsOf, expiryAfter, tradingClosed } from "./market";

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TEST = "5rpGrekfBLHdF8PD8eKLzXQPPmhyF7FCKeE1VA5CwV3X";
const NOW = 1792670400;

describe("request expiry", () => {
  it("keeps three minutes of validity on minute pools", () => {
    expect(batchesFor(60)).toBe(3);
    expect(expiryAfter(100, 60)).toBe(102);
  });

  it("counts one-second pools in seconds", () => {
    expect(batchesFor(1)).toBe(180);
    expect(expiryAfter(70497, 1)).toBe(70676);
  });

  it("never asks for fewer than one batch", () => {
    expect(batchesFor(600)).toBe(1);
    expect(batchesFor(0)).toBe(1);
  });
});

describe("collateral mints", () => {
  it("lists the primary mint first and names the test mint", () => {
    expect(collateralsOf({ collateralMint: USDC, secondaryCollateralMint: TEST })).toEqual([
      { mint: USDC, symbol: "USDC", name: "devnet USDC", primary: true },
      { mint: TEST, symbol: "rlUSD", name: "Relative test USD", primary: false },
    ]);
  });

  it("returns one mint when the pool has no second one", () => {
    expect(collateralsOf({ collateralMint: USDC, secondaryCollateralMint: null })).toHaveLength(1);
    expect(collateralsOf(null)).toEqual([]);
  });
});

describe("trading gate", () => {
  it("is open when the API says so or says nothing", () => {
    expect(tradingClosed(null)).toBe(false);
    expect(tradingClosed({ open: true, gate: "open", lifecycle: "active", opensAt: null })).toBe(false);
    expect(closedLabel({ open: true, gate: "open", lifecycle: "active", opensAt: null }, NOW)).toBeNull();
  });

  it("names the reason it is closed", () => {
    expect(closedLabel({ open: false, gate: "paused", lifecycle: "active", opensAt: NOW - 60 }, NOW)).toBe("Trading paused");
    expect(closedLabel({ open: false, gate: "before-opening", lifecycle: "active", opensAt: NOW + 7200 }, NOW)).toBe("Opens at 14:00 UTC");
    expect(closedLabel({ open: false, gate: "before-opening", lifecycle: "active", opensAt: NOW + 86400 }, NOW)).toBe("Opens at 23 Oct, 12:00 UTC");
    expect(closedLabel({ open: false, gate: "retired", lifecycle: "active", opensAt: null }, NOW)).toBe("Market retired");
    expect(closedNote({ open: false, gate: "not-initialized", lifecycle: "active", opensAt: null }, NOW)).toBe("This market has not opened yet.");
    expect(closedLabel({ open: false, gate: "preparing", lifecycle: "preparing", opensAt: NOW + 7200 }, NOW)).toBe("Opens at 14:00 UTC");
    expect(closedNote({ open: false, gate: "preparing", lifecycle: "preparing", opensAt: NOW + 7200 }, NOW)).toBe("This market is being set up. Trading opens at 14:00 UTC.");
    expect(closedNote({ open: false, gate: "preparing", lifecycle: "preparing", opensAt: NOW - 60 }, NOW)).toBe("This market is being set up. Trading opens once it is ready.");
    expect(closedLabel({ open: false, gate: "archived", lifecycle: "archived", opensAt: null }, NOW)).toBe("Market closed");
  });
});
