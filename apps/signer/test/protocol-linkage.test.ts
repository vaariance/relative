import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { checkProtocolLinkage } from "../src/protocol-linkage.js";
import type { AdaptiveCoxLinkage, EpochLinkage, SolanaProgramBinding } from "../src/config.js";
import type { ChainAccount } from "../src/cox-linkage.js";
import { PolicyRejection } from "../src/policy.js";
const disc = (kind: string, name: string) => createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const operator = Keypair.generate().publicKey;
const admin = Keypair.generate().publicKey;
const holder = Keypair.generate().publicKey;
function fixture() {
  const program = Keypair.generate().publicKey;
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
  const rows = new Map<string, ChainAccount>();
  const put = (key: PublicKey, name: string, size: number) => { const data = Buffer.alloc(size); disc("account", name).copy(data); rows.set(key.toBase58(), { owner: program, data }); return data; };
  const fetch = async (keys: PublicKey[]) => keys.map(key => rows.get(key.toBase58()) ?? null);
  const tx = (name: string, keys: PublicKey[], args = Buffer.alloc(0), payer = operator) => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: SystemProgram.programId.toBase58(), instructions: [new TransactionInstruction({ programId: program, keys: keys.map(pubkey => ({ pubkey, isSigner: pubkey.equals(payer), isWritable: true })), data: Buffer.concat([disc("global", name), args]) })] }).compileToV0Message());
  const binding: SolanaProgramBinding = { programId: program.toBase58(), discriminators: [] };
  return { program, pda, rows, put, fetch, tx, binding };
}
async function refused(call: Promise<void>, pattern: RegExp) { await assert.rejects(call, error => error instanceof PolicyRejection && pattern.test(error.message)); }
function basic(domainName = "COX/METHODOLOGY/ADAPTIVE/V1") {
  const f = fixture();
  const pool = f.pda(Buffer.from("pool"), u64(2n));
  const registry = f.pda(Buffer.from("registry"));
  const domain = Buffer.from(domainName);
  const canonical = Buffer.alloc(4 + domain.length);
  canonical.writeUInt32LE(domain.length);
  domain.copy(canonical, 4);
  const digest = createHash("sha256").update(canonical).digest();
  const methodology = f.pda(Buffer.from("methodology"), digest);
  const vault = f.pda(Buffer.from("vault"), pool.toBuffer());
  const batch = f.pda(Buffer.from("batch"), pool.toBuffer());
  const data = f.put(pool, "Pool", 147);
  data.writeUInt16LE(4, 8);
  data.writeBigUInt64LE(2n, 11);
  registry.toBuffer().copy(data, 19);
  methodology.toBuffer().copy(data, 51);
  vault.toBuffer().copy(data, 115);
  const reg = f.put(registry, "Registry", 75);
  reg.writeUInt16LE(1, 8);
  operator.toBuffer().copy(reg, 43);
  const method = f.put(methodology, "Methodology", 48 + canonical.length);
  method.writeUInt16LE(2, 8);
  digest.copy(method, 11);
  method.writeUInt32LE(canonical.length, 43);
  canonical.copy(method, 47);
  method[47 + canonical.length] = 1;
  const request = f.pda(Buffer.from("request"), pool.toBuffer(), u64(3n));
  const req = f.put(request, "Request", 83);
  req.writeUInt16LE(4, 8);
  pool.toBuffer().copy(req, 11);
  holder.toBuffer().copy(req, 43);
  req.writeBigUInt64LE(3n, 75);
  const position = f.pda(Buffer.from("position"), pool.toBuffer(), holder.toBuffer());
  const linkage: AdaptiveCoxLinkage = { kind: "cox-adaptive-v1", poolId: "2", pool: pool.toBase58(), methodology: methodology.toBase58(), methodologyDigest: digest.toString("hex"), operator: operator.toBase58() };
  const keys = [registry, pool, batch, request, position, vault];
  return { ...f, keys, linkage, req, data, reg, method, request };
}
test("adaptive linkage accepts schema 4 request and rejects nonce, owner, schema and pool forgery", async () => {
  const f = basic();
  await checkProtocolLinkage(f.binding, f.linkage, f.tx("evaluate", f.keys), f.fetch);
  f.req.writeBigUInt64LE(4n, 75);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", f.keys), f.fetch), /nonce/);
  f.req.writeBigUInt64LE(3n, 75);
  Keypair.generate().publicKey.toBuffer().copy(f.req, 43);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", f.keys), f.fetch), /owner position/);
  holder.toBuffer().copy(f.req, 43);
  f.req.writeUInt16LE(5, 8);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", f.keys), f.fetch), /schema/);
  f.req.writeUInt16LE(4, 8);
  f.rows.get(f.request.toBase58())!.owner = Keypair.generate().publicKey;
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", f.keys), f.fetch), /owner/);
  f.data.writeUInt16LE(3, 8);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", f.keys), f.fetch), /schema/);
});
test("adaptive linkage rejects the legacy minute methodology schema and unknown replacements", async () => {
  const f = basic();
  for (const schema of [0, 1, 3]) {
    f.method.writeUInt16LE(schema, 8);
    await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("evaluate", f.keys), f.fetch), /methodology schema 2 required/);
  }
  f.method.writeUInt16LE(2, 8);
  await checkProtocolLinkage(f.binding, f.linkage, f.tx("evaluate", f.keys), f.fetch);
});
test("adaptive linkage refuses a correctly hashed legacy domain even with schema 2", async () => {
  const f = basic("COX/METHODOLOGY/V1");
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("evaluate", f.keys), f.fetch), /adaptive methodology domain/);
});
test("adaptive linkage verifies sealed canonical bytes against the configured digest", async () => {
  const f = basic();
  f.method[51] ^= 1;
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("evaluate", f.keys), f.fetch), /canonical digest mismatch/);
});
test("adaptive linkage binds sealed methodology, operator and complete account list; administration denied", async () => {
  const f = basic();
  f.method[f.method.length - 1] = 0;
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("evaluate", f.keys), f.fetch), /unsealed/);
  f.method[f.method.length - 1] = 1;
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("evaluate", f.keys, Buffer.alloc(0), holder), f.fetch), /operator fee payer/);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("schedule_fees", f.keys), f.fetch), /not adaptive runtime/);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("evaluate", [...f.keys.slice(0, 5), holder]), f.fetch), /vault/);
  operator.toBuffer().copy(f.reg, 43);
  await checkProtocolLinkage(f.binding, f.linkage, f.tx("seal_evaluation", [f.keys[0]!, f.keys[1]!, f.keys[2]!, f.keys[5]!]), f.fetch);
});
function epoch() {
  const f = fixture();
  const config = f.pda(Buffer.from("config"), admin.toBuffer(), u64(4n));
  const digest = Buffer.alloc(32, 8);
  const root = f.put(config, "PoolConfig", 150);
  admin.toBuffer().copy(root, 8);
  root.writeBigUInt64LE(4n, 40);
  operator.toBuffer().copy(root, 48);
  holder.toBuffer().copy(root, 80);
  root[112] = 0;
  digest.copy(root, 113);
  const epoch = f.pda(Buffer.from("epoch"), config.toBuffer(), u64(14400n));
  const vault = f.pda(Buffer.from("vault"), epoch.toBuffer());
  const testVault = f.pda(Buffer.from("test-vault"), epoch.toBuffer());
  const state = f.put(epoch, "EpochAccount", 320);
  config.toBuffer().copy(state, 8);
  state.writeBigUInt64LE(14400n, 40);
  vault.toBuffer().copy(state, 48);
  testVault.toBuffer().copy(state, 80);
  state[117] = 1;
  config.toBuffer().copy(state, 118);
  admin.toBuffer().copy(state, 150);
  operator.toBuffer().copy(state, 182);
  digest.copy(state, 247);
  state.writeBigUInt64LE(14400n, 307);
  const lot = f.pda(Buffer.from("lot"), epoch.toBuffer(), u64(3n));
  const lotData = f.put(lot, "LotAccount", 140);
  epoch.toBuffer().copy(lotData, 8);
  lotData.writeBigUInt64LE(3n, 40);
  lotData[49] = 1;
  config.toBuffer().copy(lotData, 50);
  lotData.writeBigUInt64LE(14400n, 82);
  lotData.writeBigUInt64LE(3n, 90);
  holder.toBuffer().copy(lotData, 98);
  const linkage: EpochLinkage = { kind: "epoch-v1", configId: "4", config: config.toBase58(), admin: admin.toBase58(), operator: operator.toBase58(), methodologyDigest: digest.toString("hex") };
  return { ...f, linkage, root, state, lotData, keys: [config, epoch, lot, vault, testVault] };
}
test("Epoch linkage binds config, sealed epoch, lot nonce and internal ownership identity", async () => {
  const f = epoch();
  await checkProtocolLinkage(f.binding, f.linkage, f.tx("score", f.keys), f.fetch);
  f.lotData.writeBigUInt64LE(9n, 40);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("score", f.keys), f.fetch), /nonce/);
  f.lotData.writeBigUInt64LE(3n, 40);
  holder.toBuffer().copy(f.lotData, 50);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("refund", f.keys), f.fetch), /lot state pool/);
  await refused(checkProtocolLinkage(f.binding, { ...f.linkage, config: holder.toBase58() }, f.tx("score", f.keys), f.fetch), /config PDA/);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("withdraw", f.keys), f.fetch), /not Epoch runtime/);
});
test("Epoch publication binds fresh snapshot PDA, payload length and operator without a preexisting snapshot", async () => {
  const f = epoch();
  const args = Buffer.alloc(86);
  args.writeBigUInt64LE(14401n, 0);
  args.writeUInt32LE(1, 32);
  const snapshot = f.pda(Buffer.from("snapshot"), new PublicKey(f.linkage.config).toBuffer(), u64(14401n));
  const keys = [operator, new PublicKey(f.linkage.config), snapshot, SystemProgram.programId];
  await checkProtocolLinkage(f.binding, f.linkage, f.tx("publish_snapshot", keys, args), f.fetch);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("publish_snapshot", [operator, keys[1]!, holder, SystemProgram.programId], args), f.fetch), /snapshot sequence/);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("publish_snapshot", keys, args.subarray(1)), f.fetch), /payload/);
});
test("Epoch cranks need sealed snapshots with the bound methodology and exact nonce-derived address", async () => {
  const f = epoch();
  const config = new PublicKey(f.linkage.config);
  const snapshot = f.pda(Buffer.from("snapshot"), config.toBuffer(), u64(14401n));
  const data = f.put(snapshot, "SnapshotAccount", 194);
  config.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(14401n, 40);
  Buffer.from(f.linkage.methodologyDigest, "hex").copy(data, 74);
  data.writeUInt32LE(1, 106);
  data[160] = 1;
  const keys = [operator, ...f.keys, snapshot];
  await checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", keys), f.fetch);
  data[160] = 0;
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", keys), f.fetch), /seal/);
  data[160] = 1;
  data[74] ^= 1;
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", keys), f.fetch), /methodology/);
  data[74] ^= 1;
  data.writeBigUInt64LE(14402n, 40);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", keys), f.fetch), /snapshot PDA/);
  for (const name of ["score", "allocate", "refund"])
    await checkProtocolLinkage(f.binding, f.linkage, f.tx(name, f.keys), f.fetch);
  for (const name of ["finalize_scores", "void_epoch"])
    await checkProtocolLinkage(f.binding, f.linkage, f.tx(name, [f.keys[0]!, f.keys[1]!, f.keys[3]!, f.keys[4]!]), f.fetch);
});
test("new linkage configs are explicit, bounded and reject unknown variants without changing live bindings", async () => {
  const { readFileSync, mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadSignerConfig } = await import("../src/config.js");
  const original = JSON.parse(readFileSync(new URL("../config/dev.json", import.meta.url), "utf8"));
  const directory = mkdtempSync(join(tmpdir(), "relative-signer-binding-"));
  const path = join(directory, "config.json");
  const f = basic();
  const value = structuredClone(original);
  value.bindings["oracle-operator"].solana.programs[0].linkage = f.linkage;
  try {
    writeFileSync(path, JSON.stringify(value));
    assert.equal(loadSignerConfig(path).bindings["oracle-operator"]!.solana!.programs[0]!.linkage!.kind, "cox-adaptive-v1");
    value.bindings["oracle-operator"].solana.programs[0].linkage = { ...f.linkage, testCollateralMint: "invalid" };
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => loadSignerConfig(path), /test collateral mint/);
    value.bindings["oracle-operator"].solana.programs[0].linkage = { ...f.linkage, testCollateralMint: holder.toBase58() };
    writeFileSync(path, JSON.stringify(value));
    assert.equal((loadSignerConfig(path).bindings["oracle-operator"]!.solana!.programs[0]!.linkage as AdaptiveCoxLinkage).testCollateralMint, holder.toBase58());
    value.bindings["oracle-operator"].solana.programs[0].linkage = { ...f.linkage, poolId: "18446744073709551616" };
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => loadSignerConfig(path), /adaptive linkage/);
    value.bindings["oracle-operator"].solana.programs[0].linkage = epoch().linkage;
    writeFileSync(path, JSON.stringify(value));
    assert.equal(loadSignerConfig(path).bindings["oracle-operator"]!.solana!.programs[0]!.linkage!.kind, "epoch-v1");
    value.bindings["oracle-operator"].solana.programs[0].linkage = { kind: "epoch-v2" };
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => loadSignerConfig(path), /unknown protocol linkage/);
    assert.equal(original.bindings["oracle-operator"].solana.programs[0].linkage.kind, "cox-v2");
  }
  finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime linkage account indices and discriminator bytes match the generated contract ABIs", async () => {
  const { readFileSync } = await import("node:fs");
  const check = (path: string, expected: Record<string, string[]>) => {
    const idl = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { instructions: { name: string; discriminator: number[]; accounts: { name: string }[] }[] };
    for (const [name, accounts] of Object.entries(expected)) {
      const instruction = idl.instructions.find(value => value.name === name)!;
      assert.deepEqual(instruction.accounts.map(value => value.name), accounts);
      assert.deepEqual(Buffer.from(instruction.discriminator), disc("global", name));
    }
  };
  check("../../../packages/cox/idl/cox.json", {
    publish_adaptive: ["payer", "runtime", "registry", "pool", "methodology", "batch", "vault", "system_program", "test_vault"],
    execute: ["registry", "pool", "batch", "request", "position", "vault", "test_vault"],
    seal_evaluation: ["registry", "pool", "batch", "vault", "test_vault"],
    finalize: ["payer", "registry", "pool", "batch", "methodology", "publication", "vault", "system_program", "test_vault"],
  });
  check("../../../packages/cox-epoch/idl/epoch.json", {
    publish_snapshot: ["operator", "config", "snapshot", "system_program"],
    close_snapshot: ["operator", "config", "snapshot"],
    execute: ["operator", "config", "epoch", "lot", "vault", "test_vault", "snapshot"],
    begin_close: ["operator", "config", "epoch", "vault", "test_vault", "snapshot"],
    score: ["config", "epoch", "lot", "vault", "test_vault"],
    allocate: ["config", "epoch", "lot", "vault", "test_vault"],
    refund: ["config", "epoch", "lot", "vault", "test_vault"],
    finalize_scores: ["config", "epoch", "vault", "test_vault"],
    void_epoch: ["config", "epoch", "vault", "test_vault"],
  });
});

