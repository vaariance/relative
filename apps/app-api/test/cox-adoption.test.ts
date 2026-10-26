import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import anchor from "@coral-xyz/anchor";
import { addresses, decodeAccount, discriminator, dynamicManifestBytes, readDynamicManifest, type Methodology } from "@cox/client";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ChainChangeFeed } from "../src/cox/chain-changes.js";
import { adoptionProblem, loadProgram, parseManifest } from "../src/cox/chain.js";
import { LiveCoxSource, PoolMethodologyRejected } from "../src/cox/live-source.js";
import { directorySegments } from "../src/cox/publication-history.js";
import { CoxTransactions, TradingClosedError, TransactionInputError } from "../src/cox/transactions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const idlPath = join(root, "packages", "cox", "idl", "cox.json");
const EPOCH_CONFIG = new PublicKey("61LyZqtLHzdqDKZ5qsK7c6xU5R9F5HaNbpaX77kRyiq9");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const OWNER = "HgC4Jn7XMLzNsDjVdsr1x7BDuGBb2SBvx5TFLSUYaEyU";
const ADDED = 30;

class AdoptionConnection {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  methodologyReads = 0;

  set(address: string, owner: PublicKey, data: Buffer): void {
    this.accounts.set(address, { data, owner, executable: false, lamports: 1, rentEpoch: 0 });
  }

  async getAccountInfo(key: PublicKey) {
    const info = this.accounts.get(key.toBase58()) ?? null;
    if (info && info.data.subarray(0, 8).equals(discriminator("account", "Methodology"))) this.methodologyReads += 1;
    return info;
  }

  async getLatestBlockhash() {
    return { blockhash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", lastValidBlockHeight: 99 };
  }

  async simulateTransaction() {
    return { context: { slot: 1 }, value: { err: null, logs: [] } };
  }

  async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
    return { context: { slot: 1 }, value: keys.map((k) => this.accounts.get(k.toBase58()) ?? null) };
  }
}

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function encode(coder: anchor.BorshAccountsCoder, name: string, value: object, minimum: number): Buffer {
  const layout = (coder as unknown as { accountLayouts: Map<string, { layout: { encode(value: object, buffer: Buffer): number } }> }).accountLayouts.get(name)!;
  const body = Buffer.alloc(262_144);
  const length = layout.layout.encode(value, body);
  const data = Buffer.alloc(Math.max(minimum, length + 8));
  Buffer.concat([coder.accountDiscriminator(name), body.subarray(0, length)]).copy(data);
  return data;
}

