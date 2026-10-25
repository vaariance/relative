import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeAccount } from "@cox/client";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadProgram } from "../src/cox/chain.js";
import { LiveCoxSource } from "../src/cox/live-source.js";
import { directorySegments } from "../src/cox/publication-history.js";
import { CoxTransactions, TradingClosedError } from "../src/cox/transactions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const idlPath = join(root, "packages", "cox", "idl", "cox.json");
const EPOCH_CONFIG = new PublicKey("61LyZqtLHzdqDKZ5qsK7c6xU5R9F5HaNbpaX77kRyiq9");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
type Phase = "preparing" | "active" | "archived";

class GenerationConnection {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();

  set(address: string, owner: PublicKey, data: Buffer): void {
    this.accounts.set(address, { data, owner, executable: false, lamports: 1, rentEpoch: 0 });
  }

  async getAccountInfo(key: PublicKey) {
    return this.accounts.get(key.toBase58()) ?? null;
  }

  async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
    return { context: { slot: 1 }, value: keys.map((k) => this.accounts.get(k.toBase58()) ?? null) };
  }
}

let dir = "";

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function zero(data: Buffer, value: Uint8Array): void {
  const at = data.indexOf(Buffer.from(value));
  if (at < 0 || data.indexOf(Buffer.from(value), at + 1) >= 0) throw new Error("value must occur once");
  data.fill(0, at, at + value.length);
}

async function open(phase: Phase, legacy = false) {
  dir = mkdtempSync(join(tmpdir(), "cox-generation-"));
  const fixture = JSON.parse(readFileSync(join(root, "packages", "cox", "fixtures", "generation", `${phase}.json`), "utf8")) as {
    accounts: { address: string; dataHex: string; name: string; owner: string }[];
  };
  const connection = new GenerationConnection();
  for (const account of fixture.accounts) connection.set(account.address, new PublicKey(account.owner), Buffer.from(account.dataHex, "hex"));
  const program = loadProgram(connection as unknown as Connection, idlPath);
  const poolKey = fixture.accounts.find((a) => a.name === "pool")!.address;
  const fresh = decodeAccount(program, "pool", connection.accounts.get(poolKey)!);
  if (legacy) {
    const data = connection.accounts.get(poolKey)!.data;
    zero(data, Uint8Array.from(fresh.generation));
    zero(data, fresh.assetRegistry.toBytes());
  }
  const pool = decodeAccount(program, "pool", connection.accounts.get(poolKey)!);
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  connection.set(pool.collateralMint.toBase58(), TOKEN_PROGRAM, mint);
  const source = await LiveCoxSource.open({
    connection: connection as unknown as Connection, program, poolId: BigInt(pool.poolId.toString()), network: "solana-devnet", epochConfig: EPOCH_CONFIG,
    history: { path: join(dir, "publications.jsonl"), store: directorySegments(join(dir, "segments")) },
  });
  return { source, pool, poolKey, connection, program };
}

describe("fresh market generations", () => {
  it("puts CRYPTO at class 0 and reports the generation, its registry and the composite key", async () => {
    const { source, pool, poolKey } = await open("active");
    const deployment = await source.deployment();
    expect(deployment.cryptoClass).toBe(0);
    expect(source.classes[0]).toBe("CRYPTO");
    expect(source.classes).toHaveLength(32);
    expect(source.classes[31]).toBe(source.manifest.assets.at(-1)!.assetId);
    const id = Buffer.from(pool.generation).toString("hex");
    expect(deployment.generation).toEqual({
      id, assetRegistry: pool.assetRegistry.toBase58(), epochConfig: EPOCH_CONFIG.toBase58(),
      key: [id, pool.assetRegistry.toBase58(), poolKey, EPOCH_CONFIG.toBase58()].join(":"),
    });
  });

  it.each([["preparing", "preparing"], ["active", "active"], ["archived", "archived"]] as const)("reads the %s lifecycle apart from the pause", async (phase, lifecycle) => {
    const { source } = await open(phase);
    await source.tick();
    const status = await source.status(Math.floor(Date.now() / 1000));
    expect(status.trading.lifecycle).toBe(lifecycle);
    if (lifecycle !== "active") expect(status.trading).toMatchObject({ open: false, gate: lifecycle });
  });

  it.each(["preparing", "archived"] as const)("refuses new trades on a %s market", async (phase) => {
    const { source, pool, connection, program } = await open(phase);
    const transactions = new CoxTransactions({
      connection: connection as unknown as Connection, program, poolId: BigInt(pool.poolId.toString()), pool: source.poolAddress, vault: source.vaultAddress, mint: pool.collateralMint,
      origin: source.manifest.origin, interval: source.interval, acceptanceDeadline: source.acceptanceDeadline, classes: source.classes, dynamic: source.manifest.dynamic,
    });
    await expect(transactions.deposit({ owner: "HgC4Jn7XMLzNsDjVdsr1x7BDuGBb2SBvx5TFLSUYaEyU", toClass: "CRYPTO", amount: "1000000", minimumUnits: "0", expiryBatch: Math.floor(Date.now() / 1000) - source.manifest.origin + 5, expectedFeeVersion: pool.feeVersion.toString() }))
      .rejects.toBeInstanceOf(TradingClosedError);
  });
  it("reads a legacy pool archived in place, with a lifecycle but no generation, as legacy and archived", async () => {
    const { source } = await open("archived", true);
    expect((await source.deployment()).generation).toBeNull();
    await source.tick();
    expect((await source.status(Math.floor(Date.now() / 1000))).trading).toMatchObject({ open: false, gate: "archived", lifecycle: "archived" });
  });
});
