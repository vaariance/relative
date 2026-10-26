import { describe, expect, it } from "vitest";
import { ChainChangeFeed, ChainChangeInvalid, gcsChainChangeStore, notificationName, parseChainChange, parseNotification, type ChainChangeIdentity, type ChainChangeStore } from "../src/cox/chain-changes.js";

const T = 1_792_700_000_000;
const PROGRAM = "G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF";
const POOL = "HPnHZGLeQ8oisu3V8ZEBfPRT2Sai8XWnpfQmcZ8sTZE4";
const IDENTITY: ChainChangeIdentity = { networks: ["solana-devnet"], program: PROGRAM, pools: [POOL] };
const GEN_A = "a1".repeat(32);
const GEN_B = "b2".repeat(32);

function change(revision: string, overrides: Record<string, unknown> = {}) {
  return { schema: "relative.chain-change/v1", generation: GEN_A, revision, observedSlot: 100 + Number(revision), commitment: "confirmed", streamHealthy: true, ...overrides };
}

function notification(ms: number, chainChange: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { schema: "relative.chain-notification/v1", timestampMs: ms, network: "solana-devnet", program: PROGRAM, pool: POOL, chainChange, ...overrides };
}

const nameOf = (ms: number, salt = "c3") => `${notificationName(ms)}-${salt.repeat(32)}.json`;

class MemoryStore implements ChainChangeStore {
  readonly files = new Map<string, string>();
  failList = false;
  failRead = new Set<string>();
  put(ms: number, value: unknown, salt?: string): string {
    const name = nameOf(ms, salt);
    this.files.set(name, typeof value === "string" ? value : JSON.stringify(value));
    return name;
  }
  async list(startOffset: string) {
    if (this.failList) throw new Error("chain change storage returned HTTP 503");
    return [...this.files.keys()].filter((name) => name >= startOffset).sort();
  }
  async read(name: string) {
    if (this.failRead.has(name)) throw new Error("chain change storage returned HTTP 503");
    return this.files.get(name)!;
  }
}

function harness(start = T) {
  let nowMs = start;
  const store = new MemoryStore();
  const errors: unknown[] = [];
  const signals: (number | null)[] = [];
  const feed = new ChainChangeFeed({ store, identity: IDENTITY, nowMs: () => nowMs, onError: (error) => errors.push(error) });
  feed.onChange((slot) => signals.push(slot));
  return { store, feed, errors, signals, at: (ms: number) => (nowMs = ms) };
}

describe("chain change records", () => {
  it("reads a notification whose name, time, network, program and pool match", () => {
    const parsed = parseNotification(nameOf(T), JSON.stringify(notification(T, change("7"))), IDENTITY);
    expect(parsed).toEqual({ name: nameOf(T), timestampMs: T, change: { generation: GEN_A, revision: 7n, observedSlot: 107, streamHealthy: true } });
  });

  it("refuses notifications that do not belong to this pool or are malformed", () => {
    const bad = (value: unknown, name = nameOf(T)) => () => parseNotification(name, JSON.stringify(value), IDENTITY);
    expect(bad(notification(T + 1, change("1")))).toThrow("another time");
    expect(bad(notification(T, change("1")), `${notificationName(T)}.json`)).toThrow("unexpected name");
    expect(bad(notification(T, change("1"), { pool: "F44g6A58N3cu9TGaDE1LiDB3r1BCxCrfFkMQV1DcEv37" }))).toThrow("another network, program or pool");
    expect(bad(notification(T, change("1"), { schema: "relative.preview/v1" }))).toThrow(ChainChangeInvalid);
    expect(() => parseChainChange(change("01"))).toThrow("unsigned decimal");
    expect(() => parseChainChange(change("1", { generation: "AB".repeat(32) }))).toThrow("64 lowercase hex");
    expect(() => parseChainChange(change("1", { commitment: "finalized" }))).toThrow("not confirmed");
    expect(() => parseChainChange(change("1", { streamHealthy: "yes" }))).toThrow("not a boolean");
    expect(() => parseNotification(nameOf(T), "{", IDENTITY)).toThrow("not JSON");
  });

  it("lists every page from the cursor and keeps only notification names, in order", async () => {
    const calls: URL[] = [];
    const later = nameOf(T + 1000);
    const fake = (async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.searchParams.get("alt") === "media") return new Response("body");
      const page = url.searchParams.get("pageToken");
      return new Response(JSON.stringify(page ? { items: [{ name: `pool-2/chain-changes/${nameOf(T)}` }] } : { items: [{ name: `pool-2/chain-changes/${later}` }, { name: "pool-2/chain-changes/readme.txt" }], nextPageToken: "next" }));
    }) as typeof fetch;
    const store = gcsChainChangeStore("gs://bucket-a/pool-2/chain-changes/", async () => "token", fake);
    expect(await store.list(nameOf(T))).toEqual([nameOf(T), later]);
    expect(calls[0]!.searchParams.get("startOffset")).toBe(`pool-2/chain-changes/${nameOf(T)}`);
    expect(calls[1]!.searchParams.get("pageToken")).toBe("next");
    expect(await store.read(later)).toBe("body");
  });
});