async function setup(feedHealthy: boolean | null = null) {
  dir = mkdtempSync(join(tmpdir(), "cox-adoption-"));
  const fixture = JSON.parse(readFileSync(join(root, "packages", "cox", "fixtures", "generation", "active.json"), "utf8")) as {
    accounts: { address: string; dataHex: string; name: string; owner: string }[];
  };
  const connection = new AdoptionConnection();
  for (const account of fixture.accounts) connection.set(account.address, new PublicKey(account.owner), Buffer.from(account.dataHex, "hex"));
  const program = loadProgram(connection as unknown as Connection, idlPath);
  const coder = program.coder.accounts as anchor.BorshAccountsCoder;
  const poolKey = fixture.accounts.find((a) => a.name === "pool")!.address;
  const pool = decodeAccount(program, "pool", connection.accounts.get(poolKey)!);
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  connection.set(pool.collateralMint.toBase58(), TOKEN_PROGRAM, mint);
  const source = await LiveCoxSource.open({
    connection: connection as unknown as Connection, program, poolId: BigInt(pool.poolId.toString()), network: "solana-devnet", epochConfig: EPOCH_CONFIG,
    history: { path: join(dir, "publications.jsonl"), store: directorySegments(join(dir, "segments")) },
    ...(feedHealthy === null ? {} : { changes: { onChange: () => () => undefined, state: () => ({ healthy: feedHealthy, revision: null, observedAt: null }) } as unknown as ChainChangeFeed }),
  });
  const transactions = new CoxTransactions({
    connection: connection as unknown as Connection, program, poolId: BigInt(pool.poolId.toString()), pool: source.poolAddress, vault: source.vaultAddress, mint: pool.collateralMint,
    origin: source.manifest.origin, interval: source.interval, acceptanceDeadline: source.acceptanceDeadline, classes: source.classes, methodology: source.methodologyAddress, unavailable: () => source.unavailable(), dynamic: source.manifest.dynamic,
  });
  const methodologyKey = source.methodologyAddress;
  const methodology = decodeAccount(program, "methodology", connection.accounts.get(methodologyKey.toBase58())!) as Methodology;
  const current = readDynamicManifest(methodology, new PublicKey(poolKey));

  const grow = (change: (instruments: typeof current.instruments) => typeof current.instruments = (list) => list) => {
    const first = current.instruments[0]!;
    const added = Array.from({ length: ADDED }, (_, i) => ({
      ...first, stableId: `relative:new-${i}`, symbol: `NEW${i}`, classId: current.instruments.length + 1 + i, epochId: current.instruments.length + i,
      pythProFeedId: 900_000 + i, pythCoreFeedId: createHash("sha256").update(`core-${i}`).digest(), tokenMint: null,
    }));
    const instruments = change([...current.instruments, ...added]);
    const bytes = dynamicManifestBytes({
      ...current, version: current.version + 1n, predecessorDigest: Buffer.from(methodology.digest), expectedInstruments: instruments.length,
      capture: { ...current.capture, pricesE8: [...current.capture.pricesE8, ...added.map(() => current.capture.pricesE8[0]!)] }, instruments,
    });
    const digest = createHash("sha256").update(bytes).digest();
    const raw = coder.decode("methodology", connection.accounts.get(methodologyKey.toBase58())!.data);
    const address = addresses(program.programId).methodology(digest);
    connection.set(address.toBase58(), program.programId, encode(coder, "methodology", {
      ...raw, digest: [...digest], canonical: bytes, expectedLength: bytes.length, roster: Buffer.from(instruments.map((_, i) => i)),
    }, 0));
    const rawPool = coder.decode("pool", connection.accounts.get(poolKey)!.data);
    connection.set(poolKey, program.programId, encode(coder, "pool", {
      ...rawPool, methodology: address, classes: [...rawPool.classes, ...Array.from({ length: ADDED }, () => rawPool.classes[1])],
    }, connection.accounts.get(poolKey)!.data.length));
    return { address, digest: digest.toString("hex") };
  };
  return { connection, program, source, transactions, methodologyKey, grow };
}

