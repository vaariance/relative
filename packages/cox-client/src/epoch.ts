import { Buffer } from "buffer";
import { BN, type Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { bytes32, integer } from "./wire.ts";
import type { MarketLifecycle } from "./lifecycle.ts";

export * from "./epoch-readers.ts";

export const EPOCH_SECONDS = 14_400n;
export const EPOCH_FEE_BPS = 2n;
export const EPOCH_FEE_CAP = 200_000n;
export const EPOCH_HEAP_BYTES = 262_144;
export const EPOCH_ACCOUNT_BYTES = 64_000;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MAX_REFERENCE = 10n ** 24n;
const bn = (value: bigint) => new BN(value.toString());
const assetId = (value: number) => { if (!Number.isSafeInteger(value) || value < 0 || value >= 256) throw new Error("InvalidEpochAsset"); return value; };
const positiveReference = (value: bigint) => { if (value <= 0n || value > MAX_REFERENCE) throw new Error("InvalidEpochReference"); return bn(value); };

export interface EpochSelection { readonly config: PublicKey; readonly opensAt: bigint }
export interface EpochRegistryBinding { readonly assetRegistry: PublicKey; readonly registryVersion: PublicKey; readonly methodology: PublicKey }
export interface EpochPreparationProgress { readonly accountBytes: number | null; readonly copiedAssets: number; readonly assetCount: number; readonly sealed: boolean }
export interface EpochAsset { readonly id: number; readonly feedId: Uint8Array; readonly originPrice: bigint }
export interface EpochPrice { readonly assetId: number; readonly feedId: Uint8Array; readonly value: bigint }
export interface EpochPrediction {
  readonly nonce: bigint;
  readonly owner: PublicKey;
  readonly collateralAccount: PublicKey;
  readonly grossStake: bigint;
  readonly basket: readonly number[];
  readonly backedAsset: number;
}

export function epochAddresses(programId: PublicKey) {
  const derive = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  return {
    config: (admin: PublicKey, id: bigint) => derive(Buffer.from("config"), admin.toBytes(), integer(id, 8)),
    epoch: (selection: EpochSelection) => {
      if (selection.opensAt % EPOCH_SECONDS !== 0n) throw new Error("InvalidEpochBoundary");
      return derive(Buffer.from("epoch"), selection.config.toBytes(), integer(selection.opensAt, 8));
    },
    vault: (epoch: PublicKey) => derive(Buffer.from("vault"), epoch.toBytes()),
    testVault: (epoch: PublicKey) => derive(Buffer.from("test-vault"), epoch.toBytes()),
    lot: (epoch: PublicKey, nonce: bigint) => derive(Buffer.from("lot"), epoch.toBytes(), integer(nonce, 8)),
    snapshot: (config: PublicKey, sequence: bigint) => derive(Buffer.from("snapshot"), config.toBytes(), integer(sequence, 8)),
  };
}

export function epochEntryFee(grossStake: bigint): bigint {
  integer(grossStake, 8);
  if (grossStake === 0n) throw new Error("InvalidEpochStake");
  const fee = grossStake * EPOCH_FEE_BPS / 10_000n;
  return fee > EPOCH_FEE_CAP ? EPOCH_FEE_CAP : fee;
}

export class EpochInstructions {
  readonly pdas;
  readonly program: Program;
  constructor(program: Program) {
    if (program.idl.metadata?.name !== "relativeEpoch") throw new Error("InvalidEpochProgramInterface");
    this.program = program;
    this.pdas = epochAddresses(program.programId);
  }
  private build(name: string, args: object, accounts: Record<string, PublicKey>): TransactionInstruction {
    const definition = this.program.idl.instructions.find(instruction => instruction.name === name);
    if (!definition || Object.keys(accounts).length !== definition.accounts.length) throw new Error("InvalidEpochInstructionAccounts");
    const keys = definition.accounts.map(account => {
      if ("accounts" in account || !accounts[account.name]) throw new Error("InvalidEpochInstructionAccounts");
      return { pubkey: accounts[account.name]!, isSigner: account.signer ?? false, isWritable: account.writable ?? false };
    });
    return new TransactionInstruction({ programId: this.program.programId, keys, data: this.program.coder.instruction.encode(name, args) });
  }
  private keys(selection: EpochSelection) {
    const epoch = this.pdas.epoch(selection);
    return { config: selection.config, epoch, vault: this.pdas.vault(epoch), testVault: this.pdas.testVault(epoch) };
  }
  initializeConfig(admin: PublicKey, mint: PublicKey, configId: bigint, operator: PublicKey, methodology: Uint8Array,
    originBenchmark: bigint, maxEntryPriceAge: bigint, maxLots: number) {
    return this.build("initializeConfig", this.configArguments(configId, operator, methodology, originBenchmark, maxEntryPriceAge, maxLots),
      { admin, mint, config: this.pdas.config(admin, configId), systemProgram: SystemProgram.programId });
  }
  initializeDevnetConfig(admin: PublicKey, mint: PublicKey, testMint: PublicKey, configId: bigint, operator: PublicKey,
    methodology: Uint8Array, originBenchmark: bigint, maxEntryPriceAge: bigint, maxLots: number) {
    if (testMint.equals(mint)) throw new Error("InvalidEpochCollateral");
    return this.build("initializeDevnetConfig", this.configArguments(configId, operator, methodology, originBenchmark, maxEntryPriceAge, maxLots),
      { admin, mint, testMint, config: this.pdas.config(admin, configId), systemProgram: SystemProgram.programId });
  }
  initializeRegistryConfig(admin: PublicKey, mint: PublicKey, configId: bigint, operator: PublicKey, methodology: Uint8Array,
    originBenchmark: bigint, maxEntryPriceAge: bigint, maxLots: number, assetRegistry: PublicKey, testMint?: PublicKey) {
    if (assetRegistry.equals(PublicKey.default) || testMint?.equals(mint)) throw new Error("InvalidEpochConfiguration");
    return this.build(testMint ? "initializeRegistryDevnetConfig" : "initializeRegistryConfig",
      { ...this.configArguments(configId, operator, methodology, originBenchmark, maxEntryPriceAge, maxLots), assetRegistry },
      { admin, mint, ...(testMint ? { testMint } : {}), config: this.pdas.config(admin, configId), systemProgram: SystemProgram.programId });
  }
  setConfigLifecycle(admin: PublicKey, config: PublicKey, lifecycle: MarketLifecycle) {
    return this.build("setConfigLifecycle", { lifecycle: { [lifecycle]: {} } }, { admin, config });
  }
  initializeCurrentEpoch(payer: PublicKey, mint: PublicKey, selection: EpochSelection, binding: EpochRegistryBinding, testMint: PublicKey = mint) {
    return this.build("initializeCurrentEpoch", { opensAt: bn(selection.opensAt) }, { payer, ...this.keys(selection), ...binding, mint, testMint, tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId });
  }
  private currentDraftKeys(payer: PublicKey, selection: EpochSelection, binding: EpochRegistryBinding) {
    return { payer, config: selection.config, ...binding, epoch: this.pdas.epoch(selection), systemProgram: SystemProgram.programId };
  }
  growCurrentEpoch(payer: PublicKey, selection: EpochSelection, binding: EpochRegistryBinding, additionalBytes: number) {
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 1 || additionalBytes > 8192) throw new Error("InvalidEpochGrowth");
    return this.build("growCurrentEpoch", { additionalBytes }, this.currentDraftKeys(payer, selection, binding));
  }
  copyRegistryAssets(payer: PublicKey, selection: EpochSelection, binding: EpochRegistryBinding, start: number, count: number) {
    if (!Number.isSafeInteger(start) || start < 0 || start > 254 || !Number.isSafeInteger(count) || count < 1 || count > 8 || start + count > 255) throw new Error("InvalidEpochPage");
    return this.build("copyRegistryAssets", { start, count }, this.currentDraftKeys(payer, selection, binding));
  }
  sealCurrentEpoch(payer: PublicKey, selection: EpochSelection, binding: EpochRegistryBinding) {
    return this.build("sealCurrentEpoch", {}, this.currentDraftKeys(payer, selection, binding));
  }
  prepareCurrentEpoch(payer: PublicKey, mint: PublicKey, selection: EpochSelection, binding: EpochRegistryBinding, progress: EpochPreparationProgress, testMint: PublicKey = mint): TransactionInstruction[] {
    if (!Number.isSafeInteger(progress.assetCount) || progress.assetCount < 30 || progress.assetCount > 255
      || !Number.isSafeInteger(progress.copiedAssets) || progress.copiedAssets < 0 || progress.copiedAssets > progress.assetCount
      || progress.accountBytes !== null && (!Number.isSafeInteger(progress.accountBytes) || progress.accountBytes < 2048 || progress.accountBytes > EPOCH_ACCOUNT_BYTES)
      || progress.accountBytes === null && (progress.copiedAssets !== 0 || progress.sealed)) throw new Error("InvalidEpochPreparation");
    if (progress.sealed) return [];
    const instructions: TransactionInstruction[] = [];
    if (progress.accountBytes === null) instructions.push(this.initializeCurrentEpoch(payer, mint, selection, binding, testMint));
    let bytes = progress.accountBytes ?? 2048;
    while (bytes < EPOCH_ACCOUNT_BYTES) {
      const growth = Math.min(8192, EPOCH_ACCOUNT_BYTES - bytes);
      instructions.push(this.growCurrentEpoch(payer, selection, binding, growth)); bytes += growth;
    }
    for (let start = progress.copiedAssets; start < progress.assetCount; start += 8) instructions.push(this.copyRegistryAssets(payer, selection, binding, start, Math.min(8, progress.assetCount - start)));
    instructions.push(this.sealCurrentEpoch(payer, selection, binding));
    return instructions;
  }
  finalizeEmpty(selection: EpochSelection) {
    return this.build("finalizeEmpty", {}, this.keys(selection));
  }
  private configArguments(configId: bigint, operator: PublicKey, methodology: Uint8Array, originBenchmark: bigint, maxEntryPriceAge: bigint, maxLots: number) {
    integer(configId, 8); integer(maxEntryPriceAge, 8);
    if (maxEntryPriceAge === 0n || !Number.isSafeInteger(maxLots) || maxLots < 1 || maxLots > 1_000_000) throw new Error("InvalidEpochConfiguration");
    return { configId: bn(configId), operator, methodology: [...bytes32(methodology)],
      originBenchmark: positiveReference(originBenchmark), maxEntryPriceAge: bn(maxEntryPriceAge), maxLots };
  }
  initializeEpoch(admin: PublicKey, mint: PublicKey, selection: EpochSelection, testMint: PublicKey = mint) {
    return this.build("initializeEpoch", { opensAt: bn(selection.opensAt) }, { admin, ...this.keys(selection), mint, testMint,
      tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId });
  }
  growEpoch(admin: PublicKey, selection: EpochSelection, additionalBytes: number) {
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 1 || additionalBytes > 8192) throw new Error("InvalidEpochGrowth");
    return this.build("growEpoch", { additionalBytes }, { admin, config: selection.config, epoch: this.pdas.epoch(selection), systemProgram: SystemProgram.programId });
  }
  appendUniverse(admin: PublicKey, selection: EpochSelection, assets: readonly EpochAsset[]) {
    if (!assets.length || assets.length > 8) throw new Error("InvalidEpochPage");
    return this.build("appendUniverse", { assets: assets.map(asset => ({ id: assetId(asset.id), feedId: [...bytes32(asset.feedId)], originPrice: positiveReference(asset.originPrice) })) },
      { admin, config: selection.config, epoch: this.pdas.epoch(selection), systemProgram: SystemProgram.programId });
  }
  sealEpoch(admin: PublicKey, selection: EpochSelection) {
    return this.build("sealEpoch", {}, { admin, config: selection.config, epoch: this.pdas.epoch(selection), systemProgram: SystemProgram.programId });
  }
  queue(selection: EpochSelection, prediction: EpochPrediction) {
    epochEntryFee(prediction.grossStake); integer(prediction.nonce, 8);
    if (prediction.basket.length !== 30 || new Set(prediction.basket).size !== 30 || !prediction.basket.includes(prediction.backedAsset)) throw new Error("InvalidEpochBasket");
    prediction.basket.forEach(assetId);
    const keys = this.keys(selection);
    return this.build("queue", { nonce: bn(prediction.nonce), grossStake: bn(prediction.grossStake), basket: [...prediction.basket], backedAsset: assetId(prediction.backedAsset) },
      { owner: prediction.owner, ...keys, lot: this.pdas.lot(keys.epoch, prediction.nonce), source: prediction.collateralAccount,
        tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId });
  }
  initializeSnapshot(operator: PublicKey, config: PublicKey, sequence: bigint, timestamp: bigint, benchmark: bigint, expectedPrices: number) {
    integer(sequence, 8); integer(timestamp, 8);
    if (!Number.isSafeInteger(expectedPrices) || expectedPrices < 1 || expectedPrices > 256) throw new Error("InvalidEpochPage");
    return this.build("initializeSnapshot", { sequence: bn(sequence), oracleTimestamp: bn(timestamp), benchmark: positiveReference(benchmark), expectedPrices },
      this.snapshotKeys(operator, config, sequence));
  }
  closeSnapshot(operator: PublicKey, config: PublicKey, sequence: bigint) {
    integer(sequence, 8);
    return this.build("closeSnapshot", {}, { operator, config, snapshot: this.pdas.snapshot(config, sequence) });
  }
  growSnapshot(operator: PublicKey, config: PublicKey, sequence: bigint, additionalBytes: number) {
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 1 || additionalBytes > 8192) throw new Error("InvalidEpochGrowth");
    return this.build("growSnapshot", { additionalBytes }, this.snapshotKeys(operator, config, sequence));
  }
  appendPrices(operator: PublicKey, config: PublicKey, sequence: bigint, prices: readonly EpochPrice[]) {
    if (!prices.length || prices.length > 8) throw new Error("InvalidEpochPage");
    const feeds = new Set<string>();
    const encoded = prices.map((price, index) => {
      assetId(price.assetId); positiveReference(price.value);
      const feed = bytes32(price.feedId);
      const identity = Buffer.from(feed).toString("hex");
      if (feed.every(byte => byte === 0) || feeds.has(identity) || (index > 0 && prices[index - 1]!.assetId >= price.assetId)) throw new Error("InvalidEpochPage");
      feeds.add(identity);
      return Buffer.concat([integer(BigInt(price.assetId), 2), feed, integer(price.value, 16)]);
    });
    const instruction = this.build("appendPrices", { prices: [] }, this.snapshotKeys(operator, config, sequence));
    instruction.data = Buffer.concat([instruction.data.subarray(0, -4), integer(BigInt(prices.length), 4), ...encoded]);
    return instruction;
  }
  sealSnapshot(operator: PublicKey, config: PublicKey, sequence: bigint) {
    return this.build("sealSnapshot", {}, this.snapshotKeys(operator, config, sequence));
  }
  private snapshotKeys(operator: PublicKey, config: PublicKey, sequence: bigint) {
    integer(sequence, 8);
    return { operator, config, snapshot: this.pdas.snapshot(config, sequence), systemProgram: SystemProgram.programId };
  }
  publishSnapshot(operator: PublicKey, config: PublicKey, sequence: bigint, timestamp: bigint, benchmark: bigint, prices: readonly EpochPrice[]) {
    integer(sequence, 8); integer(timestamp, 8);
    if (!prices.length || prices.length > 30) throw new Error("InvalidAtomicEpochSnapshot");
    const instruction = this.build("publishSnapshot", { sequence: bn(sequence), oracleTimestamp: bn(timestamp), benchmark: positiveReference(benchmark), prices: [] },
      { operator, config, snapshot: this.pdas.snapshot(config, sequence), systemProgram: SystemProgram.programId });
    const encoded = prices.map(price => {
      assetId(price.assetId); positiveReference(price.value);
      return Buffer.concat([integer(BigInt(price.assetId), 2), bytes32(price.feedId), integer(price.value, 16)]);
    });
    instruction.data = Buffer.concat([instruction.data.subarray(0, -4), integer(BigInt(prices.length), 4), ...encoded]);
    return instruction;
  }
  execute(operator: PublicKey, selection: EpochSelection, nonce: bigint, snapshotSequence: bigint) {
    const keys = this.keys(selection);
    return this.build("execute", {}, { operator, ...keys, lot: this.pdas.lot(keys.epoch, nonce), snapshot: this.pdas.snapshot(keys.config, snapshotSequence) });
  }
  beginClose(operator: PublicKey, selection: EpochSelection, snapshotSequence: bigint) {
    const keys = this.keys(selection);
    return this.build("beginClose", {}, { operator, ...keys, snapshot: this.pdas.snapshot(keys.config, snapshotSequence) });
  }
  score(selection: EpochSelection, nonce: bigint) { return this.lotInstruction("score", selection, nonce); }
  allocate(selection: EpochSelection, nonce: bigint) { return this.lotInstruction("allocate", selection, nonce); }
  refund(selection: EpochSelection, nonce: bigint) { return this.lotInstruction("refund", selection, nonce); }
  private lotInstruction(name: "score" | "allocate" | "refund", selection: EpochSelection, nonce: bigint) {
    const keys = this.keys(selection); return this.build(name, {}, { ...keys, lot: this.pdas.lot(keys.epoch, nonce) });
  }
  finalizeScores(selection: EpochSelection) { return this.build("finalizeScores", {}, this.keys(selection)); }
  voidEpoch(selection: EpochSelection) { return this.build("voidEpoch", {}, this.keys(selection)); }
  withdraw(owner: PublicKey, destination: PublicKey, selection: EpochSelection, nonce: bigint) {
    const keys = this.keys(selection);
    return this.build("withdraw", {}, { owner, ...keys, lot: this.pdas.lot(keys.epoch, nonce), destination, tokenProgram: TOKEN_PROGRAM });
  }
  withdrawPartial(owner: PublicKey, destination: PublicKey, selection: EpochSelection, nonce: bigint, amount: bigint) {
    integer(amount, 8); if (amount === 0n) throw new Error("InvalidEpochStake");
    const keys = this.keys(selection);
    return this.build("withdrawPartial", { amount: bn(amount) }, { owner, ...keys, lot: this.pdas.lot(keys.epoch, nonce), destination, tokenProgram: TOKEN_PROGRAM });
  }
  withdrawFees(admin: PublicKey, destination: PublicKey, selection: EpochSelection, amount: bigint) {
    integer(amount, 8); if (amount === 0n) throw new Error("InvalidEpochStake");
    return this.build("withdrawFees", { amount: bn(amount) }, { admin, ...this.keys(selection), destination, tokenProgram: TOKEN_PROGRAM });
  }
}
