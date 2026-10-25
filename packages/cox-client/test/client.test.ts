import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import anchor, { type Idl } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, type AccountInfo, type VersionedTransaction } from "@solana/web3.js";
import { CoxInstructions } from "../src/builders.ts";
import { CoxReader, checkedPublication, committedPosition, committedRequest, decodeAccount } from "../src/readers.ts";
import { addresses } from "../src/pdas.ts";
import { discriminator } from "../src/wire.ts";
import type { Accounts } from "../src/accounts.ts";
import { CoxSimulations } from "../src/simulations.ts";

interface Fixture { name: keyof Accounts; address: string; owner: string; dataHex: string }
const idl = JSON.parse(readFileSync(new URL("../../cox/idl/cox.json", import.meta.url), "utf8")) as Idl;
const fixtures = JSON.parse(readFileSync(new URL("../../cox/fixtures/accounts.json", import.meta.url), "utf8")) as { programAddress: string; accounts: Fixture[] };
const info = (value: Fixture): AccountInfo<Buffer> => ({ owner: new PublicKey(value.owner), data: Buffer.from(value.dataHex, "hex"), executable: false, lamports: 100000000, rentEpoch: 0 });
const connection = { getAccountInfo: async (key: PublicKey) => {
  const value = fixtures.accounts.find(value => value.address === key.toBase58());
  return value ? info(value) : null;
} } as Connection;
const program = new anchor.Program(idl, { connection });
const reader = new CoxReader(program);
const builder = new CoxInstructions(program);
const fixture = <K extends keyof Accounts>(name: K) => {
  const value = fixtures.accounts.find(value => value.name === name);
  assert.ok(value, `Missing ${name} SBF fixture`);
  return { key: new PublicKey(value.address), account: decodeAccount(program, name, info(value)), info: info(value) };
};

test("retirement builders match generated ABI and permissionless payout has no owner-signing requirement", () => {
  const pool = fixture("pool");
  const owner = fixture("position").account.owner;
  const keys = { pool: pool.key, vault: pool.account.vault };
  const calls = [
    builder.beginRetirement(owner, keys),
    builder.retirePosition({ ...keys, position: reader.pdas.position(pool.key, owner) }),
    builder.retireRequest({ ...keys, authority: owner, position: reader.pdas.position(pool.key, owner), request: fixture("request").key }),
    builder.payRetirement({ ...keys, position: reader.pdas.position(pool.key, owner), userToken: pool.account.vault }),
  ];
  for (const [index, name] of ["beginRetirement", "retirePosition", "retireRequest", "payRetirement"].entries()) {
    const instruction = calls[index]!;
    const definition = program.idl.instructions.find(value => value.name === name)!;
    assert.deepEqual(instruction.data, discriminator("global", name.replace(/[A-Z]/g, letter => "_" + letter.toLowerCase())));
    assert.equal(instruction.keys.length, definition.accounts.length);
    assert.ok(definition.accounts.every(account => account.name !== "recipient"));
    if (name === "retirePosition" || name === "payRetirement") assert.ok(instruction.keys.every(key => !key.isSigner));
  }
});

test("retired schema preserves the existing pool layout and committed fee fields", () => {
  const release = JSON.parse(readFileSync(new URL("../../cox/fixtures/fee-accounts.json", import.meta.url), "utf8")) as { accounts: Fixture[] };
  const value = release.accounts.find(value => value.name === "pool")!;
  const original = info(value);
  const retired = { ...original, data: Buffer.from(original.data) };
  retired.data.writeUInt16LE(3, 8);
  const before = decodeAccount(program, "pool", original);
  const after = decodeAccount(program, "pool", retired);
  assert.equal(after.schemaVersion, 3);
  assert.equal(after.fees.toString(), before.fees.toString());
  assert.equal(after.active.toString(), before.active.toString());
  assert.deepEqual(after.classes, before.classes);
});

test("actual SBF account bytes decode with the generated Anchor IDL", () => {
  assert.equal(program.programId.toBase58(), fixtures.programAddress);
  for (const name of ["registry", "methodology", "pool", "position", "request", "batch", "publication"] as const) {
    const value = fixture(name);
    assert.equal(value.account.schemaVersion, name === "batch" || name === "publication" ? 2 : 1);
    assert.throws(() => decodeAccount(program, name, { ...value.info, owner: PublicKey.default }), /AccountOwnerMismatch/);
    const damaged = Buffer.from(value.info.data); damaged[0] ^= 255;
    assert.throws(() => decodeAccount(program, name, { ...value.info, data: damaged }));
    const wrongVersion = Buffer.from(value.info.data);
    wrongVersion[8] = 255;
    assert.throws(() => decodeAccount(program, name, { ...value.info, data: wrongVersion }), /AccountVersionMismatch/);
  }
});

