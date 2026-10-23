import { describe, expect, it } from "vitest";
import { FAUCET_WINDOW_SECONDS, claimAllowance, faucetMemo } from "./faucet";

const NOW = 1792800000;
const OWNER = "GpgFFekD9bT9kAHnDyfwXwCbDdT6mVwkgCnZrFbnnepN";
const OTHER = "HgC4Jn7XMLzNsDjVdsr1x7BDuGBb2SBvx5TFLSUYaEyU";
const claim = (owner: string, blockTime: number | null, failed = false) => ({ memo: `[${faucetMemo(owner).length}] ${faucetMemo(owner)}`, blockTime, failed });

describe("faucet allowance", () => {
  it("allows two claims a day for a new wallet", () => {
    expect(claimAllowance([], OWNER, NOW, 2)).toEqual({ left: 2, nextAt: null });
  });

  it("counts only this wallet's successful claims in the last 24 hours", () => {
    const records = [claim(OWNER, NOW - 100), claim(OTHER, NOW - 50), claim(OWNER, NOW - 10, true), claim(OWNER, NOW - FAUCET_WINDOW_SECONDS - 1), { memo: null, blockTime: NOW, failed: false }];
    expect(claimAllowance(records, OWNER, NOW, 2)).toEqual({ left: 1, nextAt: null });
  });

  it("gives the time the oldest counted claim leaves the window", () => {
    const records = [claim(OWNER, NOW - 300), claim(OWNER, NOW - 7200)];
    expect(claimAllowance(records, OWNER, NOW, 2)).toEqual({ left: 0, nextAt: NOW - 7200 + FAUCET_WINDOW_SECONDS });
  });

  it("counts a claim that has no block time yet as just made", () => {
    expect(claimAllowance([claim(OWNER, null), claim(OWNER, NOW - 60)], OWNER, NOW, 2).left).toBe(0);
  });
});