function dualBasic() {
  const f = basic();
  const pool = new PublicKey(f.linkage.pool);
  const mint = Keypair.generate().publicKey;
  const vault = f.pda(Buffer.from("test-vault"), pool.toBuffer());
  const token = Buffer.alloc(165);
  mint.toBuffer().copy(token, 0);
  pool.toBuffer().copy(token, 32);
  token[108] = 1;
  f.rows.set(vault.toBase58(), { owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), data: token });
  return { ...f, linkage: { ...f.linkage, testCollateralMint: mint.toBase58() }, token, vault, mint, pool };
}
test("Basic dual custody pins the optional vault without shifting legacy account indices", async () => {
  const f = dualBasic();
  for (const name of ["evaluate", "safety", "execute"])
    await checkProtocolLinkage(f.binding, f.linkage, f.tx(name, [...f.keys, f.vault]), f.fetch);
  await checkProtocolLinkage(f.binding, f.linkage, f.tx("seal_evaluation", [f.keys[0]!, f.keys[1]!, f.keys[2]!, f.keys[5]!, f.vault]), f.fetch);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", f.keys), f.fetch), /missing test vault/);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", [...f.keys, holder]), f.fetch), /test vault PDA/);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", [...f.keys, f.program]), f.fetch), /test vault PDA/);
  await refused(checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", [...f.keys.slice(0, 5), f.vault, f.keys[5]!]), f.fetch), /test vault PDA/);
  const single = basic();
  await checkProtocolLinkage(single.binding, single.linkage, single.tx("execute", [...single.keys, single.program]), single.fetch);
  await refused(checkProtocolLinkage(single.binding, single.linkage, single.tx("execute", [...single.keys, f.vault]), single.fetch), /sentinel/);
});
test("Basic dual custody rejects wrong token owner, mint, authority and unsafe account state", async () => {
  const f = dualBasic();
  const check = () => checkProtocolLinkage(f.binding, f.linkage, f.tx("execute", [...f.keys, f.vault]), f.fetch);
  const row = f.rows.get(f.vault.toBase58())!;
  const owner = row.owner;
  row.owner = f.program;
  await refused(check(), /token owner/);
  row.owner = owner;
  holder.toBuffer().copy(f.token, 0);
  await refused(check(), /vault mint/);
  f.mint.toBuffer().copy(f.token, 0);
  holder.toBuffer().copy(f.token, 32);
  await refused(check(), /vault authority/);
  f.pool.toBuffer().copy(f.token, 32);
  for (const offset of [72, 109, 129]) {
    f.token.writeUInt32LE(1, offset);
    await refused(check(), /unsafe/);
    f.token.writeUInt32LE(0, offset);
  }
  for (const state of [0, 2]) {
    f.token[108] = state;
    await refused(check(), /unsafe/);
  }
  f.token[108] = 1;
  await check();
  f.mint.toBuffer().copy(f.data, 83);
  await refused(check(), /differ from primary/);
  f.rows.delete(f.vault.toBase58());
  Buffer.alloc(32).copy(f.data, 83);
  await refused(check(), /token owner/);
});
function epochSnapshot() {
  const f = epoch();
  const config = new PublicKey(f.linkage.config);
  const snapshot = f.pda(Buffer.from("snapshot"), config.toBuffer(), u64(14401n));
  const data = f.put(snapshot, "SnapshotAccount", 194);
  config.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(14401n, 40);
  Buffer.from(f.linkage.methodologyDigest, "hex").copy(data, 74);
  data.writeUInt32LE(1, 106);
  data[160] = 1;
  return { ...f, config, snapshot, data };
}
test("Epoch snapshot rent recovery pins recipient, config, sequence, owner, seal and methodology", async () => {
  const f = epochSnapshot();
  const { config, snapshot, data } = f;
  const check = (keys = [operator, config, snapshot], args = Buffer.alloc(0)) => checkProtocolLinkage(f.binding, f.linkage, f.tx("close_snapshot", keys, args), f.fetch);
  await check();
  await refused(check([holder, config, snapshot]), /rent recipient/);
  await refused(check([operator, holder, snapshot]), /close config/);
  await refused(check([operator, config, holder]), /owner/);
  await refused(check([operator, config]), /close accounts/);
  await refused(check(undefined, Buffer.alloc(1)), /runtime args/);
  holder.toBuffer().copy(data, 8);
  await refused(check(), /snapshot config/);
  config.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(14402n, 40);
  await refused(check(), /snapshot PDA/);
  data.writeBigUInt64LE(14401n, 40);
  data[160] = 0;
  await refused(check(), /seal/);
  data[160] = 1;
  data[74] ^= 1;
  await refused(check(), /methodology/);
  data[74] ^= 1;
  f.rows.get(snapshot.toBase58())!.owner = holder;
  await refused(check(), /owner/);
});
test("Epoch snapshot can be published and closed atomically, only after a valid publication", async () => {
  const f = epoch();
  const config = new PublicKey(f.linkage.config);
  const snapshot = f.pda(Buffer.from("snapshot"), config.toBuffer(), u64(14401n));
  const args = Buffer.alloc(86);
  args.writeBigUInt64LE(14401n, 0);
  args.writeUInt32LE(1, 32);
  const publish = TransactionMessage.decompile(f.tx("publish_snapshot", [operator, config, snapshot, SystemProgram.programId], args).message).instructions[0]!;
  const close = TransactionMessage.decompile(f.tx("close_snapshot", [operator, config, snapshot]).message).instructions[0]!;
  const combine = (instructions: TransactionInstruction[]) => new VersionedTransaction(new TransactionMessage({ payerKey: operator, recentBlockhash: SystemProgram.programId.toBase58(), instructions }).compileToV0Message());
  await checkProtocolLinkage(f.binding, f.linkage, combine([publish, close]), f.fetch);
  await refused(checkProtocolLinkage(f.binding, f.linkage, combine([close, publish]), f.fetch), /owner/);
  publish.keys[1]!.pubkey = holder;
  await refused(checkProtocolLinkage(f.binding, f.linkage, combine([publish, close]), f.fetch), /snapshot config/);
});
