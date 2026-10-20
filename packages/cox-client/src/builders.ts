import { Buffer } from "buffer";
import { BN, type Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { addresses } from "./pdas.ts";
import { bytes32 } from "./wire.ts";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const bn = (value: bigint) => new BN(value.toString());
export interface ManifestConfig { version: string; roster: number[]; origin: bigint; bybit: boolean; feedCheckDigest: Uint8Array }
export interface PublishPrice { priceE8: bigint; venue: 0 | 1 | 2; step: 1 | 2 | 3 | 4; candleStart: bigint; tradeAgeMinutes: number }
export interface PoolKeys { pool: PublicKey; vault: PublicKey }
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
      if (!pubkey) throw new Error(`InstructionAccountMissing:${account.name}`);
      return { pubkey, isSigner: account.signer ?? false, isWritable: account.writable ?? false };
    });
    if (Object.keys(accounts).length !== definition.accounts.length) throw new Error("UnexpectedInstructionAccounts");
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
  initializePool(admin: PublicKey, methodology: PublicKey, mint: PublicKey, poolId: bigint) {
    const pool = this.pdas.pool(poolId);
    return this.build("initializePool", { poolId: bn(poolId) }, { admin, registry: this.pdas.registry(), methodology, pool, mint, vault: this.pdas.vault(pool), tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId });
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
  cancel(keys: Omit<OwnerKeys, "userToken">) {
    const { owner, ...rest } = keys;
    return this.build("cancel", {}, { ...rest, authority: owner, registry: this.pdas.registry() });
  }
  expire(keys: PoolKeys & { authority: PublicKey; position: PublicKey; request: PublicKey }) {
    return this.build("expire", {}, { ...keys, registry: this.pdas.registry() });
  }
  refund(keys: OwnerKeys) { return this.build("refund", {}, { ...keys, registry: this.pdas.registry(), tokenProgram: TOKEN_PROGRAM }); }
  withdraw(keys: Omit<OwnerKeys, "request">, amount: bigint) { return this.build("withdraw", { amount: bn(amount) }, { ...keys, registry: this.pdas.registry(), tokenProgram: TOKEN_PROGRAM }); }
  payRetirement(keys: PoolKeys & { position: PublicKey; userToken: PublicKey }) {
    return this.build("payRetirement", {}, { ...keys, tokenProgram: TOKEN_PROGRAM });
  }
  publish(keys: PoolKeys & { payer: PublicKey; runtime: PublicKey; methodology: PublicKey }, batchId: bigint, sequence: bigint, predecessor: Uint8Array, prices: readonly PublishPrice[], snapshot: Uint8Array, archiveTime: bigint) {
    return this.build("publish", { batchId: bn(batchId), sequence: bn(sequence), predecessor: [...bytes32(predecessor)], prices: prices.map(price => ({ ...price, priceE8: bn(price.priceE8), candleStart: bn(price.candleStart) })), snapshot: [...bytes32(snapshot)], archiveTime: bn(archiveTime) },
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
    return this.build("scheduleFees", { bps, cap: bn(cap), activationCutoff: bn(activationCutoff) }, { admin, registry: this.pdas.registry(), ...keys });
  }
  cancelFees(admin: PublicKey, keys: PoolKeys) { return this.build("cancelFees", {}, { admin, registry: this.pdas.registry(), ...keys }); }
  withdrawFees(admin: PublicKey, keys: PoolKeys, treasuryToken: PublicKey, amount: bigint) {
    return this.build("withdrawFees", { amount: bn(amount) }, { admin, registry: this.pdas.registry(), ...keys, treasuryToken, tokenProgram: TOKEN_PROGRAM });
  }
  pause(admin: PublicKey) { return this.build("pause", {}, { admin, registry: this.pdas.registry() }); }
  unpause(admin: PublicKey) { return this.build("unpause", {}, { admin, registry: this.pdas.registry() }); }
  rotateRuntime(admin: PublicKey, newRuntime: PublicKey, effectiveBatch: bigint) { return this.build("rotateRuntime", { newRuntime, effectiveBatch: bn(effectiveBatch) }, { admin, registry: this.pdas.registry() }); }
}
