import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import anchor from "@coral-xyz/anchor";
import { CoxInstructions, decodeState, discriminator } from "@cox/client";
import type { AddressInfo } from "node:net";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AccountInfo, type Connection } from "@solana/web3.js";
import { createCoxApiClient, type Publication, type UnsignedTransaction } from "@eox/app-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainChangeFeed } from "../src/cox/chain-changes.js";
import { loadProgram } from "../src/cox/chain.js";
import { LiveCoxSource, PoolMethodologyRejected } from "../src/cox/live-source.js";
import { directorySource, gcsSource, PublicationArchive, PublicationArchiveMissing } from "../src/cox/publication-archive.js";
import { directorySegments, PublicationHistory } from "../src/cox/publication-history.js";
import { FileSubmissionStore } from "../src/cox/submission-store.js";
import { createCoxApiServer } from "../src/cox/server.js";
import { CoxSubmissions } from "../src/cox/submissions.js";
import { associatedTokenAddress, CoxTransactions, FeeChangedError, NothingToDoError } from "../src/cox/transactions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const idlPath = join(root, "packages", "cox", "idl", "cox.json");
const fixture = JSON.parse(readFileSync(join(root, "packages", "cox", "fixtures", "accounts.json"), "utf8")) as {
  programAddress: string;
  accounts: Record<string, { address: string; dataHex: string; name: string; owner: string }>;
};
const POOL = "Fn3Xuh7CVxjcRpqJEnGR1isPy2GVBBsdiAbuhfpoVbHb";
const VAULT = "6Z7NdtAx71cmySoSYMDm697UCQcuuVYj39yPFsh2nWQ8";
const MINT = "54JFNS6S9YszKKrAQp4EYuuq4Khsj5vKgdfR4fJk5Wgf";
const OWNER = "DbiQtg1LM8UCLjY7g38d9MEpnE2Zm6eSh3tmRHojY7Au";
const REQUEST = "H6wVPbPg4N3qsTyCWyYuuDfWhUUeGTBp2eGiZWuvXQG7";
const PREDECESSOR = "a3a503199e6473d4ed9f6e9bf1102d2130fd06bae84c19d17ec63f8b2c3f1a17";
const STATE_DIGEST = "415921267ce275b5917786a678908b7ac9972105692657e8d0dbb7ef71f79dd8";
const MANIFEST = "13958d7ddc906ef68321713db05d7524ca791a647f1e09525bd91364688f564f";
const PUBLICATION = "J5Jyo9xBvaEeG5g6n5CE85SS9sy9zBriHHx3giUAEnZC";
const BATCH = "CckMCGwaEDcRbHogJLa79GRU74nFPAJtLEe3GSyzzHtb";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

class FixtureConnection {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly signatures = new Map<string, { signature: string; slot: number; err: null }[]>();
  readonly sent: Buffer[] = [];
  simulationError: string | null = null;
  returnData: { programId: string; data: [string, "base64"] } | null = null;
  status: { slot: number; confirmationStatus: string; err: unknown } | null = null;
  slots: number[] = [];
  viewReads = 0;
  programReads = 0;

  async getLatestBlockhash() {
    return { blockhash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", lastValidBlockHeight: 4242 };
  }

  async simulateTransaction() {
    if (!this.simulationError) return { context: { slot: 1 }, value: { err: null, logs: [], returnData: this.returnData } };
    return { context: { slot: 1 }, value: { err: { InstructionError: [0, { Custom: 6000 }] }, logs: [`Program log: AnchorError occurred. Error Message: ${this.simulationError}.`] } };
  }

  async sendRawTransaction(bytes: Buffer) {
    this.sent.push(Buffer.from(bytes));
    return anchor.utils.bytes.bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!);
  }

  async getSignatureStatuses() {
    return { context: { slot: 1 }, value: [this.status] };
  }

  async isBlockhashValid() {
    return { context: { slot: 1 }, value: false };
  }

  set(address: string, owner: PublicKey, data: Buffer): void {
    this.accounts.set(address, { data, owner, executable: false, lamports: 1, rentEpoch: 0 });
  }

  async getAccountInfo(key: PublicKey) {
    return this.accounts.get(key.toBase58()) ?? null;
  }

  async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
    this.viewReads += 1;
    return { context: { slot: this.slots.shift() ?? 1 }, value: keys.map((k) => this.accounts.get(k.toBase58()) ?? null) };
  }

  async getProgramAccounts(programId: PublicKey, config: { filters: { memcmp: { offset: number; bytes: string } }[] }) {
    this.programReads += 1;
    return [...this.accounts.entries()]
      .filter(([, info]) => info.owner.equals(programId))
      .filter(([, info]) => config.filters.every(({ memcmp }) => {
        const bytes = Buffer.from(anchor.utils.bytes.bs58.decode(memcmp.bytes));
        return info.data.subarray(memcmp.offset, memcmp.offset + bytes.length).equals(bytes);
      }))
      .map(([address, account]) => ({ pubkey: new PublicKey(address), account }));
  }

  async getSignaturesForAddress(key: PublicKey) {
    return this.signatures.get(key.toBase58()) ?? [];
  }
}

function tokenAccount(mint: string, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(POOL).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data;
}

function mintAccount(decimals: number): Buffer {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = 1;
  return data;
}

function originEntry(): Publication {
  return {
    identity: {
      program: fixture.programAddress, poolId: "0", sequence: 0, batch: 0, predecessorSequence: null, predecessorBatch: null, missedBatches: [], cutoff: 120000,
      manifestDigest: null, snapshotDigest: null, stateDigest: PREDECESSOR, committedAt: null, finalization: { transaction: null, slot: null, finalized: true },
    },
    prices: [], benchmarkGross: null, benchmark: "100000000000000", references: [], classes: [],
    flows: { acceptedDeposits: "0", newPayable: "0", transferResidual: "0", flowResidual: "0", fees: "0", executed: 0, rejected: 0 },
    ledger: { active: "0", pending: "0", refundable: null, payable: "0", residual: "0", fees: "0", vault: "0" },
    fees: null,
    receiptRoot: null,
  };
}

let dir = "";
let connection: FixtureConnection;
let ledger = 0n;

function open(path = join(dir, "publications.jsonl"), poolId = 0n) {
  const program = loadProgram(connection as unknown as Connection, idlPath);
  return LiveCoxSource.open({ connection: connection as unknown as Connection, program, poolId, network: "solana-devnet", history: { path, store: directorySegments(join(dir, "segments")) } });
}

