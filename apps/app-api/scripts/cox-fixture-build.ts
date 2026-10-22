import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

const COX = new URL("../../../packages/cox/", import.meta.url);
const ORACLE_FILES = ["Cargo.lock", "crates/math/src/lib.rs", "crates/cli/src/main.rs"];
const SCALE = 1_000_000_000_000n;
const E8 = 100_000_000n;

interface ClassState {
  backing: bigint;
  units: bigint;
}

type Request =
  | { id: string; kind: "deposit"; to: number; amount: bigint; minimum: bigint; expiry: number }
  | { id: string; kind: "redeem"; from: number; units: bigint; minimum: bigint; expiry: number }
  | { id: string; kind: "switch"; from: number; to: number; units: bigint; minimum: bigint; expiry: number };

type Wire = { [key: string]: string | Wire[] };

function cox(command: "reference" | "revalue" | "batch", input: unknown): Wire {
  const json = JSON.stringify(input, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
  const binary = process.env.COX_CLI;
  const [file, args] = binary
    ? [binary, [command]]
    : ["cargo", ["run", "--quiet", "--locked", "--release", "--manifest-path", fileURLToPath(new URL("Cargo.toml", COX)), "-p", "cox-cli", "--", command]];
  return JSON.parse(execFileSync(file, args, { input: json, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] })) as Wire;
}

const big = (value: unknown) => BigInt(value as string);
const bigs = (value: unknown) => (value as string[]).map(BigInt);
const classesOf = (value: unknown) => (value as Wire[]).map((c) => ({ backing: big(c.backing), units: big(c.units) }));
const wireRequest = (r: Request) =>
  r.kind === "deposit"
    ? { kind: r.kind, id: r.id, to: r.to, amount: r.amount, minimum: r.minimum, expiry: r.expiry }
    : r.kind === "redeem"
      ? { kind: r.kind, id: r.id, from: r.from, units: r.units, minimum: r.minimum, expiry: r.expiry }
      : { kind: r.kind, id: r.id, from: r.from, to: r.to, units: r.units, minimum: r.minimum, expiry: r.expiry };

function reference(previous: bigint[], current: bigint[], origin: bigint[], previousBenchmark: bigint) {
  const out = cox("reference", { previous, current, origin, previousBenchmark });
  return { gross: bigs(out.gross), benchmarkGross: big(out.benchmarkGross), benchmark: big(out.benchmark), relative: bigs(out.relative), h: bigs(out.h) };
}

function revalue(classes: ClassState[], h: bigint[]) {
  const out = cox("revalue", { classes, h });
  return { classes: classesOf(out.classes), residual: big(out.residual) };
}

function batch(classes: ClassState[], requests: Request[], publicationBatch: number) {
  const out = cox("batch", { classes, requests: requests.map(wireRequest), publicationBatch });
  return {
    classes: classesOf(out.classes),
    payable: big(out.payable),
    refunds: big(out.refunds),
    residual: big(out.residual),
    receipts: (out.receipts as Wire[]).map((r) => ({ id: r.id as string, outcome: r.outcome as string, minted: big(r.minted), proceeds: big(r.proceeds) })),
  };
}

function oracleDigest(): string {
  const hash = createHash("sha256");
  for (const path of ORACLE_FILES) hash.update(`${path}\n`).update(readFileSync(new URL(path, COX), "utf8").replace(/\r\n/g, "\n"));
  return hash.digest("hex");
}
const ASSETS = [
  { assetId: "SYNA", name: "Synthetic asset A" },
  { assetId: "SYNB", name: "Synthetic asset B" },
] as const;
const CLASS_IDS = [...ASSETS.map((a) => a.assetId), "CRYPTO"];
const OUTCOME = { Filled: "filled", ConditionFailed: "condition-failed", Expired: "expired", ZeroValueClass: "zero-value-class" } as const;

interface Step {
  batch: number;
  prices: bigint[];
  requests: (Request & { owner: string; targetBatch: number })[];
}

const wallet = (name: string) => new PublicKey(createHash("sha256").update(`cox-app-api-fixture:${name}`).digest()).toBase58();
const OWNERS = { alice: wallet("alice"), bob: wallet("bob"), carol: wallet("carol"), dave: wallet("dave"), erin: wallet("erin") };

