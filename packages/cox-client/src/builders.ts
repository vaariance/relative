import { Buffer } from "buffer";
import { BN, type Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { addresses } from "./pdas.ts";
import { bytes32 } from "./wire.ts";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const bn = (value: bigint) => new BN(value.toString());
const dynamicClass = (value: number, sentinel = false) => { if (!Number.isInteger(value) || value < 0 || value > 255 && !(sentinel && value === 65535)) throw new Error("InvalidDynamicClass"); };
export interface ManifestConfig { version: string; roster: number[]; origin: bigint; bybit: boolean; feedCheckDigest: Uint8Array }
export interface AdaptiveManifestConfig {
  version: string;
  roster: number[];
  pythFeedIds: number[];
  origin: bigint;
  originPrices: bigint[];
  universeDigest: Uint8Array;
  feedCheckDigest: Uint8Array;
  maxPriceAgeMs: bigint;
  maxFeedAgeMs: bigint;
}
export interface PublishPrice { priceE8: bigint; venue: 0 | 1 | 2; step: 1 | 2 | 3 | 4; candleStart: bigint; tradeAgeMinutes: number }
export interface AdaptivePublishPrice { priceE8: bigint; venue: 3; step: 0; candleStart: bigint; tradeAgeMinutes: 0 }
export interface PoolKeys { pool: PublicKey; vault: PublicKey; testVault?: PublicKey }
export interface OwnerKeys extends PoolKeys { owner: PublicKey; position: PublicKey; request: PublicKey; userToken: PublicKey }
export interface ProcessKeys extends PoolKeys { batch: PublicKey; request: PublicKey; position: PublicKey }
export class CoxInstructions {
  readonly pdas;
  readonly program: Program;
  constructor(program: Program) { this.program = program; this.pdas = addresses(program.programId); }
  private build(name: string, args: object, accounts: Record<string, PublicKey>): TransactionInstruction {
    const definition = this.program.idl.instructions.find(instruction => instruction.name === name);
    if (!definition) throw new Error(`InstructionMissing:${name}`);
    const keys = definition.accounts.map(account => {
      if ("accounts" in account) throw new Error("UnexpectedAccountGroup");
      const pubkey = accounts[account.name];
      if (!pubkey) {
        if (account.optional) return { pubkey: this.program.programId, isSigner: false, isWritable: false };
        throw new Error(`InstructionAccountMissing:${account.name}`);
      }
      return { pubkey, isSigner: account.signer ?? false, isWritable: account.writable ?? false };
    });
    if (Object.keys(accounts).some(name => !definition.accounts.some(account => account.name === name))) throw new Error("UnexpectedInstructionAccounts");
    return new TransactionInstruction({ programId: this.program.programId, keys, data: this.program.coder.instruction.encode(name, args) });
  }
  initializeRegistry(admin: PublicKey, runtime: PublicKey, upgradeAuthority: PublicKey) {
    const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
    const programData = PublicKey.findProgramAddressSync([this.program.programId.toBytes()], loader)[0];
    return this.build("initializeRegistry", { runtime }, { admin, upgradeAuthority, programAccount: this.program.programId, programData, registry: this.pdas.registry(), systemProgram: SystemProgram.programId });
  }
  registerMethodology(admin: PublicKey, digest: Uint8Array, length: number, activationBatch: bigint) {
    return this.build("registerMethodology", { digest: [...bytes32(digest)], length, activationBatch: bn(activationBatch) }, { admin, registry: this.pdas.registry(), methodology: this.pdas.methodology(digest), systemProgram: SystemProgram.programId });
  }
  uploadMethodology(admin: PublicKey, digest: Uint8Array, offset: number, bytes: Uint8Array) {
    return this.build("uploadMethodology", { offset, bytes: Buffer.from(bytes) }, { admin, registry: this.pdas.registry(), methodology: this.pdas.methodology(digest) });
  }
  sealMethodology(admin: PublicKey, digest: Uint8Array, config: ManifestConfig) {
    return this.build("sealMethodology", { config: { ...config, roster: Buffer.from(config.roster), origin: bn(config.origin), feedCheckDigest: [...bytes32(config.feedCheckDigest)] } }, { admin, registry: this.pdas.registry(), methodology: this.pdas.methodology(digest) });
  }
  sealAdaptiveMethodology(admin: PublicKey, digest: Uint8Array, config: AdaptiveManifestConfig) {
    return this.build("sealAdaptiveMethodology", { config: {
      ...config, roster: Buffer.from(config.roster), origin: bn(config.origin),
      originPrices: config.originPrices.map(bn), universeDigest: [...bytes32(config.universeDigest)],
      feedCheckDigest: [...bytes32(config.feedCheckDigest)], maxPriceAgeMs: bn(config.maxPriceAgeMs),
      maxFeedAgeMs: bn(config.maxFeedAgeMs),
    } }, { admin, registry: this.pdas.registry(), methodology: this.pdas.methodology(digest) });
  }
  initializePool(admin: PublicKey, methodology: PublicKey, mint: PublicKey, poolId: bigint) {
    const pool = this.pdas.pool(poolId);
    return this.build("initializePool", { poolId: bn(poolId) }, { admin, registry: this.pdas.registry(), methodology, pool, mint, vault: this.pdas.vault(pool), tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId });
  }
  initializeAdaptivePool(admin: PublicKey, methodology: PublicKey, mint: PublicKey, poolId: bigint, tradingOpensAt: bigint) {
    const pool = this.pdas.pool(poolId);
    return this.build("initializeAdaptivePool", { poolId: bn(poolId), tradingOpensAt: bn(tradingOpensAt) }, { admin, registry: this.pdas.registry(), methodology, pool, mint, vault: this.pdas.vault(pool), tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId });
  }
  initializeDevnetCollateral(admin: PublicKey, keys: PoolKeys, testMint: PublicKey) {
    return this.build("initializeDevnetCollateral", {}, { admin, registry: this.pdas.registry(), pool: keys.pool, vault: keys.vault,
      testMint, testVault: this.pdas.testVault(keys.pool), tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId });
  }
  private submit(name: string, args: object, keys: OwnerKeys) {
    return this.build(name, args, { ...keys, registry: this.pdas.registry(), tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId });
  }
  deposit(keys: OwnerKeys, to: number, amount: bigint, minimumUnits: bigint, expiry: bigint) {
    return this.submit("deposit", { to, amount: bn(amount), minimumUnits: bn(minimumUnits), expiry: bn(expiry) }, keys);
  }
  switch(keys: OwnerKeys, from: number, to: number, units: bigint, minimumUnits: bigint, expiry: bigint) {
    return this.submit("switch", { from, to, units: bn(units), minimumUnits: bn(minimumUnits), expiry: bn(expiry) }, keys);
  }
  redeem(keys: OwnerKeys, from: number, units: bigint, minimumProceeds: bigint, expiry: bigint) {
    return this.submit("redeem", { from, units: bn(units), minimumProceeds: bn(minimumProceeds), expiry: bn(expiry) }, keys);
  }
  depositWithFee(keys: OwnerKeys, to: number, amount: bigint, minimumUnits: bigint, expiry: bigint, expectedFeeVersion: bigint) {
    return this.submit("depositWithFee", { to, amount: bn(amount), minimumUnits: bn(minimumUnits), expiry: bn(expiry), expectedFeeVersion: bn(expectedFeeVersion) }, keys);
  }
  switchWithFee(keys: OwnerKeys, from: number, to: number, units: bigint, minimumUnits: bigint, expiry: bigint, expectedFeeVersion: bigint) {
    return this.submit("switchWithFee", { from, to, units: bn(units), minimumUnits: bn(minimumUnits), expiry: bn(expiry), expectedFeeVersion: bn(expectedFeeVersion) }, keys);
  }
  redeemWithFee(keys: OwnerKeys, from: number, units: bigint, minimumProceeds: bigint, expiry: bigint, expectedFeeVersion: bigint) {
    return this.submit("redeemWithFee", { from, units: bn(units), minimumProceeds: bn(minimumProceeds), expiry: bn(expiry), expectedFeeVersion: bn(expectedFeeVersion) }, keys);
  }
  depositV2(keys: OwnerKeys, to: number, amount: bigint, minimumUnits: bigint, expiry: bigint, expectedFeeVersion: bigint) {
    dynamicClass(to);
    return this.submit("depositV2", { to, amount: bn(amount), minimumUnits: bn(minimumUnits), expiry: bn(expiry), expectedFeeVersion: bn(expectedFeeVersion) }, keys);
  }
  switchV2(keys: OwnerKeys, from: number, to: number, units: bigint, minimumUnits: bigint, expiry: bigint, expectedFeeVersion: bigint) {
    dynamicClass(from); dynamicClass(to);
    return this.submit("switchV2", { from, to, units: bn(units), minimumUnits: bn(minimumUnits), expiry: bn(expiry), expectedFeeVersion: bn(expectedFeeVersion) }, keys);
  }
  redeemV2(keys: OwnerKeys, from: number, units: bigint, minimumProceeds: bigint, expiry: bigint, expectedFeeVersion: bigint) {
    dynamicClass(from);
    return this.submit("redeemV2", { from, units: bn(units), minimumProceeds: bn(minimumProceeds), expiry: bn(expiry), expectedFeeVersion: bn(expectedFeeVersion) }, keys);
  }
  registerDynamicMethodology(admin: PublicKey, digest: Uint8Array, length: number, activationBatch: bigint) {
    return this.build("registerDynamicMethodology", { digest: [...bytes32(digest)], length, activationBatch: bn(activationBatch) }, { admin, registry: this.pdas.registry(), methodology: this.pdas.methodology(digest), systemProgram: SystemProgram.programId });
  }
  sealDynamicMethodology(runtime: PublicKey, pool: PublicKey, methodology: PublicKey, nextMethodology: PublicKey) {
    return this.build("sealDynamicMethodology", {}, { runtime, registry: this.pdas.registry(), pool, methodology, nextMethodology });
  }
  migrateDynamicPool(admin: PublicKey, keys: PoolKeys, methodology: PublicKey, nextMethodology: PublicKey) {
    return this.build("migrateDynamicPool", {}, { admin, registry: this.pdas.registry(), ...keys, methodology, nextMethodology });
  }
  scheduleUniverse(admin: PublicKey, pool: PublicKey, methodology: PublicKey, version: bigint, identitiesDigest: Uint8Array, expectedInstruments: number, activationTimestamp: bigint, expiresAt: bigint) {
    if (!Number.isInteger(expectedInstruments) || expectedInstruments < 31 || expectedInstruments > 255 || activationTimestamp <= 0n || expiresAt < activationTimestamp || expiresAt > activationTimestamp + 86400n) throw new Error("InvalidUniverseSchedule");
    return this.build("scheduleUniverse", { version: bn(version), identitiesDigest: [...bytes32(identitiesDigest)], expectedInstruments, activationTimestamp: bn(activationTimestamp), expiresAt: bn(expiresAt) }, { admin, registry: this.pdas.registry(), pool, methodology, schedule: this.pdas.universeSchedule(pool, version), systemProgram: SystemProgram.programId });
  }
  cancelUniverseSchedule(admin: PublicKey, pool: PublicKey, version: bigint) {
    return this.build("cancelUniverseSchedule", {}, { admin, registry: this.pdas.registry(), pool, schedule: this.pdas.universeSchedule(pool, version) });
  }
  registerScheduledMethodology(runtime: PublicKey, pool: PublicKey, methodology: PublicKey, version: bigint, digest: Uint8Array, length: number) {
    return this.build("registerScheduledMethodology", { digest: [...bytes32(digest)], length }, { runtime, registry: this.pdas.registry(), pool, methodology, schedule: this.pdas.universeSchedule(pool, version), nextMethodology: this.pdas.methodology(digest), systemProgram: SystemProgram.programId });
  }
  uploadScheduledMethodology(runtime: PublicKey, pool: PublicKey, methodology: PublicKey, version: bigint, nextMethodology: PublicKey, offset: number, bytes: Uint8Array) {
    return this.build("uploadScheduledMethodology", { offset, bytes: Buffer.from(bytes) }, { runtime, registry: this.pdas.registry(), pool, methodology, schedule: this.pdas.universeSchedule(pool, version), nextMethodology });
  }
  sealScheduledMethodology(runtime: PublicKey, pool: PublicKey, methodology: PublicKey, version: bigint, nextMethodology: PublicKey) {
    return this.build("sealScheduledMethodology", {}, { runtime, registry: this.pdas.registry(), pool, methodology, schedule: this.pdas.universeSchedule(pool, version), nextMethodology });
  }
  activateUniverse(runtime: PublicKey, keys: PoolKeys, methodology: PublicKey, nextMethodology: PublicKey, version: bigint) {
    return this.build("activateUniverse", {}, { runtime, registry: this.pdas.registry(), ...keys, methodology, nextMethodology, schedule: this.pdas.universeSchedule(keys.pool, version) });
  }
  beginDynamicPublication(keys: PoolKeys & { payer: PublicKey; runtime: PublicKey; methodology: PublicKey }, batchId: bigint, sequence: bigint, predecessor: Uint8Array, snapshot: Uint8Array, benchmark: bigint) {
    return this.build("beginDynamicPublication", { batchId: bn(batchId), sequence: bn(sequence), predecessor: [...bytes32(predecessor)], snapshot: [...bytes32(snapshot)], benchmark: bn(benchmark) }, { ...keys, registry: this.pdas.registry(), batch: this.pdas.batch(keys.pool), systemProgram: SystemProgram.programId });
  }
  appendDynamicPrices(runtime: PublicKey, pool: PublicKey, methodology: PublicKey, offset: number, prices: readonly AdaptivePublishPrice[]) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 254 || prices.length < 1 || prices.length > 16) throw new Error("InvalidDynamicPricePage");
    return this.build("appendDynamicPrices", { offset, prices: prices.map(price => ({ ...price, priceE8: bn(price.priceE8), candleStart: bn(price.candleStart) })) }, { runtime, registry: this.pdas.registry(), pool, methodology, batch: this.pdas.batch(pool) });
  }
  sealDynamicPublication(runtime: PublicKey, pool: PublicKey, methodology: PublicKey) {
    return this.build("sealDynamicPublication", {}, { runtime, registry: this.pdas.registry(), pool, methodology, batch: this.pdas.batch(pool) });
  }
  prepareDynamicRevaluation(runtime: PublicKey, pool: PublicKey, methodology: PublicKey, offset: number, limit = 16) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 254 || !Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("InvalidDynamicRevaluationPage");
    return this.build("prepareDynamicRevaluation", { offset, limit }, { runtime, registry: this.pdas.registry(), pool, methodology, batch: this.pdas.batch(pool) });
  }
  finishDynamicRevaluation(runtime: PublicKey, pool: PublicKey, methodology: PublicKey, offset: number, limit = 16) {
    if (!Number.isInteger(offset) || offset < 0 || offset > 255 || !Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error("InvalidDynamicRevaluationPage");
    return this.build("finishDynamicRevaluation", { offset, limit }, { runtime, registry: this.pdas.registry(), pool, methodology, batch: this.pdas.batch(pool) });
  }
  cancelDynamicPreparation(admin: PublicKey, pool: PublicKey) {
    return this.build("cancelDynamicPreparation", {}, { admin, registry: this.pdas.registry(), pool, batch: this.pdas.batch(pool) });
  }
  growDynamicAccount(payer: PublicKey, pool: PublicKey, target: PublicKey, additionalBytes: number) {
    if (!Number.isInteger(additionalBytes) || additionalBytes <= 0 || additionalBytes > 8192) throw new Error("InvalidDynamicGrowth");
    return this.build("growDynamicAccount", { additionalBytes }, { payer, registry: this.pdas.registry(), pool, target, systemProgram: SystemProgram.programId });
  }
  initializeDynamicPosition(owner: PublicKey, pool: PublicKey) {
    return this.build("initializeDynamicPosition", {}, { owner, pool, position: this.pdas.position(pool, owner), systemProgram: SystemProgram.programId });
  }
  quoteRequestV2(pool: PublicKey, operation: 0 | 1 | 2, from: number, to: number, amount: bigint, units: bigint, expectedFeeVersion: bigint) {
    dynamicClass(from, true); dynamicClass(to, true);
    return this.build("quoteRequestV2", { operation, from, to, amount: bn(amount), units: bn(units), expectedFeeVersion: bn(expectedFeeVersion) }, { pool });
  }
  readReferenceV2(pool: PublicKey, classIndex: number) { dynamicClass(classIndex); return this.build("readReferenceV2", { class: classIndex }, { pool }); }
  cancel(keys: Omit<OwnerKeys, "userToken">) {
    const { owner, ...rest } = keys;
    return this.build("cancel", {}, { ...rest, authority: owner, registry: this.pdas.registry() });
  }
  expire(keys: PoolKeys & { authority: PublicKey; position: PublicKey; request: PublicKey }) {
    return this.build("expire", {}, { ...keys, registry: this.pdas.registry() });
  }
  refund(keys: OwnerKeys) { return this.build("refund", {}, { ...keys, registry: this.pdas.registry(), tokenProgram: TOKEN_PROGRAM }); }
  refundPartial(keys: OwnerKeys, amount: bigint) { return this.build("refundPartial", { amount: bn(amount) }, { ...keys, registry: this.pdas.registry(), tokenProgram: TOKEN_PROGRAM }); }
  withdraw(keys: Omit<OwnerKeys, "request">, amount: bigint) { return this.build("withdraw", { amount: bn(amount) }, { ...keys, registry: this.pdas.registry(), tokenProgram: TOKEN_PROGRAM }); }
  payRetirement(keys: PoolKeys & { position: PublicKey; userToken: PublicKey }) {
    return this.build("payRetirement", {}, { ...keys, tokenProgram: TOKEN_PROGRAM });
  }
  publish(keys: PoolKeys & { payer: PublicKey; runtime: PublicKey; methodology: PublicKey }, batchId: bigint, sequence: bigint, predecessor: Uint8Array, prices: readonly PublishPrice[], snapshot: Uint8Array, archiveTime: bigint) {
    return this.build("publish", { batchId: bn(batchId), sequence: bn(sequence), predecessor: [...bytes32(predecessor)], prices: prices.map(price => ({ ...price, priceE8: bn(price.priceE8), candleStart: bn(price.candleStart) })), snapshot: [...bytes32(snapshot)], archiveTime: bn(archiveTime) },
      { ...keys, registry: this.pdas.registry(), batch: this.pdas.batch(keys.pool), systemProgram: SystemProgram.programId });
  }
  publishAdaptive(keys: PoolKeys & { payer: PublicKey; runtime: PublicKey; methodology: PublicKey }, batchId: bigint, sequence: bigint, predecessor: Uint8Array, prices: readonly AdaptivePublishPrice[], snapshot: Uint8Array, archiveTime: bigint, benchmark: bigint) {
    return this.build("publishAdaptive", { batchId: bn(batchId), sequence: bn(sequence), predecessor: [...bytes32(predecessor)], prices: prices.map(price => ({ ...price, priceE8: bn(price.priceE8), candleStart: bn(price.candleStart) })), snapshot: [...bytes32(snapshot)], archiveTime: bn(archiveTime), benchmark: bn(benchmark) },
      { ...keys, registry: this.pdas.registry(), batch: this.pdas.batch(keys.pool), systemProgram: SystemProgram.programId });
  }
  evaluate(keys: ProcessKeys) { return this.build("evaluate", {}, { ...keys, registry: this.pdas.registry() }); }
  safety(keys: ProcessKeys) { return this.build("safety", {}, { ...keys, registry: this.pdas.registry() }); }
  execute(keys: ProcessKeys) { return this.build("execute", {}, { ...keys, registry: this.pdas.registry() }); }
  sealEvaluation(keys: PoolKeys & { batch: PublicKey }) { return this.build("sealEvaluation", {}, { ...keys, registry: this.pdas.registry() }); }
  finalize(keys: PoolKeys & { batch: PublicKey; methodology: PublicKey; payer: PublicKey }) {
    return this.build("finalize", {}, { ...keys, registry: this.pdas.registry(), publication: this.pdas.publication(keys.pool), systemProgram: SystemProgram.programId });
  }
  materializePosition(keys: PoolKeys & { position: PublicKey }) { return this.build("materializePosition", {}, { ...keys }); }
  readReference(pool: PublicKey, classIndex: number) { return this.build("readReference", { class: classIndex }, { pool }); }
  readPosition(pool: PublicKey, owner: PublicKey) { return this.build("readPosition", { owner }, { pool, position: this.pdas.position(pool, owner) }); }
  quoteRequest(pool: PublicKey, operation: 0 | 1 | 2, from: number, to: number, amount: bigint, units: bigint) { return this.build("quoteRequest", { operation, from, to, amount: bn(amount), units: bn(units) }, { pool }); }
  quoteRequestWithFee(pool: PublicKey, operation: 0 | 1 | 2, from: number, to: number, amount: bigint, units: bigint, expectedFeeVersion: bigint) {
    return this.build("quoteRequestWithFee", { operation, from, to, amount: bn(amount), units: bn(units), expectedFeeVersion: bn(expectedFeeVersion) }, { pool });
  }
  migratePool(admin: PublicKey, keys: PoolKeys) { return this.build("migratePool", {}, { admin, registry: this.pdas.registry(), ...keys }); }
  beginRetirement(admin: PublicKey, keys: PoolKeys) {
    return this.build("beginRetirement", {}, { admin, registry: this.pdas.registry(), ...keys, retirement: this.pdas.retirement(keys.pool), systemProgram: SystemProgram.programId });
  }
  retirePosition(keys: PoolKeys & { position: PublicKey }) {
    return this.build("retirePosition", {}, { ...keys, retirement: this.pdas.retirement(keys.pool) });
  }
  retireRequest(keys: PoolKeys & { authority: PublicKey; request: PublicKey; position: PublicKey }) {
    return this.build("retireRequest", {}, { ...keys, registry: this.pdas.registry() });
  }
  scheduleFees(admin: PublicKey, keys: PoolKeys, bps: number, cap: bigint, activationCutoff: bigint) {
    return this.build("scheduleFees", { bps, cap: bn(cap), activationCutoff: bn(activationCutoff) }, { admin, registry: this.pdas.registry(), pool: keys.pool, vault: keys.vault });
  }
  cancelFees(admin: PublicKey, keys: PoolKeys) { return this.build("cancelFees", {}, { admin, registry: this.pdas.registry(), pool: keys.pool, vault: keys.vault }); }
  withdrawFees(admin: PublicKey, keys: PoolKeys, treasuryToken: PublicKey, amount: bigint) {
    return this.build("withdrawFees", { amount: bn(amount) }, { admin, registry: this.pdas.registry(), ...keys, treasuryToken, tokenProgram: TOKEN_PROGRAM });
  }
  pause(admin: PublicKey) { return this.build("pause", {}, { admin, registry: this.pdas.registry() }); }
  unpause(admin: PublicKey) { return this.build("unpause", {}, { admin, registry: this.pdas.registry() }); }
  rotateRuntime(admin: PublicKey, newRuntime: PublicKey, effectiveBatch: bigint) { return this.build("rotateRuntime", { newRuntime, effectiveBatch: bn(effectiveBatch) }, { admin, registry: this.pdas.registry() }); }
}
