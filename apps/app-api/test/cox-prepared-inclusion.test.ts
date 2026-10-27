import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addresses, decodeAccount, decodeEpochAccount } from "@cox/client";
import { PublicKey, VersionedTransaction, type AccountInfo, type Connection } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadProgram } from "../src/cox/chain.js";
import { EpochSource } from "../src/cox/epoch-source.js";
import { LiveCoxSource } from "../src/cox/live-source.js";
import { directorySegments } from "../src/cox/publication-history.js";
import { NothingToDoError } from "../src/cox/transactions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const PAYER = "HgC4Jn7XMLzNsDjVdsr1x7BDuGBb2SBvx5TFLSUYaEyU";
const EPOCH_SECONDS = 14_400;

const fixture = JSON.parse(readFileSync(join(root, "packages", "cox", "fixtures", "generation", "prepared-inclusion.json"), "utf8")) as {
  expected: { oldAssets: number; newAssets: number; cryptoClass: number; captureTimestamp: string; handoffTimestamp: string; effectiveFrom: string; frozenEpochAssets: number; successorEpochAssets: number };
  accounts: { address: string; dataHex: string; name: string; owner: string }[];
};
const account = (name: string) => fixture.accounts.find((a) => a.name === name)!;
const key = (name: string) => new PublicKey(account(name).address);

class FixtureConnection {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();

  constructor() {
    for (const a of fixture.accounts) this.set(a.address, new PublicKey(a.owner), Buffer.from(a.dataHex, "hex"));
  }

  set(address: string, owner: PublicKey, data: Buffer): void {
    this.accounts.set(address, { data, owner, executable: false, lamports: 1, rentEpoch: 0 });
  }

  async getAccountInfo(k: PublicKey) {
    return this.accounts.get(k.toBase58()) ?? null;
  }

  async getMultipleAccountsInfo(keys: PublicKey[]) {
    return keys.map((k) => this.accounts.get(k.toBase58()) ?? null);
  }

  async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
    return { context: { slot: 1 }, value: keys.map((k) => this.accounts.get(k.toBase58()) ?? null) };
  }

  async getProgramAccounts(programId: PublicKey) {
    return [...this.accounts.entries()].filter(([, info]) => info.owner.equals(programId)).map(([address, a]) => ({ pubkey: new PublicKey(address), account: a }));
  }

  async getLatestBlockhash() {
    return { blockhash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", lastValidBlockHeight: 99 };
  }

  async simulateTransaction() {
    return { value: { err: null, logs: [] } };
  }
}

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function setup(now: number) {
  dir = mkdtempSync(join(tmpdir(), "cox-prepared-"));
  const connection = new FixtureConnection();
  const basic = loadProgram(connection as unknown as Connection, join(root, "packages", "cox", "idl", "cox.json"));
  const epochProgram = loadProgram(connection as unknown as Connection, join(root, "packages", "cox-epoch", "idl", "epoch.json"));
  const pool = decodeAccount(basic, "pool", connection.accounts.get(key("pool").toBase58())!);
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  connection.set(pool.collateralMint.toBase58(), TOKEN_PROGRAM, mint);
  const token = (owner: PublicKey) => {
    const data = Buffer.alloc(165);
    owner.toBuffer().copy(data, 0);
    return data;
  };
  connection.set(pool.vault.toBase58(), TOKEN_PROGRAM, token(pool.collateralMint));
  if (pool.testCollateralMint) connection.set(addresses(basic.programId).testVault(key("pool")).toBase58(), TOKEN_PROGRAM, token(pool.testCollateralMint));
  const config = decodeEpochAccount(epochProgram, "poolConfig", connection.accounts.get(key("epochConfig").toBase58())!);
  for (const name of ["frozenEpoch", "successorEpoch"]) {
    const round = decodeEpochAccount(epochProgram, "epochAccount", connection.accounts.get(key(name).toBase58())!);
    const pending = BigInt(round.state?.ledger.pendingGross.toString() ?? "0") + BigInt(round.state?.ledger.activeNet.toString() ?? "0") + BigInt(round.state?.ledger.heldFees.toString() ?? "0") + BigInt(round.state?.ledger.claimable.toString() ?? "0") + BigInt(round.state?.ledger.committedFees.toString() ?? "0") + BigInt(round.state?.ledger.residual.toString() ?? "0");
    const vault = token(config.mint);
    vault.writeBigUInt64LE(pending, 64);
    connection.set(round.vault.toBase58(), TOKEN_PROGRAM, vault);
    connection.set(round.testVault.toBase58(), TOKEN_PROGRAM, token(config.testMint ?? config.mint));
  }
  const source = await LiveCoxSource.open({
    connection: connection as unknown as Connection, program: basic, poolId: BigInt(pool.poolId.toString()), network: "solana-devnet", epochConfig: key("epochConfig"),
    history: { path: join(dir, "publications.jsonl"), store: directorySegments(join(dir, "segments")) },
  });
  const epochs = await EpochSource.open({ connection: connection as unknown as Connection, program: epochProgram, config: key("epochConfig"), basic, now: () => now });
  epochs.nameAssets(new Map(source.manifest.assets.flatMap((asset) => (asset.epochId === null ? [] : [[asset.epochId, asset.assetId] as const]))));
  return { connection, basic, epochProgram, source, epochs, pool };
}

