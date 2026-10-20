import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import anchor, { type Idl } from "@coral-xyz/anchor";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import type { Accounts } from "../src/accounts.ts";
import { addresses } from "../src/pdas.ts";
import { decodeAccount } from "../src/readers.ts";
import { auditRetirement } from "../src/retirement.ts";

const idl = JSON.parse(readFileSync(new URL("../../cox/idl/cox.json", import.meta.url), "utf8")) as Idl;
const fixtures = JSON.parse(readFileSync(new URL("../../cox/fixtures/accounts.json", import.meta.url), "utf8")) as {
  accounts: { name: keyof Accounts; address: string; owner: string; dataHex: string }[];
};
const bn = (value: bigint | number) => new anchor.BN(value.toString());
const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const account = (data: Buffer, owner: PublicKey): AccountInfo<Buffer> => ({ data, owner, executable: false, lamports: 100000000, rentEpoch: 0 });

async function setup() {
  const data = new Map<string, AccountInfo<Buffer>>();
  let reads = 0;
  let finalMutation: (() => Promise<void>) | undefined;
  const calls: { keys: PublicKey[]; commitment: string; minContextSlot?: number }[] = [];
  const connection = { getMultipleAccountsInfoAndContext: async (keys: PublicKey[], config: { commitment: string; minContextSlot?: number }) => {
    reads++;
    calls.push({ keys, ...config });
    if (reads === 5) await finalMutation?.();
    return { context: { slot: 100 + reads }, value: keys.map((key) => data.get(key.toBase58()) ?? null) };
  } } as unknown as Connection;
  const program = new anchor.Program(idl, { connection });
  const pdas = addresses(program.programId);
  const fixture = <K extends keyof Accounts>(name: K): Accounts[K] => {
    const value = fixtures.accounts.find((value) => value.name === name)!;
    return decodeAccount(program, name, account(Buffer.from(value.dataHex, "hex"), new PublicKey(value.owner)));
  };
  const put = async <K extends keyof Accounts>(name: K, key: PublicKey, value: Accounts[K]) => {
    const bytes = await program.coder.accounts.encode(name, value);
    data.set(key.toBase58(), account(bytes, program.programId));
  };
  const pool = fixture("pool");
  const poolId = BigInt(pool.poolId.toString());
  const poolKey = pdas.pool(poolId);
  const registry = fixture("registry");
  registry.paused = true;
  pool.schemaVersion = 2;
  pool.registry = pdas.registry();
  pool.vault = pdas.vault(poolKey);
  pool.stage = null;
  pool.initialized = true;
  pool.nextRequestNonce = bn(2);
  pool.classes = [{ backing: bn(3), units: bn(3) }, { backing: bn(0), units: bn(0) }, { backing: bn(0), units: bn(0) }];
  pool.references = [bn(100), bn(100), bn(100)];
  pool.active = bn(3); pool.pending = bn(5); pool.payable = bn(7); pool.residual = bn(1); pool.fees = bn(2);
  const position = fixture("position");
  const owner = position.owner;
  position.pool = poolKey;
  position.bump = PublicKey.findProgramAddressSync([Buffer.from("position"), poolKey.toBytes(), owner.toBytes()], program.programId)[1];
  position.appliedSequence = pool.sequence.sub(bn(1));
  position.classes = [{ units: bn(2), locked: bn(2) }, { units: bn(0), locked: bn(0) }, { units: bn(0), locked: bn(0) }];
  position.payable = bn(6); position.refundable = bn(0);
  position.staged = true; position.stagedSequence = pool.sequence;
  position.stagedBurns = [bn(0), bn(0), bn(0)]; position.stagedMints = [bn(1), bn(0), bn(0)];
  position.stagedUnlocks = [bn(1), bn(0), bn(0)]; position.stagedPayable = bn(1); position.stagedRefundable = bn(5);
  const request = fixture("request");
  request.pool = poolKey; request.owner = owner;
  request.schemaVersion = 2; request.status = 0; request.applied = false;
  request.nonce = bn(0); request.operation = 2; request.from = 0; request.to = 255; request.units = bn(1); request.amount = bn(0);
  request.bump = PublicKey.findProgramAddressSync([Buffer.from("request"), poolKey.toBytes(), Buffer.alloc(8)], program.programId)[1];
  const rejected = { ...request, nonce: bn(1), operation: 0, from: 255, to: 1, units: bn(0), amount: bn(5),
    applied: true, boundSequence: pool.sequence, receiptStatus: 1 };
  const nonceBytes = Buffer.alloc(8); nonceBytes.writeBigUInt64LE(1n);
  rejected.bump = PublicKey.findProgramAddressSync([Buffer.from("request"), poolKey.toBytes(), nonceBytes], program.programId)[1];
  await put("registry", pdas.registry(), registry);
  await put("pool", poolKey, pool);
  await put("position", pdas.position(poolKey, owner), position);
  await put("request", pdas.request(poolKey, 0n), request);
  await put("request", pdas.request(poolKey, 1n), rejected);
  const vault = Buffer.alloc(165);
  pool.collateralMint.toBuffer().copy(vault); poolKey.toBuffer().copy(vault, 32);
  vault.writeBigUInt64LE(18n, 64); vault[108] = 1;
  data.set(pool.vault.toBase58(), account(vault, tokenProgram));
  return { program, pool, poolId, poolKey, registry, position, owner, request, rejected, pdas, data, put, calls,
    mutateOnFinalRead: (fn: () => Promise<void>) => { finalMutation = fn; } };
}

