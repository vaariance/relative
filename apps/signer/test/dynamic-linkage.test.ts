import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { checkProtocolLinkage } from "../src/protocol-linkage.js";
import type { DynamicCoxLinkage, SolanaProgramBinding } from "../src/config.js";
import type { ChainAccount } from "../src/cox-linkage.js";
import { PolicyRejection } from "../src/policy.js";
const hash = (value: Buffer) => createHash("sha256").update(value).digest();
const disc = (kind: string, name: string) => hash(Buffer.from(`${kind}:${name}`)).subarray(0, 8);
const num = (value: bigint | number, width: number) => { let n = BigInt(value); const out = Buffer.alloc(width); for (let i = 0; i < width; i++) { out[i] = Number(n & 255n); n >>= 8n; } return out; };
const text = (value: string) => Buffer.concat([num(Buffer.byteLength(value), 4), Buffer.from(value)]);
const vec = (rows: Buffer[]) => Buffer.concat([num(rows.length, 4), ...rows]);
const filled = (value: number) => Buffer.alloc(32, value);
const operator = Keypair.generate().publicKey, admin = Keypair.generate().publicKey, stranger = Keypair.generate().publicKey;
const SCALE = 1000000000000n;
function fixture(count = 30, phase = 4) {
  const program = Keypair.generate().publicKey, pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
  const pool = pda(Buffer.from("pool"), num(2, 8)), registry = pda(Buffer.from("registry")), vault = pda(Buffer.from("vault"), pool.toBuffer()), batch = pda(Buffer.from("batch"), pool.toBuffer());
  const rows = new Map<string, ChainAccount>(), source = filled(44), state = filled(45), timestamp = BigInt(Math.floor(Date.now() / 1000) - 10), sequence = 4n;
  const identity = (index: number) => Buffer.concat([text(`asset${index}`), text(`ASSET${index}`), num(index < 30 ? index : index + 1, 2), num(index, 2), num(index + 1, 4), filled(index + 1), num(0, 1)]);
  const canonical = (size: number, version: bigint, predecessor: Buffer, captureAt: bigint) => Buffer.concat([text("COX/UNIVERSE/OPERATOR-ATTESTED/V1"), num(1, 2), pool.toBuffer(), operator.toBuffer(), source, num(version, 8), predecessor, num(size, 2), filled(46), num(captureAt, 8), num(100n * SCALE, 16), vec(Array.from({ length: size }, () => num(100000000, 8))), filled(47), filled(48), num(sequence, 8), state,
    vec(Array.from({ length: size }, (_, index) => Buffer.concat([identity(index), num(100000000, 8), num(100n * SCALE, 16), num(index < count ? 1000n : captureAt, 8)])))]);
  const currentCanonical = canonical(count, 1n, filled(0), 1000n), digest = hash(currentCanonical), methodology = pda(Buffer.from("methodology"), digest);
  const put = (key: PublicKey, data: Buffer) => { rows.set(key.toBase58(), { owner: program, data }); return data; };
  const method = (data: Buffer, sealed: boolean, activation = timestamp - 1000n, expected = data.length, fixedDigest = hash(data)) => Buffer.concat([disc("account", "Methodology"), num(3, 2), num(0, 1), fixedDigest, num(data.length, 4), data, num(sealed ? 1 : 0, 1), num(activation, 8), num(expected, 4), vec(Array.from({ length: count }, (_, index) => num(index, 1))), num(1000, 8), num(0, 1)]);
  put(methodology, method(currentCanonical, true, 0n));
  const root = put(pool, Buffer.concat([disc("account", "Pool"), num(5, 2), num(0, 1), num(2, 8), registry.toBuffer(), methodology.toBuffer(), stranger.toBuffer(), vault.toBuffer(), num(1000, 8), num(timestamp - 1000n, 8), num(sequence, 8), state, num(100n * SCALE, 16), vec(Array.from({ length: count }, () => num(100000000, 8))), vec(Array.from({ length: count }, () => num(100000000, 8))), vec(Array.from({ length: count + 1 }, () => num(100n * SCALE, 16))), vec(Array.from({ length: count + 1 }, () => Buffer.alloc(24))), Buffer.alloc(40), num(0, 1), num(1, 1), num(0, 8), num(timestamp - 1000n, 8), num(0, 8)]));
  const reg = put(registry, Buffer.concat([disc("account", "Registry"), num(1, 2), num(0, 1), admin.toBuffer(), operator.toBuffer()]));
  const batchBytes = put(batch, Buffer.concat([disc("account", "Batch"), num(4, 2), num(0, 1), pool.toBuffer(), num(timestamp + 1n - 1000n, 8), num(sequence + 1n, 8), num(timestamp + 1n, 8), num(sequence, 8), state, filled(49), vec([]), num(100n * SCALE, 16), vec([]), vec([]), vec([]), vec([]), vec([]), vec([]), Buffer.alloc(48), num(0, 8), Buffer.alloc(80), num(phase, 1), num(0, 1), num(0, 8)]));
  const schedule = pda(Buffer.from("universe-schedule"), pool.toBuffer(), num(2, 8));
  const identitiesDigest = hash(Buffer.concat([text("COX/UNIVERSE/IDENTITIES/V1"), vec(Array.from({ length: count + 1 }, (_, index) => identity(index)))]));
  const approval = put(schedule, Buffer.concat([disc("account", "UniverseSchedule"), num(1, 2), num(0, 1), pool.toBuffer(), digest, source, num(2, 8), identitiesDigest, num(count + 1, 2), num(timestamp, 8), num(timestamp + 1000n, 8), num(0, 1), num(0, 1)]));
  const nextCanonical = canonical(count + 1, 2n, digest, timestamp), nextDigest = hash(nextCanonical), nextMethodology = pda(Buffer.from("methodology"), nextDigest);
  const nextBytes = put(nextMethodology, method(nextCanonical, false));
  const fetch = async (keys: PublicKey[]) => keys.map(key => rows.get(key.toBase58()) ?? null);
  const instruction = (name: string, keys: PublicKey[], args = Buffer.alloc(0)) => new TransactionInstruction({ programId: program, keys: keys.map(pubkey => ({ pubkey, isSigner: pubkey.equals(operator), isWritable: true })), data: Buffer.concat([disc("global", name), args]) });
  const transaction = (instructions: TransactionInstruction[]) => new VersionedTransaction(new TransactionMessage({ payerKey: operator, recentBlockhash: SystemProgram.programId.toBase58(), instructions }).compileToV0Message());
  const binding: SolanaProgramBinding = { programId: program.toBase58(), discriminators: [] }, linkage: DynamicCoxLinkage = { kind: "cox-dynamic-v1", poolId: "2", pool: pool.toBase58(), operator: operator.toBase58(), sourceMethodologyDigest: source.toString("hex") };
  const check = (name: string, keys: PublicKey[], args = Buffer.alloc(0)) => checkProtocolLinkage(binding, linkage, transaction([instruction(name, keys, args)]), fetch);
  return { pda, program, pool, registry, vault, batch, methodology, schedule, nextMethodology, rows, root, reg, batchBytes, approval, nextBytes, currentCanonical, nextCanonical, nextDigest, digest, timestamp, source, state, sequence, method, canonical, put, fetch, binding, linkage, instruction, transaction, check };
}
async function rejected(value: Promise<void>, pattern: RegExp) { await assert.rejects(value, error => error instanceof PolicyRejection && pattern.test(error.message)); }
test("dynamic signer accepts only admin-approved exact boundary captures and rejects altered approval, references and source", async () => {
  const f = fixture(), keys = [operator, f.registry, f.pool, f.methodology, f.schedule, f.nextMethodology];
  await f.check("seal_scheduled_methodology", keys);
  f.approval[165] = 1; await rejected(f.check("seal_scheduled_methodology", keys), /cancelled/); f.approval[165] = 0;
  f.approval[166] = 1; await rejected(f.check("seal_scheduled_methodology", keys), /cancelled/); f.approval[166] = 0;
  f.approval[115] ^= 1; await rejected(f.check("seal_scheduled_methodology", keys), /instrument identities/); f.approval[115] ^= 1;
  f.approval.writeBigUInt64LE(f.timestamp + 1n, 149); await rejected(f.check("seal_scheduled_methodology", keys), /non-boundary/); f.approval.writeBigUInt64LE(f.timestamp, 149);
  await rejected(checkProtocolLinkage(f.binding, { ...f.linkage, sourceMethodologyDigest: filled(90).toString("hex") }, f.transaction([f.instruction("seal_scheduled_methodology", keys)]), f.fetch), /source methodology/);
  await rejected(f.check("schedule_universe", keys), /not approved dynamic runtime/);
  await rejected(f.check("migrate_dynamic_pool", keys), /not approved dynamic runtime/);
  await rejected(f.check("cancel_dynamic_preparation", keys), /not approved dynamic runtime/);
  await rejected(f.check("seal_scheduled_methodology", [...keys, stranger]), /accounts/);
  await rejected(f.check("seal_scheduled_methodology", [operator, f.registry, f.pool, f.methodology, stranger, f.nextMethodology]), /owner/);
});
test("scheduled successor uploads require exact cursors, bounded bytes and hash-bound approved capture", async () => {
  const f = fixture(), keys = [operator, f.registry, f.pool, f.methodology, f.schedule, f.nextMethodology];
  f.rows.set(f.nextMethodology.toBase58(), { owner: f.program, data: f.method(Buffer.alloc(0), false, f.timestamp - 1000n, f.nextCanonical.length, f.nextDigest) });
  const page = f.nextCanonical.subarray(0, 600), args = Buffer.concat([num(0, 4), num(page.length, 4), page]);
  await f.check("upload_scheduled_methodology", keys, args);
  await rejected(f.check("upload_scheduled_methodology", keys, Buffer.concat([num(1, 4), num(page.length, 4), page])), /cursor/);
  await rejected(f.check("seal_scheduled_methodology", keys), /incomplete/);
  const second = f.nextCanonical.subarray(600, 1200);
  await checkProtocolLinkage(f.binding, f.linkage, f.transaction([f.instruction("upload_scheduled_methodology", keys, args), f.instruction("upload_scheduled_methodology", keys, Buffer.concat([num(600, 4), num(second.length, 4), second]))]), f.fetch);
  const registration = Buffer.concat([f.nextDigest, num(f.nextCanonical.length, 4)]);
  await f.check("register_scheduled_methodology", [operator, f.registry, f.pool, f.methodology, f.schedule, f.nextMethodology, SystemProgram.programId], registration);
  await rejected(f.check("register_scheduled_methodology", [operator, f.registry, f.pool, f.methodology, f.schedule, stranger, SystemProgram.programId], registration), /account/);
});
test("dynamic activation requires sealed approved successor and pins both custody accounts", async () => {
  const f = fixture(), keys = [operator, f.registry, f.pool, f.methodology, f.nextMethodology, f.vault, f.schedule];
  await rejected(f.check("activate_universe", keys), /unsealed/);
  f.rows.set(f.nextMethodology.toBase58(), { owner: f.program, data: f.method(f.nextCanonical, true) });
  await f.check("activate_universe", keys);
  await rejected(f.check("activate_universe", [...keys.slice(0, 5), stranger, f.schedule]), /vault/);
  await rejected(f.check("activate_universe", [...keys, stranger]), /sentinel/);
});
test("dynamic publication validates cursor phases, timestamp and bounded pages without admitting arbitrary runtime calls", async () => {
  const f = fixture(33), stage = [operator, f.registry, f.pool, f.methodology, f.batch];
  const prices = (offset: number, size: number) => Buffer.concat([num(offset, 2), num(size, 4), ...Array.from({ length: size }, () => Buffer.concat([num(100000000, 8), num(3, 1), num(0, 1), num(f.timestamp + 1n, 8), num(0, 2)]))]);
  await f.check("append_dynamic_prices", stage, prices(0, 16));
  await rejected(f.check("append_dynamic_prices", stage, prices(1, 16)), /cursor/);
  await rejected(f.check("append_dynamic_prices", stage, prices(0, 17)), /page/);
  await rejected(f.check("seal_dynamic_publication", stage), /seal phase/);
  const phaseAt = f.batchBytes.length - 10;
  f.batchBytes[phaseAt] = 5;
  await f.check("prepare_dynamic_revaluation", stage, Buffer.concat([num(0, 2), num(16, 2)]));
  await rejected(f.check("prepare_dynamic_revaluation", stage, Buffer.concat([num(1, 2), num(16, 2)])), /cursor/);
  await rejected(f.check("finish_dynamic_revaluation", stage, Buffer.concat([num(0, 2), num(16, 2)])), /phase/);
  f.batchBytes[phaseAt] = 6;
  await f.check("finish_dynamic_revaluation", stage, Buffer.concat([num(0, 2), num(16, 2)]));
  await rejected(f.check("prepare_dynamic_revaluation", stage, Buffer.concat([num(0, 2), num(17, 2)])), /phase/);
  await rejected(f.check("deposit_v2", stage), /not approved dynamic runtime/);
});
test("dynamic lineage account order is checked against generated contract ABI", () => {
  const idl = JSON.parse(readFileSync(new URL("../../../packages/cox/idl/cox.json", import.meta.url), "utf8"));
  const expected: Record<string, string[]> = {
    begin_universe_handoff: ["runtime", "registry", "pool", "batch", "methodology", "next_methodology", "schedule", "handoff", "system_program"],
    append_universe_handoff_prices: ["runtime", "registry", "pool", "batch", "methodology", "next_methodology", "handoff"],
    activate_prepared_universe: ["runtime", "registry", "pool", "batch", "methodology", "next_methodology", "schedule", "handoff", "vault", "instructions", "test_vault", "asset_registry", "next_registry_version", "previous_registry_version"],
    register_scheduled_methodology: ["runtime", "registry", "pool", "methodology", "schedule", "next_methodology", "system_program"],
    upload_scheduled_methodology: ["runtime", "registry", "pool", "methodology", "schedule", "next_methodology"],
    seal_scheduled_methodology: ["runtime", "registry", "pool", "methodology", "schedule", "next_methodology"],
    activate_universe: ["runtime", "registry", "pool", "methodology", "next_methodology", "vault", "schedule", "test_vault", "asset_registry", "next_registry_version", "previous_registry_version"],
    prepare_dynamic_revaluation: ["runtime", "registry", "pool", "methodology", "batch"], finish_dynamic_revaluation: ["runtime", "registry", "pool", "methodology", "batch"],
  };
  for (const [name, accounts] of Object.entries(expected)) {
    const instruction = idl.instructions.find((value: { name: string }) => value.name === name);
    assert.deepEqual(instruction.accounts.map((value: { name: string }) => value.name), accounts);
    assert.deepEqual(Buffer.from(instruction.discriminator), disc("global", name));
  }
});