const ORIGIN_PRICES = [100n * E8, 100n * E8];
const STEPS: Step[] = [
  {
    batch: 1,
    prices: [100n * E8, 100n * E8],
    requests: [
      { id: "alice-1", owner: OWNERS.alice, targetBatch: 1, kind: "deposit", to: 0, amount: 100n, minimum: 0n, expiry: 3 },
      { id: "bob-1", owner: OWNERS.bob, targetBatch: 1, kind: "deposit", to: 1, amount: 50n, minimum: 0n, expiry: 3 },
      { id: "carol-1", owner: OWNERS.carol, targetBatch: 1, kind: "deposit", to: 2, amount: 20n, minimum: 0n, expiry: 3 },
    ],
  },
  {
    batch: 2,
    prices: [120n * E8, 80n * E8],
    requests: [
      { id: "alice-2", owner: OWNERS.alice, targetBatch: 2, kind: "redeem", from: 0, units: 10n * SCALE, minimum: 0n, expiry: 4 },
      { id: "bob-2", owner: OWNERS.bob, targetBatch: 2, kind: "switch", from: 1, to: 0, units: 10n * SCALE, minimum: 0n, expiry: 4 },
      { id: "dave-1", owner: OWNERS.dave, targetBatch: 2, kind: "deposit", to: 1, amount: 30n, minimum: 1000n * SCALE, expiry: 4 },
    ],
  },
  {
    batch: 4,
    prices: [130n * E8, 70n * E8],
    requests: [{ id: "erin-1", owner: OWNERS.erin, targetBatch: 3, kind: "deposit", to: 0, amount: 40n, minimum: 0n, expiry: 3 }],
  },
];
const QUEUED = [{ id: "alice-3", owner: OWNERS.alice, targetBatch: 5, kind: "deposit" as const, to: 2, amount: 25n, minimum: 0n, expiry: 7 }];

const s = (value: bigint) => value.toString();
const state = (c: ClassState) => ({ backing: s(c.backing), units: s(c.units) });

function requestView(r: Step["requests"][number], status: string, receipt: unknown) {
  return {
    requestId: r.id,
    owner: r.owner,
    operation: r.kind,
    fromClass: r.kind === "deposit" ? null : CLASS_IDS[r.from]!,
    toClass: r.kind === "redeem" ? null : CLASS_IDS[r.to]!,
    amount: r.kind === "deposit" ? s(r.amount) : null,
    units: r.kind === "deposit" ? null : s(r.units),
    minimumUnits: r.kind === "redeem" ? null : s(r.minimum),
    minimumProceeds: r.kind === "redeem" ? s(r.minimum) : null,
    targetBatch: r.targetBatch,
    expiryBatch: r.expiry,
    state: status,
    receipt,
  };
}

