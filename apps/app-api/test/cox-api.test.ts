import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCoxApiClient, type CoxApiClient, type CoxPublicationEvent } from "@eox/app-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCoxFixture } from "../scripts/cox-fixture-build.ts";
import { CoxFixtureSource } from "../src/cox/fixture-source.js";
import { createCoxApiServer } from "../src/cox/server.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cox-fixture.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ReturnType<typeof buildCoxFixture>;
const NOW = 1_900_000_000 - (1_900_000_000 % 60) + 25;
const ALICE = fixture.wallets.find((w) => w.requests.some((r) => r.requestId === "alice-1"))!.owner;
const DAVE = fixture.wallets.find((w) => w.requests.some((r) => r.requestId === "dave-1"))!.owner;

let client: CoxApiClient;
let baseUrl = "";
const server = createCoxApiServer({ source: new CoxFixtureSource(fixturePath), now: () => NOW, onError: (e) => { throw e; } });

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = createCoxApiClient({ baseUrl });
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("COX fixture provenance", () => {
  it("is exactly what the Rust cox-cli produces for the fixture timeline", () => {
    expect(buildCoxFixture()).toEqual(fixture);
  });

  it("reconciles the vault with every custody category at every publication", () => {
    for (const p of fixture.publications as { ledger: Record<string, string> }[]) {
      const { active, pending, payable, residual, vault } = p.ledger;
      expect(BigInt(active!) + BigInt(pending!) + BigInt(payable!) + BigInt(residual!)).toBe(BigInt(vault!));
    }
  });
});

describe("cox.app-api/v1 on the fixture", () => {
  it("labels the deployment as a fixture on test collateral under MVP-0", async () => {
    const { deployment, data } = await client.deployment();
    expect(data).toEqual(deployment);
    expect(deployment).toMatchObject({ origin: "fixture", testCollateral: true, transferRule: "COX/TRANSFER/MVP-0", program: null, methodology: { status: "draft", label: "CRYPTO (fixture, 2 synthetic assets)" } });
    expect(deployment.fixtureSource).toContain("packages/cox/crates/cli");
  });

  it("keeps the latest publication on the latest minute and reports fresh status", async () => {
    const { status } = await client.status();
    expect(status).toMatchObject({ state: "fresh", latestSequence: 3, latestBatch: 4, latestCutoff: NOW - 25, ageSeconds: 25, missedCutoffs: 0, executing: false });
    expect(status.currentBatch).toEqual({ batch: 5, cutoff: NOW - 25 + 60, acceptanceDeadline: NOW - 25 + 115 });
  });

  it("separates the publication sequence from the scheduled batch and lists the missed batch", async () => {
    const { data } = await client.latestPublication();
    expect(data.identity).toMatchObject({ sequence: 3, batch: 4, predecessorSequence: 2, predecessorBatch: 2, missedBatches: [3], cutoff: NOW - 25 });
    expect(data.references.map((r) => r.reference)).toEqual(["132765957446763", "71489361702103"]);
    expect(data.classes.map((c) => [c.classId, c.fixed?.backing, c.final.backing])).toEqual([["SYNA", "113", "113"], ["SYNB", "24", "24"], ["CRYPTO", "17", "17"]]);
    expect(data.ledger).toEqual({ active: "154", pending: "70", refundable: "70", payable: "11", residual: "5", fees: "0", vault: "240" });
    expect(data.fees).toBeNull();
    const origin = await client.publication(0);
    expect(origin.data.identity).toMatchObject({ sequence: 0, batch: 0, predecessorSequence: null });
    expect(origin.data.benchmark).toBe("100000000000000");
  });

  it("pages publications from sequence 0 and streams them resumably", async () => {
    expect((await client.publications()).data.events.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    expect((await client.publications(1, 1)).data).toMatchObject({ nextAfter: 2, events: [{ sequence: 2 }] });
    const seen: CoxPublicationEvent[] = [];
    const subscription = client.subscribePublications(1, (e) => seen.push(e));
    for (let i = 0; i < 50 && seen.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
    subscription.close();
    await subscription.closed;
    expect(seen.map((e) => e.sequence)).toEqual([2, 3]);
  });

  it("serves assets, CRYPTO weights and explicit errors", async () => {
    const assets = (await client.assets()).data;
    expect(assets.map((a) => [a.assetId, a.latest?.priceE8])).toEqual([["SYNA", "13000000000"], ["SYNB", "7000000000"]]);
    expect((await client.crypto()).data.members).toEqual([
      { assetId: "SYNA", weightNumerator: "1", weightDenominator: "2" },
      { assetId: "SYNB", weightNumerator: "1", weightDenominator: "2" },
    ]);
    await expect(client.asset("BTC")).rejects.toMatchObject({ code: "UNKNOWN_ASSET", httpStatus: 404 });
    await expect(client.publication(99)).rejects.toMatchObject({ code: "PUBLICATION_NOT_FOUND" });
    for (const path of ["/v1/publications?after=-1", "/v1/publications?limit=0", "/v1/assets/btc", "/v1/wallets/0OIl/portfolio", "/v1/nope"]) {
      expect((await fetch(`${baseUrl}${path}`)).status, path).toBeGreaterThanOrEqual(400);
    }
    expect((await fetch(`${baseUrl}/v1/status`, { method: "POST" })).status).toBe(405);
  });

  it("does not build or track transactions on the fixture", async () => {
    await expect(client.buildDeposit({ owner: ALICE, toClass: "SYNA", amount: "1", minimumUnits: "0", expiryBatch: 9 })).rejects.toMatchObject({ code: "NOT_LIVE", httpStatus: 409 });
    await expect(client.submission("1".repeat(64))).rejects.toMatchObject({ code: "NOT_LIVE" });
    expect((await fetch(`${baseUrl}/v1/transactions/deposit`)).status).toBe(405);
  });

  it("serves a wallet's positions, payable, refundable deposits and receipts", async () => {
    const alice = (await client.portfolio(ALICE)).data;
    expect(alice).toMatchObject({ appliedSequence: 3, payable: "11", refundable: "0", pending: "25", positions: [{ classId: "SYNA", units: "90000000000000", locked: "0" }] });
    expect(alice.requests.map((r) => [r.requestId, r.state, r.receipt?.batch ?? null])).toEqual([["alice-1", "filled", 1], ["alice-2", "filled", 2], ["alice-3", "queued", null]]);
    const dave = (await client.portfolio(DAVE)).data;
    expect(dave).toMatchObject({ refundable: "30", positions: [] });
    expect(dave.requests[0]).toMatchObject({ state: "condition-failed", receipt: { status: "condition-failed", minted: "0" } });
    await expect(client.portfolio("11111111111111111111111111111111")).rejects.toMatchObject({ code: "UNKNOWN_WALLET" });
  });
});

describe("CORS for the public deployment", () => {
  it("allows browser reads from the configured origin and answers preflight, and sends nothing when unset", async () => {
    const open = createCoxApiServer({ source: new CoxFixtureSource(fixturePath), now: () => NOW, corsOrigin: "*" });
    await new Promise<void>((resolve) => open.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(open.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${url}/v1/status`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const preflight = await fetch(`${url}/v1/publications/stream`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-headers": "last-event-id" } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")).toContain("last-event-id");
      expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST");
      expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");
      expect((await fetch(`${url}/v1/status`, { method: "POST" })).status).toBe(405);
    } finally {
      open.closeAllConnections();
      open.close();
    }
    expect((await fetch(`${baseUrl}/v1/status`)).headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${baseUrl}/v1/status`, { method: "OPTIONS" })).status).toBe(405);
  });
});
