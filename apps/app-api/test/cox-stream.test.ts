import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createCoxApiClient, type CoxStatus, type CoxStreamEvent, type Portfolio, type Publication } from "@eox/app-api";
import { afterEach, describe, expect, it } from "vitest";
import { createCoxApiServer } from "../src/cox/server.js";
import type { CoxSource } from "../src/cox/source.js";

const WALLET = "HgC4Jn7XMLzNsDjVdsr1x7BDuGBb2SBvx5TFLSUYaEyU";

function publication(sequence: number): Publication {
  return {
    identity: {
      program: null, poolId: "1", sequence, batch: sequence, predecessorSequence: sequence === 0 ? null : sequence - 1, predecessorBatch: sequence === 0 ? null : sequence - 1,
      missedBatches: [], cutoff: 1000 + sequence * 60, manifestDigest: null, snapshotDigest: null, stateDigest: null, committedAt: null, finalization: { transaction: null, slot: null, finalized: true },
    },
    prices: [], benchmarkGross: null, benchmark: "100000000000000", references: [], classes: [],
    flows: { acceptedDeposits: null, newPayable: null, transferResidual: null, flowResidual: null, fees: "0", executed: 0, rejected: 0 },
    ledger: { active: "0", pending: "0", refundable: null, payable: "0", residual: "0", fees: "0", vault: "0" }, fees: null, receiptRoot: null,
  };
}

class MemorySource implements CoxSource {
  readonly published: Publication[] = [0, 1, 2].map(publication);
  readonly listeners = new Set<(p: Publication) => void>();
  units = "1";
  portfolioReads = 0;
  feeVersion = "0";

  async deployment() {
    return { origin: "live" as const, network: "test", program: null, poolId: "1", poolAddress: null, collateralMint: null, collateralDecimals: 6, secondaryCollateralMint: null, testCollateral: true as const, transferRule: "COX/TRANSFER/MVP-0" as const, methodology: { digest: null, label: "x", status: "sealed" as const, assetCount: 0 }, mode: "minute" as const, publicationIntervalSeconds: 60, tradingOpensAt: null, fixtureSource: null };
  }

  async status(now: number): Promise<CoxStatus> {
    const latest = this.published.at(-1)!;
    return {
      asOf: now, latestSequence: latest.identity.sequence, latestBatch: latest.identity.batch, latestCutoff: latest.identity.cutoff, ageSeconds: now - latest.identity.cutoff,
      missedCutoffs: 0, state: "fresh", executing: false, monitor: null, reconciliation: null,
      fees: { policy: "COX/FEES/V1", migrated: true, active: { version: this.feeVersion, bps: 0, cap: "0" }, scheduled: null, committed: "0" }, currentBatch: null, trading: { open: true, gate: "open", opensAt: null },
    };
  }

  async assets() {
    return [];
  }

  async crypto() {
    return { label: "x", methodologyDigest: null, members: [] };
  }

  async latest() {
    return this.published.at(-1) ?? null;
  }

  async publication(sequence: number) {
    return this.published[sequence] ?? null;
  }

  async publications(_now: number, after: number | null, limit: number) {
    return this.published.slice(after === null ? 0 : after + 1).slice(0, limit);
  }

  async portfolio(owner: string): Promise<Portfolio | null> {
    this.portfolioReads += 1;
    if (owner !== WALLET) return null;
    return { owner, appliedSequence: this.published.at(-1)!.identity.sequence, positions: [{ classId: "CRYPTO", units: this.units, locked: "0" }], payable: "0", refundable: "0", pending: "0", requests: [] };
  }

