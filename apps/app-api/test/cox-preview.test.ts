import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createCoxApiClient, type CoxStatus, type CoxStreamEvent, type Portfolio, type Preview } from "@eox/app-api";
import { afterEach, describe, expect, it } from "vitest";
import { gcsPreviewStore, parsePreview, PreviewFeed, previewPortfolio, PreviewInvalid, type PreviewIdentity, type PreviewStore } from "../src/cox/preview.js";
import { createCoxApiServer } from "../src/cox/server.js";
import type { CoxSource } from "../src/cox/source.js";

const T = 1_792_690_000;
const WALLET = "HgC4Jn7XMLzNsDjVdsr1x7BDuGBb2SBvx5TFLSUYaEyU";
const PROGRAM = "G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF";
const POOL = "HPnHZGLeQ8oisu3V8ZEBfPRT2Sai8XWnpfQmcZ8sTZE4";
const METHODOLOGY = "2b8360bed080095ebd1a0a8ca81479010580d24d771881b59b6b86557964bdba";
const IDENTITY: PreviewIdentity = { networks: ["solana-devnet"], program: PROGRAM, pools: [POOL, "2"], methodologyDigest: METHODOLOGY, assets: ["BTC", "ETH"] };
const CLASSES = ["BTC", "ETH", "CRYPTO"];

function record(timestamp = T, overrides: Record<string, unknown> = {}, sequence = 1): Record<string, unknown> {
  return {
    schema: "relative.preview/v1",
    status: "estimate",
    timestamp,
    network: "solana-devnet",
    program: PROGRAM,
    pool: POOL,
    methodologyDigest: METHODOLOGY,
    universeDigest: "e7".repeat(32),
    benchmark: "94115440032680",
    assets: [
      { classId: 0, assetId: "BTC", priceE8: "8117531545582", reference: "101000000000000" },
      { classId: 1, assetId: "ETH", priceE8: "237197465112", reference: "99000000000000" },
    ],
    cryptoClass: 2,
    cryptoReference: "100000000000000",
    scales: { price: 100000000, reference: 1000000000000, collateral: 1000000 },
    basicProjection: {
      sequence,
      stateDigest: "ab".repeat(32),
      publicationTimestamp: T - 30,
      classes: [
        { classId: 0, backing: "3000000", units: "2000000000000000000", addedResidual: "0" },
        { classId: 1, backing: "0", units: "0", addedResidual: "0" },
        { classId: 2, backing: "5000000", units: "5000000000000000000", addedResidual: "1" },
      ],
    },
    ...overrides,
  };
}

class MemoryStore implements PreviewStore {
  readonly files = new Map<number, string>();
  put(timestamp: number, value: unknown): void {
    this.files.set(timestamp, typeof value === "string" ? value : JSON.stringify(value));
  }
  async newest(after: number) {
    const keys = [...this.files.keys()].filter((key) => key > after);
    return keys.length === 0 ? null : Math.max(...keys);
  }
  async read(timestamp: number) {
    return this.files.get(timestamp) ?? null;
  }
}

describe("preview records", () => {
  it("accepts a record for this network, program, pool, methodology and roster", () => {
    expect(parsePreview(JSON.stringify(record()), T, IDENTITY).benchmark).toBe("94115440032680");
    expect(parsePreview(JSON.stringify(record(T, { pool: "2", timestamp: String(T) })), T, IDENTITY).pool).toBe("2");
    expect(parsePreview(JSON.stringify(record(T, { basicProjection: null })), T, IDENTITY).basicProjection).toBeNull();
  });

  it("refuses records that are not estimates for this pool and roster", () => {
    const bad = (overrides: Record<string, unknown>, timestamp = T) => () => parsePreview(JSON.stringify(record(T, overrides)), timestamp, IDENTITY);
    expect(bad({ status: "confirmed" })).toThrow(PreviewInvalid);
    expect(bad({}, T + 1)).toThrow("carries timestamp");
    expect(bad({ network: "solana-mainnet" })).toThrow("another network");
    expect(bad({ pool: "F44g6A58N3cu9TGaDE1LiDB3r1BCxCrfFkMQV1DcEv37" })).toThrow("another program or pool");
    expect(bad({ methodologyDigest: "00".repeat(32) })).toThrow("another methodology");
    expect(bad({ scales: { price: 1000000, reference: 1000000000000, collateral: 1000000 } })).toThrow("price scale");
    expect(bad({ assets: [record().assets as unknown[]].flat().reverse() })).toThrow("asset 0 is not BTC");
    expect(bad({ assets: [{ classId: 0, assetId: "BTC", priceE8: "0", reference: "1" }, { classId: 1, assetId: "ETH", priceE8: "1", reference: "1" }] })).toThrow("BTC priceE8");
    expect(bad({ cryptoClass: 0 })).toThrow("CRYPTO at class 0");
    expect(bad({ cryptoReference: "100" })).toThrow("CRYPTO reference");
    expect(bad({ basicProjection: { sequence: 1, stateDigest: "ab".repeat(32), publicationTimestamp: T, classes: [] } })).toThrow("must list 3 classes");
    expect(() => parsePreview("{", T, IDENTITY)).toThrow("not JSON");
  });
});

