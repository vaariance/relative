import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import anchor from "@coral-xyz/anchor";
import { discriminator, epochAddresses } from "@cox/client";
import { Keypair, PublicKey, VersionedTransaction, type AccountInfo, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { loadProgram } from "../src/cox/chain.js";
import { EpochSource } from "../src/cox/epoch-source.js";
import { FileSubmissionStore } from "../src/cox/submission-store.js";
import { CoxSubmissions } from "../src/cox/submissions.js";
import { TradingClosedError, TransactionInputError, associatedTokenAddress } from "../src/cox/transactions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const idlPath = join(root, "packages", "cox-epoch", "idl", "epoch.json");
const PROGRAM = new PublicKey("4RRBbmzExtPDMYNUgCaetfz3wNYkF2mrAYKZVY4iXz2w");
const ADMIN = new PublicKey("4rCo36GY63kyZpCae2ccfhJEk3TLqKMybhT42YhCPp9N");
const OPERATOR = new PublicKey("GNmM11ZMFqEu3FYewGNDunpSSJBw8KnkDxzCGpSbpGj6");
const MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const TEST_MINT = new PublicKey("5rpGrekfBLHdF8PD8eKLzXQPPmhyF7FCKeE1VA5CwV3X");
const OPEN = 1_792_670_400;
const DRAFT = OPEN + 14_400;
const ASSETS = ["BTC", "ETH", "SOL", "XRP", "BNB", "TRX", "AVAX", "DOT", "NEAR", "SUI", "APT", "UNI", "ARB", "OP", "INJ", "AAVE", "ZEC", "STRK", "HYPE", "TAO", "WLD", "ONDO", "ENA", "ZRO", "FET", "JUP", "AERO", "RENDER", "TIA", "W"];
const bn = (value: number | bigint | string) => new anchor.BN(value.toString());
const pdas = epochAddresses(PROGRAM);
const config = pdas.config(ADMIN, 2n);

class EpochConnection {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  simulated: VersionedTransaction | null = null;

  set(address: PublicKey, data: Buffer, owner = PROGRAM): void {
    this.accounts.set(address.toBase58(), { data, owner, executable: false, lamports: 1 });
  }

  async getAccountInfo(address: PublicKey) {
    return this.accounts.get(address.toBase58()) ?? null;
  }

  async getMultipleAccountsInfo(addresses: PublicKey[]) {
    return addresses.map((a) => this.accounts.get(a.toBase58()) ?? null);
  }

  async getProgramAccounts(program: PublicKey, options: { dataSlice?: { offset: number; length: number }; filters: { memcmp: { offset: number; bytes: string } }[] }) {
    return [...this.accounts.entries()]
      .filter(([, info]) => info.owner.equals(program))
      .filter(([, info]) => options.filters.every(({ memcmp }) => {
        const wanted = Buffer.from(anchor.utils.bytes.bs58.decode(memcmp.bytes));
        return info.data.subarray(memcmp.offset, memcmp.offset + wanted.length).equals(wanted);
      }))
      .map(([address, info]) => ({
        pubkey: new PublicKey(address),
        account: { ...info, data: options.dataSlice ? info.data.subarray(options.dataSlice.offset, options.dataSlice.offset + options.dataSlice.length) : info.data },
      }));
  }

  async getLatestBlockhash() {
    return { blockhash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", lastValidBlockHeight: 99 };
  }

  async simulateTransaction(transaction: VersionedTransaction) {
    this.simulated = transaction;
    return { value: { err: null, logs: [] } };
  }
}

function encodeLarge(coder: anchor.BorshAccountsCoder, name: string, value: object): Buffer {
  const entry = (coder as unknown as { accountLayouts: Map<string, { layout: { encode(value: object, buffer: Buffer): number } }> }).accountLayouts.get(name);
  if (!entry) throw new Error(`unknown account ${name}`);
  const buffer = Buffer.alloc(65_536);
  const length = entry.layout.encode(value, buffer);
  return Buffer.concat([coder.accountDiscriminator(name), buffer.subarray(0, length)]);
}

function token(mint: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

async function setup(now: number) {
  const connection = new EpochConnection();
  const program = loadProgram(connection as unknown as Connection, idlPath);
  const coder = program.coder.accounts as anchor.BorshAccountsCoder;
  const universe = ASSETS.map((_, id) => ({ id, feedId: Array(32).fill(id + 1), originPrice: bn(1_000_000 + id) }));
  const configValue = {
    pool: Array(32).fill(1), admin: [...ADMIN.toBytes()], operator: [...OPERATOR.toBytes()], collateralMint: [...MINT.toBytes()], collateralDecimals: 6,
    methodology: Array(32).fill(4), originBenchmark: bn("100000000000000"), maxEntryPriceAge: bn(5), maxLots: 4096,
  };
  const ledger = { pendingGross: bn(3_000_000), activeNet: bn(0), heldFees: bn(0), claimable: bn(1_500_000), committedFees: bn(600), residual: bn(0) };
  const state = {
    config: configValue, opensAt: bn(OPEN), closesAt: bn(OPEN + 14_400), universe, phase: { open: {} }, nextNonce: bn(2), executedLots: 1, scoredLots: 0, allocatedLots: 0,
    totalWeight: bn(0), settlementPot: bn(0), allZero: false, closingSnapshot: null, closingReferences: [], lastEntrySnapshot: null, ledger,
  };
  connection.set(config, Buffer.from(await coder.encode("poolConfig", {
    admin: ADMIN, configId: bn(2), operator: OPERATOR, mint: MINT, testMint: TEST_MINT, methodology: Array(32).fill(4), originBenchmark: bn("100000000000000"), maxEntryPriceAge: bn(5), maxLots: 4096, bump: 254,
  })));
  const sealed = pdas.epoch({ config, opensAt: BigInt(OPEN) });
  const draft = pdas.epoch({ config, opensAt: BigInt(DRAFT) });
  const encodeEpoch = async (address: PublicKey, opensAt: number, value: object | null) => {
    connection.set(address, encodeLarge(coder, "epochAccount", { config, opensAt: bn(opensAt), vault: pdas.vault(address), testVault: pdas.testVault(address), bump: 250, universe: value ? [] : universe, state: value }));
  };
  return { connection, program, coder, sealed, draft, encodeEpoch, state, configValue, now, universe };
}

async function lotBytes(coder: anchor.BorshAccountsCoder, epoch: PublicKey, nonce: number, owner: PublicKey, state: object): Promise<Buffer> {
  return Buffer.from(await coder.encode("lotAccount", {
    epoch, nonce: bn(nonce), bump: 255,
    state: { pool: Array(32).fill(1), epoch: bn(OPEN), nonce: bn(nonce), owner: [...owner.toBytes()], grossStake: bn(2_000_000), fee: bn(400), admittedAt: bn(OPEN + 30), basket: ASSETS.map((_, i) => i), backedAsset: 2, execution: null, state },
  }));
}

describe("Epoch reads", () => {
  it("lists sealed and draft epochs for the configuration with their ledger and vault coverage", async () => {
    const t = await setup(OPEN + 60);
    await t.encodeEpoch(t.sealed, OPEN, t.state);
    await t.encodeEpoch(t.draft, DRAFT, null);
    t.connection.set(pdas.vault(t.sealed), token(MINT, 4_000_000n), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
    t.connection.set(pdas.testVault(t.sealed), token(TEST_MINT, 500_600n), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
    const source = await EpochSource.open({ connection: t.connection as unknown as Connection, program: t.program, config, now: () => t.now });
    const overview = await source.overview();
    expect(overview.configuration).toMatchObject({ configId: "2", collateralMint: MINT.toBase58(), secondaryCollateralMint: TEST_MINT.toBase58(), maxLots: 4096, entryFee: { bps: 2, cap: "200000" } });
    expect(overview.epochs.map((e) => [e.opensAt, e.phase, e.sealed, e.entriesOpen])).toEqual([[OPEN, "open", true, true], [DRAFT, "draft", false, false]]);
    expect(overview.epochs[0]).toMatchObject({ nextNonce: "2", lots: { executed: 1, scored: 0, allocated: 0 }, ledger: { liabilities: "4500600", vault: "4500600", covered: true } });
    expect(overview.epochs[0]!.universe[29]).toEqual({ id: 29, assetId: "W", originPrice: "1000029" });
  });

  it("finds a wallet's lots by the owner bytes inside the lot and reads claimable amounts", async () => {
    const t = await setup(OPEN + 60);
    await t.encodeEpoch(t.sealed, OPEN, t.state);
    const wallet = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    const mine = await lotBytes(t.coder, t.sealed, 0, wallet, { claimable: { amount: bn(1_500_000) } });
    expect(mine.subarray(98, 130).equals(wallet.toBuffer())).toBe(true);
    expect(mine.subarray(0, 8).equals(discriminator("account", "LotAccount"))).toBe(true);
    t.connection.set(pdas.lot(t.sealed, 0n), mine);
    t.connection.set(pdas.lot(t.sealed, 1n), await lotBytes(t.coder, t.sealed, 1, other, { pending: {} }));
    const source = await EpochSource.open({ connection: t.connection as unknown as Connection, program: t.program, config, now: () => t.now });
    const lots = await source.lots(OPEN, wallet.toBase58());
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ nonce: "0", owner: wallet.toBase58(), grossStake: "2000000", fee: "400", backedAsset: "SOL", state: "claimable", claimable: "1500000", score: null });
    expect(lots[0]!.basket).toEqual(ASSETS);
  });
});

describe("Epoch transactions", () => {
  it("builds an entry for the next lot nonce from the chosen collateral, and refuses drafts, bad baskets and closed windows", async () => {
    const t = await setup(OPEN + 60);
    await t.encodeEpoch(t.sealed, OPEN, t.state);
    await t.encodeEpoch(t.draft, DRAFT, null);
    const wallet = Keypair.generate().publicKey;
    const source = await EpochSource.open({ connection: t.connection as unknown as Connection, program: t.program, config, now: () => t.now });
    const input = { owner: wallet.toBase58(), opensAt: OPEN, grossStake: "1000000", basket: ASSETS, backedAsset: "SOL", collateralMint: TEST_MINT.toBase58() };
    const built = await source.entry(input);
    expect(built).toMatchObject({ operation: "epoch-entry", owner: wallet.toBase58(), nonce: "2", requestId: pdas.lot(t.sealed, 2n).toBase58(), amount: "1000000" });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
    const keys = tx.message.staticAccountKeys;
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(keys[0]!.equals(wallet)).toBe(true);
    const [instruction] = tx.message.compiledInstructions;
    expect(keys[instruction!.programIdIndex]!.equals(PROGRAM)).toBe(true);
    expect(Buffer.from(instruction!.data).subarray(0, 8).equals(discriminator("global", "queue"))).toBe(true);
    expect(instruction!.accountKeyIndexes.map((i) => keys[i]!.toBase58())).toContain(associatedTokenAddress(wallet, TEST_MINT).toBase58());
    await expect(source.entry({ ...input, opensAt: DRAFT })).rejects.toThrow(TradingClosedError);
    await expect(source.entry({ ...input, basket: [...ASSETS.slice(1), "BTC"].map((a, i) => (i === 0 ? "BTC" : a)) })).rejects.toThrow("must not repeat");
    await expect(source.entry({ ...input, basket: ASSETS.slice(1) })).rejects.toThrow(TransactionInputError);
    await expect(source.entry({ ...input, backedAsset: "DOGE" })).rejects.toThrow("backedAsset");
    await expect(source.entry({ ...input, collateralMint: Keypair.generate().publicKey.toBase58() })).rejects.toThrow("collateral mints");
    await expect(source.entry({ ...input, opensAt: OPEN + 1 })).rejects.toThrow("multiple of 14400");
    t.now = OPEN + 14_400;
    await expect(source.entry(input)).rejects.toThrow("not accepting entries");
  });

  it("reports refunds and builds one refund-and-withdraw transaction for an entry that never executed or a voided round", async () => {
    const t = await setup(OPEN + 14_400 + 60);
    await t.encodeEpoch(t.sealed, OPEN, t.state);
    t.connection.set(pdas.vault(t.sealed), token(MINT, 4_000_000n), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
    t.connection.set(pdas.testVault(t.sealed), token(TEST_MINT, 500_600n), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
    const wallet = Keypair.generate().publicKey;
    t.connection.set(pdas.lot(t.sealed, 0n), await lotBytes(t.coder, t.sealed, 0, wallet, { pending: {} }));
    t.connection.set(pdas.lot(t.sealed, 1n), await lotBytes(t.coder, t.sealed, 1, wallet, { executed: {} }));
    const source = await EpochSource.open({ connection: t.connection as unknown as Connection, program: t.program, config, now: () => t.now });
    const epoch = (await source.epoch(OPEN))!;
    expect(epoch).toMatchObject({ phase: "open", closingDeadline: OPEN + 14_400 + 86_400, voidable: false });
    expect((await source.lots(OPEN, wallet.toBase58())).map((lot) => [lot.nonce, lot.refund])).toEqual([["0", "not-executed"], ["1", null]]);
    const built = await source.refund({ owner: wallet.toBase58(), opensAt: OPEN, nonce: "0" });
    expect(built).toMatchObject({ operation: "epoch-refund", nonce: "0", amount: "2000000", requestId: pdas.lot(t.sealed, 0n).toBase58() });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
    const data = tx.message.compiledInstructions.map((i) => Buffer.from(i.data).subarray(0, 8));
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(tx.message.staticAccountKeys[0]!.equals(wallet)).toBe(true);
    expect(data[1]!.equals(discriminator("global", "refund"))).toBe(true);
    expect(data[2]!.equals(discriminator("global", "withdraw"))).toBe(true);
    await expect(source.refund({ owner: wallet.toBase58(), opensAt: OPEN, nonce: "1" })).rejects.toThrow("cannot be refunded");
    t.now = OPEN + 14_400 + 86_401;
    expect((await source.epoch(OPEN))!.voidable).toBe(true);
    await t.encodeEpoch(t.sealed, OPEN, { ...t.state, phase: { voided: {} } });
    source.invalidate();
    expect((await source.lots(OPEN, wallet.toBase58())).map((lot) => lot.refund)).toEqual(["not-executed", "voided"]);
    expect((await source.epoch(OPEN))!.voidable).toBe(false);
  });

  it("builds a full or partial withdrawal only for the owner's claimable lot", async () => {
    const t = await setup(OPEN + 20_000);
    await t.encodeEpoch(t.sealed, OPEN, t.state);
    const wallet = Keypair.generate().publicKey;
    t.connection.set(pdas.lot(t.sealed, 0n), await lotBytes(t.coder, t.sealed, 0, wallet, { claimable: { amount: bn(1_500_000) } }));
    t.connection.set(pdas.lot(t.sealed, 1n), await lotBytes(t.coder, t.sealed, 1, wallet, { executed: {} }));
    const source = await EpochSource.open({ connection: t.connection as unknown as Connection, program: t.program, config, now: () => t.now });
    const full = await source.withdraw({ owner: wallet.toBase58(), opensAt: OPEN, nonce: "0" });
    expect(full).toMatchObject({ operation: "epoch-withdraw", amount: "1500000", nonce: "0" });
    const tx = VersionedTransaction.deserialize(Buffer.from(full.transaction, "base64"));
    const programs = tx.message.compiledInstructions.map((i) => tx.message.staticAccountKeys[i.programIdIndex]!.toBase58());
    expect(programs).toEqual(["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", PROGRAM.toBase58()]);
    expect(Buffer.from(tx.message.compiledInstructions[1]!.data).subarray(0, 8).equals(discriminator("global", "withdraw"))).toBe(true);
    const partial = await source.withdraw({ owner: wallet.toBase58(), opensAt: OPEN, nonce: "0", amount: "500000" });
    expect(partial.amount).toBe("500000");
    await expect(source.withdraw({ owner: wallet.toBase58(), opensAt: OPEN, nonce: "1" })).rejects.toThrow("nothing to withdraw");
    await expect(source.withdraw({ owner: Keypair.generate().publicKey.toBase58(), opensAt: OPEN, nonce: "0" })).rejects.toThrow("EpochLotIdentityMismatch");
  });
});

describe("Epoch submissions", () => {
  it("relays a wallet-signed Epoch entry only when the deployment serves that Epoch program", async () => {
    const t = await setup(OPEN + 60);
    await t.encodeEpoch(t.sealed, OPEN, t.state);
    const wallet = Keypair.generate();
    const source = await EpochSource.open({ connection: t.connection as unknown as Connection, program: t.program, config, now: () => t.now });
    const built = await source.entry({ owner: wallet.publicKey.toBase58(), opensAt: OPEN, grossStake: "1000000", basket: ASSETS, backedAsset: "BTC" });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
    tx.sign([wallet]);
    const signed = Buffer.from(tx.serialize()).toString("base64");
    const dir = mkdtempSync(join(tmpdir(), "cox-epoch-"));
    const relay = { sendRawTransaction: async () => anchor.utils.bytes.bs58.encode(tx.signatures[0]!) };
    try {
      const options = { connection: relay as unknown as Connection, programId: new PublicKey("G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF"), feeVersion: async () => 0n, now: () => t.now };
      const without = new CoxSubmissions({ ...options, store: new FileSubmissionStore(join(dir, "a.json")) });
      await expect(without.submit(signed)).rejects.toThrow("outside COX");
      const withEpoch = new CoxSubmissions({ ...options, epochProgramId: PROGRAM, store: new FileSubmissionStore(join(dir, "b.json")) });
      expect(await withEpoch.submit(signed)).toMatchObject({ operation: "epoch-entry", owner: wallet.publicKey.toBase58(), state: "submitted" });
      t.now = OPEN + 14_400 + 60;
      t.connection.set(pdas.lot(t.sealed, 0n), await lotBytes(t.coder, t.sealed, 0, wallet.publicKey, { pending: {} }));
      const refund = VersionedTransaction.deserialize(Buffer.from((await source.refund({ owner: wallet.publicKey.toBase58(), opensAt: OPEN, nonce: "0" })).transaction, "base64"));
      refund.sign([wallet]);
      relay.sendRawTransaction = async () => anchor.utils.bytes.bs58.encode(refund.signatures[0]!);
      expect(await withEpoch.submit(Buffer.from(refund.serialize()).toString("base64"))).toMatchObject({ operation: "epoch-refund", owner: wallet.publicKey.toBase58() });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