describe("adopting an asset change without a restart", () => {
  it("adopts 31 to 61 assets in place, once, and keeps every existing class where it was", async () => {
    const { source, connection, grow } = await setup();
    const before = [...source.classes];
    expect(source.manifest.assets).toHaveLength(31);
    const adopted: number[] = [];
    source.onAdopt((manifest) => adopted.push(manifest.assets.length));
    const next = grow();
    const reads = connection.methodologyReads;
    await Promise.all([source.tick(), source.tick(), source.tick()]);
    expect(adopted).toEqual([61]);
    expect(connection.methodologyReads - reads).toBe(1);
    expect(source.manifest.assets).toHaveLength(61);
    expect(source.manifest.digest).toBe(next.digest);
    expect(source.methodologyAddress.equals(next.address)).toBe(true);
    expect(source.classes.slice(0, before.length)).toEqual(before);
    expect(source.classes).toHaveLength(62);
    expect(source.classes[0]).toBe("CRYPTO");
    const status = await source.status(Math.floor(Date.now() / 1000));
    expect(status.chain?.methodology).toEqual({ digest: next.digest, adoption: "current", reason: null });
    expect((await source.deployment()).methodology.assetCount).toBe(61);
  });

  it("keeps the last consistent view and closes trading when the new list changes an existing asset", async () => {
    const { source, grow, transactions } = await setup();
    const digest = source.manifest.digest;
    grow((list) => list.map((asset, i) => (i === 0 ? { ...asset, pythProFeedId: 999_999 } : asset)));
    await expect(source.tick()).rejects.toBeInstanceOf(PoolMethodologyRejected);
    await expect(source.tick()).rejects.toThrow("changes");
    expect(source.manifest.digest).toBe(digest);
    expect(source.manifest.assets).toHaveLength(31);
    const status = await source.status(Math.floor(Date.now() / 1000));
    expect(status.chain?.methodology).toMatchObject({ digest, adoption: "rejected" });
    expect(status.trading).toMatchObject({ open: false, gate: "unavailable" });
    await expect(transactions.quoteDeposit({ owner: OWNER, toClass: source.classes[1]!, amount: "1000000" })).rejects.toThrow("asset list is being updated");
  });

  it("refuses trades between the chain change and the builders' adoption, then accepts the new classes", async () => {
    const { source, grow, transactions } = await setup();
    source.onAdopt((manifest, methodology) => transactions.adopt(methodology, manifest.classes));
    grow();
    const trade = (toClass: string) => transactions.quoteDeposit({ owner: OWNER, toClass, amount: "1000000" });
    await expect(trade("NEW0")).rejects.toBeInstanceOf(TransactionInputError);
    await expect(trade(source.classes[1]!)).rejects.toBeInstanceOf(TradingClosedError);
    await source.tick();
    await expect(trade("NEW0")).rejects.not.toThrow("asset list is being updated");
    await expect(trade("NEW0")).rejects.not.toBeInstanceOf(TransactionInputError);
  });

  it("asks an existing 31-asset position to grow in bounded steps once the pool has 61", async () => {
    const { source, grow, transactions } = await setup();
    source.onAdopt((manifest, methodology) => transactions.adopt(methodology, manifest.classes));
    grow();
    await source.tick();
    const prepared = await transactions.preparePosition({ owner: OWNER });
    expect(prepared.preparation).toMatchObject({ requiredBytes: "8192" });
    expect(Number(prepared.preparation!.bytes)).toBeLessThanOrEqual(8192);
  });
});

describe("a stopped publisher", () => {
  it("is shown as unavailable and delayed, not as an on-chain pause, and new requests are refused", async () => {
    const { source, transactions } = await setup(false);
    await source.tick();
    const status = await source.status(Math.floor(Date.now() / 1000));
    expect(status.chain?.feed).toBe("unhealthy");
    expect(status.trading).toMatchObject({ open: false, gate: "unavailable", lifecycle: "active" });
    expect(status.state).toBe("delayed");
    await expect(transactions.quoteDeposit({ owner: OWNER, toClass: source.classes[1]!, amount: "1000000" })).rejects.toThrow("publisher is not reporting chain changes");
  });

  it("reports the on-chain state again once the change feed is healthy", async () => {
    const { source } = await setup(true);
    await source.tick();
    const status = await source.status(Math.floor(Date.now() / 1000));
    expect(status.trading.gate).not.toBe("unavailable");
    expect(source.unavailable()).toBeNull();
  });
});

describe("append-only adoption rule", () => {
  it("refuses a list that drops, moves or repeats an asset", async () => {
    const { source } = await setup();
    const current = source.manifest;
    const shifted = { ...current, assets: [...current.assets.slice(1), current.assets[0]!] };
    expect(adoptionProblem(current, shifted)).toMatch(/changes|adds no assets/);
    expect(adoptionProblem(current, current)).toBe("the new methodology adds no assets");
    expect(adoptionProblem(current, { ...current, cryptoClass: 5 })).toBe("the new methodology moves CRYPTO");
    expect(typeof parseManifest).toBe("function");
  });
});