test("retirement audit enumerates request PDAs, materializes lazy entitlements and reconciles every obligation", async () => {
  const s = await setup();
  const report = await auditRetirement(s.program, { poolId: s.poolId, batchSize: 1 });
  assert.equal(report.flags.ready, true);
  assert.equal(report.requestCount, 2);
  assert.equal(report.positionCount, 1);
  assert.equal(report.queuedRequestCount, 1);
  assert.equal(report.totals.pending, 5n);
  assert.equal(report.totals.payable, 7n);
  assert.equal(report.totals.refundable, 5n);
  assert.equal(report.totals.fees, 2n);
  assert.equal(report.totals.positionRetirementPayable, 3n);
  assert.deepEqual(report.totals.classUnits, [3n, 0n, 0n]);
  assert.deepEqual(report.totals.lockedUnits, [1n, 0n, 0n]);
  assert.equal(report.owners[0]?.totalCollateralClaim, 15n);
  assert.ok(s.calls.every((call) => call.commitment === "finalized"));
  assert.ok(s.calls.slice(1).every((call) => call.minContextSlot !== undefined));
});

test("audit fails closed on missing historical requests or forged owner/PDA identities", async () => {
  const missing = await setup();
  missing.data.delete(missing.pdas.request(missing.poolKey, 0n).toBase58());
  await assert.rejects(auditRetirement(missing.program, { poolId: missing.poolId }), /AccountMissing/);
  const forged = await setup();
  forged.request.nonce = bn(9);
  await forged.put("request", forged.pdas.request(forged.poolKey, 0n), forged.request);
  await assert.rejects(auditRetirement(forged.program, { poolId: forged.poolId }), /RequestMismatch/);
  const owner = await setup();
  owner.position.owner = PublicKey.default;
  await owner.put("position", owner.pdas.position(owner.poolKey, owner.owner), owner.position);
  await assert.rejects(auditRetirement(owner.program, { poolId: owner.poolId }), /PdaMismatch|PositionMismatch/);
});

test("audit rejects custody shortfalls, foreign account owners and unreconciled units", async () => {
  const short = await setup();
  short.data.get(short.pool.vault.toBase58())!.data.writeBigUInt64LE(17n, 64);
  await assert.rejects(auditRetirement(short.program, { poolId: short.poolId }), /VaultShortfall/);
  const foreign = await setup();
  foreign.data.get(foreign.pdas.request(foreign.poolKey, 0n).toBase58())!.owner = PublicKey.default;
  await assert.rejects(auditRetirement(foreign.program, { poolId: foreign.poolId }), /AccountOwnerMismatch/);
  const units = await setup();
  units.pool.classes[0]!.units = bn(4);
  await units.put("pool", units.poolKey, units.pool);
  await assert.rejects(auditRetirement(units.program, { poolId: units.poolId }), /LedgerMismatch/);
});

test("audit requires a stable finalized pool snapshot, rejects active batches and bounds enumeration", async () => {
  const changing = await setup();
  changing.mutateOnFinalRead(async () => {
    changing.pool.sequence = changing.pool.sequence.add(bn(1));
    await changing.put("pool", changing.poolKey, changing.pool);
  });
  await assert.rejects(auditRetirement(changing.program, { poolId: changing.poolId, batchSize: 1 }), /StateChanged/);
  const busy = await setup();
  busy.pool.stage = busy.pdas.batch(busy.poolKey);
  await busy.put("pool", busy.poolKey, busy.pool);
  await assert.rejects(auditRetirement(busy.program, { poolId: busy.poolId }), /BatchBusy/);
  const bounded = await setup();
  await assert.rejects(auditRetirement(bounded.program, { poolId: bounded.poolId, maxRequests: 1 }), /RequestLimit/);
  await assert.rejects(auditRetirement(bounded.program, { poolId: bounded.poolId, batchSize: 101 }), /InvalidRetirementAuditBounds/);
});

test("audit reports unpaused readiness and separates donated vault surplus from user claims", async () => {
  const s = await setup();
  s.registry.paused = false;
  await s.put("registry", s.pdas.registry(), s.registry);
  s.data.get(s.pool.vault.toBase58())!.data.writeBigUInt64LE(20n, 64);
  const report = await auditRetirement(s.program, { poolId: s.poolId });
  assert.equal(report.flags.ready, false);
  assert.equal(report.totals.vaultSurplus, 2n);
  assert.equal(report.totals.projectedResidual, 3n);
  assert.equal(report.owners[0]?.totalCollateralClaim, 15n);
});
