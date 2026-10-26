import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { checkProtocolLinkage } from "../src/protocol-linkage.js";
import { checkSolanaPolicy } from "../src/policy.js";
import { loadSignerConfig, type RoleBindings } from "../src/config.js";
import { poolFields, universe } from "../src/dynamic-linkage.js";
import type { ChainAccount } from "../src/cox-linkage.js";
import type { DynamicCoxLinkage, EpochLinkage, SolanaProgramBinding } from "../src/config.js";

const require = createRequire(new URL("../../../packages/cox-client/package.json", import.meta.url)), anchor = require("@coral-xyz/anchor");
const { CoxInstructions } = require("./src/builders.ts"), { EpochInstructions } = require("./src/epoch.ts");
const disc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
const keyAt = (bytes: Buffer, offset: number) => new PublicKey(bytes.subarray(offset, offset + 32));
test("signer accepts captured legacy padding and fails closed on malformed tagged lifecycle", () => {
  const captured = JSON.parse(readFileSync(new URL("../../../packages/cox/fixtures/generation/legacy-pool-dirty-padding.json", import.meta.url), "utf8")) as { dataHex: string };
  const legacy = poolFields(Buffer.from(captured.dataHex, "hex"));
  assert.equal(legacy.lifecycle, 1);
  assert.equal(legacy.cryptoClass, 30);
  assert.equal(legacy.classes, 32);
  const f = fixture(), bytes = Buffer.from(f.pool.data), marker = bytes.indexOf(Buffer.from("RLPOOL01"));
  assert.ok(marker > 0);
  bytes[marker + 8] = 2;
  assert.throws(() => poolFields(bytes), /unsupported dynamic lifecycle/);
  assert.throws(() => poolFields(bytes.subarray(0, marker + 10)), /truncated dynamic lifecycle/);
});
function fixture(phase = "active") {
  const input = JSON.parse(readFileSync(new URL(`../../../packages/cox/fixtures/generation/${phase}.json`, import.meta.url), "utf8")) as { programAddress: string; accounts: { name: string; address: string; owner: string; dataHex: string }[] };
  const rows = new Map<string, ChainAccount>(input.accounts.map(row => [row.address, { owner: new PublicKey(row.owner), data: Buffer.from(row.dataHex, "hex") }]));
  const named = (name: string) => {
    const row = input.accounts.find(row => row.name === name)!;
    return { key: new PublicKey(row.address), data: rows.get(row.address)!.data };
  };
  const pool = named("pool"), root = named("registry"), method = named("methodology"), registry = named("assetRegistry"), version = named("assetRegistryVersion");
  const operator = keyAt(root.data, 43), admin = keyAt(root.data, 11);
  const canonical = method.data.subarray(47, 47 + method.data.readUInt32LE(43)), manifest = universe(canonical);
  const connection = { getAccountInfo: async () => null };
  const program = new anchor.Program(JSON.parse(readFileSync(new URL("../../../packages/cox/idl/cox.json", import.meta.url), "utf8")), { connection });
  const sdk = new CoxInstructions(program);
  const linkage: DynamicCoxLinkage = { kind: "cox-dynamic-v1", poolId: pool.data.readBigUInt64LE(11).toString(), pool: pool.key.toBase58(), operator: operator.toBase58(), sourceMethodologyDigest: manifest.source.toString("hex") };
  const fetch = async (keys: PublicKey[]) => keys.map(key => rows.get(key.toBase58()) ?? null);
  const transaction = (instruction: TransactionInstruction) => new VersionedTransaction(new TransactionMessage({ payerKey: operator, recentBlockhash: SystemProgram.programId.toBase58(), instructions: [instruction] }).compileToV0Message());
  const binding: SolanaProgramBinding = { programId: input.programAddress, discriminators: [] };
  return { rows, named, pool, root, method, registry, version, operator, admin, manifest, sdk, linkage, fetch, transaction, binding };
}
test("fresh class-zero genesis and registry linkage accept compiler-produced accounts and reject archived generations", async () => {
  const f = fixture();
  assert.equal(f.manifest.schemaVersion, 2);
  const generation = f.registry.data.subarray(11, 43), digest = f.version.data.subarray(107, 139);
  await checkProtocolLinkage(f.binding, f.linkage, f.transaction(f.sdk.registerAssetRegistryVersion(f.operator, f.pool.key, generation, digest)), f.fetch);
  const sealOffset = 47 + f.method.data.readUInt32LE(43);
  f.method.data[sealOffset] = 0;
  await checkProtocolLinkage(f.binding, f.linkage, f.transaction(f.sdk.sealGenesisMethodology(f.operator, f.method.key)), f.fetch);
  f.method.data[sealOffset] = 1;
  await assert.rejects(checkProtocolLinkage(f.binding, f.linkage, f.transaction(f.sdk.sealGenesisMethodology(f.operator, f.method.key)), f.fetch), /fresh genesis/);
  const old = fixture("archived");
  await assert.rejects(checkProtocolLinkage(old.binding, old.linkage, old.transaction(old.sdk.registerAssetRegistryVersion(old.operator, old.pool.key, old.registry.data.subarray(11, 43), old.version.data.subarray(107, 139))), old.fetch), /archived/);
});
test("disabled release policy permits only the bound operator's registry version registration", async () => {
  const f = fixture();
  const configured = JSON.parse(readFileSync(new URL("../config/dev-dynamic.json", import.meta.url), "utf8")).bindings["oracle-operator"] as RoleBindings;
  const program = configured.solana!.programs[0]!;
  assert.equal(program.enabled, false);
  const instruction = f.sdk.registerAssetRegistryVersion(f.operator, f.pool.key, f.registry.data.subarray(11, 43), f.version.data.subarray(107, 139));
  const discriminator = Buffer.from(instruction.data.subarray(0, 8)).toString("hex");
  const rule = program.instructions!.find(value => value.discriminator === discriminator);
  assert.ok(rule);
  const rebound = { ...program, enabled: true, programId: f.binding.programId, instructions: [{ ...rule, accounts: { ...rule.accounts, "1": f.root.key.toBase58(), "2": f.pool.key.toBase58(), "3": f.registry.key.toBase58() } }] };
  const bindings: RoleBindings = { ...configured, solana: { ...configured.solana!, programs: [rebound] } };
  const transaction = f.transaction(instruction);
  checkSolanaPolicy("oracle-operator", bindings, transaction, f.operator);
  await checkProtocolLinkage(rebound, f.linkage, transaction, f.fetch);
  assert.throws(() => checkSolanaPolicy("oracle-operator", bindings, transaction, f.admin), /signer|payer|operator/i);
  const archived = fixture("archived");
  await assert.rejects(checkProtocolLinkage(rebound, archived.linkage, archived.transaction(archived.sdk.registerAssetRegistryVersion(archived.operator, archived.pool.key, archived.registry.data.subarray(11, 43), archived.version.data.subarray(107, 139))), archived.fetch), /archived/);
});
test("sole operator can prepare a registry-bound round without administrator authority", async () => {
  const f = fixture(), program = new anchor.Program(JSON.parse(readFileSync(new URL("../../../packages/cox-epoch/idl/epoch.json", import.meta.url), "utf8")), { connection: {} });
  const sdk = new EpochInstructions(program), config = sdk.pdas.config(f.admin, 77n), mint = keyAt(f.pool.data, 83);
  const root = Buffer.alloc(256); disc("PoolConfig").copy(root); f.admin.toBuffer().copy(root, 8); root.writeBigUInt64LE(77n, 40);
  f.operator.toBuffer().copy(root, 48); mint.toBuffer().copy(root, 80); f.manifest.source.copy(root, 113);
  Buffer.from("RLCFG001").copy(root, 174); root[182] = 1; root[183] = 0; f.registry.key.toBuffer().copy(root, 184);
  f.rows.set(config.toBase58(), { owner: program.programId, data: root });
  const linkage: EpochLinkage = { kind: "epoch-v1", configId: "77", config: config.toBase58(), admin: f.admin.toBase58(), operator: f.operator.toBase58(), methodologyDigest: f.manifest.source.toString("hex"), registry: { programId: f.binding.programId, assetRegistry: f.registry.key.toBase58(), generation: f.registry.data.subarray(11, 43).toString("hex") } };
  const binding = { programId: program.programId.toBase58(), discriminators: [] };
  const opening = BigInt(Math.floor(Date.now() / 1000 / 14400)) * 14400n, selection = { config, opensAt: opening };
  const registryBinding = { assetRegistry: f.registry.key, registryVersion: f.version.key, methodology: f.method.key };
  const initialize = sdk.initializeCurrentEpoch(f.operator, mint, selection, registryBinding);
  await checkProtocolLinkage(binding, linkage, f.transaction(initialize), f.fetch);
  await assert.rejects(checkProtocolLinkage(binding, { ...linkage, registry: undefined }, f.transaction(initialize), f.fetch), /not enabled/);
  f.registry.data.writeBigUInt64LE(opening, 179);
  await assert.rejects(checkProtocolLinkage(binding, linkage, f.transaction(initialize), f.fetch), /pending activation/);
  f.registry.data.writeBigUInt64LE(0n, 179);
  f.version.data.writeBigUInt64LE(opening, 179);
  await assert.rejects(checkProtocolLinkage(binding, linkage, f.transaction(initialize), f.fetch), /interval/);
  f.version.data.writeBigUInt64LE(0n, 179);
  const epoch = sdk.pdas.epoch(selection), bytes = Buffer.alloc(2048);
  disc("EpochAccount").copy(bytes); config.toBuffer().copy(bytes, 8); bytes.writeBigUInt64LE(opening, 40); Buffer.from("RLEPCH01").copy(bytes, 118); bytes[126] = 1; f.version.key.toBuffer().copy(bytes, 127);
  f.rows.set(epoch.toBase58(), { owner: program.programId, data: bytes });
  await checkProtocolLinkage(binding, linkage, f.transaction(sdk.growCurrentEpoch(f.operator, selection, registryBinding, 8192)), f.fetch);
  await checkProtocolLinkage(binding, linkage, f.transaction(sdk.copyRegistryAssets(f.operator, selection, registryBinding, 0, 8)), f.fetch);
  await assert.rejects(checkProtocolLinkage(binding, linkage, f.transaction(sdk.copyRegistryAssets(f.operator, selection, registryBinding, 1, 8)), f.fetch), /canonical Epoch page/);
  await assert.rejects(checkProtocolLinkage(binding, linkage, f.transaction(sdk.setConfigLifecycle(f.admin, config, "active")), f.fetch), /sole operator|not Epoch runtime/);
  root[183] = 2;
  await assert.rejects(checkProtocolLinkage(binding, linkage, f.transaction(initialize), f.fetch), /not available/);
});