test("compiled fee accounts decode with committed custody and V2 publication identity", () => {
  const release = JSON.parse(readFileSync(new URL("../../cox/fixtures/fee-accounts.json", import.meta.url), "utf8")) as { accounts: Fixture[] };
  const account = <K extends keyof Accounts>(name: K): Accounts[K] => {
    const value = release.accounts.find(value => value.name === name)!;
    return decodeAccount(program, name, info(value));
  };
  const pool = account("pool"), request = account("request"), batch = account("batch");
  assert.equal(pool.schemaVersion, 2);
  assert.equal(request.schemaVersion, 2);
  assert.equal(batch.schemaVersion, 3);
  assert.equal(pool.feeBps, 2);
  assert.ok(pool.fees.gtn(0));
  assert.equal(request.fee.toString(), request.gross.muln(2).divn(10000).toString());
  const key = release.accounts.find(value => value.name === "pool")!;
  const publication = checkedPublication(program.programId, new PublicKey(key.address), account("publication"));
  assert.equal(publication.schemaVersion, 3);
  assert.equal(publication.state.feeState!.fees.toString(), pool.fees.toString());
  assert.equal(publication.state.feeState!.batchFees.toString(), batch.fees.toString());
});
test("checked readers validate live account identities and publication preimage", async () => {
  const { account: pool } = fixture("pool");
  const id = BigInt(pool.poolId.toString());
  await reader.registry();
  await reader.pool(id);
  await reader.methodology(pool.methodology);
  const { account: position } = fixture("position");
  await reader.position(id, position.owner);
  const { account: request } = fixture("request");
  await reader.request(id, BigInt(request.nonce.toString()));
  const { account: batch } = fixture("batch");
  await reader.batch(id, BigInt(batch.batchId.toString()));
  const { account: publication } = fixture("publication");
  const value = await reader.publication(id, BigInt(publication.sequence.toString()));
  assert.equal(value.state.sequence.toString(), publication.sequence.toString());
});
test("rolling account addresses are fixed per pool and historical requests fail explicitly", async () => {
  const pdas = addresses(program.programId);
  const { account: pool, key } = fixture("pool");
  const { account: batch, key: batchKey } = fixture("batch");
  const { account: publication, key: publicationKey } = fixture("publication");
  assert.ok(pdas.batch(key).equals(batchKey));
  assert.ok(pdas.publication(key).equals(publicationKey));
  const otherPool = pdas.pool(BigInt(pool.poolId.toString()) + 1n);
  assert.ok(!pdas.batch(otherPool).equals(batchKey));
  assert.ok(!pdas.publication(otherPool).equals(publicationKey));
  await assert.rejects(reader.batch(BigInt(pool.poolId.toString()), BigInt(batch.batchId.toString()) + 1n), /CoxHistoryNotRetained/);
  await assert.rejects(reader.publication(BigInt(pool.poolId.toString()), BigInt(publication.sequence.toString()) + 1n), /CoxHistoryNotRetained/);
});
test("archived publication verification rejects altered identity, preimage and prices", () => {
  const { key } = fixture("pool");
  const { account: publication } = fixture("publication");
  assert.equal(checkedPublication(program.programId, key, publication).state.sequence.toString(), publication.sequence.toString());
  assert.throws(() => checkedPublication(PublicKey.default, key, publication), /PublicationStateMismatch/);
  assert.throws(() => checkedPublication(program.programId, PublicKey.default, publication), /PublicationIdentityMismatch/);
  assert.throws(() => checkedPublication(program.programId, key, { ...publication, schemaVersion: 1 }), /AccountVersionMismatch/);
  assert.throws(() => checkedPublication(program.programId, key, { ...publication, sequence: publication.sequence.addn(1) }), /PublicationStateMismatch/);
  const preimage = [...publication.statePreimage]; preimage[0] = preimage[0]! ^ 1;
  assert.throws(() => checkedPublication(program.programId, key, { ...publication, statePreimage: preimage }), /PublicationIdentityMismatch/);
  const prices = publication.prices.map((price, index) => index === 0 ? { ...price, priceE8: price.priceE8.addn(1) } : price);
  assert.throws(() => checkedPublication(program.programId, key, { ...publication, prices }), /PublicationPriceMismatch/);
});
test("staged credits remain unavailable until global finalization and apply once", () => {
  const { account: pool } = fixture("pool");
  const { account: position } = fixture("position");
  const zero = new anchor.BN(0), one = new anchor.BN(1);
  const staged = { ...position, appliedSequence: pool.sequence, staged: true, stagedSequence: pool.sequence.add(one), stagedBurns: position.classes.map(() => zero), stagedMints: position.classes.map(() => one), stagedUnlocks: position.classes.map(() => zero), stagedPayable: one, stagedRefundable: one };
  assert.equal(committedPosition(staged, pool), staged);
  const committed = committedPosition(staged, { ...pool, sequence: staged.stagedSequence });
  assert.equal(committed.payable.toString(), position.payable.add(one).toString());
  assert.equal(committed.classes[0]!.units.toString(), position.classes[0]!.units.add(one).toString());
  assert.equal(committedPosition(committed, { ...pool, sequence: staged.stagedSequence }), committed);
  assert.throws(() => committedPosition({ ...position, appliedSequence: pool.sequence.add(one) }, pool), /InconsistentRead/);
  const { account: request } = fixture("request");
  const stagedRequest = { ...request, status: 0, applied: true, boundSequence: pool.sequence.add(one), receiptStatus: 4 };
  assert.equal(committedRequest(stagedRequest, pool).status, 0);
  assert.equal(committedRequest(stagedRequest, { ...pool, sequence: stagedRequest.boundSequence }).status, 7);
});
test("every unsigned builder uses actual IDL account flags and instruction bytes", () => {
  const { key: pool, account: state } = fixture("pool");
  const { key: position, account: ownerState } = fixture("position");
  const { key: request } = fixture("request");
  const { key: batch } = fixture("batch");
  const owner = ownerState.owner, vault = state.vault, methodology = state.methodology;
  const userToken = PublicKey.default;
  const keys = { owner, pool, vault, position, request, userToken };
  const process = { pool, vault, position, request, batch };
  const digest = Buffer.alloc(32, 1);
  const instructions = [
    builder.initializeRegistry(owner, PublicKey.default, owner), builder.registerMethodology(owner, digest, 100, 0n), builder.uploadMethodology(owner, digest, 0, Buffer.from([1, 2])),
    builder.sealMethodology(owner, digest, { version: "test", roster: [0, 1], origin: 1800000000n, bybit: false, feedCheckDigest: digest }), builder.initializePool(owner, methodology, state.collateralMint, 0n),
    builder.deposit(keys, 0, 1n, 0n, 99n), builder.switch(keys, 0, 1, 1n, 0n, 99n), builder.redeem(keys, 0, 1n, 0n, 99n),
    builder.cancel({ owner, pool, vault, position, request }), builder.expire({ authority: owner, pool, vault, position, request }), builder.refund(keys), builder.withdraw({ owner, pool, vault, position, userToken }, 1n),
    builder.publish({ pool, vault, payer: owner, runtime: owner, methodology }, 1n, 1n, digest, [{ priceE8: 1n, venue: 0, step: 1, candleStart: 1800000000n, tradeAgeMinutes: 0 }], digest, 1800000060n),
    builder.evaluate(process), builder.safety(process), builder.sealEvaluation({ pool, vault, batch }), builder.execute(process), builder.finalize({ pool, vault, batch, methodology, payer: owner }),
    builder.materializePosition({ pool, vault, position }), builder.readReference(pool, 0), builder.readPosition(pool, owner), builder.quoteRequest(pool, 0, 255, 0, 1n, 0n),
    builder.pause(owner), builder.unpause(owner), builder.rotateRuntime(owner, PublicKey.default, 99n)
  ];
  for (const instruction of instructions) {
    const decoded = new anchor.BorshInstructionCoder(program.idl).decode(instruction.data);
    assert.ok(decoded);
    const definition = program.idl.instructions.find(value => value.name === decoded.name)!;
    assert.deepEqual([...instruction.data.subarray(0, 8)], definition.discriminator);
    assert.equal(instruction.keys.length, definition.accounts.length);
    instruction.keys.forEach((key, index) => {
      const account = definition.accounts[index]!;
      assert.ok(!("accounts" in account));
      assert.equal(key.isSigner, account.signer ?? false); assert.equal(key.isWritable, account.optional && key.pubkey.equals(program.programId) ? false : account.writable ?? false);
    });
  }
  assert.equal(instructions[12]!.data.subarray(0, 8).toString("hex"), discriminator("global", "publish").toString("hex"));
});
test("fee-aware and treasury builders match the generated program ABI", () => {
  const { key: pool, account: state } = fixture("pool");
  const { key: position, account: owned } = fixture("position");
  const { key: request } = fixture("request");
  const keys = { pool, vault: state.vault }, ownerKeys = { ...keys, owner: owned.owner, position, request, userToken: PublicKey.default };
  const instructions = [builder.depositWithFee(ownerKeys, 2, 1000000n, 1n, 99n, 7n),
    builder.switchWithFee(ownerKeys, 0, 2, 1000000000000n, 1n, 99n, 7n),
    builder.redeemWithFee(ownerKeys, 2, 1000000000000n, 999800n, 99n, 7n),
    builder.quoteRequestWithFee(pool, 0, 255, 2, 1000000n, 0n, 7n), builder.migratePool(owned.owner, keys),
    builder.scheduleFees(owned.owner, keys, 2, 2000000n, 1800086400n), builder.cancelFees(owned.owner, keys),
    builder.withdrawFees(owned.owner, keys, PublicKey.default, 200n)];
  for (const instruction of instructions) {
    const decoded = new anchor.BorshInstructionCoder(program.idl).decode(instruction.data)!;
    const definition = program.idl.instructions.find(value => value.name === decoded.name)!;
    assert.deepEqual([...instruction.data.subarray(0, 8)], definition.discriminator);
    assert.equal(instruction.keys.length, definition.accounts.length);
    instruction.keys.forEach((key, i) => {
      const account = definition.accounts[i]!;
      assert.ok(!("accounts" in account)); assert.equal(key.isSigner, account.signer ?? false); assert.equal(key.isWritable, account.optional && key.pubkey.equals(program.programId) ? false : account.writable ?? false);
    });
    if ("expectedFeeVersion" in decoded.data) assert.equal((decoded.data.expectedFeeVersion as anchor.BN).toString(), "7");
  }
  const withdrawal = instructions.at(-1)!;
  assert.equal(withdrawal.keys.filter(key => key.isSigner).length, 1);
  assert.ok(withdrawal.keys.find(key => key.isSigner)!.pubkey.equals(owned.owner));
});
test("legacy accounts decode without requiring appended fee bytes", () => {
  for (const name of ["pool", "request", "batch"] as const) {
    const value = fixture(name);
    const legacyIdl = structuredClone(program.idl);
    const feeFields = name === "pool" ? ["feeVersion", "feeBps", "feeCap", "fees", "feeNextVersion", "feePending", "feePendingVersion", "feePendingBps", "feePendingCap", "feePendingCutoff", "feeInitialScheduled", "tradingOpensAt"] : name === "request" ? ["feeVersion", "feeBps", "feeCap", "gross", "fee"] : ["fees"];
    const type = legacyIdl.types!.find(type => type.name === name)!;
    assert.equal(type.type.kind, "struct");
    if (type.type.kind !== "struct" || !type.type.fields || !type.type.fields.every(field => typeof field === "object" && "name" in field)) throw new Error("InvalidFixtureType");
    type.type.fields = type.type.fields.filter(field => typeof field === "object" && "name" in field && !feeFields.includes(field.name));
    const coder = new anchor.BorshAccountsCoder(legacyIdl);
    const layouts = coder as unknown as { accountLayouts: Map<string, { layout: { encode(value: unknown, data: Buffer): number }; discriminator: number[] }> };
    const entry = layouts.accountLayouts.get(name)!;
    const bytes = Buffer.alloc(4096); Buffer.from(entry.discriminator).copy(bytes);
    const length = entry.layout.encode(value.account, bytes.subarray(8));
    const decoded = decodeAccount(program, name, { ...value.info, data: bytes.subarray(0, length + 8) });
    assert.equal(decoded.schemaVersion, name === "batch" ? 2 : 1);
    if (name === "pool") assert.equal((decoded as Accounts["pool"]).fees.toString(), "0");
    if (name === "request") assert.equal((decoded as Accounts["request"]).fee.toString(), "0");
    if (name === "batch") assert.equal((decoded as Accounts["batch"]).fees.toString(), "0");
  }
});
test("read simulations stay unsigned and reject return data from another program", async () => {
  const { key: pool } = fixture("pool");
  const { account: position } = fixture("position");
  let wrongProgram = false;
  const simulationConnection = {
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 }),
    simulateTransaction: async (transaction: VersionedTransaction, config: { sigVerify: boolean }) => {
      assert.equal(config.sigVerify, false);
      assert.ok(transaction.signatures.every(signature => signature.every(byte => byte === 0)));
      const quote = { sequence: new anchor.BN(1), minted: new anchor.BN(2), proceeds: new anchor.BN(3) };
      return { value: { err: null, returnData: { programId: wrongProgram ? PublicKey.default.toBase58() : program.programId.toBase58(), data: [program.coder.types.encode("quoteRead", quote).toString("base64"), "base64"] } } };
    }
  } as unknown as Connection;
  const simulations = new CoxSimulations(new anchor.Program(idl, { connection: simulationConnection }), position.owner);
  assert.equal((await simulations.quote(pool, 0, 255, 0, 1n, 0n)).minted.toString(), "2");
  wrongProgram = true;
  await assert.rejects(() => simulations.quote(pool, 0, 255, 0, 1n, 0n), /InvalidSimulationReturnData/);
});
test("thirty-price publication fits a legacy packet with a separate payer", () => {
  const { key: pool, account: state } = fixture("pool");
  const { account: registry } = fixture("registry");
  const { account: position } = fixture("position");
  assert.ok(!registry.runtime.equals(position.owner));
  const prices = Array.from({ length: 30 }, () => ({ priceE8: 100000000n, venue: 0 as const, step: 1 as const, candleStart: 1800000000n, tradeAgeMinutes: 0 }));
  const instruction = builder.publish({ pool, vault: state.vault, methodology: state.methodology, payer: position.owner, runtime: registry.runtime }, 1n, 1n, Buffer.alloc(32), prices, Buffer.alloc(32), 1800000060n);
  const transaction = new Transaction({ feePayer: position.owner, recentBlockhash: PublicKey.default.toBase58() }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0n }), instruction);
  assert.equal(instruction.data.length, 700);
  assert.equal(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length, 1219);
});