  onPublication(listener: (p: Publication) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(): void {
    const next = publication(this.published.length);
    this.published.push(next);
    for (const listener of this.listeners) listener(next);
  }
}

const servers: Server[] = [];
let clock = 5000;

async function serve(source: MemorySource, stream: { maxPerClient?: number; maxWallets?: number } = {}) {
  const server = createCoxApiServer({ source, now: () => clock, stream: { statusMs: 20, portfolioMs: 20, ...stream } });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for stream events");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe("live stream", () => {
  it("sends status, publications after the cursor and the wallet's portfolio, then live changes only", async () => {
    const source = new MemorySource();
    const client = createCoxApiClient({ baseUrl: await serve(source) });
    const events: CoxStreamEvent[] = [];
    const subscription = client.subscribe({ after: 0, wallet: WALLET }, (event) => events.push(event));
    await until(() => events.some((e) => e.type === "portfolio"));
    expect(events.filter((e) => e.type === "publication").map((e) => (e.type === "publication" ? e.data.sequence : -1))).toEqual([1, 2]);
    expect(events[0]).toMatchObject({ type: "status", data: { latestSequence: 2 } });
    expect(events.find((e) => e.type === "portfolio")).toMatchObject({ data: { owner: WALLET, portfolio: { positions: [{ units: "1" }] } } });

    clock += 7;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events.filter((e) => e.type === "status")).toHaveLength(1);
    expect(events.filter((e) => e.type === "portfolio")).toHaveLength(1);

    source.units = "5";
    source.publish();
    await until(() => events.filter((e) => e.type === "portfolio").length === 2 && events.filter((e) => e.type === "status").length === 2);
    expect(events.filter((e) => e.type === "publication").at(-1)).toMatchObject({ data: { sequence: 3 } });
    expect(events.filter((e) => e.type === "status").at(-1)).toMatchObject({ data: { latestSequence: 3 } });
    expect(events.filter((e) => e.type === "portfolio").at(-1)).toMatchObject({ data: { portfolio: { positions: [{ units: "5" }] } } });

    source.feeVersion = "1";
    await until(() => events.filter((e) => e.type === "status").length === 3);
    expect(events.at(-1)).toMatchObject({ type: "status", data: { fees: { active: { version: "1" } } } });
    subscription.close();
  });

  it("starts a stream without a cursor at the latest publication instead of replaying history", async () => {
    const source = new MemorySource();
    const client = createCoxApiClient({ baseUrl: await serve(source) });
    const events: CoxStreamEvent[] = [];
    const subscription = client.subscribe({}, (event) => events.push(event));
    await until(() => events.some((e) => e.type === "publication"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.filter((e) => e.type === "publication").map((e) => (e.type === "publication" ? e.data.sequence : -1))).toEqual([2]);
    subscription.close();
  });

  it("resumes publications from Last-Event-ID and labels publication events with their sequence", async () => {
    const source = new MemorySource();
    const baseUrl = await serve(source);
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/v1/stream`, { headers: { "last-event-id": "1" }, signal: controller.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("event: publication")) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    expect(text).toContain("retry: 3000");
    expect(text).toContain("id: 2\nevent: publication");
    expect(text).not.toContain("id: 1\n");
    expect(text).not.toContain("event: portfolio");
  });

  it("shares one portfolio poll per wallet and refuses bad wallets and excess streams", async () => {
    const source = new MemorySource();
    const baseUrl = await serve(source, { maxPerClient: 2, maxWallets: 1 });
    const client = createCoxApiClient({ baseUrl });
    const first: CoxStreamEvent[] = [];
    const second: CoxStreamEvent[] = [];
    const a = client.subscribe({ wallet: WALLET }, (event) => first.push(event));
    const b = client.subscribe({ wallet: WALLET }, (event) => second.push(event));
    await until(() => first.some((e) => e.type === "portfolio") && second.some((e) => e.type === "portfolio"));
    const reads = source.portfolioReads;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(source.portfolioReads - reads).toBeLessThanOrEqual(13);
    const third = await fetch(`${baseUrl}/v1/stream`);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("10");
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    expect((await fetch(`${baseUrl}/v1/stream?wallet=not-a-wallet`)).status).toBe(400);
    expect(() => client.subscribe({ wallet: "bad" }, () => {})).toThrow("invalid owner");
    a.close();
    b.close();
  });
});