export function buildCoxFixture() {
  const zero: ClassState[] = CLASS_IDS.map(() => ({ backing: 0n, units: 0n }));
  const publications: unknown[] = [];
  const requests: ReturnType<typeof requestView>[] = [];
  const positions = new Map<string, bigint[]>();
  const owed = new Map<string, { payable: bigint; refundable: bigint }>();
  const account = (owner: string) => {
    if (!positions.has(owner)) positions.set(owner, CLASS_IDS.map(() => 0n));
    if (!owed.has(owner)) owed.set(owner, { payable: 0n, refundable: 0n });
    return { units: positions.get(owner)!, owed: owed.get(owner)! };
  };
  let classes = zero;
  let previousPrices = ORIGIN_PRICES;
  let benchmark = 100n * SCALE;
  let vault = 0n;
  let payable = 0n;
  let refundable = 0n;
  let residual = 0n;
  let previousBatch = 0;

  publications.push({
    sequence: 0,
    batch: 0,
    predecessorSequence: null,
    predecessorBatch: null,
    missedBatches: [],
    prices: ORIGIN_PRICES.map((p, i) => ({ assetId: ASSETS[i]!.assetId, priceE8: s(p) })),
    benchmarkGross: null,
    benchmark: s(benchmark),
    references: ASSETS.map((a) => ({ assetId: a.assetId, gross: null, reference: s(100n * SCALE) })),
    classes: CLASS_IDS.map((classId, classIndex) => ({ classId, classIndex, transferFactor: null, preRevaluation: state(zero[classIndex]!), fixed: state(zero[classIndex]!), final: state(zero[classIndex]!) })),
    flows: { acceptedDeposits: "0", newPayable: "0", transferResidual: "0", flowResidual: "0", executed: 0, rejected: 0 },
    ledger: { active: "0", pending: "0", refundable: "0", payable: "0", residual: "0", vault: "0" },
  });

  STEPS.forEach((step, index) => {
    const ref = reference(previousPrices, step.prices, ORIGIN_PRICES, benchmark);
    const revalued = revalue(classes, ref.h);
    const result = batch(revalued.classes, step.requests, step.batch);
    for (const r of step.requests) if (r.kind === "deposit") vault += r.amount;
    payable += result.payable;
    refundable += result.refunds;
    residual += revalued.residual + result.residual;
    const active = result.classes.reduce((sum, c) => sum + c.backing, 0n);
    if (active + refundable + payable + residual !== vault) throw new Error(`fixture vault does not reconcile at batch ${step.batch}`);
    const sequence = index + 1;
    result.receipts.forEach((receipt, i) => {
      const r = step.requests[i]!;
      const status = OUTCOME[receipt.outcome as keyof typeof OUTCOME];
      const { units, owed: o } = account(r.owner);
      if (status === "filled") {
        if (r.kind !== "deposit") units[r.from]! -= r.units;
        if (r.kind !== "redeem") units[r.to]! += receipt.minted;
        if (r.kind === "redeem") o.payable += receipt.proceeds;
      } else if (r.kind === "deposit") {
        o.refundable += r.amount;
      }
      requests.push(requestView(r, status, { requestId: r.id, sequence, batch: step.batch, status, minted: s(receipt.minted), proceeds: s(receipt.proceeds) }));
    });
    const missedBatches = [];
    for (let b = previousBatch + 1; b < step.batch; b += 1) missedBatches.push(b);
    publications.push({
      sequence,
      batch: step.batch,
      predecessorSequence: sequence - 1,
      predecessorBatch: previousBatch,
      missedBatches,
      prices: step.prices.map((p, i) => ({ assetId: ASSETS[i]!.assetId, priceE8: s(p) })),
      benchmarkGross: s(ref.benchmarkGross),
      benchmark: s(ref.benchmark),
      references: ASSETS.map((a, i) => ({ assetId: a.assetId, gross: s(ref.gross[i]!), reference: s(ref.relative[i]!) })),
      classes: CLASS_IDS.map((classId, classIndex) => ({
        classId,
        classIndex,
        transferFactor: s(ref.h[classIndex]!),
        preRevaluation: state(classes[classIndex]!),
        fixed: state(revalued.classes[classIndex]!),
        final: state(result.classes[classIndex]!),
      })),
      flows: {
        acceptedDeposits: s(step.requests.reduce((sum, r, i) => (r.kind === "deposit" && result.receipts[i]!.outcome === "Filled" ? sum + r.amount : sum), 0n)),
        newPayable: s(result.payable),
        transferResidual: s(revalued.residual),
        flowResidual: s(result.residual),
        executed: result.receipts.filter((r) => r.outcome === "Filled").length,
        rejected: result.receipts.filter((r) => r.outcome !== "Filled").length,
      },
      ledger: { active: s(active), pending: s(refundable), refundable: s(refundable), payable: s(payable), residual: s(residual), vault: s(vault) },
    });
    classes = result.classes;
    previousPrices = step.prices;
    benchmark = ref.benchmark;
    previousBatch = step.batch;
  });

  for (const r of QUEUED) {
    account(r.owner);
    requests.push(requestView(r, "queued", null));
  }
  const wallets = [...positions.entries()].map(([owner, units]) => {
    const o = owed.get(owner)!;
    const queued = QUEUED.filter((r) => r.owner === owner).reduce((sum, r) => sum + r.amount, 0n);
    return {
      owner,
      positions: units.map((u, i) => ({ classId: CLASS_IDS[i]!, units: s(u), locked: "0" })).filter((p) => p.units !== "0"),
      payable: s(o.payable),
      refundable: s(o.refundable),
      pending: s(o.refundable + queued),
      requests: requests.filter((r) => r.owner === owner),
    };
  });

  return {
    schema: "cox.app-api/fixture/v1",
    source: {
      oracle: "packages/cox/crates/cli",
      oracleSha256: oracleDigest(),
      note: "Two synthetic assets and CRYPTO computed with the Rust cox-cli (reference, revalue, batch; legacy arithmetic benchmark). Synthetic prices and wallets; not market data.",
    },
    methodology: { digest: null, label: "CRYPTO (fixture, 2 synthetic assets)", status: "draft", assetCount: ASSETS.length },
    assets: ASSETS.map((a, classIndex) => ({ ...a, classIndex })),
    classIds: CLASS_IDS,
    publications,
    wallets,
  };
}