test("adaptive pool initializer binds the immutable admission timestamp in its signed ABI", () => {
  const { account: pool } = fixture("pool");
  const owner = fixture("position").account.owner;
  const opensAt = 1792627200n;
  const instruction = builder.initializeAdaptivePool(owner, pool.methodology, pool.collateralMint, 7n, opensAt);
  assert.deepEqual(instruction.data, Buffer.concat([discriminator("global", "initialize_adaptive_pool"), Buffer.from("0700000000000000", "hex"), Buffer.from("0052d96a00000000", "hex")]));
  const decoded = new anchor.BorshInstructionCoder(program.idl).decode(instruction.data)!;
  assert.equal(decoded.name, "initializeAdaptivePool");
  assert.equal((decoded.data as { poolId: anchor.BN }).poolId.toString(), "7");
  assert.equal((decoded.data as { tradingOpensAt: anchor.BN }).tradingOpensAt.toString(), opensAt.toString());
  assert.ok(instruction.keys.some(value => value.pubkey.equals(builder.pdas.pool(7n))));
});

test("legacy and retired pools default their reserved admission field to zero", () => {
  assert.equal(fixture("pool").account.tradingOpensAt.toString(), "0");
  const release = JSON.parse(readFileSync(new URL("../../cox/fixtures/fee-accounts.json", import.meta.url), "utf8")) as { accounts: Fixture[] };
  const value = release.accounts.find(value => value.name === "pool")!;
  for (const schema of [2, 3]) {
    const bytes = Buffer.from(value.dataHex, "hex"); bytes.writeUInt16LE(schema, 8);
    assert.equal(decodeAccount(program, "pool", { ...info(value), data: bytes }).tradingOpensAt.toString(), "0");
  }
});

