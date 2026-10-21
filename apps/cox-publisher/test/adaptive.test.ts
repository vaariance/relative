import assert from "node:assert/strict";
import test from "node:test";
import {
  AdaptivePublisher,
  type AdaptiveChainState,
  type AdaptiveCheckpoint,
  type AdaptivePlan,
  type AdaptivePorts,
  type AdaptiveSnapshot,
  type AdaptiveWork,
} from "../src/adaptive.ts";

function basic(id: string, eligibleAfterMs = 0): AdaptiveWork {
  return { kind: "basic-request", id, eligibleAfterMs, assetIds: ["BTC"] };
}

function epoch(id: string, eligibleAfterMs = 0): AdaptiveWork {
  return { kind: "epoch-prediction", id, eligibleAfterMs, assetIds: ["BTC", "ETH"] };
}

function harness(maxBatchSize = 2) {
  let now = 10_000;
  let saved: AdaptiveCheckpoint | null = null;
  let outcome: "pending" | "accepted" | "expired" = "accepted";
  let submitError = false;
  let saveError = false;
  let blocked: Promise<void> | null = null;
  let provideSnapshot = true;
  let rewriteSnapshot = (snapshot: AdaptiveSnapshot) => snapshot;
  const state: { value: AdaptiveChainState } = {
    value: { stateId: "state-1", methodologyId: "operator-geometric-v1", nextSequence: 1n,
      requiredAssetIds: ["SOL"], pending: [], nextClosingDeadlineMs: null },
  };
  const plans: AdaptivePlan[] = [];
  const calls = { reads: 0, snapshots: 0, prepares: 0, submits: 0, reconciles: 0 };
  const ports: AdaptivePorts = {
    clock: { nowMs: () => now },
    chain: { read: async () => { calls.reads++; if (blocked) await blocked; return state.value; } },
    snapshots: { select: async (plan) => {
      calls.snapshots++;
      if (!provideSnapshot) return null;
      return rewriteSnapshot({
        id: `snapshot-${now}`, previousStateId: plan.stateId, sequence: plan.sequence,
        oracleTimestampMs: plan.closingTimestampMs ?? now,
        methodologyId: "operator-geometric-v1", benchmark: 100n,
        prices: plan.requiredAssetIds.map((assetId) => ({ assetId, price: 100n })),
        oracleEvidence: new Uint8Array([1]),
      });
    } },
    executor: {
      prepare: async (plan) => {
        calls.prepares++;
        plans.push(plan);
        return { id: `tx-${now}`, transaction: new Uint8Array([1, 2]) };
      },
      submit: async () => { calls.submits++; if (submitError) throw new Error("submission timed out"); },
      reconcile: async () => {
        calls.reconciles++;
        if (outcome === "accepted") {
          const done = new Set(plans.at(-1)?.work.map((item) => item.id));
          state.value = { ...state.value, stateId: `state-${now}`, nextSequence: state.value.nextSequence + 1n,
            pending: state.value.pending.filter((item) => !done.has(item.id)) };
        }
        return outcome;
      },
    },
    checkpoint: {
      load: async () => saved,
      save: async (checkpoint) => { if (saveError) throw new Error("disk unavailable"); saved = checkpoint; },
    },
  };
  const create = () => new AdaptivePublisher(ports, { maxBatchSize, maxEntrySnapshotAgeMs: 2_000 });
  return {
    create, calls, plans, state, checkpoint: () => saved,
    advance: (ms: number) => { now += ms; },
    outcome: (value: typeof outcome) => { outcome = value; },
    submitError: (value: boolean) => { submitError = value; },
    saveError: (value: boolean) => { saveError = value; },
    blocked: (value: Promise<void> | null) => { blocked = value; },
    provideSnapshot: (value: boolean) => { provideSnapshot = value; },
    rewriteSnapshot: (rewrite: typeof rewriteSnapshot) => { rewriteSnapshot = rewrite; },
  };
}