describe("preview feed", () => {
  it("follows the newest second, keeps gaps as gaps and reports staleness", async () => {
    let now = T + 1;
    const store = new MemoryStore();
    const seen: Preview[] = [];
    const errors: unknown[] = [];
    const feed = new PreviewFeed({ store, identity: IDENTITY, now: () => now, staleSeconds: 5, onError: (error) => errors.push(error) });
    feed.onPreview((preview) => seen.push(preview));
    await feed.tick();
    expect(feed.latest()).toBeNull();

    store.put(T, record(T));
    await feed.tick();
    expect(feed.latest()).toMatchObject({ ageSeconds: 1, stale: false, record: { timestamp: T } });

    store.put(T + 3, record(T + 3));
    now = T + 4;
    await feed.tick();
    expect(feed.latest()?.record.timestamp).toBe(T + 3);

    store.put(T + 4, record(T + 4, { pool: "F44g6A58N3cu9TGaDE1LiDB3r1BCxCrfFkMQV1DcEv37" }));
    await feed.tick();
    expect(errors).toHaveLength(1);
    expect(feed.latest()?.record.timestamp).toBe(T + 3);

    now = T + 20;
    await feed.tick();
    await feed.tick();
    expect(feed.latest()).toMatchObject({ ageSeconds: 17, stale: true });
    expect(seen.map((p) => [p.record.timestamp, p.stale])).toEqual([[T, false], [T + 3, false], [T + 3, true]]);
  });

  it("lists the bucket from the next second and reads one object per second", async () => {
    const calls: string[] = [];
    const fake = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("alt=media")) return url.includes(`${T + 2}.json`) ? new Response(JSON.stringify(record(T + 2))) : new Response("", { status: 404 });
      return new Response(JSON.stringify({ items: [{ name: `pool-2/preview/${T + 1}.json` }, { name: `pool-2/preview/${T + 2}.json` }, { name: "pool-2/preview/notes.txt" }] }));
    }) as typeof fetch;
    const store = gcsPreviewStore("gs://bucket-a/pool-2/preview/", async () => "token", fake);
    expect(await store.newest(T)).toBe(T + 2);
    expect(decodeURIComponent(calls[0]!)).toContain(`startOffset=pool-2/preview/${T + 1}.json`);
    expect(await store.read(T + 2)).toContain("relative.preview/v1");
    expect(await store.read(T + 9)).toBeNull();
    expect(() => gcsPreviewStore("gs://bucket-a/pool-2/preview", async () => "token")).toThrow("ending in a slash");
  });
});

describe("preview portfolio", () => {
  const preview = (sequence: number, projection = true): Preview => ({ record: parsePreview(JSON.stringify(record(T, projection ? {} : { basicProjection: null }, sequence)), T, IDENTITY), ageSeconds: 0, stale: false });
  const portfolio: Portfolio = {
    owner: WALLET, appliedSequence: 1, payable: "0", refundable: "0", pending: "0", requests: [],
    positions: [{ classId: "BTC", units: "1000000000000000000", locked: "1000000000000000000" }, { classId: "ETH", units: "0", locked: "0" }, { classId: "CRYPTO", units: "3", locked: "0" }],
  };

  it("values each position from the publisher's projected class state", () => {
    expect(previewPortfolio(preview(1), portfolio, 1, CLASSES)).toEqual({
      owner: WALLET, timestamp: T, stale: false, basisSequence: 1, unavailable: null, estimatedValue: "1500000",
      positions: [
        { classId: "BTC", units: "1000000000000000000", locked: "1000000000000000000", estimatedValue: "1500000" },
        { classId: "ETH", units: "0", locked: "0", estimatedValue: "0" },
        { classId: "CRYPTO", units: "3", locked: "0", estimatedValue: "0" },
      ],
    });
  });

  it("gives no estimate without a projection or when it starts from another publication", () => {
    expect(previewPortfolio(preview(1, false), portfolio, 1, CLASSES)).toMatchObject({ unavailable: "no-projection", estimatedValue: null, basisSequence: null });
    const behind = previewPortfolio(preview(1), portfolio, 2, CLASSES);
    expect(behind).toMatchObject({ unavailable: "basis-mismatch", estimatedValue: null, basisSequence: 1 });
    expect(behind.positions.every((p) => p.estimatedValue === null)).toBe(true);
  });
});