async function seed(...entries: Publication[]): Promise<void> {
  const history = await PublicationHistory.open({ path: join(dir, "publications.jsonl"), store: directorySegments(join(dir, "segments")), identity: { program: fixture.programAddress, pool: POOL } });
  for (const entry of entries) await history.append(entry);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cox-live-"));
  connection = new FixtureConnection();
  const programId = new PublicKey(fixture.programAddress);
  for (const account of Object.values(fixture.accounts)) connection.set(account.address, new PublicKey(account.owner), Buffer.from(account.dataHex, "hex"));
  const program = loadProgram(connection as unknown as Connection, idlPath);
  const pool = program.coder.accounts.decode("pool", connection.accounts.get(POOL)!.data);
  ledger = [pool.active, pool.pending, pool.payable, pool.residual].reduce((sum: bigint, v: { toString(): string }) => sum + BigInt(v.toString()), 0n);
  connection.set(VAULT, TOKEN_PROGRAM, tokenAccount(MINT, ledger));
  connection.set(MINT, TOKEN_PROGRAM, mintAccount(6));
  expect(programId.toBase58()).toBe("G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("live COX source on the compiled-program account fixtures", () => {
  it("describes the deployment from the pool, its sealed methodology and the collateral mint", async () => {
    const source = await open();
    expect(await source.deployment()).toMatchObject({
      origin: "live", network: "solana-devnet", program: fixture.programAddress, poolId: "0", poolAddress: POOL, collateralMint: MINT, collateralDecimals: 6, testCollateral: true,
      methodology: { status: "sealed", assetCount: 30, label: "CRYPTO (pilot, 30 assets)", digest: MANIFEST },
    });
    const crypto = await source.crypto();
    expect(crypto.members).toHaveLength(30);
    expect(crypto.members[0]).toEqual({ assetId: "BTC", weightNumerator: "1", weightDenominator: "30" });
    const assets = await source.assets();
    expect(assets.find((a) => a.assetId === "TRX")?.venues).toEqual({ krakenWs: "TRX/USD", krakenRest: "TRXUSD", coinbase: null, bybit: "TRXUSDT" });
    expect(assets.every((a) => a.latest === null)).toBe(true);
  });

  it("indexes the next finalized publication after the durable log and links it to its predecessor", async () => {
    await seed(originEntry());
    const source = await open();
    const seen: Publication[] = [];
    source.onPublication((p) => seen.push(p));
    await source.tick();
    const [, latest] = await source.publications();
    expect(seen).toEqual([latest]);
    expect(latest!.identity).toMatchObject({
      sequence: 1, batch: 1, predecessorSequence: 0, predecessorBatch: 0, missedBatches: [], cutoff: 120060,
      stateDigest: STATE_DIGEST,
      manifestDigest: MANIFEST,
      finalization: { transaction: null, slot: 1, finalized: true },
    });
    expect(latest!.prices).toHaveLength(30);
    expect(latest!.prices[0]).toEqual({ assetId: "BTC", priceE8: "100000000", venue: "kraken", step: 1, candleStart: 120000, tradeAgeMinutes: 0 });
    expect(latest!.classes.map((c) => c.classId).at(-1)).toBe("CRYPTO");
    expect(latest!.classes).toHaveLength(31);
    const { active, pending, payable, residual, vault } = latest!.ledger;
    expect(BigInt(active) + BigInt(pending) + BigInt(payable) + BigInt(residual)).toBe(BigInt(vault));
    expect(latest!.ledger.refundable).toBeNull();
    expect(latest!.classes.every((c) => c.fixed !== null)).toBe(true);
    expect(latest!.flows.acceptedDeposits).not.toBeNull();
    await source.tick();
    expect(await source.publications()).toHaveLength(2);
    expect(seen).toHaveLength(1);
    const status = await source.status(120060 + 25);
    expect(status).toMatchObject({ state: "fresh", latestSequence: 1, latestBatch: 1, missedCutoffs: 0, executing: false, reconciliation: { sequence: 1, vault: ledger.toString(), ledger: ledger.toString(), covered: true } });
    expect((await source.assets())[0]!.latest).toMatchObject({ sequence: 1, batch: 1, priceE8: "100000000" });
    const reopened = await open();
    expect((await reopened.publications()).map((p) => p.identity.sequence)).toEqual([0, 1]);
  });

  it("reports an incident when the vault holds less than the ledger", async () => {
    await seed(originEntry());
    connection.set(VAULT, TOKEN_PROGRAM, tokenAccount(MINT, ledger - 1n));
    const source = await open();
    await source.tick();
    expect(await source.status(120060 + 25)).toMatchObject({ state: "incident", reconciliation: { covered: false } });
  });

  it("refuses a publication that does not follow the logged predecessor", async () => {
    const wrong = originEntry();
    wrong.identity.stateDigest = "00".repeat(32);
    await seed(wrong);
    const source = await open();
    await expect(source.tick()).rejects.toThrow("PublicationPredecessorMismatch");
    expect(await source.publications()).toHaveLength(1);
  });

  it("serves a wallet's committed position and its filled request from chain state", async () => {
    const source = await open();
    const portfolio = await source.portfolio(OWNER);
    expect(portfolio).toMatchObject({ owner: OWNER, appliedSequence: 1, payable: "0", refundable: "0", pending: "0" });
    expect(portfolio!.positions).toHaveLength(31);
    expect(portfolio!.positions[0]).toEqual({ classId: "BTC", units: "2000000000000000000", locked: "0" });
    expect(portfolio!.requests).toEqual([{
      requestId: REQUEST, owner: OWNER, operation: "deposit", fromClass: null, toClass: "BTC", amount: "1000000", units: null, minimumUnits: "0", minimumProceeds: null,
      targetBatch: 1, expiryBatch: 20, state: "filled", feeTerms: { version: "0", bps: 0, cap: "0" },
      receipt: { requestId: REQUEST, sequence: 1, batch: 1, status: "filled", minted: "1000000000000000000", proceeds: "0", gross: null, fee: "0" },
    }]);
    expect(await source.portfolio("11111111111111111111111111111111")).toBeNull();
  });
});