test("adaptive publisher stays idle without work and a wake never trusts a notification as an order", async () => {
  const h = harness();
  const publisher = h.create();
  assert.deepEqual(await publisher.tick(), { status: "idle", nextWakeAtMs: null });
  assert.equal((await publisher.wake()).status, "idle");
  assert.equal(h.calls.submits, 0);
  assert.equal(h.calls.snapshots, 0);
});

test("first work submits immediately, mixed backlog drains once a second, then stops", async () => {
  const h = harness();
  h.state.value = { ...h.state.value, pending: [basic("b1"), basic("b2"), epoch("e1"), epoch("e2")] };
  const publisher = h.create();
  assert.equal((await publisher.wake()).status, "submitted");
  assert.deepEqual(h.plans[0].work.map((item) => item.id), ["b1", "e1"]);
  assert.deepEqual(h.plans[0].requiredAssetIds, ["BTC", "ETH", "SOL"]);
  h.advance(500);
  assert.equal((await publisher.wake()).status, "waiting");
  assert.equal(h.calls.submits, 1);
  h.advance(500);
  assert.equal((await publisher.tick()).status, "submitted");
  assert.deepEqual(h.plans[1].work.map((item) => item.id), ["b2", "e2"]);
  h.advance(1_000);
  assert.equal((await publisher.tick()).status, "idle");
  assert.equal(h.calls.submits, 2);
});

test("batch size one alternates pools instead of starving Epoch behind Basic", async () => {
  const h = harness(1);
  h.state.value = { ...h.state.value, pending: [basic("b1"), basic("b2"), epoch("e1")] };
  const publisher = h.create();
  await publisher.tick();
  h.advance(1_000);
  await publisher.tick();
  assert.deepEqual(h.plans.map((plan) => plan.work[0].id), ["b1", "e1"]);
});

test("closing deadline wakes an otherwise idle publisher and uses its original timestamp", async () => {
  const h = harness();
  h.state.value = { ...h.state.value, nextClosingDeadlineMs: 14_400_000,
    pending: [{ kind: "epoch-close", id: "close-0", closingTimestampMs: 14_400_000, assetIds: ["ETH"] }] };
  const publisher = h.create();
  assert.deepEqual(await publisher.tick(), { status: "idle", nextWakeAtMs: 14_400_000 });
  h.advance(14_390_000 + 60_000);
  assert.equal((await publisher.tick()).status, "submitted");
  assert.equal(h.plans[0].closingTimestampMs, 14_400_000);
});

test("duplicate concurrent wakes coalesce and never create concurrent transactions", async () => {
  const h = harness();
  h.state.value = { ...h.state.value, pending: [basic("b1")] };
  let release!: () => void;
  h.blocked(new Promise<void>((resolve) => { release = resolve; }));
  const publisher = h.create();
  const first = publisher.wake();
  const second = publisher.wake();
  const third = publisher.wake();
  assert.equal(first, second);
  assert.equal(second, third);
  release();
  assert.equal((await first).status, "submitted");
  assert.equal(h.calls.submits, 1);
  assert.equal((await first).nextWakeAtMs, 10_000);
});

test("an uncertain submission is persisted and reconciled after restart rather than resubmitted", async () => {
  const h = harness();
  h.state.value = { ...h.state.value, pending: [basic("b1")] };
  h.submitError(true);
  await assert.rejects(h.create().tick(), /submission timed out/);
  assert.equal(h.checkpoint()?.inFlight?.id, "tx-10000");
  h.outcome("pending");
  h.advance(1_000);
  assert.equal((await h.create().tick()).status, "in-flight");
  assert.equal(h.calls.submits, 1);
  h.outcome("accepted");
  assert.equal((await h.create().tick()).status, "idle");
  assert.equal(h.calls.submits, 1);
});