test("adaptive methodology seal encodes exact feed and origin bindings with schema-two readers", () => {
  const config = { version: "relative-adaptive-v1", roster: [0, 1], pythFeedIds: [1, 2],
    origin: 120001n, originPrices: [100000000n, 200000000n], universeDigest: Buffer.alloc(32, 43),
    feedCheckDigest: Buffer.alloc(32, 42), maxPriceAgeMs: 5000n, maxFeedAgeMs: 60000n };
  const digest = Buffer.alloc(32, 7), admin = PublicKey.default;
  const instruction = builder.sealAdaptiveMethodology(admin, digest, config);
  const decoded = new anchor.BorshInstructionCoder(program.idl).decode(instruction.data)!;
  assert.equal(decoded.name, "sealAdaptiveMethodology");
  const data = (decoded.data as { config: { roster: Buffer; pythFeedIds: number[]; origin: anchor.BN; originPrices: anchor.BN[]; maxPriceAgeMs: anchor.BN } }).config;
  assert.deepEqual([...data.roster], config.roster);
  assert.deepEqual(data.pythFeedIds, config.pythFeedIds);
  assert.equal(data.origin.toString(), "120001");
  assert.deepEqual(data.originPrices.map(value => value.toString()), ["100000000", "200000000"]);
  assert.equal(data.maxPriceAgeMs.toString(), "5000");
  const original = fixture("methodology");
  const bytes = Buffer.from(original.info.data);
  bytes.writeUInt16LE(2, 8);
  assert.equal(decodeAccount(program, "methodology", { ...original.info, data: bytes }).schemaVersion, 2);
});