class PreviewSource implements CoxSource {
  async deployment() {
    return { origin: "live" as const, network: "solana-devnet", program: PROGRAM, poolId: "2", poolAddress: POOL, collateralMint: null, collateralDecimals: 6, secondaryCollateralMint: null, testCollateral: true as const, transferRule: "COX/TRANSFER/MVP-0" as const, methodology: { digest: METHODOLOGY, label: "x", status: "sealed" as const, assetCount: 2 }, mode: "adaptive" as const, publicationIntervalSeconds: 1, tradingOpensAt: null, fixtureSource: null };
  }
  async status(now: number): Promise<CoxStatus> {
    return {
      asOf: now, latestSequence: 1, latestBatch: 1, latestCutoff: T - 30, ageSeconds: 30, missedCutoffs: 0, state: "fresh", executing: false, monitor: null, reconciliation: null,
      fees: { policy: "COX/FEES/V1", migrated: true, active: { version: "1", bps: 2, cap: "200000" }, scheduled: null, committed: "0" }, currentBatch: null, trading: { open: true, gate: "open", opensAt: null },
    };
  }
  async assets() {
    return [];
  }
  async crypto() {
    return { label: "x", methodologyDigest: METHODOLOGY, members: [] };
  }
  async latest() {
    return null;
  }
  async publication() {
    return null;
  }
  async publications() {
    return [];
  }
  async portfolio(owner: string): Promise<Portfolio | null> {
    return owner === WALLET ? { owner, appliedSequence: 1, positions: [{ classId: "BTC", units: "2000000000000000000", locked: "0" }], payable: "0", refundable: "0", pending: "0", requests: [] } : null;
  }
  onPublication() {
    return () => undefined;
  }
}

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

async function serve(preview: PreviewFeed | null): Promise<string> {
  const server = createCoxApiServer({ source: new PreviewSource(), preview, classes: CLASSES, now: () => T + 1 });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("preview routes", () => {
  it("serves the latest preview, a wallet estimate and preview stream events", async () => {
    const store = new MemoryStore();
    const feed = new PreviewFeed({ store, identity: IDENTITY, now: () => T + 1 });
    const base = await serve(feed);
    const client = createCoxApiClient({ baseUrl: base });
    await expect(client.preview()).rejects.toMatchObject({ code: "NO_PREVIEW", httpStatus: 404 });

    store.put(T, record(T));
    await feed.tick();
    const preview = await client.preview();
    expect(preview.data).toMatchObject({ ageSeconds: 1, stale: false, record: { timestamp: T, status: "estimate" } });
    expect((await client.previewPortfolio(WALLET)).data).toMatchObject({ estimatedValue: "3000000", basisSequence: 1, unavailable: null });
    await expect(client.previewPortfolio("11111111111111111111111111111111")).rejects.toMatchObject({ code: "UNKNOWN_WALLET" });

    const events: CoxStreamEvent[] = [];
    const subscription = client.subscribe({}, (event) => events.push(event));
    await expect.poll(() => events.some((e) => e.type === "preview")).toBe(true);
    store.put(T + 1, record(T + 1));
    await feed.tick();
    await expect.poll(() => events.filter((e) => e.type === "preview").map((e) => (e.data as Preview).record.timestamp)).toEqual([T, T + 1]);
    subscription.close();
  });

  it("reports a deployment without previews as not configured", async () => {
    const client = createCoxApiClient({ baseUrl: await serve(null) });
    await expect(client.preview()).rejects.toMatchObject({ code: "NOT_CONFIGURED", httpStatus: 409 });
  });
});