describe("dynamic request classes", () => {
  it("keeps its view and rejects a pool that moves to a methodology it cannot read", async () => {
    await seed(originEntry());
    const source = await open();
    await source.tick();
    const program = loadProgram(connection as unknown as Connection, idlPath);
    const coder = program.coder.accounts as anchor.BorshAccountsCoder;
    const pool = coder.decode("pool", connection.accounts.get(POOL)!.data);
    const layout = (coder as unknown as { accountLayouts: Map<string, { layout: { encode(value: object, buffer: Buffer): number } }> }).accountLayouts.get("pool")!;
    const body = Buffer.alloc(65_536);
    const length = layout.layout.encode({ ...pool, methodology: Keypair.generate().publicKey }, body);
    const data = Buffer.alloc(connection.accounts.get(POOL)!.data.length);
    Buffer.concat([coder.accountDiscriminator("pool"), body.subarray(0, length)]).copy(data);
    connection.set(POOL, program.programId, data);
    await expect(source.tick()).rejects.toThrow();
    expect(source.manifest.digest).toBe(MANIFEST);
  });

  it("reads a schema 3 request's classes from its 16-bit ids, with 65535 as no class", async () => {
    const program = loadProgram(connection as unknown as Connection, idlPath);
    const coder = program.coder.accounts as anchor.BorshAccountsCoder;
    const current = coder.decode("request", connection.accounts.get(REQUEST)!.data);
    const encoded = await coder.encode("request", { ...current, schemaVersion: 3, fromId: 65535, toId: 1 });
    const data = Buffer.alloc(connection.accounts.get(REQUEST)!.data.length);
    encoded.copy(data);
    connection.set(REQUEST, program.programId, data);
    const source = await open();
    const portfolio = await source.portfolio(OWNER);
    expect(portfolio!.requests[0]).toMatchObject({ requestId: REQUEST, fromClass: null, toClass: "ETH" });
  });
});

describe("change-driven chain reads", () => {
  it("reads only when the change feed signals, waits for finality and caches wallets until the next change", async () => {
    let signal: (slot: number | null) => void = () => undefined;
    let healthy = true;
    const changes = {
      onChange: (listener: (slot: number | null) => void) => {
        signal = listener;
        return () => undefined;
      },
      state: () => ({ healthy, revision: "1", observedAt: 1 }),
    } as unknown as ChainChangeFeed;
    await seed(originEntry());
    const program = loadProgram(connection as unknown as Connection, idlPath);
    const source = await LiveCoxSource.open({
      connection: connection as unknown as Connection, program, poolId: 0n, network: "solana-devnet",
      history: { path: join(dir, "publications.jsonl"), store: directorySegments(join(dir, "segments")) }, changes, finalityWaitMs: 5, safetyMs: 3_600_000, now: () => 1_792_700_000_000,
    });
    let refreshed = 0;
    source.onChainRefresh!(() => (refreshed += 1));
    connection.viewReads = 0;
    source.start();
    await vi.waitFor(() => expect(refreshed).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connection.viewReads).toBe(1);
    expect((await source.status(1_792_700_000)).chain).toMatchObject({ readAt: 1_792_700_000, slot: 1, feed: "healthy", methodology: { adoption: "current" } });

    connection.programReads = 0;
    await Promise.all([source.portfolio(OWNER), source.portfolio(OWNER)]);
    await source.portfolio(OWNER);
    expect(connection.programReads).toBe(1);

    connection.slots = [5, 5, 12];
    signal(10);
    await vi.waitFor(() => expect(refreshed).toBe(2));
    expect(connection.viewReads).toBe(4);
    await source.portfolio(OWNER);
    expect(connection.programReads).toBe(2);

    healthy = false;
    expect((await source.status(1_792_700_000)).chain?.feed).toBe("unhealthy");
    source.stop();
  });
});