test("dual-collateral pool keys do not add custody accounts to fee configuration", () => {
  const { account: state, key: pool } = fixture("pool");
  const owner = fixture("position").account.owner;
  const primary = { pool, vault: state.vault };
  const dual = { ...primary, testVault: addresses(program.programId).testVault(pool) };
  for (const [left, right] of [
    [builder.scheduleFees(owner, primary, 2, 200000n, 1800086400n), builder.scheduleFees(owner, dual, 2, 200000n, 1800086400n)],
    [builder.cancelFees(owner, primary), builder.cancelFees(owner, dual)],
  ]) {
    assert.deepEqual(left, right);
  }
});

test("dynamic positions materialize old staged credits before appending zero class balances", () => {
  const originalPool = fixture("pool").account;
  const originalPosition = fixture("position").account;
  const pool = { ...originalPool, schemaVersion: 5, initialized: true, sequence: originalPosition.appliedSequence.addn(1),
    classes: [...originalPool.classes, { backing: new anchor.BN(0), units: new anchor.BN(0) }] };
  const position = { ...originalPosition, staged: true, stagedSequence: pool.sequence.addn(1),
    stagedBurns: originalPosition.classes.map(() => new anchor.BN(0)), stagedMints: originalPosition.classes.map(() => new anchor.BN(7)),
    stagedUnlocks: originalPosition.classes.map(() => new anchor.BN(0)), stagedPayable: new anchor.BN(11), stagedRefundable: new anchor.BN(13) };
  const pending = committedPosition(position, pool);
  assert.equal(pending.classes[0]!.units.toString(), originalPosition.classes[0]!.units.toString());
  assert.equal(pending.classes.at(-1)!.units.toString(), "0");
  assert.equal(pending.payable.toString(), position.payable.toString());
  const finalized = committedPosition(position, { ...pool, sequence: position.stagedSequence });
  assert.equal(finalized.classes[0]!.units.toString(), originalPosition.classes[0]!.units.addn(7).toString());
  assert.equal(finalized.classes.at(-1)!.units.toString(), "0");
  assert.equal(finalized.payable.toString(), position.payable.addn(11).toString());
  assert.equal(position.classes.length, originalPosition.classes.length);
});

test("large dynamic position simulations fail with account-reader guidance before requesting a blockhash", async () => {
  const value = fixture("pool"), owner = fixture("position").account.owner;
  const compiled = JSON.parse(readFileSync(new URL("../../cox/fixtures/generation/active.json", import.meta.url), "utf8")) as { accounts: { name: string; address: string; owner: string; dataHex: string }[] };
  const pool = compiled.accounts.find(row => row.name === "pool")!;
  let reads = 0;
  const poolKey = new PublicKey(pool.address);
  const connection = { getAccountInfo: async (key: PublicKey) => { reads++; assert.ok(key.equals(poolKey)); return { ...value.info, data: Buffer.from(pool.dataHex, "hex") }; },
    getLatestBlockhash: async () => { throw new Error("UnnecessaryBlockhashRequest"); } } as unknown as Connection;
  const dynamic = new anchor.Program(program.idl, { connection });
  await assert.rejects(new CoxSimulations(dynamic, owner).position(poolKey, owner), /CoxPositionSimulationLimit:UseCoxReader.position/);
  assert.equal(reads, 1);
});
