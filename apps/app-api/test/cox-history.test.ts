import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Publication } from "@eox/app-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directorySegments, gcsSegments, PublicationHistory, type SegmentStore } from "../src/cox/publication-history.js";
import { replay, STREAM_REPLAY_LIMIT } from "../src/cox/replay.js";
import type { CoxSource } from "../src/cox/source.js";
import { FileSubmissionStore, FirestoreSubmissionStore, type StoredSubmission } from "../src/cox/submission-store.js";

const identity = { program: "G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF", pool: "F44g6A58N3cu9TGaDE1LiDB3r1BCxCrfFkMQV1DcEv37" };
const SIGNATURE = "5".repeat(87);

function publication(sequence: number, batch = sequence + 1, predecessorBatch: number | null = sequence === 0 ? null : sequence): Publication {
  return {
    identity: {
      program: identity.program, poolId: "1", sequence, batch, predecessorSequence: sequence === 0 ? null : sequence - 1, predecessorBatch, missedBatches: [],
      cutoff: 1000 + batch * 60, manifestDigest: null, snapshotDigest: null, stateDigest: sequence.toString(16).padStart(64, "0"), committedAt: null,
      finalization: { transaction: null, slot: sequence, finalized: true },
    },
    prices: [], benchmarkGross: null, benchmark: "100000000000000", references: [], classes: [],
    flows: { acceptedDeposits: null, newPayable: null, transferResidual: null, flowResidual: null, fees: "0", executed: 0, rejected: 0 },
    ledger: { active: "0", pending: "0", refundable: null, payable: "0", residual: "0", fees: "0", vault: "0" }, fees: null, receiptRoot: null,
  };
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cox-history-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function open(store: SegmentStore = directorySegments(join(dir, "segments")), path = join(dir, "tail.jsonl"), segmentSize = 3, cacheSegments = 2) {
  return PublicationHistory.open({ path, store, identity, segmentSize, cacheSegments });
}

async function fill(history: PublicationHistory, count: number): Promise<void> {
  for (let i = history.nextSequence; i < count; i += 1) await history.append(publication(i));
}

describe("publication history in immutable segments", () => {
  it("seals full segments, keeps only the tail locally and serves any sequence or page", async () => {
    const history = await open();
    await fill(history, 8);
    expect(readdirSync(join(dir, "segments")).sort()).toEqual([
      "seg-000000000000-000000000002-x-3.json",
      "seg-000000000003-000000000005-3-6.json",
    ]);
    const tail = readFileSync(join(dir, "tail.jsonl"), "utf8").trim().split("\n");
    expect(tail.slice(1).map((line) => (JSON.parse(line) as Publication).identity.sequence)).toEqual([6, 7]);
    expect(history.latest()!.identity.sequence).toBe(7);
    expect((await history.get(1))!.identity.batch).toBe(2);
    expect(await history.get(8)).toBeNull();
    expect((await history.page(null, 100)).map((p) => p.identity.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect((await history.page(1, 4)).map((p) => p.identity.sequence)).toEqual([2, 3, 4, 5]);
    expect(await history.page(7, 10)).toEqual([]);
  });

  it("starts from the segments alone, as a fresh instance does, and continues the chain", async () => {
    await fill(await open(), 7);
    const fresh = await open(directorySegments(join(dir, "segments")), join(dir, "elsewhere.jsonl"));
    expect(fresh.nextSequence).toBe(6);
    expect(fresh.latest()!.identity.sequence).toBe(5);
    await expect(fresh.append(publication(7))).rejects.toThrow("out of order");
    await expect(fresh.append({ ...publication(6), identity: { ...publication(6).identity, predecessorBatch: 2 } })).rejects.toThrow("does not follow batch 6");
    await fresh.append(publication(6));
    expect((await fresh.page(4, 10)).map((p) => p.identity.sequence)).toEqual([5, 6]);
  });

  it("moves an existing full log into segments on first start and drops a partly written last line", async () => {
    const path = join(dir, "tail.jsonl");
    writeFileSync(path, `${JSON.stringify({ schema: "cox.app-api.publications/v1", ...identity })}\n${[0, 1, 2, 3, 4].map((i) => JSON.stringify(publication(i))).join("\n")}\n`);
    appendFileSync(path, '{"identity":{"seq');
    const history = await open();
    expect(history.nextSequence).toBe(5);
    expect(readdirSync(join(dir, "segments"))).toEqual(["seg-000000000000-000000000002-x-3.json"]);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(3);
    await expect(open(directorySegments(join(dir, "segments")), path, 3).then(() => PublicationHistory.open({ path, store: directorySegments(join(dir, "segments")), identity: { ...identity, pool: identity.program }, segmentSize: 3 }))).rejects.toThrow("another program or pool");
  });

  it("adopts a segment another instance sealed first and reads the stored copy", async () => {
    const store = directorySegments(join(dir, "segments"));
    const first = await open(store, join(dir, "a.jsonl"));
    const second = await open(store, join(dir, "b.jsonl"));
    await fill(first, 4);
    for (let i = 0; i < 4; i += 1) await second.append({ ...publication(i), identity: { ...publication(i).identity, finalization: { transaction: null, slot: 900 + i, finalized: true } } });
    expect(readdirSync(join(dir, "segments"))).toHaveLength(1);
    expect((await second.get(0))!.identity.finalization.slot).toBe(0);
    expect((await second.get(3))!.identity.finalization.slot).toBe(903);
  });

  it("refuses segments that do not match their name or break the chain", async () => {
    await fill(await open(), 10);
    const name = "seg-000000000003-000000000005-3-6.json";
    const file = join(dir, "segments", name);
    const original = JSON.parse(readFileSync(file, "utf8")) as { publications: Publication[] };
    original.publications[1]!.identity.predecessorBatch = 9;
    writeFileSync(file, JSON.stringify(original));
    const reopened = await open(directorySegments(join(dir, "segments")), join(dir, "other.jsonl"), 3, 1);
    await expect(reopened.get(0)).resolves.toMatchObject({ identity: { sequence: 0 } });
    await expect(reopened.get(4)).rejects.toThrow("breaks the batch chain");
    await expect(open(directorySegments(join(dir, "segments")), join(dir, "late.jsonl"), 3, 1).then(async () => {
      writeFileSync(join(dir, "segments", "seg-000000000006-000000000008-6-9.json"), JSON.stringify({ ...original, start: 9 }));
      return open(directorySegments(join(dir, "segments")), join(dir, "late2.jsonl"), 3, 1);
    })).rejects.toThrow("does not match its name");
    rmSync(file);
    writeFileSync(join(dir, "segments", "seg-000000000003-000000000005-7-6.json"), "{}");
    await expect(open(directorySegments(join(dir, "segments")), join(dir, "third.jsonl"))).rejects.toThrow("does not follow");
  });

  it("starts a fresh generation at its genesis publication 1 and never asks for publication 0", async () => {
    const fresh = (sequence: number) => {
      const value = publication(sequence, sequence - 1, sequence === 1 ? null : sequence - 2);
      return { ...value, identity: { ...value.identity, predecessorSequence: sequence === 1 ? null : sequence - 1 } };
    };
    const at = (path: string) => PublicationHistory.open({ path: join(dir, path), store: directorySegments(join(dir, "segments")), identity, firstSequence: 1, segmentSize: 3, cacheSegments: 2 });
    const history = await at("tail.jsonl");
    expect(history.nextSequence).toBe(1);
    await expect(history.append(publication(0))).rejects.toThrow("expected 1");
    await expect(history.append(fresh(2))).rejects.toThrow("expected 1");
    for (let i = 1; i <= 8; i += 1) await history.append(fresh(i));
    expect(readdirSync(join(dir, "segments")).sort()).toEqual(["seg-000000000001-000000000003-x-2.json", "seg-000000000004-000000000006-2-5.json"]);
    expect(await history.get(0)).toBeNull();
    expect((await history.get(1))!.identity).toMatchObject({ sequence: 1, batch: 0, predecessorBatch: null });
    expect((await history.get(5))!.identity.batch).toBe(4);
    expect((await history.page(null, 100)).map((p) => p.identity.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await history.page(0, 2)).map((p) => p.identity.sequence)).toEqual([1, 2]);
    expect((await history.page(3, 4)).map((p) => p.identity.sequence)).toEqual([4, 5, 6, 7]);
    const reopened = await at("other.jsonl");
    expect(reopened.nextSequence).toBe(7);
    expect((await reopened.get(2))!.identity.sequence).toBe(2);
    rmSync(join(dir, "segments", "seg-000000000001-000000000003-x-2.json"));
    const gap = await at("gap.jsonl");
    expect(gap.nextSequence).toBe(1);
    expect(gap.latest()).toBeNull();
  });

  it("keeps at most the configured number of segments in memory", async () => {
    const reads: string[] = [];
    const inner = directorySegments(join(dir, "segments"));
    await fill(await open(inner), 13);
    const counting: SegmentStore = { list: () => inner.list(), create: (n, t) => inner.create(n, t), read: async (n) => (reads.push(n), inner.read(n)) };
    const history = await open(counting, join(dir, "x.jsonl"), 3, 2);
    reads.length = 0;
    await history.get(0);
    await history.get(4);
    await history.get(1);
    await history.get(7);
    await history.get(0);
    await history.get(4);
    expect(reads.map((n) => n.slice(4, 16))).toEqual(["000000000000", "000000000003", "000000000006", "000000000003"]);
  });
});

describe("Cloud Storage segment store", () => {
  it("lists every page under the prefix, reads objects and creates only when absent", async () => {
    const objects = new Map<string, string>([["h/seg-000000000000-000000000002-x-3.json", "A"], ["h/seg-000000000003-000000000005-3-6.json", "B"], ["h/notes.txt", "x"]]);
    const calls: string[] = [];
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${(init?.headers as Record<string, string>).authorization}`);
      if (url.pathname.startsWith("/upload/")) {
        const name = url.searchParams.get("name")!;
        expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
        if (objects.has(name)) return new Response("", { status: 412 });
        objects.set(name, String(init!.body));
        return new Response("{}");
      }
      if (url.searchParams.has("prefix")) {
        const names = [...objects.keys()].filter((n) => n.startsWith(url.searchParams.get("prefix")!)).sort();
        const page = url.searchParams.get("pageToken") === "2" ? names.slice(2) : names.slice(0, 2);
        return Response.json({ items: page.map((name) => ({ name })), nextPageToken: url.searchParams.get("pageToken") ? undefined : "2" });
      }
      const name = decodeURIComponent(url.pathname.split("/o/")[1]!);
      return objects.has(name) ? new Response(objects.get(name)) : new Response("", { status: 404 });
    }) as typeof fetch;
    const store = gcsSegments("gs://cox-history/h/", async () => "token", request);
    expect((await store.list()).sort()).toEqual(["seg-000000000000-000000000002-x-3.json", "seg-000000000003-000000000005-3-6.json"]);
    expect(await store.read("seg-000000000003-000000000005-3-6.json")).toBe("B");
    expect(await store.read("seg-000000000006-000000000008-6-9.json")).toBeNull();
    expect(await store.create("seg-000000000006-000000000008-6-9.json", "C")).toBe("created");
    expect(await store.create("seg-000000000006-000000000008-6-9.json", "D")).toBe("exists");
    expect(objects.get("h/seg-000000000006-000000000008-6-9.json")).toBe("C");
    expect(calls.every((c) => c.endsWith("Bearer token"))).toBe(true);
    expect(() => gcsSegments("gs://cox-history/h", async () => "t")).toThrow("ending in a slash");
  });
});

describe("submission stores", () => {
  const entry: StoredSubmission = { signature: SIGNATURE, owner: identity.pool, operation: "deposit", transaction: "AQ==", submittedAt: 1791700000, state: "submitted", slot: null, error: null, recentBlockhash: "11111111111111111111111111111111" };

  it("keeps submissions in a file that survives a restart", async () => {
    const path = join(dir, "submissions.json");
    const store = new FileSubmissionStore(path);
    expect(await store.create(entry)).toBe("created");
    expect(await store.create(entry)).toBe("exists");
    await store.update({ ...entry, state: "finalized", slot: 9 });
    expect(await new FileSubmissionStore(path).get(SIGNATURE)).toMatchObject({ state: "finalized", slot: 9 });
    expect(await store.get("6".repeat(87))).toBeNull();
  });

  it("shares submissions between instances through Firestore with an expiry for the TTL policy", async () => {
    const documents = new Map<string, Record<string, { stringValue?: string; timestampValue?: string }>>();
    const calls: string[] = [];
    const request = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toContain("/databases/cox-app-api/documents/");
      calls.push(`${init?.method} ${url.pathname.split("/documents/")[1]}${url.search}`);
      const path = decodeURIComponent(url.pathname.split("/documents/")[1]!);
      if (init?.method === "POST") {
        const id = `${path}/${url.searchParams.get("documentId")}`;
        if (documents.has(id)) return new Response("{}", { status: 409 });
        documents.set(id, (JSON.parse(String(init.body)) as { fields: Record<string, { stringValue?: string }> }).fields);
        return Response.json({});
      }
      if (init?.method === "PATCH") {
        if (!documents.has(path)) return new Response("{}", { status: 404 });
        documents.set(path, (JSON.parse(String(init.body)) as { fields: Record<string, { stringValue?: string }> }).fields);
        return Response.json({});
      }
      return documents.has(path) ? Response.json({ fields: documents.get(path) }) : new Response("{}", { status: 404 });
    }) as typeof fetch;
    const store = new FirestoreSubmissionStore("colosseum-eox", "coxSubmissionsPool1", async () => "token", request, "cox-app-api");
    const other = new FirestoreSubmissionStore("colosseum-eox", "coxSubmissionsPool1", async () => "token", request, "cox-app-api");
    expect(await store.create(entry)).toBe("created");
    expect(await other.create(entry)).toBe("exists");
    await other.update({ ...entry, state: "confirmed", slot: 4 });
    expect(await store.get(SIGNATURE)).toMatchObject({ state: "confirmed", slot: 4, recentBlockhash: entry.recentBlockhash });
    expect(documents.get(`coxSubmissionsPool1/${SIGNATURE}`)!.expireAt!.timestampValue).toBe(new Date((1791700000 + 30 * 86400) * 1000).toISOString());
    expect(await store.get("not-a-signature")).toBeNull();
    expect(calls.find((c) => c.startsWith("PATCH"))).toContain("currentDocument.exists=true");
    expect(() => new FirestoreSubmissionStore("Bad Project", "c", async () => "t")).toThrow("invalid Firestore project");
    expect(() => new FirestoreSubmissionStore("colosseum-eox", "c", async () => "t", fetch, "../other")).toThrow("invalid Firestore database");
  });
});

describe("stream replay", () => {
  it("replays at most the replay limit and nothing when the client is current", async () => {
    const history = await open(directorySegments(join(dir, "segments")), join(dir, "tail.jsonl"), 500, 8);
    await fill(history, STREAM_REPLAY_LIMIT + 20);
    const source = { latest: async () => history.latest(), publications: (_: number, after: number | null, limit: number) => history.page(after, limit) } as unknown as CoxSource;
    const all = await replay(source, 0, null);
    expect(all).toHaveLength(STREAM_REPLAY_LIMIT);
    expect(all[0]!.identity.sequence).toBe(20 + 0);
    expect(all.at(-1)!.identity.sequence).toBe(STREAM_REPLAY_LIMIT + 19);
    expect((await replay(source, 0, STREAM_REPLAY_LIMIT + 10)).map((p) => p.identity.sequence)).toEqual(Array.from({ length: 9 }, (_, i) => STREAM_REPLAY_LIMIT + 11 + i));
    expect(await replay(source, 0, STREAM_REPLAY_LIMIT + 19)).toEqual([]);
  });
});