test("scheduled capture cannot replace an origin price even under a fresh consistent canonical hash", async () => {
  const f = fixture(), changed = Buffer.from(f.nextCanonical);
  changed[changed.length - 32] ^= 1;
  const digest = hash(changed), next = f.pda(Buffer.from("methodology"), digest);
  f.put(next, f.method(changed, false));
  await rejected(f.check("seal_scheduled_methodology", [operator, f.registry, f.pool, f.methodology, f.schedule, next]), /new original references/);
  f.approval.writeBigUInt64LE(f.timestamp, 157);
  await rejected(f.check("seal_scheduled_methodology", [operator, f.registry, f.pool, f.methodology, f.schedule, f.nextMethodology]), /expired/);
});
test("dynamic runtime cranks retain legacy requests but bind owner, nonce and stage phase", async () => {
  const f = fixture(30, 0), owner = Keypair.generate().publicKey, nonce = 7n;
  const request = f.pda(Buffer.from("request"), f.pool.toBuffer(), num(nonce, 8)), position = f.pda(Buffer.from("position"), f.pool.toBuffer(), owner.toBuffer());
  const bytes = f.put(request, Buffer.concat([disc("account", "Request"), num(3, 2), num(0, 1), f.pool.toBuffer(), owner.toBuffer(), num(nonce, 8)]));
  const keys = [f.registry, f.pool, f.batch, request, position, f.vault];
  for (const schema of [1, 2, 3, 4]) { bytes.writeUInt16LE(schema, 8); await f.check("evaluate", keys); }
  bytes.writeUInt16LE(5, 8); await rejected(f.check("evaluate", keys), /request schema/); bytes.writeUInt16LE(3, 8);
  await rejected(f.check("execute", keys), /crank phase/);
  owner.toBuffer().copy(bytes, 43); await rejected(f.check("evaluate", [...keys.slice(0, 4), stranger, f.vault]), /owner position/);
  bytes.writeBigUInt64LE(8n, 75); await rejected(f.check("evaluate", keys), /nonce PDA/);
});
test("dynamic linkage config requires a nonzero pinned source and leaves live bindings unchanged", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { loadSignerConfig } = await import("../src/config.js");
  const original = JSON.parse(readFileSync(new URL("../config/dev.json", import.meta.url), "utf8")), value = structuredClone(original), f = fixture();
  const directory = mkdtempSync(join(tmpdir(), "dynamic-signer-")), path = join(directory, "config.json");
  try {
    value.bindings["oracle-operator"].solana.programs[0].linkage = f.linkage; writeFileSync(path, JSON.stringify(value));
    assert.equal(loadSignerConfig(path).bindings["oracle-operator"]!.solana!.programs[0]!.linkage!.kind, "cox-dynamic-v1");
    value.bindings["oracle-operator"].solana.programs[0].linkage.sourceMethodologyDigest = "0".repeat(64); writeFileSync(path, JSON.stringify(value));
    assert.throws(() => loadSignerConfig(path), /dynamic linkage/);
    assert.equal(original.bindings["oracle-operator"].solana.programs[0].linkage.kind, "cox-v2");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("pending runtime authority changes only at its admin-scheduled publication batch", async () => {
  const f = fixture(), nextOperator = Keypair.generate().publicKey, effectiveBatch = f.timestamp + 1n - 1000n;
  f.rows.set(f.registry.toBase58(), { owner: f.program, data: Buffer.concat([f.reg, num(1, 1), nextOperator.toBuffer(), num(effectiveBatch, 8)]) });
  const args = (batch: bigint) => Buffer.concat([num(batch, 8), num(f.sequence + 1n, 8), f.state, filled(49), num(100n * SCALE, 16)]);
  const begin = (key: PublicKey, batch: bigint) => new TransactionInstruction({ programId: f.program,
    keys: [key, key, f.registry, f.pool, f.methodology, f.batch, f.vault, SystemProgram.programId].map(pubkey => ({ pubkey, isSigner: pubkey.equals(key), isWritable: true })),
    data: Buffer.concat([disc("global", "begin_dynamic_publication"), args(batch)]) });
  const tx = (key: PublicKey, batch: bigint) => new VersionedTransaction(new TransactionMessage({ payerKey: key, recentBlockhash: SystemProgram.programId.toBase58(), instructions: [begin(key, batch)] }).compileToV0Message());
  const nextLinkage = { ...f.linkage, operator: nextOperator.toBase58() };
  await rejected(checkProtocolLinkage(f.binding, f.linkage, tx(operator, effectiveBatch), f.fetch), /registry operator/);
  await checkProtocolLinkage(f.binding, nextLinkage, tx(nextOperator, effectiveBatch), f.fetch);
  await rejected(checkProtocolLinkage(f.binding, nextLinkage, tx(nextOperator, effectiveBatch - 1n), f.fetch), /registry operator/);
  f.rows.set(f.registry.toBase58(), { owner: f.program, data: Buffer.concat([f.reg.subarray(0, 43), nextOperator.toBuffer(), num(0, 1), num(effectiveBatch, 8)]) });
  await checkProtocolLinkage(f.binding, nextLinkage, tx(nextOperator, effectiveBatch), f.fetch);
  f.root.writeBigUInt64LE(effectiveBatch, f.root.length - 16);
  await rejected(checkProtocolLinkage(f.binding, nextLinkage, tx(nextOperator, effectiveBatch), f.fetch), /publication predecessor/);
  await checkProtocolLinkage(f.binding, nextLinkage, tx(nextOperator, effectiveBatch + 1n), f.fetch);
});

test("migration preparation permits only the pinned adaptive source and exact genesis capture", async () => {
  const f = fixture(), adaptive = text("COX/METHODOLOGY/ADAPTIVE/V1"), source = hash(adaptive);
  source.copy(f.source);
  const oldMethodology = f.pda(Buffer.from("methodology"), source), old = f.method(adaptive, true, 0n); old.writeUInt16LE(2, 8); f.put(oldMethodology, old);
  f.root.writeUInt16LE(4, 8); oldMethodology.toBuffer().copy(f.root, 51);
  const genesis = f.canonical(30, 1n, filled(0), 1000n), digest = hash(genesis), next = f.pda(Buffer.from("methodology"), digest);
  f.put(next, f.method(genesis, false, 0n));
  const linkage = { ...f.linkage, sourceMethodologyDigest: source.toString("hex") }, keys = [operator, f.registry, f.pool, oldMethodology, next];
  const check = () => checkProtocolLinkage(f.binding, linkage, f.transaction([f.instruction("seal_dynamic_methodology", keys)]), f.fetch);
  await check();
  old[47 + adaptive.length] = 0; await rejected(check(), /unsealed bootstrap/); old[47 + adaptive.length] = 1;
  old[51] ^= 1; await rejected(check(), /canonical digest/); old[51] ^= 1;
  await rejected(checkProtocolLinkage(f.binding, linkage, f.transaction([f.instruction("seal_scheduled_methodology", keys)]), f.fetch), /not approved dynamic runtime/);
});

test("prepared candidates retain approval and immutable origins while ordinary publications advance", async () => {
  const f = fixture(), keys = [operator, f.registry, f.pool, f.methodology, f.schedule, f.nextMethodology];
  f.approval.writeUInt16LE(2, 8);
  f.root.writeBigUInt64LE(f.timestamp + 8n - 1000n, 155);
  f.root.writeBigUInt64LE(f.sequence + 1n, 163);
  f.root[171] ^= 1;
  await f.check("seal_scheduled_methodology", keys);
  f.approval.writeUInt16LE(1, 8);
  await rejected(f.check("seal_scheduled_methodology", keys), /non-boundary/);
  f.approval.writeUInt16LE(2, 8);
  f.rows.set(f.nextMethodology.toBase58(), { owner: f.program, data: f.method(f.nextCanonical, true) });
  await rejected(f.check("activate_universe", [operator, f.registry, f.pool, f.methodology, f.nextMethodology, f.vault, f.schedule]), /atomic prepared activation/);
});

test("prepared handoff strictly binds the successor, prices, pool, and immediate finalization", async () => {
  const f = fixture(30, 1); f.approval.writeUInt16LE(2, 8);
  f.rows.set(f.nextMethodology.toBase58(), { owner: f.program, data: f.method(f.nextCanonical, true) });
  const cutoff = f.timestamp + 1n, anchor = f.pda(Buffer.from("universe-handoff"), f.pool.toBuffer(), f.nextDigest);
  const batchData = Buffer.concat([disc("account", "Batch"), num(4, 2), num(0, 1), f.pool.toBuffer(), num(cutoff - 1000n, 8), num(f.sequence + 1n, 8), num(cutoff, 8), num(f.sequence, 8), f.state, filled(49), vec(Array.from({length:30}, () => Buffer.concat([num(100000000,8),num(3,1),num(0,1),num(cutoff,8),num(0,2)]))), num(100n*SCALE,16),vec([]),vec([]),vec([]),vec([]),vec([]),vec([]),Buffer.alloc(48),num(0,8),Buffer.alloc(72),num(cutoff,8),num(1,1),num(0,1),num(0,8)]);
  f.put(f.batch,batchData);
  f.put(anchor,Buffer.concat([disc("account","UniverseHandoff"),num(1,2),num(0,1),f.pool.toBuffer(),f.schedule.toBuffer(),f.nextMethodology.toBuffer(),num(f.sequence,8),f.state,num(f.sequence+1n,8),filled(49),num(cutoff,8),num(100n*SCALE,16),num(cutoff,8),num(0,8),filled(0),vec([num(110000000,8)])]));
  const common=[operator,f.registry,f.pool,f.batch,f.methodology,f.nextMethodology];
  await rejected(f.check("append_universe_handoff_prices",[...common,anchor],Buffer.concat([num(1,2),num(1,4),num(120000000,8)])),/price page/);
  const activation=[...common,f.schedule,anchor,f.vault,new PublicKey("Sysvar1nstructions1111111111111111111111111"),f.program,f.program,f.program,f.program];
  await rejected(f.check("activate_prepared_universe",activation),/immediately preceding/);
  const finalize=f.instruction("finalize",[operator,f.registry,f.pool,f.batch,f.methodology,f.pda(Buffer.from("publication"),f.pool.toBuffer()),f.vault,SystemProgram.programId]);
  await checkProtocolLinkage(f.binding,f.linkage,f.transaction([finalize,f.instruction("activate_prepared_universe",activation)]),f.fetch);
  await rejected(checkProtocolLinkage(f.binding,f.linkage,f.transaction([finalize,f.instruction("activate_prepared_universe",activation.map((key,index)=>index===7?stranger:key))]),f.fetch),/account/);
  await rejected(f.check("append_universe_handoff_prices",[...common,anchor],Buffer.concat([num(0,2),num(1,4),num(0,8)])),/price page|zero handoff/);
});

 test("prepared handoff begins only from a fresh accepted empty-price publication", async () => {
  const f=fixture(); f.approval.writeUInt16LE(2,8); f.put(f.nextMethodology,f.method(f.nextCanonical,true));
  const anchor=f.pda(Buffer.from("universe-handoff"),f.pool.toBuffer(),f.nextDigest), keys=[operator,f.registry,f.pool,f.batch,f.methodology,f.nextMethodology,f.schedule,anchor,SystemProgram.programId];
  const clock=Date.now; Date.now=()=>Number(f.timestamp+2n)*1000;
  try { await f.check("begin_universe_handoff",keys); await rejected(f.check("begin_universe_handoff",keys.map((key,index)=>index===7?stranger:key)),/account/); Date.now=()=>Number(f.timestamp+7n)*1000; await rejected(f.check("begin_universe_handoff",keys),/handoff batch/); } finally { Date.now=clock; }
 });

test("prepared approval bounds staging preallocation without changing the current universe", async () => {
  const f = fixture(31);
  f.approval.writeUInt16LE(2, 8);
  f.put(f.batch, Buffer.concat([f.batchBytes, Buffer.alloc(8192 - f.batchBytes.length)]));
  const keys = [operator, f.registry, f.pool, f.batch, SystemProgram.programId];
  await f.check("grow_dynamic_account", keys, num(8192, 4));
  f.put(f.batch, Buffer.concat([f.batchBytes, Buffer.alloc(16384 - f.batchBytes.length)]));
  await rejected(f.check("grow_dynamic_account", keys, num(8192, 4)), /exceeds target bound/);
  f.put(f.batch, Buffer.concat([f.batchBytes, Buffer.alloc(8192 - f.batchBytes.length)]));
  f.approval.writeUInt16LE(1, 8);
  await rejected(f.check("grow_dynamic_account", keys, num(8192, 4)), /prepared universe approval/);
});

test("active batches permit bounded position storage growth but reject batch resizing and foreign positions", async () => {
  const f = fixture(61), owner = Keypair.generate().publicKey;
  const stageOffset = f.root.length - 26;
  assert.equal(f.root[stageOffset], 0);
  f.put(f.pool, Buffer.concat([f.root.subarray(0, stageOffset), num(1, 1), f.batch.toBuffer(), f.root.subarray(stageOffset + 1)]));
  const position = f.pda(Buffer.from("position"), f.pool.toBuffer(), owner.toBuffer());
  const bytes = Buffer.alloc(4096);
  disc("account", "Position").copy(bytes); bytes.writeUInt16LE(1, 8);
  f.pool.toBuffer().copy(bytes, 11); owner.toBuffer().copy(bytes, 43); f.put(position, bytes);
  const keys = [operator, f.registry, f.pool, position, SystemProgram.programId];
  await f.check("grow_dynamic_account", keys, num(4096, 4));
  await f.check("grow_dynamic_account", keys, num(8192, 4));
  f.put(position, Buffer.concat([bytes, Buffer.alloc(4096)]));
  await f.check("grow_dynamic_account", keys, num(4096, 4));
  await rejected(f.check("grow_dynamic_account", keys, num(8193, 4)), /invalid dynamic growth target/);
  await rejected(f.check("grow_dynamic_account", [operator, f.registry, f.pool, f.batch, SystemProgram.programId], num(4096, 4)), /active batch only/);
  f.put(stranger, bytes);
  await rejected(f.check("grow_dynamic_account", [operator, f.registry, f.pool, stranger, SystemProgram.programId], num(4096, 4)), /position growth PDA/);
});