describe("chain change feed", () => {
  it("asks for one baseline read at start, then only on new revisions", async () => {
    const { store, feed, signals, at } = harness();
    store.put(T - 1_000, notification(T - 1_000, change("4")));
    await feed.tick();
    expect(signals).toEqual([104]);
    expect(feed.state()).toEqual({ healthy: true, revision: "4", observedAt: Math.floor((T - 1_000) / 1000) });

    at(T + 20_000);
    store.put(T + 20_000, notification(T + 20_000, change("4")));
    await feed.tick();
    expect(signals).toHaveLength(1);

    store.put(T + 21_000, notification(T + 21_000, change("5")));
    store.put(T + 21_000, notification(T + 21_000, change("5")), "d4");
    await feed.tick();
    expect(signals).toEqual([104, 105]);
  });

  it("signals a catch-up on a skipped revision or a new generation, and ignores older revisions", async () => {
    const { store, feed, signals } = harness();
    store.put(T - 3_000, notification(T - 3_000, change("1")));
    await feed.tick();
    store.put(T - 2_000, notification(T - 2_000, change("4")));
    await feed.tick();
    store.put(T - 1_500, notification(T - 1_500, change("3")));
    await feed.tick();
    store.put(T - 1_000, notification(T - 1_000, change("0", { generation: GEN_B })));
    await feed.tick();
    expect(signals).toEqual([101, 104, 100]);
  });

  it("becomes unhealthy without a heartbeat for 60 seconds or when the publisher says so, and catches up on recovery", async () => {
    const { store, feed, signals, at } = harness();
    store.put(T, notification(T, change("2")));
    await feed.tick();
    at(T + 61_000);
    await feed.tick();
    expect(feed.state().healthy).toBe(false);
    expect(signals).toEqual([102]);

    store.put(T + 62_000, notification(T + 62_000, change("2")));
    await feed.tick();
    expect(feed.state().healthy).toBe(true);
    expect(signals).toEqual([102, null]);

    store.put(T + 63_000, notification(T + 63_000, change("2", { streamHealthy: false })));
    await feed.tick();
    expect(feed.state().healthy).toBe(false);
    store.put(T + 64_000, notification(T + 64_000, change("2")));
    await feed.tick();
    expect(signals).toEqual([102, null, null]);
  });

  it("marks a failed listing unhealthy without asking for chain reads, and retries an unread notification", async () => {
    const { store, feed, signals, errors } = harness();
    store.put(T - 1_000, notification(T - 1_000, change("1")));
    await feed.tick();
    store.failList = true;
    await feed.tick();
    expect(feed.state().healthy).toBe(false);
    expect(signals).toEqual([101]);

    store.failList = false;
    const name = store.put(T - 500, notification(T - 500, change("2")));
    store.failRead.add(name);
    await feed.tick();
    expect(signals).toEqual([101]);
    store.failRead.clear();
    await feed.tick();
    expect(signals).toEqual([101, 102]);
    expect(errors).toHaveLength(2);
  });

  it("skips an invalid notification and keeps following the stream", async () => {
    const { store, feed, signals, errors } = harness();
    store.put(T - 2_000, notification(T - 2_000, change("1"), { program: "11111111111111111111111111111111" }));
    store.put(T - 1_000, notification(T - 1_000, change("2")));
    await feed.tick();
    expect(errors[0]).toBeInstanceOf(ChainChangeInvalid);
    expect(signals).toEqual([102]);
  });

  it("asks for a baseline read when there is no notification history at all", async () => {
    const { feed, signals } = harness();
    await feed.tick();
    expect(signals).toEqual([null]);
    expect(feed.state()).toEqual({ healthy: false, revision: null, observedAt: null });
  });
  it("asks for the baseline read once, however many empty, invalid or failing ticks follow", async () => {
    const empty = harness();
    for (let i = 0; i < 10; i += 1) {
      empty.at(T + i * 1_000);
      await empty.feed.tick();
    }
    expect(empty.signals).toEqual([null]);
    expect(empty.feed.state().healthy).toBe(false);

    const invalid = harness();
    for (let i = 0; i < 10; i += 1) {
      invalid.at(T + i * 1_000);
      invalid.store.put(T + i * 1_000, notification(T + i * 1_000, change("1"), { program: "11111111111111111111111111111111" }));
      await invalid.feed.tick();
    }
    expect(invalid.signals).toEqual([null]);
    expect(invalid.errors).toHaveLength(10);

    const failing = harness();
    failing.store.failList = true;
    for (let i = 0; i < 10; i += 1) {
      failing.at(T + i * 1_000);
      await failing.feed.tick();
    }
    expect(failing.signals).toEqual([null]);
    expect(failing.errors).toHaveLength(10);

    failing.store.failList = false;
    failing.store.put(T + 10_000, notification(T + 10_000, change("3")));
    failing.at(T + 10_000);
    await failing.feed.tick();
    expect(failing.signals).toEqual([null, 103]);
  });
});