const opensAtOf = (epochProgram: ReturnType<typeof loadProgram>, connection: FixtureConnection, name: string): number =>
  Number(decodeEpochAccount(epochProgram, "epochAccount", connection.accounts.get(key(name).toBase58())!).opensAt.toString());

describe("prepared inclusion with schema 2 registry versions", () => {
  it("reads both registry version schemas and the activation interval, which starts after the capture", async () => {
    const { basic, connection } = await setup(Number(fixture.expected.effectiveFrom));
    const next = decodeAccount(basic, "assetRegistryVersion", connection.accounts.get(key("assetRegistryVersion").toBase58())!);
    const previous = decodeAccount(basic, "assetRegistryVersion", connection.accounts.get(key("previousAssetRegistryVersion").toBase58())!);
    expect(next.schemaVersion).toBe(2);
    expect(previous.schemaVersion).toBe(1);
    expect(next.effectiveFrom.toString()).toBe(fixture.expected.effectiveFrom);
    expect(previous.effectiveUntil.toString()).toBe(fixture.expected.effectiveFrom);
    expect(BigInt(fixture.expected.captureTimestamp)).toBeLessThan(BigInt(fixture.expected.effectiveFrom));
    expect(decodeAccount(basic, "universeSchedule", connection.accounts.get(key("universeSchedule").toBase58())!).schemaVersion).toBe(2);
  });

  it("serves the 32-asset market with CRYPTO at class 0 and keeps the 31-asset list for earlier publications", async () => {
    const { source, connection, basic } = await setup(Number(fixture.expected.effectiveFrom));
    await source.tick();
    expect(source.manifest.assets).toHaveLength(fixture.expected.newAssets);
    expect(source.classes[fixture.expected.cryptoClass]).toBe("CRYPTO");
    expect(source.classes).toHaveLength(fixture.expected.newAssets + 1);
    const previous = decodeAccount(basic, "methodology", connection.accounts.get(key("previousMethodology").toBase58())!);
    const roster = await source.methodologyRoster(Buffer.from(previous.digest).toString("hex"));
    expect(roster.assets).toHaveLength(fixture.expected.oldAssets);
    expect(roster.assets).toEqual(source.manifest.assets.slice(0, fixture.expected.oldAssets).map((asset) => asset.assetId));
  });

  it("keeps the frozen 31-asset round on the previous version and the successor on the new one", async () => {
    const { epochs, connection, epochProgram } = await setup(Number(fixture.expected.effectiveFrom));
    const frozen = (await epochs.epoch(opensAtOf(epochProgram, connection, "frozenEpoch")))!;
    const successor = (await epochs.epoch(opensAtOf(epochProgram, connection, "successorEpoch")))!;
    expect(frozen.universe).toHaveLength(fixture.expected.frozenEpochAssets);
    expect(frozen.registry?.version).toBe(key("previousAssetRegistryVersion").toBase58());
    expect(frozen.registry?.originBenchmarks).toHaveLength(fixture.expected.frozenEpochAssets);
    expect(successor.universe).toHaveLength(fixture.expected.successorEpochAssets);
    expect(successor.registry?.version).toBe(key("assetRegistryVersion").toBase58());
    expect(successor.universe.slice(0, fixture.expected.frozenEpochAssets).map((asset) => asset.assetId)).toEqual(frozen.universe.map((asset) => asset.assetId));
    expect(successor.universe.every((asset) => !asset.assetId.startsWith("#"))).toBe(true);
  });

  it("prepares the next round against the version in force at its opening, chosen by effectiveFrom", async () => {
    const { connection, basic, epochProgram } = await setup(0);
    const successorOpensAt = opensAtOf(epochProgram, connection, "successorEpoch");
    const next = successorOpensAt + EPOCH_SECONDS;
    const epochs = await EpochSource.open({ connection: connection as unknown as Connection, program: epochProgram, config: key("epochConfig"), basic, now: () => next + 60 });
    const prepared = await epochs.prepare({ owner: PAYER });
    expect(prepared.opensAt).toBe(next);
    const keys = VersionedTransaction.deserialize(Buffer.from(prepared.transaction.transaction, "base64")).message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys).toContain(key("assetRegistryVersion").toBase58());
    expect(keys).not.toContain(key("previousAssetRegistryVersion").toBase58());
    const sealed = await EpochSource.open({ connection: connection as unknown as Connection, program: epochProgram, config: key("epochConfig"), basic, now: () => successorOpensAt + 60 });
    await expect(sealed.prepare({ owner: PAYER })).rejects.toBeInstanceOf(NothingToDoError);
  });
});