describe("transaction rate limit", () => {
  async function limited(options: { gatewaySecret?: string }) {
    const source = await open();
    const program = loadProgram(connection as unknown as Connection, idlPath);
    const transactions = new CoxTransactions({ connection: connection as unknown as Connection, program, poolId: 0n, pool: source.poolAddress, vault: source.vaultAddress, mint: source.collateralMint, origin: source.manifest.origin, classes: source.classes });
    const submissions = new CoxSubmissions({ connection: connection as unknown as Connection, programId: program.programId, store: new FileSubmissionStore(join(dir, "submissions.json")), feeVersion: async () => 0n });
    const server = createCoxApiServer({ source, transactions, submissions, postLimit: { perMinute: 2, trustForwardedFor: true }, ...options });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/transactions/withdraw`;
    const post = (forwarded: string, gateway?: string) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": forwarded, ...(gateway ? { "x-relative-gateway": gateway } : {}) }, body: JSON.stringify({ owner: "bad" }) });
    return { server, url, post };
  }

  it("limits POSTs per visitor, the first address the gateway forwards, not the proxy that appended last", async () => {
    const { server, url, post } = await limited({});
    try {
      expect((await post("1.1.1.1, 9.9.9.9")).status).toBe(400);
      expect((await post("1.1.1.1, 8.8.8.8")).status).toBe(400);
      const blocked = await post("1.1.1.1, 7.7.7.7");
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("30");
      expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
      expect((await post("2.2.2.2, 9.9.9.9")).status).toBe(400);
      expect((await fetch(url.replace("/transactions/withdraw", "/status"))).status).toBe(200);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("trusts the visitor address only from the gateway once a gateway secret is set", async () => {
    const secret = "s3cr3t-gateway-value-with-enough-length";
    const { server, post } = await limited({ gatewaySecret: secret });
    try {
      expect((await post("1.1.1.1, 9.9.9.9", secret)).status).toBe(400);
      expect((await post("1.1.1.1, 8.8.8.8", secret)).status).toBe(400);
      expect((await post("1.1.1.1, 7.7.7.7", secret)).status).toBe(429);
      expect((await post("5.5.5.5, 6.6.6.6", "wrong")).status).toBe(400);
      expect((await post("4.4.4.4, 6.6.6.6")).status).toBe(400);
      expect((await post("3.3.3.3, 6.6.6.6")).status).toBe(429);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("reusable publication account and the publisher archive", () => {
  function archiveRecord(overrides: Record<string, unknown> = {}) {
    const account = Object.values(fixture.accounts).find((a) => a.name === "publication")!;
    const bytes = Buffer.from(account.dataHex, "hex");
    return {
      schema: "cox.publication-archive/v1",
      identity: { program: fixture.programAddress, pool: POOL, genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" },
      address: PUBLICATION, sequence: "1", batch: "1", stateDigest: STATE_DIGEST,
      accountSha256: createHash("sha256").update(bytes).digest("hex"), accountBase64: bytes.toString("base64"), finalizedSlot: 77,
      ...overrides,
    };
  }

  function archive(records: Record<string, unknown>) {
    const directory = join(dir, "history");
    mkdirSync(directory, { recursive: true });
    for (const [sequence, record] of Object.entries(records)) writeFileSync(join(directory, `${sequence}.json`), JSON.stringify(record));
    return new PublicationArchive(directorySource(directory), loadProgram(connection as unknown as Connection, idlPath), new PublicKey(POOL), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  }

  it("refuses to skip publications that are only in an unconfigured archive", async () => {
    const source = await open();
    await expect(source.tick()).rejects.toThrow(PublicationArchiveMissing);
    expect(await source.publications()).toHaveLength(0);
  });

  it("reads and checks archived publication bytes, and refuses tampered or foreign records", async () => {
    const store = archive({ 1: archiveRecord(), 2: archiveRecord({ sequence: "2" }), 3: archiveRecord({ sequence: "3", accountSha256: "00".repeat(32) }), 4: archiveRecord({ identity: { program: fixture.programAddress, pool: VAULT, genesisHash: "x" } }) });
    const { publication, slot } = await store.read(1n);
    expect(Buffer.from(publication.stateDigest).toString("hex")).toBe(STATE_DIGEST);
    expect(slot).toBe(77);
    await expect(store.read(2n)).rejects.toThrow("does not match its record");
    await expect(store.read(3n)).rejects.toThrow("fails its account hash");
    await expect(store.read(4n)).rejects.toThrow("another program, pool or network");
    await expect(store.read(9n)).rejects.toThrow(PublicationArchiveMissing);
  });

  it("keeps confirmed v2 records apart from finalized v1 records and refuses mixed provenance", async () => {
    const confirmed = { schema: "cox.publication-archive/v2", finalizedSlot: undefined, observedSlot: 88, commitment: "confirmed" };
    const store = archive({
      1: archiveRecord(confirmed),
      2: archiveRecord({ ...confirmed, sequence: "2", commitment: "finalized" }),
      3: archiveRecord({ ...confirmed, sequence: "3", finalizedSlot: 90 }),
      4: archiveRecord({ sequence: "4", observedSlot: 91 }),
      5: archiveRecord({ sequence: "5", schema: "cox.publication-archive/v3" }),
    });
    expect(await store.read(1n)).toMatchObject({ slot: 88, finalized: false });
    for (const sequence of [2n, 3n, 4n, 5n]) await expect(store.read(sequence)).rejects.toThrow("inconsistent commitment provenance");
    const finalized = archive({ 1: archiveRecord() });
    expect(await finalized.read(1n)).toMatchObject({ slot: 77, finalized: true });
  });

  it("reads one content-addressed record per sequence from Cloud Storage", async () => {
    const text = JSON.stringify(archiveRecord());
    const digest = createHash("sha256").update(text).digest("hex");
    const objects: Record<string, string> = { [`pool-0/history/1/${digest}.json`]: text, [`pool-0/history/2/${"0".repeat(64)}.json`]: text, [`pool-0/history/3/${digest}.json`]: text, [`pool-0/history/3/${"1".repeat(64)}.json`]: text };
    const requests: string[] = [];
    const storage = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${(init?.headers as Record<string, string>).authorization} ${url.pathname}`);
      const prefix = url.searchParams.get("prefix");
      if (prefix !== null) return Response.json({ items: Object.keys(objects).filter((name) => name.startsWith(prefix)).map((name) => ({ name })) });
      const name = decodeURIComponent(url.pathname.split("/o/")[1]!);
      return objects[name] === undefined ? new Response("", { status: 404 }) : new Response(objects[name]);
    }) as typeof fetch;
    const source = gcsSource("gs://cox-archive/pool-0/history/", async () => "token", storage);
    const store = new PublicationArchive(source, loadProgram(connection as unknown as Connection, idlPath), new PublicKey(POOL), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    expect((await store.read(1n)).slot).toBe(77);
    expect(requests.every((r) => r.startsWith("Bearer token /storage/v1/b/cox-archive/o"))).toBe(true);
    await expect(store.read(2n)).rejects.toThrow("does not match its name");
    await expect(store.read(3n)).rejects.toThrow("holds 2 records");
    await expect(store.read(5n)).rejects.toThrow(PublicationArchiveMissing);
    expect(() => gcsSource("gs://cox-archive/pool-0/history", async () => "token")).toThrow("ending in a slash");
  });

  it("indexes a publication whose batch was already reused, leaving the fixed valuation unknown", async () => {
    await seed(originEntry());
    connection.accounts.delete(BATCH);
    const source = await open();
    await source.tick();
    const [, latest] = await source.publications();
    expect(latest!.identity).toMatchObject({ sequence: 1, stateDigest: STATE_DIGEST });
    expect(latest!.classes.every((c) => c.fixed === null)).toBe(true);
    expect(latest!.flows).toMatchObject({ acceptedDeposits: null, newPayable: null, transferResidual: null, flowResidual: null, executed: 64 });
  });
});

