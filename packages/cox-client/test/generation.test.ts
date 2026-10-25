import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import anchor, { type Idl } from "@coral-xyz/anchor";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountInfo, type Connection } from "@solana/web3.js";
import { CoxInstructions } from "../src/builders.ts";
import { CoxReader, decodeAccount } from "../src/readers.ts";
import { readDynamicManifest } from "../src/dynamic.ts";
import { marketLifecycle } from "../src/lifecycle.ts";
import type { Accounts } from "../src/accounts.ts";
import { CoxSwapSdk } from "../src/swap.ts";

interface Fixture { programAddress: string; accounts: { name: string; address: string; owner: string; dataHex: string }[] }
const idl = JSON.parse(readFileSync(new URL("../../cox/idl/cox.json", import.meta.url), "utf8")) as Idl;
test("captured legacy pool ignores dirty padding and retains class 30 and financial state", () => {
  const row = JSON.parse(readFileSync(new URL("../../cox/fixtures/generation/legacy-pool-dirty-padding.json", import.meta.url), "utf8")) as { owner: string; dataHex: string };
  const program = new anchor.Program(idl, { connection: {} as Connection });
  const data = Buffer.from(row.dataHex, "hex");
  for (const bytes of [data, data.subarray(0, 2180)]) {
    const pool = decodeAccount(program, "pool", { owner: new PublicKey(row.owner), data: bytes, executable: false, lamports: 1, rentEpoch: 0 });
    assert.equal(pool.poolId.toString(), "2");
    assert.equal(pool.classes.length, 32);
    assert.equal(pool.lifecycleVersion, 0);
    assert.equal(pool.cryptoClass, 30);
    assert.equal(marketLifecycle(pool), "active");
    assert.ok(pool.assetRegistry.equals(PublicKey.default));
    assert.ok(pool.generation.every(value => value === 0));
  }
});
test("marked lifecycle extensions reject unknown versions, invalid states and truncated payloads", () => {
  const f = setup("active"), row = f.fixture.accounts.find(row => row.name === "pool")!;
  const info = f.rows.get(row.address)!;
  const offset = info.data.indexOf(Buffer.from("RLPOOL01"));
  assert.ok(offset > 0);
  const version = Buffer.from(info.data); version[offset + 8] = 2;
  assert.throws(() => decodeAccount(f.program, "pool", { ...info, data: version }), /UnsupportedLifecycleVersion/);
  const state = Buffer.from(info.data); state[offset + 9] = 255;
  assert.throws(() => decodeAccount(f.program, "pool", { ...info, data: state }));
  assert.throws(() => decodeAccount(f.program, "pool", { ...info, data: info.data.subarray(0, offset + 10) }));
});
function setup(phase: string) {
  const fixture = JSON.parse(readFileSync(new URL(`../../cox/fixtures/generation/${phase}.json`, import.meta.url), "utf8")) as Fixture;
  const rows = new Map<string, AccountInfo<Buffer>>(fixture.accounts.map(row => [row.address, { owner: new PublicKey(row.owner), data: Buffer.from(row.dataHex, "hex"), executable: false, lamports: 1, rentEpoch: 0 }]));
  const connection = {
    getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    getAccountInfo: async (key: PublicKey) => rows.get(key.toBase58()) ?? null,
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({ context: { slot: 100 }, value: keys.map(key => rows.get(key.toBase58()) ?? null) }),
  } as unknown as Connection;
  const program = new anchor.Program(idl, { connection }), builder = new CoxInstructions(program), reader = new CoxReader(program);
  const account = <K extends keyof Accounts>(name: K) => {
    const row = fixture.accounts.find(row => row.name === name)!;
    assert.ok(row, `missing compiled fixture ${name}`);
    return { key: new PublicKey(row.address), value: decodeAccount(program, name, rows.get(row.address)! as AccountInfo<Buffer>) };
  };
  return { fixture, program, builder, reader, account, rows };
}
test("SDK distinguishes preparing and archived markets from a global pause and exposes CRYPTO zero", async () => {
  for (const phase of ["preparing", "active", "archived"]) {
    const f = setup(phase), pool = f.account("pool"), registry = f.account("registry");
    const mint = Buffer.alloc(82); mint[44] = 6; mint[45] = 1;
    const clock = Buffer.alloc(40); clock.writeBigInt64LE(BigInt(pool.value.origin.toString()) + 100n, 32);
    const info = (data: Buffer, owner: PublicKey) => ({ data, owner, executable: false, lamports: 1, rentEpoch: 0 });
    f.rows.set(pool.value.collateralMint.toBase58(), info(mint, new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")));
    f.rows.set(SYSVAR_CLOCK_PUBKEY.toBase58(), info(clock, PublicKey.default));
    const sdk = new CoxSwapSdk(f.program, { poolId: 7n, collateralMint: pool.value.collateralMint }), market = await sdk.market();
    assert.equal(market.lifecycle, phase);
    assert.equal(market.cryptoClass, 0);
    assert.equal(market.tradingOpen, phase === "active" && !registry.value.paused);
    assert.equal(market.retired, phase === "archived");
    if (phase !== "active") await assert.rejects(sdk.prepareBuy({ owner: registry.value.admin, tokenAccount: pool.value.vault, amount: 1n, minimumUnits: 1n, expiryBatch: 1000n }), phase === "preparing" ? /MarketPreparing/ : /MarketArchived/);
  }
});
test("compiled fresh generation fixtures expose lifecycle, unified registry and CRYPTO zero", async () => {
  for (const phase of ["preparing", "active", "archived"]) {
    const f = setup(phase), pool = f.account("pool"), method = f.account("methodology"), registry = f.account("assetRegistry");
    assert.equal(marketLifecycle(pool.value), phase);
    assert.equal(pool.value.cryptoClass, 0);
    assert.equal(pool.value.poolId.toString(), "7");
    assert.equal(pool.value.benchmark.toString(), "100000000000000");
    assert.ok(pool.value.references.every(reference => reference.toString() === "100000000000000"));
    const universe = readDynamicManifest(method.value, pool.key);
    assert.equal(universe.schemaVersion, 2);
    assert.deepEqual(universe.instruments.map(asset => asset.classId), Array.from({ length: 31 }, (_, i) => i + 1));
    assert.ok(pool.value.assetRegistry.equals(registry.key));
    assert.deepEqual((await f.reader.assetRegistry(Uint8Array.from(pool.value.generation))).generation, pool.value.generation);
    const version = await f.reader.assetRegistryVersion(Uint8Array.from(pool.value.generation), Uint8Array.from(method.value.digest));
    assert.ok(version.methodology.equals(method.key));
  }
});
test("fresh genesis and registry builders match compiler-generated ABI and separate administrator from runtime", () => {
  const f = setup("active"), pool = f.account("pool"), method = f.account("methodology"), registry = f.account("registry");
  const generation = Uint8Array.from(pool.value.generation), digest = Uint8Array.from(method.value.digest);
  const calls = [
    f.builder.sealGenesisMethodology(registry.value.runtime, method.key),
    f.builder.initializeDynamicPool(registry.value.admin, method.key, pool.value.collateralMint, 7n, BigInt(pool.value.tradingOpensAt.toString())),
    f.builder.initializeDynamicStaging(registry.value.runtime, pool.key),
    f.builder.prepareDynamicPool(registry.value.admin, pool.key, method.key),
    f.builder.initializeAssetRegistry(registry.value.admin, pool.key, generation),
    f.builder.registerAssetRegistryVersion(registry.value.runtime, pool.key, generation, digest),
    f.builder.activateAssetRegistryVersion(registry.value.runtime, pool.key, generation, digest),
    f.builder.setPoolLifecycle(registry.value.admin, pool.key, "archived", pool.value.assetRegistry),
  ];
  const coder = new anchor.BorshInstructionCoder(f.program.idl);
  assert.deepEqual(calls.map(call => coder.decode(call.data)!.name), ["sealGenesisMethodology", "initializeDynamicPool", "initializeDynamicStaging", "prepareDynamicPool", "initializeAssetRegistry", "registerAssetRegistryVersion", "activateAssetRegistryVersion", "setPoolLifecycle"]);
  assert.ok(calls[5]!.keys.filter(key => key.isSigner).every(key => key.pubkey.equals(registry.value.runtime)));
  assert.ok(calls[7]!.keys.filter(key => key.isSigner).every(key => key.pubkey.equals(registry.value.admin)));
});