test("fresh-four release stays disabled with the already operated runtime instruction and writable boundaries", () => {
  const config = loadSignerConfig(new URL("../config/dev-dynamic.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const programs = config.bindings["oracle-operator"]!.solana!.programs;
  const expected = [
    ["seal_genesis_methodology", "initialize_dynamic_staging", "register_asset_registry_version", "activate_asset_registry_version", "seal_dynamic_methodology", "register_scheduled_methodology", "upload_scheduled_methodology", "seal_scheduled_methodology", "activate_universe", "grow_dynamic_account", "begin_dynamic_publication", "append_dynamic_prices", "seal_dynamic_publication", "prepare_dynamic_revaluation", "finish_dynamic_revaluation", "evaluate", "safety", "execute", "seal_evaluation", "finalize"],
    ["initialize_current_epoch", "grow_current_epoch", "copy_registry_assets", "seal_current_epoch", "finalize_empty", "publish_snapshot", "initialize_snapshot", "grow_snapshot", "append_prices", "seal_snapshot", "close_snapshot", "execute", "begin_close", "score", "allocate", "refund", "finalize_scores", "void_epoch"],
  ];
  const overrides: Record<string, number[]>[] = [
    { append_dynamic_prices: [1, 2, 4], seal_dynamic_publication: [1, 2, 4], evaluate: [0, 1, 2, 3, 4], safety: [0, 1, 2, 3, 4], execute: [0, 1, 2, 3, 4], seal_evaluation: [0, 1, 2] },
    { execute: [2, 3, 6], begin_close: [2, 5] },
  ];
  assert.equal(programs.length, 2);
  for (const [index, program] of programs.entries()) {
    const path = index === 0 ? "../../../packages/cox/idl/cox.json" : "../../../packages/cox-epoch/idl/epoch.json";
    const idl = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
    assert.equal(program.enabled, false);
    assert.equal(program.programId, idl.address);
    assert.deepEqual(program.discriminators, expected[index]!.map(name => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex")));
    assert.equal(program.instructions!.length, expected[index]!.length);
    for (const [position, name] of expected[index]!.entries()) {
      const definition = idl.instructions.find((instruction: { name: string }) => instruction.name === name);
      const rule = program.instructions![position]!;
      assert.equal(rule.discriminator, program.discriminators[position]);
      const declared = definition.accounts.flatMap((account: { writable?: boolean }, accountIndex: number) => account.writable ? [accountIndex] : []);
      assert.deepEqual(rule.v1WritableAccounts, overrides[index]![name] ?? declared, name);
      assert(!definition.accounts.some((account: { name: string }) => account.name === "admin"));
      for (const [accountIndex, account] of definition.accounts.entries()) {
        if (account.signer) assert.equal(rule.accounts[String(accountIndex)], "$signer", name);
      }
    }
  }
});

test("fresh-four policy pins the new generation and refuses legacy pool and Epoch targets", () => {
  const config = loadSignerConfig(new URL("../config/dev-dynamic.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const binding = config.bindings["oracle-operator"]!;
  const programs = binding.solana!.programs;
  const basic = programs[0]!, epoch = programs[1]!;
  assert(basic.linkage?.kind === "cox-dynamic-v1");
  assert(epoch.linkage?.kind === "epoch-v1");
  assert.equal(basic.linkage.poolId, "4");
  assert.equal(basic.linkage.pool, "45jn5iDor3M4e8NsG8XL99528F3eeMYBYJrbyuZSmPPi");
  assert.equal(epoch.linkage.configId, "4");
  assert.equal(epoch.linkage.config, "BnSKCuZQ8ao6mpMKY7SSBTckkAmpiPD7pM2dnb8AT1UJ");
  assert.deepEqual(epoch.linkage.registry, { programId: basic.programId, assetRegistry: "EozvAzsyQBHiwLWC3H1BK8Qj3p3UJSRKGxaVdZQGMM2n", generation: "f0130bd0b06ec441c72f5a748ff1c2316f92e1ce4c0f2f3f668588627065ebf1" });
  const operator = new PublicKey(basic.linkage.operator), generation = Buffer.from(epoch.linkage.registry!.generation, "hex");
  const basicProgram = new anchor.Program(JSON.parse(readFileSync(new URL("../../../packages/cox/idl/cox.json", import.meta.url), "utf8")), { connection: {} });
  const epochProgram = new anchor.Program(JSON.parse(readFileSync(new URL("../../../packages/cox-epoch/idl/epoch.json", import.meta.url), "utf8")), { connection: {} });
  const sdk = new CoxInstructions(basicProgram), epochs = new EpochInstructions(epochProgram);
  const pool = sdk.pdas.pool(4n), digest = Buffer.alloc(32, 7), registry = sdk.pdas.assetRegistry(generation);
  const register = sdk.registerAssetRegistryVersion(operator, pool, generation, digest);
  const transaction = (instruction: TransactionInstruction) => new VersionedTransaction(new TransactionMessage({ payerKey: operator, recentBlockhash: SystemProgram.programId.toBase58(), instructions: [instruction] }).compileToV0Message());
  assert.throws(() => checkSolanaPolicy("oracle-operator", binding, transaction(register), operator), /not enabled/);
  const enabled: RoleBindings = { solana: { ...binding.solana!, programs: programs.map(program => ({ ...program, enabled: true })) } };
  checkSolanaPolicy("oracle-operator", enabled, transaction(register), operator);
  assert.throws(() => checkSolanaPolicy("oracle-operator", enabled, transaction(sdk.registerAssetRegistryVersion(operator, sdk.pdas.pool(3n), generation, digest)), operator), /account/);
  const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), testMint = new PublicKey(basic.linkage.testCollateralMint!);
  const selection = { config: new PublicKey(epoch.linkage.config), opensAt: 1793088000n };
  const registryBinding = { assetRegistry: registry, registryVersion: sdk.pdas.assetRegistryVersion(registry, digest), methodology: sdk.pdas.methodology(digest) };
  checkSolanaPolicy("oracle-operator", enabled, transaction(epochs.initializeCurrentEpoch(operator, mint, selection, registryBinding, testMint)), operator);
  const oldSelection = { ...selection, config: epochs.pdas.config(new PublicKey(epoch.linkage.admin), 3n) };
  assert.throws(() => checkSolanaPolicy("oracle-operator", enabled, transaction(epochs.initializeCurrentEpoch(operator, mint, oldSelection, registryBinding, testMint)), operator), /account/);
});