describe("unsigned transactions and submission", () => {
  const wallet = Keypair.generate();
  const NOW = 120000 + 60 * 5 + 10;

  async function services() {
    const source = await open();
    const program = loadProgram(connection as unknown as Connection, idlPath);
    const transactions = new CoxTransactions({
      connection: connection as unknown as Connection, program, poolId: 0n, pool: source.poolAddress, vault: source.vaultAddress, mint: source.collateralMint, origin: source.manifest.origin, classes: source.classes,
    }, () => NOW);
    const submissions = new CoxSubmissions({ connection: connection as unknown as Connection, programId: program.programId, store: new FileSubmissionStore(join(dir, "submissions.json")), now: () => NOW, feeVersion: async () => 0n });
    return { source, program, transactions, submissions };
  }

  function decode(built: UnsignedTransaction) {
    const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
    const keys = tx.message.staticAccountKeys;
    return { tx, keys, instructions: tx.message.compiledInstructions.map((i) => ({ program: keys[i.programIdIndex]!.toBase58(), accounts: i.accountKeyIndexes.map((k) => keys[k]!.toBase58()), data: Buffer.from(i.data) })) };
  }

  it("builds a deposit for the next request nonce, paid and signed by the wallet only", async () => {
    const { program, transactions } = await services();
    const pool = program.coder.accounts.decode("pool", connection.accounts.get(POOL)!.data);
    const nonce = BigInt(pool.nextRequestNonce.toString());
    const built = await transactions.deposit({ owner: wallet.publicKey.toBase58(), toClass: "ETH", amount: "2500000", minimumUnits: "0", expiryBatch: 10 });
    const request = PublicKey.findProgramAddressSync([Buffer.from("request"), new PublicKey(POOL).toBuffer(), Buffer.from(new BigUint64Array([nonce]).buffer)], program.programId)[0];
    expect(built).toMatchObject({ operation: "deposit", owner: wallet.publicKey.toBase58(), nonce: nonce.toString(), requestId: request.toBase58(), targetBatch: { batch: 6, cutoff: 120360 }, expiryBatch: 10, toClass: "ETH", amount: "2500000", minimumUnits: "0", lastValidBlockHeight: 4242 });
    const { tx, keys, instructions } = decode(built);
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(keys[0]!.equals(wallet.publicKey)).toBe(true);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.program).toBe(fixture.programAddress);
    const position = PublicKey.findProgramAddressSync([Buffer.from("position"), new PublicKey(POOL).toBuffer(), wallet.publicKey.toBuffer()], program.programId)[0];
    expect(instructions[0]!.accounts).toEqual([
      wallet.publicKey.toBase58(), "9E52kNuxk7bHHuuvvrG13hvRBinvSnPFNFYM9kcPcKEC", POOL, position.toBase58(), request.toBase58(), VAULT,
      associatedTokenAddress(wallet.publicKey, new PublicKey(MINT)).toBase58(), TOKEN_PROGRAM.toBase58(), SystemProgram.programId.toBase58(), fixture.programAddress,
    ]);
    expect(instructions[0]!.data.subarray(0, 8)).toEqual(discriminator("global", "deposit"));
  });

  it("validates inputs before touching the chain and reports a simulated rejection", async () => {
    const { transactions } = await services();
    const owner = wallet.publicKey.toBase58();
    await expect(transactions.deposit({ owner, toClass: "DOGE", amount: "1", minimumUnits: "0", expiryBatch: 10 })).rejects.toThrow("not a class");
    await expect(transactions.deposit({ owner, toClass: "BTC", amount: "0", minimumUnits: "0", expiryBatch: 10 })).rejects.toThrow("out of range");
    await expect(transactions.deposit({ owner, toClass: "BTC", amount: "1.5", minimumUnits: "0", expiryBatch: 10 })).rejects.toThrow("integer string");
    await expect(transactions.deposit({ owner, toClass: "BTC", amount: "1", minimumUnits: "0", expiryBatch: 5 })).rejects.toThrow("expiryBatch");
    await expect(transactions.switch({ owner, fromClass: "BTC", toClass: "BTC", units: "1", minimumUnits: "0", expiryBatch: 10 })).rejects.toThrow("must differ");
    await expect(transactions.withdraw({ owner: POOL, amount: "1" })).rejects.toThrow("can sign");
    await expect(transactions.cancel({ owner, requestId: REQUEST })).rejects.toThrow("does not belong");
    connection.simulationError = "Insufficient unlocked units";
    await expect(transactions.redeem({ owner, fromClass: "BTC", units: "1", minimumProceeds: "0", expiryBatch: 10 })).rejects.toThrow("Insufficient unlocked units");
  });

  it("builds cancel for the owner's request and creates the payout token account before redeem", async () => {
    const { transactions, program } = await services();
    const cancel = decode(await transactions.cancel({ owner: OWNER, requestId: REQUEST }));
    expect(cancel.instructions[0]!.data.subarray(0, 8)).toEqual(discriminator("global", "cancel"));
    expect(cancel.instructions[0]!.accounts).toContain(REQUEST);
    const redeem = decode(await transactions.redeem({ owner: OWNER, fromClass: "BTC", units: "1000", minimumProceeds: "0", expiryBatch: 6 }));
    expect(redeem.instructions.map((i) => i.program)).toEqual(["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", fixture.programAddress]);
    expect(redeem.instructions[0]!.data).toEqual(Buffer.from([1]));
  });

  it("relays exactly the signed bytes, refuses unsigned or foreign transactions and tracks the result", async () => {
    const { transactions, submissions } = await services();
    const built = await transactions.withdraw({ owner: wallet.publicKey.toBase58(), amount: "5" });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
    await expect(submissions.submit(built.transaction)).rejects.toThrow("not fully signed");
    tx.sign([wallet]);
    const signed = Buffer.from(tx.serialize()).toString("base64");
    const submission = await submissions.submit(signed);
    expect(connection.sent.map((b) => b.toString("base64"))).toEqual([signed]);
    expect(submission).toMatchObject({ owner: wallet.publicKey.toBase58(), operation: "withdraw", transaction: signed, state: "submitted", submittedAt: NOW });
    connection.status = { slot: 77, confirmationStatus: "finalized", err: null };
    expect(await submissions.get(submission.signature)).toMatchObject({ state: "finalized", slot: 77 });
    expect(await submissions.submit(signed)).toMatchObject({ state: "finalized" });
    expect(connection.sent).toHaveLength(1);
    const reopened = new CoxSubmissions({ connection: connection as unknown as Connection, programId: new PublicKey(fixture.programAddress), store: new FileSubmissionStore(join(dir, "submissions.json")), feeVersion: async () => 0n });
    expect(await reopened.get(submission.signature)).toMatchObject({ state: "finalized", transaction: signed });
    const transfer = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(VAULT), lamports: 1 });
    const foreign = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: built.recentBlockhash, instructions: [transfer] }).compileToV0Message());
    foreign.sign([wallet]);
    await expect(submissions.submit(Buffer.from(foreign.serialize()).toString("base64"))).rejects.toThrow("outside COX");
  });

  it("serves builders, submission and lookup over HTTP", async () => {
    const { source, transactions, submissions } = await services();
    const server = createCoxApiServer({ source, transactions, submissions, now: () => NOW });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = createCoxApiClient({ baseUrl });
    const json = { "content-type": "application/json" };
    try {
      const built = (await client.buildWithdraw({ owner: wallet.publicKey.toBase58(), amount: "5" })).data;
      const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
      tx.sign([wallet]);
      const submitted = (await client.submitTransaction(Buffer.from(tx.serialize()).toString("base64"))).data;
      expect((await client.submission(submitted.signature)).data.signature).toBe(submitted.signature);
      await expect(client.submission("1".repeat(64))).rejects.toMatchObject({ code: "TRANSACTION_NOT_FOUND", httpStatus: 404 });
      await expect(client.buildDeposit({ owner: wallet.publicKey.toBase58(), toClass: "NOPE", amount: "1", minimumUnits: "0", expiryBatch: 10 })).rejects.toMatchObject({ code: "INVALID_REQUEST", httpStatus: 400 });
      connection.simulationError = "Pool paused";
      await expect(client.buildWithdraw({ owner: wallet.publicKey.toBase58(), amount: "5" })).rejects.toMatchObject({ code: "TRANSACTION_REJECTED", httpStatus: 422 });
      expect((await fetch(`${baseUrl}/v1/transactions/withdraw`, { method: "POST", body: "{}" })).status).toBe(415);
      expect((await fetch(`${baseUrl}/v1/transactions/withdraw`, { method: "POST", headers: json, body: JSON.stringify({ pad: "x".repeat(9000) }) })).status).toBe(413);
      expect((await fetch(`${baseUrl}/v1/transactions/publish`, { method: "POST", headers: json, body: "{}" })).status).toBe(404);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("fee upgrade on the compiled fee-account fixtures", () => {
  const feeFixture = JSON.parse(readFileSync(join(root, "packages", "cox", "fixtures", "fee-accounts.json"), "utf8")) as { accounts: { address: string; dataHex: string; name: string; owner: string }[] };
  const feeOwner = "7sR7Xp1CoU2JWz3mLPYZvADm39yPXtj2UGswk2cpZuKD";
  const wallet = Keypair.generate();
  const NOW = 120000 + 60 * 5 + 10;
  let feeMint = "";
  let feeLedger = 0n;

  beforeEach(() => {
    for (const account of feeFixture.accounts) connection.set(account.address, new PublicKey(account.owner), Buffer.from(account.dataHex, "hex"));
    const program = loadProgram(connection as unknown as Connection, idlPath);
    const pool = program.coder.accounts.decode("pool", connection.accounts.get(POOL)!.data);
    feeMint = pool.collateralMint.toBase58();
    feeLedger = [pool.active, pool.pending, pool.payable, pool.residual, pool.fees].reduce((sum: bigint, v: { toString(): string }) => sum + BigInt(v.toString()), 0n);
    connection.set(VAULT, TOKEN_PROGRAM, tokenAccount(feeMint, feeLedger));
    connection.set(feeMint, TOKEN_PROGRAM, mintAccount(6));
  });

  async function seedLog(): Promise<void> {
    const program = loadProgram(connection as unknown as Connection, idlPath);
    const publication = program.coder.accounts.decode("publication", connection.accounts.get(PUBLICATION)!.data);
    const previous = decodeState(Buffer.from(publication.statePreimage)).previousState;
    await seed(originEntry(), { ...originEntry(), identity: { ...originEntry().identity, sequence: 1, batch: 1, predecessorSequence: 0, predecessorBatch: 0, stateDigest: Buffer.from(previous).toString("hex") } });
  }

  async function services(feeVersion = 1n) {
    const source = await open();
    const program = loadProgram(connection as unknown as Connection, idlPath);
    const transactions = new CoxTransactions({
      connection: connection as unknown as Connection, program, poolId: 0n, pool: source.poolAddress, vault: source.vaultAddress, mint: source.collateralMint, origin: source.manifest.origin, classes: source.classes,
    }, () => NOW);
    const submissions = new CoxSubmissions({ connection: connection as unknown as Connection, programId: program.programId, store: new FileSubmissionStore(join(dir, "submissions.json")), now: () => NOW, feeVersion: async () => feeVersion });
    return { source, program, transactions, submissions };
  }

  function quoteReturn(program: ReturnType<typeof loadProgram>, values: { sequence: number; minted: string; proceeds: string; gross: string; fee: string; feeVersion: number }) {
    const data = program.coder.types.encode("feeQuoteRead", {
      sequence: new anchor.BN(values.sequence), minted: new anchor.BN(values.minted), proceeds: new anchor.BN(values.proceeds),
      gross: new anchor.BN(values.gross), fee: new anchor.BN(values.fee), feeVersion: new anchor.BN(values.feeVersion),
    });
    connection.returnData = { programId: program.programId.toBase58(), data: [Buffer.from(data).toString("base64"), "base64"] };
  }

  it("serves the migrated publication with committed and batch fees and reconciles the vault including committed fees", async () => {
    await seedLog();
    const source = await open();
    await source.tick();
    const latest = (await source.publications()).at(-1)!;
    expect(latest.identity.sequence).toBe(2);
    expect(latest.ledger.fees).toBe("6200");
    expect(latest.flows).toMatchObject({ acceptedDeposits: "31000000", fees: "6200", flowResidual: "0" });
    const { active, pending, payable, residual, fees, vault } = latest.ledger;
    expect(BigInt(active) + BigInt(pending) + BigInt(payable) + BigInt(residual) + BigInt(fees)).toBe(BigInt(vault));
    expect(latest.fees).toEqual({ policy: "COX/FEES/V1", active: { version: "1", bps: 2, cap: "2000000" }, scheduled: null });
    const status = await source.status(120120 + 25);
    expect(status.fees).toEqual({ policy: "COX/FEES/V1", migrated: true, active: { version: "1", bps: 2, cap: "2000000" }, scheduled: null, committed: "6200" });
    expect(status.reconciliation).toEqual({ sequence: 2, vault: feeLedger.toString(), ledger: feeLedger.toString(), fees: "6200", covered: true });
    connection.set(VAULT, TOKEN_PROGRAM, tokenAccount(feeMint, feeLedger - 6200n));
    await source.tick();
    expect(await source.status(120120 + 25)).toMatchObject({ state: "incident", reconciliation: { covered: false } });
  });

  it("restores a schema 3 publication from the publisher archive after a restart", async () => {
    await seedLog();
    const bytes = connection.accounts.get(PUBLICATION)!.data;
    const program = loadProgram(connection as unknown as Connection, idlPath);
    const stateDigest = Buffer.from(program.coder.accounts.decode("publication", bytes).stateDigest).toString("hex");
    const directory = join(dir, "history");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "2.json"), JSON.stringify({
      schema: "cox.publication-archive/v1",
      identity: { program: fixture.programAddress, pool: POOL, genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" },
      address: PUBLICATION, sequence: "2", batch: "2", stateDigest,
      accountSha256: createHash("sha256").update(bytes).digest("hex"), accountBase64: bytes.toString("base64"), finalizedSlot: 91,
    }));
    const archive = new PublicationArchive(directorySource(directory), program, new PublicKey(POOL), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    const { publication, slot } = await archive.read(2n);
    expect(publication.schemaVersion).toBe(3);
    expect(publication.state.feeState?.fees.toString()).toBe("6200");
    expect(slot).toBe(91);
    connection.accounts.delete(PUBLICATION);
    const restarted = await LiveCoxSource.open({ connection: connection as unknown as Connection, program, poolId: 0n, network: "solana-devnet", history: { path: join(dir, "publications.jsonl"), store: directorySegments(join(dir, "segments")) }, archive });
    connection.set(PUBLICATION, new PublicKey(fixture.programAddress), bytes);
    await restarted.tick();
    expect((await restarted.publications()).map((p) => [p.identity.sequence, p.ledger.fees])).toEqual([[0, "0"], [1, "0"], [2, "6200"]]);
  });

  it("shows a request's locked fee terms and the fee charged on its committed receipt", async () => {
    const source = await open();
    const portfolio = await source.portfolio(feeOwner);
    expect(portfolio!.requests).toHaveLength(1);
    expect(portfolio!.requests[0]).toMatchObject({
      operation: "deposit", amount: "1000000", state: "filled", feeTerms: { version: "1", bps: 2, cap: "2000000" },
      receipt: { status: "filled", gross: "1000000", fee: "200" },
    });
  });

  it("builds fee-aware trades only for the quoted fee version", async () => {
    const { transactions } = await services();
    const owner = wallet.publicKey.toBase58();
    await expect(transactions.deposit({ owner, toClass: "ETH", amount: "2500000", minimumUnits: "0", expiryBatch: 10 })).rejects.toThrow("expectedFeeVersion is required");
    await expect(transactions.deposit({ owner, toClass: "ETH", amount: "2500000", minimumUnits: "0", expiryBatch: 10, expectedFeeVersion: "0" })).rejects.toThrow(FeeChangedError);
    await expect(transactions.deposit({ owner, toClass: "ETH", amount: "2500000", minimumUnits: "0", expiryBatch: 10, expectedFeeVersion: "-1" })).rejects.toThrow("integer string");
    const built = await transactions.deposit({ owner, toClass: "ETH", amount: "2500000", minimumUnits: "0", expiryBatch: 10, expectedFeeVersion: "1" });
    expect(built.feeTerms).toEqual({ version: "1", bps: 2, cap: "2000000" });
    const data = Buffer.from(VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64")).message.compiledInstructions.at(-1)!.data);
    expect(data.subarray(0, 8)).toEqual(discriminator("global", "deposit_with_fee"));
    expect(data.length).toBe(49);
    expect(data.readBigUInt64LE(41)).toBe(1n);
    const trades: [string, () => Promise<UnsignedTransaction>][] = [
      ["switch_with_fee", () => transactions.switch({ owner: feeOwner, fromClass: "BTC", toClass: "ETH", units: "1000", minimumUnits: "0", expiryBatch: 10, expectedFeeVersion: "1" })],
      ["redeem_with_fee", () => transactions.redeem({ owner: feeOwner, fromClass: "BTC", units: "1000", minimumProceeds: "0", expiryBatch: 10, expectedFeeVersion: "1" })],
    ];
    for (const [name, call] of trades) {
      const instruction = Buffer.from(VersionedTransaction.deserialize(Buffer.from((await call()).transaction, "base64")).message.compiledInstructions.at(-1)!.data);
      expect(instruction.subarray(0, 8)).toEqual(discriminator("global", name));
      expect(instruction.readBigUInt64LE(instruction.length - 8)).toBe(1n);
    }
    connection.simulationError = "FeeVersionChanged";
    await expect(transactions.deposit({ owner, toClass: "ETH", amount: "2500000", minimumUnits: "0", expiryBatch: 10, expectedFeeVersion: "1" })).rejects.toThrow(FeeChangedError);
  });

  it("builds dynamic-pool trades as V2 instructions behind a memory frame, prepares positions and relays them", async () => {
    const { source, program, submissions } = await services();
    const context = { connection: connection as unknown as Connection, program, poolId: 0n, pool: source.poolAddress, vault: source.vaultAddress, mint: source.collateralMint, origin: source.manifest.origin, classes: source.classes };
    const dynamic = new CoxTransactions({ ...context, dynamic: true }, () => NOW);
    const instructionsOf = (built: UnsignedTransaction) => {
      const message = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64")).message;
      return message.compiledInstructions.map((i) => ({ program: message.staticAccountKeys[i.programIdIndex]!, data: Buffer.from(i.data) }));
    };

    const deposit = await dynamic.deposit({ owner: wallet.publicKey.toBase58(), toClass: "ETH", amount: "2500000", minimumUnits: "0", expiryBatch: 10, expectedFeeVersion: "1" });
    const [frame, ...rest] = instructionsOf(deposit);
    expect(frame!.program.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(frame!.data[0]).toBe(1);
    expect(frame!.data.readUInt32LE(1)).toBe(262144);
    const request = rest.at(-1)!.data;
    expect(request.subarray(0, 8)).toEqual(discriminator("global", "deposit_v2"));
    expect(request.length).toBe(50);
    expect(request.readUInt16LE(8)).toBe(1);
    expect(request.readBigUInt64LE(42)).toBe(1n);

    const trades: [string, number, () => Promise<UnsignedTransaction>][] = [
      ["switch_v2", 60, () => dynamic.switch({ owner: feeOwner, fromClass: "BTC", toClass: "ETH", units: "1000", minimumUnits: "0", expiryBatch: 10, expectedFeeVersion: "1" })],
      ["redeem_v2", 50, () => dynamic.redeem({ owner: feeOwner, fromClass: "BTC", units: "1000", minimumProceeds: "0", expiryBatch: 10, expectedFeeVersion: "1" })],
    ];
    for (const [name, length, call] of trades) {
      const data = instructionsOf(await call()).at(-1)!.data;
      expect(data.subarray(0, 8)).toEqual(discriminator("global", name));
      expect(data.length).toBe(length);
      expect(data.readBigUInt64LE(length - 8)).toBe(1n);
    }

    const fresh = await dynamic.preparePosition({ owner: wallet.publicKey.toBase58() });
    expect(fresh.preparation).toMatchObject({ bytes: "4096", requiredBytes: "4096", ready: true });
    expect(instructionsOf(fresh).at(-1)!.data.subarray(0, 8)).toEqual(discriminator("global", "initialize_dynamic_position"));
    await expect(dynamic.preparePosition({ owner: feeOwner })).rejects.toThrow(NothingToDoError);
    await expect(new CoxTransactions(context, () => NOW).preparePosition({ owner: feeOwner })).rejects.toThrow(NothingToDoError);

    const tx = VersionedTransaction.deserialize(Buffer.from(deposit.transaction, "base64"));
    tx.sign([wallet]);
    expect(await submissions.submit(Buffer.from(tx.serialize()).toString("base64"))).toMatchObject({ operation: "deposit", state: "submitted" });
    const prepared = VersionedTransaction.deserialize(Buffer.from(fresh.transaction, "base64"));
    prepared.sign([wallet]);
    expect(await submissions.submit(Buffer.from(prepared.serialize()).toString("base64"))).toMatchObject({ operation: "prepare-position", state: "submitted" });
    expect(connection.sent).toHaveLength(2);
  });

  it("refuses to relay a trade signed for a fee version the pool no longer has", async () => {
    const { program, transactions } = await services();
    const built = await transactions.deposit({ owner: wallet.publicKey.toBase58(), toClass: "ETH", amount: "2500000", minimumUnits: "0", expiryBatch: 10, expectedFeeVersion: "1" });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
    tx.sign([wallet]);
    const signed = Buffer.from(tx.serialize()).toString("base64");
    await expect((await services(2n)).submissions.submit(signed)).rejects.toThrow(FeeChangedError);
    expect(connection.sent).toHaveLength(0);
    const keys = { owner: wallet.publicKey, pool: new PublicKey(POOL), vault: new PublicKey(VAULT), position: PublicKey.default, request: PublicKey.default, userToken: PublicKey.default };
    const old = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: built.recentBlockhash, instructions: [new CoxInstructions(program).deposit(keys, 1, 5n, 0n, 10n)] }).compileToV0Message());
    old.sign([wallet]);
    const current = (await services(1n)).submissions;
    await expect(current.submit(Buffer.from(old.serialize()).toString("base64"))).rejects.toThrow(FeeChangedError);
    expect(await current.submit(signed)).toMatchObject({ operation: "deposit", state: "submitted" });
    expect(connection.sent).toHaveLength(1);
  });

  it("quotes gross value, fee, net and the fee version from the program's fee quote", async () => {
    const { program, transactions } = await services();
    quoteReturn(program, { sequence: 2, minted: "999800000000000000", proceeds: "0", gross: "1000000", fee: "200", feeVersion: 1 });
    expect(await transactions.quoteDeposit({ owner: wallet.publicKey.toBase58(), toClass: "BTC", amount: "1000000" })).toEqual({
      operation: "deposit", fromClass: null, toClass: "BTC", amount: "1000000", units: null,
      gross: "1000000", fee: "200", net: "999800", mintedUnits: "999800000000000000", proceeds: null,
      feeTerms: { version: "1", bps: 2, cap: "2000000" }, scheduledFees: null, observedSequence: 2, estimate: true,
    });
    quoteReturn(program, { sequence: 2, minted: "0", proceeds: "99998000000", gross: "100000000000", fee: "2000000", feeVersion: 1 });
    expect(await transactions.quoteRedeem({ owner: feeOwner, fromClass: "BTC", units: "1000" })).toMatchObject({ gross: "100000000000", fee: "2000000", net: "99998000000", proceeds: "99998000000", mintedUnits: null });
    quoteReturn(program, { sequence: 2, minted: "1", proceeds: "0", gross: "1000000", fee: "200", feeVersion: 2 });
    await expect(transactions.quoteDeposit({ owner: wallet.publicKey.toBase58(), toClass: "BTC", amount: "1000000" })).rejects.toThrow(FeeChangedError);
    quoteReturn(program, { sequence: 3, minted: "1", proceeds: "0", gross: "1000000", fee: "200", feeVersion: 1 });
    await expect(transactions.quoteDeposit({ owner: wallet.publicKey.toBase58(), toClass: "BTC", amount: "1000000" })).rejects.toThrow("advanced while quoting");
    await expect(transactions.quoteSwitch({ owner: feeOwner, fromClass: "BTC", toClass: "BTC", units: "1" })).rejects.toThrow("must differ");
  });

  it("matches the committed fee-aware response examples for the web app", async () => {
    await seedLog();
    const { source, program, transactions } = await services();
    await source.tick();
    const holder = Keypair.fromSeed(Buffer.alloc(32, 7)).publicKey.toBase58();
    quoteReturn(program, { sequence: 2, minted: "999800000000000000", proceeds: "0", gross: "1000000", fee: "200", feeVersion: 1 });
    const quote = await transactions.quoteDeposit({ owner: holder, toClass: "BTC", amount: "1000000" });
    const { transaction: _transaction, recentBlockhash: _blockhash, ...built } = await transactions.deposit({ owner: holder, toClass: "BTC", amount: "1000000", minimumUnits: "999800000000000000", expiryBatch: 10, expectedFeeVersion: quote.feeTerms.version });
    const examples = {
      schema: "cox.app-api/fee-examples/v1",
      source: "Responses produced by the live source, builders and quote over packages/cox/fixtures/fee-accounts.json (compiled fee-upgrade accounts, synthetic devnet pool). The quote's simulated return mirrors that fixture's committed receipt. Not live market data.",
      status: { fees: (await source.status(120120 + 25)).fees, reconciliation: (await source.status(120120 + 25)).reconciliation },
      publication: (await source.publications()).at(-1),
      portfolio: await source.portfolio(feeOwner),
      quote,
      unsignedDeposit: built,
      feeChangedError: { schemaVersion: "cox.app-api/v1", error: { code: "FEE_CHANGED", message: new FeeChangedError().message } },
    };
    await expect(`${JSON.stringify(examples, null, 2)}\n`).toMatchFileSnapshot("../fixtures/cox-fee-examples.json");
  });

  it("serves quotes over HTTP and answers a changed fee version with FEE_CHANGED", async () => {
    await seedLog();
    const { source, program, transactions, submissions } = await services();
    await source.tick();
    const server = createCoxApiServer({ source, transactions, submissions, now: () => NOW });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = createCoxApiClient({ baseUrl });
    try {
      quoteReturn(program, { sequence: 2, minted: "999800000000000000", proceeds: "0", gross: "1000000", fee: "200", feeVersion: 1 });
      const quote = (await client.quoteDeposit({ owner: wallet.publicKey.toBase58(), toClass: "BTC", amount: "1000000" })).data;
      expect(quote).toMatchObject({ fee: "200", net: "999800", feeTerms: { version: "1" } });
      const built = (await client.buildDeposit({ owner: wallet.publicKey.toBase58(), toClass: "BTC", amount: "1000000", minimumUnits: "0", expiryBatch: 10, expectedFeeVersion: quote.feeTerms.version })).data;
      expect(built.feeTerms).toEqual(quote.feeTerms);
      await expect(client.buildDeposit({ owner: wallet.publicKey.toBase58(), toClass: "BTC", amount: "1000000", minimumUnits: "0", expiryBatch: 10, expectedFeeVersion: "0" })).rejects.toMatchObject({ code: "FEE_CHANGED", httpStatus: 409 });
      expect((await fetch(`${baseUrl}/v1/quotes/deposit`)).status).toBe(405);
      expect((await fetch(`${baseUrl}/v1/quotes/constructor`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
      expect((await client.status()).status.fees).toMatchObject({ migrated: true, committed: "6200" });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