test("definitively expired transaction retries from authoritative state", async () => {
  const h = harness();
  h.state.value = { ...h.state.value, pending: [basic("b1")] };
  const publisher = h.create();
  await publisher.tick();
  h.outcome("expired");
  h.advance(1_000);
  assert.equal((await publisher.tick()).status, "submitted");
  assert.equal(h.calls.submits, 2);
});

test("missing eligible prices keep pending work on a one-second retry cadence", async () => {
  const h = harness();
  h.state.value = { ...h.state.value, pending: [epoch("e1")] };
  h.provideSnapshot(false);
  const publisher = h.create();
  assert.deepEqual(await publisher.tick(), { status: "waiting", nextWakeAtMs: 11_000 });
  h.advance(500);
  assert.equal((await publisher.tick()).status, "waiting");
  assert.equal(h.calls.snapshots, 1);
  h.advance(500);
  h.provideSnapshot(true);
  assert.equal((await publisher.tick()).status, "submitted");
});

test("orphaned processed notification disappears on authoritative reconciliation", async () => {
  const h = harness();
  const publisher = h.create();
  h.state.value = { ...h.state.value, pending: [basic("orphan", 20_000)] };
  assert.equal((await publisher.wake()).status, "idle");
  h.state.value = { ...h.state.value, pending: [] };
  h.advance(20_000);
  assert.equal((await publisher.tick()).status, "idle");
  assert.equal(h.calls.submits, 0);
});

test("snapshot completeness, predecessor, future time and entry eligibility are enforced before prepare", async () => {
  const changes = [
    (s: AdaptiveSnapshot) => ({ ...s, previousStateId: "other" }),
    (s: AdaptiveSnapshot) => ({ ...s, methodologyId: "other" }),
    (s: AdaptiveSnapshot) => ({ ...s, prices: [] }),
    (s: AdaptiveSnapshot) => ({ ...s, oracleTimestampMs: 10_001 }),
    (s: AdaptiveSnapshot) => ({ ...s, oracleTimestampMs: 9_000 }),
    (s: AdaptiveSnapshot) => ({ ...s, prices: [...s.prices, s.prices[0]] }),
  ];
  for (const change of changes) {
    const h = harness();
    h.state.value = { ...h.state.value, pending: [basic("b1", 9_000)] };
    h.rewriteSnapshot(change);
    await assert.rejects(h.create().tick());
    assert.equal(h.calls.prepares, 0);
    assert.equal(h.calls.submits, 0);
  }
});

test("closing data cannot be replaced with a later price", async () => {
  const h = harness();
  h.state.value = { ...h.state.value,
    pending: [{ kind: "epoch-close", id: "close", closingTimestampMs: 9_000, assetIds: ["BTC"] }] };
  h.rewriteSnapshot((s) => ({ ...s, oracleTimestampMs: 10_000 }));
  await assert.rejects(h.create().tick(), /closing timestamp mismatch/);
  assert.equal(h.calls.submits, 0);
});

test("checkpoint failure prevents any network submission", async () => {
  const h = harness();
  h.state.value = { ...h.state.value, pending: [basic("b1")] };
  h.saveError(true);
  await assert.rejects(h.create().tick(), /disk unavailable/);
  assert.equal(h.calls.submits, 0);
});

test("due closing backlog cannot starve Basic entries across restarts", async () => {
  const h = harness(1);
  h.state.value = { ...h.state.value, pending: [basic("b1"),
    ...["close1", "close2", "close3"].map((id) => ({
      kind: "epoch-close" as const, id, closingTimestampMs: 9_000, assetIds: ["ETH"],
    }))] };
  await h.create().tick();
  h.advance(1_000);
  await h.create().tick();
  assert.deepEqual(h.plans.map((plan) => plan.work[0].id), ["close1", "b1"]);
  h.advance(1_000);
  await h.create().tick();
  assert.equal(h.plans[2].work[0].kind, "epoch-close");
});
