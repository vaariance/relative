import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEpochAccount, type EpochRoundAccount } from "@cox/client";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { loadProgram } from "../src/cox/chain.js";
import { EpochSource } from "../src/cox/epoch-source.js";
import { TradingClosedError } from "../src/cox/transactions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const WALLET = "AfXvGQpYcZwc7MWBPw9HW7TRsMXx4bL6sqbU6huxQYsN";
const PAYER = "HgC4Jn7XMLzNsDjVdsr1x7BDuGBb2SBvx5TFLSUYaEyU";

interface Fixture {
  accounts: { address: string; dataHex: string; name: string; owner: string }[];
  expected: Record<string, unknown>;
  unixTimestamp: number;
}

class FixtureConnection {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();

  set(address: string, owner: PublicKey, data: Buffer): void {
    this.accounts.set(address, { data, owner, executable: false, lamports: 1, rentEpoch: 0 });
  }

  async getAccountInfo(key: PublicKey) {
    return this.accounts.get(key.toBase58()) ?? null;
  }

  async getMultipleAccountsInfo(keys: PublicKey[]) {
    return keys.map((k) => this.accounts.get(k.toBase58()) ?? null);
  }

  async getLatestBlockhash() {
    return { blockhash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", lastValidBlockHeight: 99 };
  }

  async simulateTransaction() {
    return { value: { err: null, logs: [] } };
  }
}

function token(mint: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

function read(name: string): Fixture {
  return JSON.parse(readFileSync(join(root, "packages", "cox-epoch", "fixtures", "generation", `${name}.json`), "utf8")) as Fixture;
}

function configBytes(name: string): { address: string; owner: PublicKey; data: Buffer } {
  const account = read(name).accounts.find((a) => a.name === "config")!;
  return { address: account.address, owner: new PublicKey(account.owner), data: Buffer.from(account.dataHex, "hex") };
}

async function load(name: string, configFrom?: string) {
  const fixture = read(name);
  const connection = new FixtureConnection();
  for (const account of fixture.accounts) connection.set(account.address, new PublicKey(account.owner), Buffer.from(account.dataHex, "hex"));
  if (configFrom) {
    const replaced = configBytes(configFrom);
    connection.set(replaced.address, replaced.owner, replaced.data);
  }
  const program = loadProgram(connection as unknown as Connection, join(root, "packages", "cox-epoch", "idl", "epoch.json"));
  const basic = loadProgram(connection as unknown as Connection, join(root, "packages", "cox", "idl", "cox.json"));
  const config = new PublicKey(fixture.accounts.find((a) => a.name === "config")!.address);
  const configAccount = decodeEpochAccount(program, "poolConfig", connection.accounts.get(config.toBase58())!);
  const rounds = new Map<string, EpochRoundAccount>();
  for (const account of fixture.accounts.filter((a) => a.name === "epoch" || a.name === "predecessorEpoch")) {
    const round = decodeEpochAccount(program, "epochAccount", connection.accounts.get(account.address)!);
    rounds.set(account.name, round);
    if (round.state) {
      connection.set(round.vault.toBase58(), TOKEN_PROGRAM, token(configAccount.mint, 0n));
      connection.set(round.testVault.toBase58(), TOKEN_PROGRAM, token(configAccount.testMint ?? configAccount.mint, BigInt(round.state.ledger.pendingGross.toString())));
    }
  }
  const source = await EpochSource.open({ connection: connection as unknown as Connection, program, config, basic, now: () => fixture.unixTimestamp });
  source.nameAssets(new Map(Array.from({ length: 256 }, (_, id) => [id, `A${id}`] as const)));
  const opensAt = (key: string) => Number(rounds.get(key)!.opensAt.toString());
  return { fixture, connection, source, rounds, opensAt, expected: fixture.expected };
}

describe("Epoch generation fixtures", () => {
  it("preparing: reads a registry-bound configuration as preparing and prepares no round", async () => {
    const { source, expected } = await load("preparing");
    expect(expected.lifecycle).toBe("Preparing");
    expect(source.configuration()).toMatchObject({ lifecycle: "preparing" });
    expect(source.configuration().assetRegistry).not.toBeNull();
    await expect(source.prepare({ owner: PAYER })).rejects.toBeInstanceOf(TradingClosedError);
  });

  it("active: reads the sealed round with its frozen registry version and roster", async () => {
    const { source, opensAt, expected, rounds } = await load("active");
    expect(source.configuration().lifecycle).toBe("active");
    const epoch = (await source.epoch(opensAt("epoch")))!;
    expect(epoch).toMatchObject({ sealed: expected.sealed, phase: "open", terminal: false });
    expect(epoch.universe).toHaveLength(expected.frozenAssets as number);
    expect(epoch.registry?.version).toBe(rounds.get("epoch")!.registryVersion.toBase58());
    expect(epoch.registry?.originBenchmarks).toHaveLength(expected.frozenAssets as number);
    expect(epoch.registry?.scale).toBe("1000000000000");
  });

  it("archived: an archived configuration with an empty terminal draft", async () => {
    const { source, opensAt, expected } = await load("archived");
    expect(source.configuration().lifecycle).toBe("archived");
    expect(expected.statePresent).toBe(false);
    expect((await source.epoch(opensAt("epoch")))!).toMatchObject({ phase: "empty", sealed: false, terminal: true, voidable: false, entriesOpen: false });
  });

  it("sealed-frozen-31: keeps the round's 31-asset version although the registry moved to 32", async () => {
    const { source, opensAt, expected, rounds, fixture } = await load("sealed-frozen-31");
    const epoch = (await source.epoch(opensAt("epoch")))!;
    expect(epoch.universe).toHaveLength(expected.frozenAssets as number);
    expect(epoch.registry?.originBenchmarks).toHaveLength(31);
    const frozen = fixture.accounts.find((a) => a.name === "assetRegistryVersion")!.address;
    const active = fixture.accounts.find((a) => a.name === "activeAssetRegistryVersion")!.address;
    expect(epoch.registry?.version).toBe(frozen);
    expect(epoch.registry?.version).not.toBe(active);
    expect(rounds.get("epoch")!.registryVersion.toBase58()).toBe(frozen);
    expect(epoch).toMatchObject({ sealed: true, terminal: false });
  });

  it("successor-32: a sealed successor with 32 assets while its predecessor is still open", async () => {
    const { source, opensAt, expected } = await load("successor-32");
    const successor = (await source.epoch(opensAt("epoch")))!;
    expect(successor.universe).toHaveLength(expected.frozenAssets as number);
    expect(successor.registry?.originBenchmarks.at(-1)?.benchmark).toBe(expected.newAssetOriginBenchmark);
    expect(successor.ledger?.pendingGross).toBe(String(expected.pendingGross));
    expect(successor.sealed).toBe(true);
    const predecessor = (await source.epoch(opensAt("predecessorEpoch")))!;
    expect(predecessor.phase).toBe("open");
    expect(opensAt("predecessorEpoch")).toBeLessThan(opensAt("epoch"));
  });

  it("empty-terminal-draft: an empty round that was never sealed is terminal", async () => {
    const { source, opensAt, expected } = await load("empty-terminal-draft");
    const epoch = (await source.epoch(opensAt("epoch")))!;
    expect(epoch.universe).toHaveLength(expected.draftAssets as number);
    expect(epoch).toMatchObject({ phase: "empty", sealed: false, terminal: true, voidable: false });
  });

  it("empty-terminal-sealed: an empty sealed round is terminal, not settled", async () => {
    const { source, opensAt, expected } = await load("empty-terminal-sealed");
    const epoch = (await source.epoch(opensAt("epoch")))!;
    expect(expected.phase).toBe("Settled");
    expect(epoch.universe).toHaveLength(expected.frozenAssets as number);
    expect(epoch).toMatchObject({ phase: "empty", sealed: true, terminal: true, voidable: false, entriesOpen: false });
  });

  it("legacy-dirty-padding: older accounts with leftover tail bytes read as legacy and active", async () => {
    const { source, opensAt, expected } = await load("legacy-dirty-padding");
    expect(source.configuration()).toMatchObject({ lifecycle: "active", assetRegistry: null });
    const epoch = (await source.epoch(opensAt("epoch")))!;
    expect(expected.bindingVersion).toBe(0);
    expect(epoch.universe).toHaveLength(expected.frozenAssets as number);
    expect(epoch).toMatchObject({ sealed: true, registry: null });
  });
  it("lifecycle change: an invalidation reloads the configuration and closes admission", async () => {
    const { source, connection, opensAt } = await load("active");
    expect(source.configuration().lifecycle).toBe("active");
    expect((await source.epoch(opensAt("epoch")))!.entriesOpen).toBe(true);
    for (const [name, lifecycle] of [["archived", "archived"], ["preparing", "preparing"]] as const) {
      const replaced = configBytes(name);
      connection.set(replaced.address, replaced.owner, replaced.data);
      await source.invalidate();
      expect(source.configuration().lifecycle).toBe(lifecycle);
      expect((await source.epoch(opensAt("epoch")))!).toMatchObject({ phase: "open", entriesOpen: false });
    }
  });

  it("archived configuration: an otherwise open round takes no entries", async () => {
    const { source, opensAt, rounds } = await load("active", "archived");
    expect(source.configuration().lifecycle).toBe("archived");
    const epoch = (await source.epoch(opensAt("epoch")))!;
    expect(epoch).toMatchObject({ phase: "open", entriesOpen: false, terminal: false });
    const basket = epoch.universe.slice(0, 30).map((asset) => asset.assetId);
    expect(rounds.get("epoch")!.state).not.toBeNull();
    await expect(source.entry({ owner: WALLET, opensAt: opensAt("epoch"), basket, backedAsset: basket[0]!, grossStake: "1000000" })).rejects.toBeInstanceOf(TradingClosedError);
  });
});
