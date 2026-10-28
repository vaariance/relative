import type { Epoch, EpochLot } from "@eox/app-api";
import { describe, expect, it } from "vitest";
import settled from "../../test/fixtures/epoch-2026-10-23-0800.json";
import { TEAMMATES, basketProblem, basketScore, byMove, defaultTeam, entryBasket, heroRounds, latestEpochs, mateLocked, basketMode, startingTeam, withToken, toggleMate, epochBasket, countdown, estimatedScore, executionReferences, feeOf, finalPayout, finalScore, lotOutcome, lotView, marketClosedReason, moves, refundMint, stageOf, timelineStep, withdrawSource } from "./epoch";

const epoch = (phase: Epoch["phase"], extra: Partial<Epoch> = {}): Epoch => ({ address: "x", opensAt: 1000, closesAt: 2000, phase, sealed: true, entriesOpen: false, universe: [], nextNonce: null, lots: null, totalWeight: null, settlementPot: null, allZero: null, closingReferences: [], closingDeadline: 88_400, voidable: false, terminal: false, ledger: null, registry: null, ...extra });
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
    expect(stageOf(epoch("open"), 88_400)).toBe("closing");
    expect(stageOf(epoch("open"), 88_401)).toBe("expired");
    expect(stageOf(epoch("open", { closingDeadline: 3000 }), 3001)).toBe("expired");
    expect(timelineStep("expired")).toBe(-1);
  });

  it("calls a round finished with no entries finished, not closing or stuck", () => {
    expect(stageOf(epoch("empty"), 2500)).toBe("empty");
    expect(stageOf(epoch("empty", { sealed: false }), 100_000)).toBe("empty");
    expect(timelineStep("empty")).toBe(-1);
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

describe("entry outcome", () => {
  it("counts only money above the stake as payout", () => {
    expect(lotOutcome(lot({ state: "claimable", claimable: "54400000" }), epoch("settled"))).toEqual({ returned: 54_400_000n, payout: 0n, result: -45_600_000n, outcome: "lost" });
    expect(lotOutcome(lot({ state: "claimable", claimable: "158560000" }), epoch("settled"))).toEqual({ returned: 158_560_000n, payout: 58_560_000n, result: 58_560_000n, outcome: "won" });
    expect(lotOutcome(lot({ state: "claimable", claimable: "0" }), epoch("settled"))?.outcome).toBe("lost");
    expect(lotOutcome(lot({}), epoch("open"))).toBeNull();
  });
});

describe("entry states", () => {
  it("separates waiting, active, withdrawable and history", () => {
    expect(lotView(lot({ state: "pending", execution: null }), epoch("open"), 1500).label).toBe("Awaiting execution");
    expect(lotView(lot({}), epoch("open"), 1500).group).toBe("active");
    expect(lotView(lot({ state: "claimable", claimable: "149970000" }), epoch("settled"), 2500)).toEqual({ group: "withdrawable", label: "Won", refund: false, outcome: "won" });
    expect(lotView(lot({ state: "claimable", claimable: "54400000" }), epoch("settled"), 2500)).toEqual({ group: "withdrawable", label: "Lost", refund: false, outcome: "lost" });
    expect(lotView(lot({ state: "claimable", claimable: "0" }), epoch("settled"), 2500)).toEqual({ group: "history", label: "Lost", refund: false, outcome: "lost" });
    expect(lotView(lot({ state: "withdrawn", claimable: null }), epoch("settled"), 2500).label).toBe("Withdrawn");
  });

  it("calls it a refund when the round was voided, nobody rose, or the entry never executed", () => {
    expect(lotView(lot({ state: "claimable", claimable: "100000000" }), epoch("voided"), 2500).label).toBe("Refund withdrawable");
    expect(lotView(lot({ state: "claimable", claimable: "100000000" }), epoch("settled", { allZero: true }), 2500).refund).toBe(true);
    expect(lotView(lot({ state: "claimable", claimable: "100000000", execution: null }), epoch("settled"), 2500).refund).toBe(true);
  });

  it("never says awaiting execution after the close", () => {
    expect(lotView(lot({ state: "pending", execution: null }), epoch("open"), 2000)).toEqual({ group: "pending", label: "Not executed · refund due", refund: true, outcome: null });
    expect(lotView(lot({}), epoch("open"), 88_401)).toEqual({ group: "pending", label: "Round not closed", refund: true, outcome: null });
  });

  it("offers the refund the API reports", () => {
    expect(lotView(lot({ state: "pending", execution: null, refund: "not-executed" }), epoch("open"), 2000)).toEqual({ group: "withdrawable", label: "Refund ready", refund: true, outcome: null });
    expect(lotView(lot({ refund: "voided" }), epoch("voided"), 90_000)).toEqual({ group: "withdrawable", label: "Refund ready", refund: true, outcome: null });
    expect(lotView(lot({ state: "withdrawn", refund: null }), epoch("voided"), 90_000).label).toBe("Withdrawn");
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

  it("estimates a score as the backed coin's share of the basket's gains", () => {
    const rows = [
      { id: "A", change: 0.3 },
      { id: "B", change: 0.1 },
      { id: "C", change: -0.1 },
    ];
    expect(estimatedScore(rows, "B")).toBeCloseTo(0.25);
    expect(estimatedScore(rows, "C")).toBe(0);
    expect(estimatedScore([{ id: "A", change: -0.1 }], "A")).toBe(0);
    expect(estimatedScore([{ id: "A", change: 0.1 }, { id: "B", change: null }], "A")).toBeNull();
    expect(estimatedScore(rows, "Z")).toBeNull();
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

  it("prefills every round, and only a larger round can be changed", () => {
    expect(basketMode(thirty)).toBe("fixed");
    expect(startingTeam(thirty, "C0")).toEqual(thirty.slice(1));
    expect(basketMode([...thirty, "LIT"])).toBe("pick");
    expect(startingTeam([...thirty, "LIT"], "C0")).toEqual(thirty.slice(1));
  });

  it("does not let a 30-coin basket change", () => {
    const mates = startingTeam(thirty, "C0");
    expect(toggleMate(thirty, "C0", mates, "C3")).toEqual(mates);
    expect(mateLocked(thirty, mates, "C3")).toBe(true);
  });

  it("orders coins by move with unpriced coins last", () => {
    const sorted = [0.02, null, -0.01, null, 0.005].sort(byMove);
    expect(sorted).toEqual([-0.01, 0.005, 0.02, null, null]);
  });

  it("only allows a team of exactly 30 coins from the round, the backed coin included", () => {
    const universe = [...thirty, "LIT"];
    expect(basketProblem([], "C0", [])).toBe("This Epoch's asset list is not available yet.");
    expect(basketProblem(universe, "C0", thirty.slice(1, 28))).toBe("Add 2 more coins to your basket.");
    expect(basketProblem(universe, "C0", [...thirty.slice(1), "LIT"])).toBe("Remove 1 coin from your basket.");
    expect(basketProblem(universe, "C0", [...thirty.slice(1, 29), "C0"])).toBe("Your basket has a coin that is not in this round.");
    expect(basketProblem(universe, "C0", [...thirty.slice(1, 29), "DOGE"])).toBe("Your basket has a coin that is not in this round.");
    expect(basketProblem(universe, "DOGE", thirty.slice(1))).toBe("Your basket has a coin that is not in this round.");
  });
});

describe("baskets in rounds of more than 30 coins", () => {
  const roundOf = (size: number) => Array.from({ length: size }, (_, i) => `A${i}`);
  const pickAll = (universe: string[], backed: string) => universe.reduce<string[]>((draft, id) => toggleMate(universe, backed, draft, id), []);

  for (const size of [31, 32, 45, 59, 60, 100, 245, 255]) {
    describe(`${size} coins`, () => {
      const universe = roundOf(size);

      it("starts with the first 29 other coins in the round's order, ready to enter", () => {
        expect(basketMode(universe)).toBe("pick");
        const backed = universe[5]!;
        const team = startingTeam(universe, backed);
        expect(team).toEqual(universe.filter((id) => id !== backed).slice(0, 29));
        expect(basketProblem(universe, backed, team)).toBeNull();
      });

      it("swaps a prefilled coin for another by removing then adding", () => {
        const backed = universe[0]!;
        const team = startingTeam(universe, backed);
        const outside = universe.at(-1)!;
        expect(mateLocked(universe, team, outside)).toBe(true);
        const swapped = toggleMate(universe, backed, toggleMate(universe, backed, team, team[3]!), outside);
        expect(swapped).toHaveLength(29);
        expect(swapped).toContain(outside);
        expect(swapped).not.toContain(team[3]);
        expect(basketProblem(universe, backed, swapped)).toBeNull();
      });

      it("still asks for the rest when coins are removed", () => {
        expect(basketProblem(universe, universe[0]!, [])).toBe("Add 29 more coins to your basket.");
      });

      it("stops at 29 picks and makes a valid basket of 30", () => {
        const backed = universe.at(-1)!;
        const mates = pickAll(universe, backed);
        expect(mates).toHaveLength(29);
        expect(mates).not.toContain(backed);
        expect(entryBasket(universe, backed, mates)).toHaveLength(30);
        expect(basketProblem(universe, backed, mates)).toBeNull();
      });

      it("locks unpicked coins once 29 are picked and frees one when a pick is removed", () => {
        const backed = universe[0]!;
        const mates = pickAll(universe, backed);
        const outside = universe.find((id) => id !== backed && !mates.includes(id))!;
        expect(mateLocked(universe, mates, outside)).toBe(true);
        expect(mateLocked(universe, mates, mates[0]!)).toBe(false);
        const fewer = toggleMate(universe, backed, mates, mates[0]!);
        expect(fewer).toHaveLength(28);
        expect(mateLocked(universe, fewer, outside)).toBe(false);
        expect(toggleMate(universe, backed, fewer, outside)).toContain(outside);
      });

      it("ignores the backed coin and coins from outside the round", () => {
        const backed = universe[0]!;
        const mates = pickAll(universe, backed);
        expect(toggleMate(universe, backed, mates, backed)).toEqual(mates);
        expect(toggleMate(universe, backed, mates, "NOT-IN-ROUND")).toEqual(mates);
      });
    });
  }
});

describe("coins the API has not named yet", () => {
  const named = Array.from({ length: 30 }, (_, i) => `A${i}`);
  const member = (assetId: string, id: number) => ({ id, assetId, originPrice: "1" });

  it("are left out of the round until they have a name", () => {
    const universe = [...named, "#30", "#31"].map(member);
    expect(epochBasket(epoch("open", { universe }))).toEqual(named);
    expect(epochBasket(epoch("settled", { closingReferences: [...named, "#30"].map((assetId) => ({ assetId, reference: "1" })) }))).toEqual(named);
  });

  it("only treat names like #31 as unnamed", () => {
    const universe = [...named, "W", "#", "#x"].map(member);
    expect(epochBasket(epoch("open", { universe }))).toEqual([...named, "W", "#", "#x"]);
  });

  it("show up as soon as they are named", () => {
    const before = epochBasket(epoch("open", { universe: [...named, "#30"].map(member) }));
    const after = epochBasket(epoch("open", { universe: [...named, "LIT"].map(member) }));
    expect(before).toHaveLength(30);
    expect(after).toEqual([...named, "LIT"]);
    expect(basketMode(after)).toBe("pick");
  });

  it("block entries when hiding them leaves fewer than 30 coins", () => {
    const basket = epochBasket(epoch("open", { universe: [...named.slice(0, 29), "#29"].map(member) }));
    expect(basket).toHaveLength(29);
    expect(basketProblem(basket, "A0", defaultTeam(basket, "A0"))).toBe("This Epoch's asset list is not available yet.");
  });
});

describe("keeping the last rounds when a refresh fails", () => {
  const overview = (tag: string) => ({ configuration: { address: tag }, epochs: [] }) as never;
  const older = { overview: overview("old"), fetchedAt: 100 };
  const newer = { overview: overview("new"), fetchedAt: 200 };

  it("shows a fresh read as current", () => {
    expect(latestEpochs({ ...newer, fresh: true }, older)).toEqual({ shown: { ...newer, fresh: true }, staleSince: null });
  });

  it("falls back to the newest copy it has, marked stale", () => {
    expect(latestEpochs(null, older)).toEqual({ shown: older, staleSince: 100 });
    expect(latestEpochs({ ...older, fresh: false }, newer).shown).toBe(newer);
    expect(latestEpochs({ ...newer, fresh: false }, older)).toEqual({ shown: { ...newer, fresh: false }, staleSince: 200 });
  });

  it("has nothing to show only when nothing was ever read", () => {
    expect(latestEpochs(null, null)).toEqual({ shown: null, staleSince: null });
  });
});

describe("hero rounds", () => {
  const settledRound = epoch("settled", { address: "s", opensAt: 0, closesAt: 900 });
  const openRound = epoch("open", { address: "o" });
  const nextRound = epoch("open", { address: "n", opensAt: 3000, closesAt: 4000 });

  it("shows only rounds that exist, never a made-up next round", () => {
    expect(heroRounds([settledRound], 1500).map((item) => item.address)).toEqual(["s"]);
    expect(heroRounds([], 1500)).toEqual([]);
  });

  it("pairs the last finished round with the open or scheduled one", () => {
    expect(heroRounds([settledRound, openRound], 1500).map((item) => item.address)).toEqual(["s", "o"]);
    expect(heroRounds([settledRound, nextRound], 1500).map((item) => item.address)).toEqual(["s", "n"]);
    expect(heroRounds([openRound], 1500).map((item) => item.address)).toEqual(["o"]);
  });

  it("does not offer a round that missed its close as the next one", () => {
    expect(heroRounds([settledRound, epoch("open", { address: "x", opensAt: 0, closesAt: 900 })], 1500).map((item) => item.address)).toEqual(["s"]);
  });
});

describe("refunds and market lifecycle", () => {
  it("refunds the whole stake from a vault that holds all of it", () => {
    expect(refundMint(["P", "S"], { primary: 10n, secondary: 0n }, 10n)).toEqual({ mint: "P", index: 0 });
    expect(refundMint(["P", "S"], { primary: 5n, secondary: 10n }, 10n)).toEqual({ mint: "S", index: 1 });
    expect(refundMint(["P", "S"], { primary: 5n, secondary: 5n }, 10n)).toBeNull();
    expect(refundMint(["P"], null, 10n)).toEqual({ index: 0 });
  });

  it("explains why entries are closed when the Epoch market is not active", () => {
    const configuration = (lifecycle: "preparing" | "active" | "archived") => ({ lifecycle }) as Parameters<typeof marketClosedReason>[0];
    expect(marketClosedReason(configuration("active"))).toBeNull();
    expect(marketClosedReason(configuration("preparing"))).toMatch(/being set up/);
    expect(marketClosedReason(configuration("archived"))).toMatch(/takes no new entries/);
  });
});

describe("basket steps", () => {
  const round = (size: number) => Array.from({ length: size }, (_, index) => `C${index}`);
  it("asks for nothing when the round has exactly 30 coins", () => {
    expect(basketMode(round(30))).toBe("fixed");
    const team = startingTeam(round(30), "C0");
    expect(team).toHaveLength(TEAMMATES);
    expect(basketProblem(round(30), "C0", team)).toBeNull();
  });
  it("prefills 29 coins in any round larger than 30", () => {
    for (const size of [31, 60, 245]) {
      expect(basketMode(round(size))).toBe("pick");
      expect(startingTeam(round(size), "C0")).toEqual(round(size).slice(1, 30));
      expect(basketProblem(round(size), "C0", startingTeam(round(size), "C0"))).toBeNull();
    }
  });
});

describe("changing the token", () => {
  const universe = Array.from({ length: 31 }, (_, index) => `C${index}`);
  it("keeps the starting basket until the user edits it", () => {
    expect(withToken(universe, null, null, "C1")).toEqual({ backed: "C1", mates: null });
  });
  it("puts the old token in the new token's place when the new one was in the basket", () => {
    const picked = universe.slice(2, 31);
    const next = withToken(universe, "C1", picked, "C2");
    expect(next.backed).toBe("C2");
    expect(next.mates).not.toContain("C2");
    expect(next.mates).toContain("C1");
    expect(next.mates).toHaveLength(29);
    expect(basketProblem(universe, "C2", next.mates ?? [])).toBeNull();
  });
  it("keeps the picks unchanged when the new token was outside the basket", () => {
    const picked = universe.slice(2, 31);
    expect(withToken(universe, "C1", picked, "C0")).toEqual({ backed: "C0", mates: picked });
  });
  it("clears the entry when the token is removed", () => {
    expect(withToken(universe, "C1", ["C2"], "C1")).toEqual({ backed: null, mates: null });
    expect(withToken(universe, "C1", ["C2"], null)).toEqual({ backed: null, mates: null });
  });
});
