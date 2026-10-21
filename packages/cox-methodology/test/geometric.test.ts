import assert from "node:assert/strict";
import test from "node:test";
import { geometricBenchmark } from "../src/geometric.ts";

const level = 100_000_000_000_000n;
test("off-chain geometric implementation matches the Rust candidate at exact output precision", () => {
  const cases: readonly [readonly bigint[], bigint][] = [
    [[110n, 110n], 110_000_000_000_000n], [[110n, 90n], 99_498_743_710_662n],
    [[200n, 100n], 141_421_356_237_310n], [[200n, 50n], level], [[50n, 100n], 70_710_678_118_655n],
  ];
  for (const [current, expected] of cases) assert.equal(geometricBenchmark([100n, 100n], current, level), expected);
});
test("live previews are anchored rather than compounded at every notification", () => {
  const anchor = [100n, 100n];
  const before = geometricBenchmark(anchor, anchor, level);
  geometricBenchmark(anchor, [110n, 90n], level);
  assert.equal(geometricBenchmark(anchor, anchor, level), before);
});
test("expanded benchmark universe remains order independent with equal log influence", () => {
  for (const count of [30, 32, 256]) {
    const anchor = Array<bigint>(count).fill(1_000_000n);
    const current = Array.from({ length: count }, (_, i) => 900_000n + BigInt(i) * 1000n);
    const benchmark = geometricBenchmark(anchor, current, level);
    assert.equal(geometricBenchmark(anchor, [...current].reverse(), level), benchmark);
    const expected = Math.exp(current.reduce((s, price) => s + Math.log(Number(price) / 1_000_000), 0) / count);
    assert.ok(Math.abs(Number(benchmark) / Number(level) - expected) < 1e-11);
  }
});
test("price domains, invalid universes and representational overflow are explicit", () => {
  assert.throws(() => geometricBenchmark([1n], [1n], level), /InvalidReferenceInput/);
  assert.throws(() => geometricBenchmark([1n, 0n], [1n, 1n], level), /InvalidReferenceInput/);
  assert.throws(() => geometricBenchmark([1n, 1n], [1n], level), /InvalidReferenceInput/);
  assert.throws(() => geometricBenchmark([1n, 1n], [1n << 64n, 1n], level), /InvalidReferenceInput/);
  assert.throws(() => geometricBenchmark([1n, 1n], [2n, 2n], (1n << 127n) - 1n), /ArithmeticOverflow/);
});
