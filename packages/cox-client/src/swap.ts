import { Buffer } from "buffer";
import type { Program } from "@coral-xyz/anchor";
import { type AccountInfo, ComputeBudgetProgram, PublicKey, SYSVAR_CLOCK_PUBKEY, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { CoxInstructions } from "./builders.ts";
import { PROGRAM_ID, addresses } from "./pdas.ts";
import { CoxReader, committedPosition, committedRequest, decodeAccount } from "./readers.ts";
import { CoxSimulations } from "./simulations.ts";
import { readDynamicManifest, DYNAMIC_CRYPTO_CLASS, dynamicPositionSpace } from "./dynamic.ts";
import { sha256 } from "./wire.ts";
import type { Pool, Position } from "./accounts.ts";
import { swapCapabilities, SWAP_DEVNET_GENESIS } from "./capabilities.ts";
export type { SwapCapabilities, SwapCapability, SwapCapabilityReason } from "./capabilities.ts";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const DEVNET_GENESIS = SWAP_DEVNET_GENESIS;
const U64_MAX = (1n << 64n) - 1n;
const UNIT_LIMIT = 10n ** 24n;
const COLLATERAL_LIMIT = 10n ** 11n;
export const COLLATERAL_DECIMALS = 6;
export const CRYPTO_UNIT_DECIMALS = 12;
export const DEVNET_TEST_COLLATERAL = new PublicKey("5rpGrekfBLHdF8PD8eKLzXQPPmhyF7FCKeE1VA5CwV3X");
const statuses = ["queued", "filled", "condition-failed", "expired", "zero-value-class", "cancelled", "refunded", "safety-rejected"] as const;
export type SwapRequestStatus = typeof statuses[number];
export interface SwapOptions { poolId: bigint; collateralMint: PublicKey }
export interface WalletAccounts { owner: PublicKey; tokenAccount: PublicKey }
export interface FeeTerms { version: bigint; bps: number; cap: bigint }
export interface BuyCrypto extends WalletAccounts { expectedFeeVersion?: bigint; amount: bigint; minimumUnits: bigint; expiryBatch: bigint }
export interface SellCrypto extends WalletAccounts { expectedFeeVersion?: bigint; units: bigint; minimumProceeds: bigint; expiryBatch: bigint }
export interface DepositClass extends BuyCrypto { classId: number }
export interface RedeemClass extends SellCrypto { classId: number }
export interface ClassSwapQuote extends Omit<SwapQuote, "direction"> {
  direction: "collateral-to-class" | "class-to-collateral";
  classId: number;
}
export interface SwapPlan {
  kind: "buy-crypto" | "sell-crypto" | "deposit-class" | "redeem-class" | "withdraw" | "cancel" | "expire" | "refund" | "prepare-position";
  owner: PublicKey;
  pool: PublicKey;
  collateralMint: PublicKey;
  testOnly: true;
  observedSequence: bigint;
  feeTerms: FeeTerms | null;
  instructions: readonly TransactionInstruction[];
  request: { address: PublicKey; nonce: bigint; earliestBatchEstimate: bigint; expiryBatch: bigint } | null;
}
export interface SwapQuote {
  direction: "collateral-to-crypto" | "crypto-to-collateral";
  input: bigint;
  estimatedOutput: bigint;
  gross: bigint;
  fee: bigint;
  netCollateral: bigint;
  feeTerms: FeeTerms;
  observedSequence: bigint;
  collateralMint: PublicKey;
  testOnly: true;
  execution: "future-publication";
  guaranteed: false;
}
export interface PreparedTransaction {
  transaction: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
}
export class SwapSdkError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "SwapSdkError"; }
}
function check(condition: boolean, code: string): asserts condition {
  if (!condition) throw new SwapSdkError(code);
}
function uint(value: bigint, maximum: bigint, positive = false): void {
  check(typeof value === "bigint" && value >= (positive ? 1n : 0n) && value <= maximum, "InvalidSwapAmount");
}
const number = (value: { toString(): string }) => BigInt(value.toString());

export class CoxSwapSdk {
  private readonly reader: CoxReader;
  private readonly builder: CoxInstructions;
  private readonly poolKey: PublicKey;
  private readonly pdas;
  private readonly program: Program;
  readonly options: SwapOptions;
  constructor(program: Program, options: SwapOptions) {
    this.program = program;
    this.options = Object.freeze({ ...options });
    check(program.programId.equals(PROGRAM_ID), "SwapProgramMismatch");
    uint(options.poolId, U64_MAX);
    this.reader = new CoxReader(program);
    this.builder = new CoxInstructions(program);
    this.pdas = addresses(program.programId);
    this.poolKey = this.pdas.pool(options.poolId);
  }
  private feeTerms(pool: Pool): FeeTerms { return { version: number(pool.feeVersion), bps: pool.feeBps, cap: number(pool.feeCap) }; }
  async capabilities() {
    return swapCapabilities(this.program.provider.connection, DEVNET_GENESIS);
  }
  private checkFeeVersion(pool: Pool, expected?: bigint) {
    if (expected !== undefined) { uint(expected, U64_MAX); check(expected === number(pool.feeVersion), "SwapFeeChangedRebuild"); }
  }
  private cryptoClass(pool: Pool): number { return pool.schemaVersion === 5 ? DYNAMIC_CRYPTO_CLASS : pool.classes.length - 1; }
  private selectedClass(pool: Pool, classId?: number): number {
    const selected = classId ?? this.cryptoClass(pool);
    check(Number.isInteger(selected) && selected >= 0 && selected < pool.classes.length, "SwapInvalidClass");
    return selected;
  }
  private async context(owner?: PublicKey) {
    const connection = this.program.provider.connection;
    check(await connection.getGenesisHash() === DEVNET_GENESIS, "SwapNetworkMismatch");
    const initial = await this.reader.pool(this.options.poolId);
    const keys = [this.poolKey, this.pdas.registry(), initial.methodology, this.options.collateralMint,
      this.pdas.vault(this.poolKey), SYSVAR_CLOCK_PUBKEY];
    if (owner) keys.push(this.pdas.position(this.poolKey, owner));
    if (initial.testCollateralMint) keys.push(this.pdas.testVault(this.poolKey));
    const response = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: "finalized" });
    const [poolInfo, registryInfo, methodologyInfo, mint, vault, clock, positionInfo] = response.value;
    check(!!poolInfo && !!registryInfo && !!methodologyInfo && !!mint && !!vault && !!clock, "SwapSetupMissing");
    const pool = decodeAccount(this.program, "pool", poolInfo);
    const registry = decodeAccount(this.program, "registry", registryInfo);
    const methodology = decodeAccount(this.program, "methodology", methodologyInfo);
    check(pool.poolId.toString() === this.options.poolId.toString() && pool.registry.equals(keys[1]!)
      && pool.methodology.equals(keys[2]!) && pool.vault.equals(keys[4]!), "SwapPoolMismatch");
    check((pool.collateralMint.equals(this.options.collateralMint)
      || (pool.schemaVersion >= 4 && !!pool.testCollateralMint?.equals(this.options.collateralMint)))
      && (pool.testCollateralMint?.toBase58() ?? null) === (initial.testCollateralMint?.toBase58() ?? null), "SwapCollateralMismatch");
    check(methodology.sealed && methodology.origin.eq(pool.origin)
      && this.pdas.methodology(Buffer.from(methodology.digest)).equals(pool.methodology)
      && methodology.canonical.length === methodology.expectedLength
      && sha256(Buffer.from(methodology.canonical)).equals(Buffer.from(methodology.digest)), "SwapMethodologyMismatch");
    const dynamic = pool.schemaVersion === 5 ? readDynamicManifest(methodology, this.poolKey) : null;
    check((pool.schemaVersion === 5) === (methodology.schemaVersion === 3), "SwapMethodologyMismatch");
    check(pool.classes.length === methodology.roster.length + 1 && pool.classes.length >= (dynamic ? 31 : 3) && pool.classes.length <= (dynamic ? 256 : 31)
      && pool.references.length === pool.classes.length
      && pool.classes.reduce((sum, value) => sum + number(value.backing), 0n) === number(pool.active), "SwapPoolLedgerMismatch");
    check(mint.owner.equals(TOKEN_PROGRAM) && mint.data.length === 82 && mint.data[44] === 6 && mint.data[45] === 1, "SwapCollateralMismatch");
    const vaultBalance = (info: AccountInfo<Buffer> | null | undefined, expectedMint: PublicKey) => {
      check(!!info && info.owner.equals(TOKEN_PROGRAM) && info.data.length === 165 && info.data[108] === 1
        && info.data.subarray(0, 32).equals(expectedMint.toBuffer())
        && info.data.subarray(32, 64).equals(this.poolKey.toBuffer())
        && info.data.readUInt32LE(72) === 0 && info.data.readUInt32LE(109) === 0
        && info.data.readUInt32LE(129) === 0, "SwapVaultMismatch");
      return info.data.readBigUInt64LE(64);
    };
    const primaryBalance = vaultBalance(vault, pool.collateralMint);
    const secondaryBalance = pool.testCollateralMint
      ? vaultBalance(response.value[owner ? 7 : 6], pool.testCollateralMint) : 0n;
    check(primaryBalance + secondaryBalance >= number(pool.active) + number(pool.pending) + number(pool.payable) + number(pool.residual) + number(pool.fees), "SwapCollateralShortfall");
    const selectedVaultBalance = pool.collateralMint.equals(this.options.collateralMint) ? primaryBalance : secondaryBalance;
    check(clock.data.length === 40, "SwapClockMismatch");
    const now = clock.data.readBigInt64LE(32);
    const origin = number(pool.origin);
    const halted = pool.schemaVersion < 4 && pool.initialized && now - (origin + number(pool.lastBatch) * 60n) >= 3600n;
    let position: Position | null = null;
    if (positionInfo && owner) {
      position = decodeAccount(this.program, "position", positionInfo);
      check(position.pool.equals(this.poolKey) && position.owner.equals(owner) && (pool.schemaVersion === 5 ? position.classes.length <= pool.classes.length : position.classes.length === pool.classes.length), "SwapPositionMismatch");
      position = committedPosition(position, pool);
    }
    return { pool, registry, methodology, dynamic, now, halted, position, positionBytes: positionInfo && owner ? positionInfo.data.length : 0, selectedVaultBalance };
  }
  private trading(context: Awaited<ReturnType<CoxSwapSdk["context"]>>) {
    check(context.pool.schemaVersion !== 3, "SwapPoolRetired");
    check(context.pool.initialized, "SwapPoolNotInitialized");
    check(!context.registry.paused, "SwapPaused");
    check(!context.halted, "SwapHalted");
    check(context.pool.schemaVersion < 4 || context.now >= number(context.pool.tradingOpensAt), "SwapTradingNotOpen");
  }
  private async token(account: PublicKey, owner: PublicKey) {
    const info = await this.program.provider.connection.getAccountInfo(account, "finalized");
    check(!!info && info.owner.equals(TOKEN_PROGRAM) && info.data.length === 165 && info.data[108] === 1
      && info.data.subarray(0, 32).equals(this.options.collateralMint.toBuffer())
      && info.data.subarray(32, 64).equals(owner.toBuffer()), "SwapWalletTokenMismatch");
    return info.data.readBigUInt64LE(64);
  }
  private keys(wallet: WalletAccounts, nonce: bigint, pool: Pool) {
    return { ...(pool.testCollateralMint ? { testVault: this.pdas.testVault(this.poolKey) } : {}), owner: wallet.owner, pool: this.poolKey, vault: this.pdas.vault(this.poolKey),
      position: this.pdas.position(this.poolKey, wallet.owner), request: this.pdas.request(this.poolKey, nonce), userToken: wallet.tokenAccount };
  }
  private plan(kind: SwapPlan["kind"], owner: PublicKey, pool: Pool, instruction: TransactionInstruction, request: SwapPlan["request"] = null, setup: readonly TransactionInstruction[] = []): SwapPlan {
    return { kind, owner, pool: this.poolKey, collateralMint: this.options.collateralMint, testOnly: true,
      observedSequence: number(pool.sequence), feeTerms: request ? this.feeTerms(pool) : null, instructions: pool.schemaVersion === 5 ? [ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }), ...setup, instruction] : [instruction], request };
  }
  private positionSetup(_owner: PublicKey, context: Awaited<ReturnType<CoxSwapSdk["context"]>>): TransactionInstruction[] {
    if (!context.dynamic) return [];
    const required = dynamicPositionSpace(context.pool.classes.length);
    check((context.positionBytes || 4096) >= required, "SwapPositionGrowthRequired");
    return [];
  }
  async preparePosition(owner: PublicKey): Promise<readonly SwapPlan[]> {
    const context = await this.context(owner);
    check(!!context.dynamic, "SwapDynamicPositionUnsupported");
    const required = dynamicPositionSpace(context.pool.classes.length), target = this.pdas.position(this.poolKey, owner);
    let bytes = context.positionBytes;
    const instructions: TransactionInstruction[] = [];
    if (bytes === 0) { instructions.push(this.builder.initializeDynamicPosition(owner, this.poolKey)); bytes = 4096; }
    check(bytes >= required || !context.pool.stage, "SwapPositionGrowthDuringBatch");
    while (bytes < required) {
      const additional = Math.min(8192, required - bytes);
      instructions.push(this.builder.growDynamicAccount(owner, this.poolKey, target, additional)); bytes += additional;
    }
    return instructions.map(instruction => this.plan("prepare-position", owner, context.pool, instruction));
  }
  private earliestBatch(context: Awaited<ReturnType<CoxSwapSdk["context"]>>) {
    const { pool, now } = context;
    return [((now - number(pool.origin)) / (pool.schemaVersion >= 4 ? 1n : 60n)) + 1n, number(pool.lastBatch) + 1n,
      pool.stage || pool.schemaVersion === 5 ? number(pool.stageBatch) + 1n : 0n].reduce((a, b) => a > b ? a : b);
  }
  private reservation(context: Awaited<ReturnType<CoxSwapSdk["context"]>>, expiryBatch: bigint) {
    uint(expiryBatch, U64_MAX);
    const { pool } = context;
    const earliestBatchEstimate = this.earliestBatch(context);
    check(expiryBatch >= earliestBatchEstimate, "SwapExpiryTooEarly");
    const nonce = number(pool.nextRequestNonce);
    return { address: this.pdas.request(this.poolKey, nonce), nonce, earliestBatchEstimate, expiryBatch };
  }
  async market() {
    const context = await this.context();
    return { pool: this.poolKey, collateralMint: this.options.collateralMint, collateralDecimals: COLLATERAL_DECIMALS,
      feeTerms: this.feeTerms(context.pool), pendingFees: context.pool.feePending ? { version: number(context.pool.feePendingVersion), bps: context.pool.feePendingBps, cap: number(context.pool.feePendingCap), activationCutoff: number(context.pool.feePendingCutoff) } : null,
      classes: context.pool.classes.map((_, classId) => ({ classId, assetId: context.dynamic ? context.dynamic.instruments.find(asset => asset.classId === classId)?.symbol ?? null : context.methodology.roster[classId] ?? null, benchmark: classId === this.cryptoClass(context.pool) })),
      cryptoUnitDecimals: CRYPTO_UNIT_DECIMALS, cryptoClass: this.cryptoClass(context.pool), testOnly: true as const,
      benchmarkLabel: `CRYPTO (pilot, ${context.methodology.roster.length} assets)`, initialized: context.pool.initialized,
      tradingOpensAt: number(context.pool.tradingOpensAt), tradingOpen: context.pool.schemaVersion < 4 || context.now >= number(context.pool.tradingOpensAt),
      retired: context.pool.schemaVersion === 3, paused: context.registry.paused, halted: context.halted, earliestBatchEstimate: this.earliestBatch(context), sequence: number(context.pool.sequence), batch: number(context.pool.lastBatch) };
  }
  async balances(owner: PublicKey) {
    return this.classBalances(owner);
  }
  async classBalances(owner: PublicKey, classId?: number) {
    const { position, pool } = await this.context(owner);
    const selected = this.selectedClass(pool, classId);
    const crypto = position?.classes[selected];
    const units = crypto ? number(crypto.units) : 0n;
    const locked = crypto ? number(crypto.locked) : 0n;
    check(locked <= units, "SwapPositionMismatch");
    return { owner, classId: selected, units, locked, availableUnits: units - locked, payable: position ? number(position.payable) : 0n,
      refundable: position ? number(position.refundable) : 0n, sequence: number(pool.sequence), collateralMint: this.options.collateralMint, testOnly: true as const };
  }
  async quoteBuy(owner: PublicKey, amount: bigint): Promise<SwapQuote> {
    uint(amount, COLLATERAL_LIMIT, true);
    return this.quote(owner, "collateral-to-crypto", amount);
  }
  async quoteSell(owner: PublicKey, units: bigint): Promise<SwapQuote> {
    uint(units, UNIT_LIMIT, true);
    return this.quote(owner, "crypto-to-collateral", units);
  }
  async quoteDeposit(owner: PublicKey, classId: number, amount: bigint): Promise<ClassSwapQuote> {
    uint(amount, COLLATERAL_LIMIT, true);
    const quote = await this.quote(owner, "collateral-to-crypto", amount, classId);
    return { ...quote, direction: "collateral-to-class", classId };
  }
  async quoteRedeem(owner: PublicKey, classId: number, units: bigint): Promise<ClassSwapQuote> {
    uint(units, UNIT_LIMIT, true);
    const quote = await this.quote(owner, "crypto-to-collateral", units, classId);
    return { ...quote, direction: "class-to-collateral", classId };
  }
  private async quote(owner: PublicKey, direction: SwapQuote["direction"], input: bigint, classId?: number): Promise<SwapQuote> {
    const context = await this.context();
    this.trading(context);
    const buying = direction === "collateral-to-crypto";
    const simulations = new CoxSimulations(this.program, owner);
    const operation = buying ? 0 : 2;
    const selected = this.selectedClass(context.pool, classId);
    const sentinel = context.dynamic ? 65535 : 255;
    const from = buying ? sentinel : selected, to = buying ? selected : sentinel;
    const feeResult = context.dynamic ? await simulations.quoteV2(this.poolKey, operation, from, to, buying ? input : 0n, buying ? 0n : input, number(context.pool.feeVersion)) : context.pool.schemaVersion !== 1
      ? await simulations.quoteWithFee(this.poolKey, operation, from, to, buying ? input : 0n, buying ? 0n : input, number(context.pool.feeVersion))
      : null;
    const result = feeResult ?? await simulations.quote(this.poolKey, operation, from, to, buying ? input : 0n, buying ? 0n : input);
    const fee = feeResult ? number(feeResult.fee) : 0n;
    const gross = feeResult ? number(feeResult.gross) : buying ? input : number(result.proceeds);
    if (feeResult) check(number(feeResult.feeVersion) === number(context.pool.feeVersion), "SwapFeeChangedRebuild");
    check(result.sequence.eq(context.pool.sequence), "SwapReadChangedRetry");
    return { direction, input, gross, fee, netCollateral: gross - fee, feeTerms: this.feeTerms(context.pool), estimatedOutput: number(buying ? result.minted : result.proceeds),
      observedSequence: number(result.sequence), collateralMint: this.options.collateralMint, testOnly: true,
      execution: "future-publication", guaranteed: false };
  }
  async entryContext(owner: PublicKey, classId: number, expiryBatch: bigint, expectedFeeVersion: bigint, minimumCollateral: bigint) {
    uint(minimumCollateral, COLLATERAL_LIMIT, true);
    uint(expectedFeeVersion, U64_MAX);
    const context = await this.context(owner);
    this.trading(context);
    const selected = this.selectedClass(context.pool, classId);
    this.checkFeeVersion(context.pool, expectedFeeVersion);
    check(number(context.pool.active) + number(context.pool.pending) + minimumCollateral <= COLLATERAL_LIMIT, "SwapCapacityExceeded");
    return { owner, pool: this.poolKey, collateralMint: this.options.collateralMint, classId: selected,
      request: this.reservation(context, expiryBatch), feeTerms: this.feeTerms(context.pool),
      observedSequence: number(context.pool.sequence), testOnly: true as const };
  }
  async prepareBuy(input: BuyCrypto): Promise<SwapPlan> {
    return this.deposit(input, "buy-crypto");
  }
  async prepareDeposit(input: DepositClass): Promise<SwapPlan> {
    return this.deposit(input, "deposit-class", input.classId);
  }
  private async deposit(input: BuyCrypto, kind: SwapPlan["kind"], classId?: number): Promise<SwapPlan> {
    uint(input.amount, COLLATERAL_LIMIT, true); uint(input.minimumUnits, UNIT_LIMIT);
    const context = await this.context(input.owner);
    this.trading(context);
    this.checkFeeVersion(context.pool, input.expectedFeeVersion);
    check(number(context.pool.active) + number(context.pool.pending) + input.amount <= COLLATERAL_LIMIT, "SwapCapacityExceeded");
    check(await this.token(input.tokenAccount, input.owner) >= input.amount, "SwapInsufficientCollateral");
    const request = this.reservation(context, input.expiryBatch);
    const selected = this.selectedClass(context.pool, classId);
    return this.plan(kind, input.owner, context.pool,
      (context.dynamic ? this.builder.depositV2(this.keys(input, request.nonce, context.pool), selected, input.amount, input.minimumUnits, input.expiryBatch, number(context.pool.feeVersion)) : context.pool.schemaVersion !== 1
        ? this.builder.depositWithFee(this.keys(input, request.nonce, context.pool), selected, input.amount, input.minimumUnits, input.expiryBatch, number(context.pool.feeVersion))
        : this.builder.deposit(this.keys(input, request.nonce, context.pool), selected, input.amount, input.minimumUnits, input.expiryBatch)), request, this.positionSetup(input.owner, context));
  }
  async prepareSell(input: SellCrypto): Promise<SwapPlan> {
    return this.redeem(input, "sell-crypto");
  }
  async prepareRedeem(input: RedeemClass): Promise<SwapPlan> {
    return this.redeem(input, "redeem-class", input.classId);
  }
  private async redeem(input: SellCrypto, kind: SwapPlan["kind"], classId?: number): Promise<SwapPlan> {
    uint(input.units, UNIT_LIMIT, true); uint(input.minimumProceeds, U64_MAX);
    const context = await this.context(input.owner);
    this.trading(context);
    this.checkFeeVersion(context.pool, input.expectedFeeVersion);
    const selected = this.selectedClass(context.pool, classId);
    const crypto = context.position?.classes[selected];
    check(!!crypto && number(crypto.units) - number(crypto.locked) >= input.units, "SwapInsufficientUnlockedUnits");
    await this.token(input.tokenAccount, input.owner);
    const request = this.reservation(context, input.expiryBatch);
    return this.plan(kind, input.owner, context.pool,
      (context.dynamic ? this.builder.redeemV2(this.keys(input, request.nonce, context.pool), selected, input.units, input.minimumProceeds, input.expiryBatch, number(context.pool.feeVersion)) : context.pool.schemaVersion !== 1
        ? this.builder.redeemWithFee(this.keys(input, request.nonce, context.pool), selected, input.units, input.minimumProceeds, input.expiryBatch, number(context.pool.feeVersion))
        : this.builder.redeem(this.keys(input, request.nonce, context.pool), selected, input.units, input.minimumProceeds, input.expiryBatch)), request, this.positionSetup(input.owner, context));
  }
  private async ownedRequest(owner: PublicKey, nonce: bigint, pool: Pool, classId?: number) {
    uint(nonce, U64_MAX);
    const info = await this.program.provider.connection.getAccountInfo(this.pdas.request(this.poolKey, nonce), "finalized");
    check(!!info, "SwapRequestNotFound");
    const value = decodeAccount(this.program, "request", info);
    check(value.pool.equals(this.poolKey) && value.owner.equals(owner) && number(value.nonce) === nonce, "SwapRequestOwnerMismatch");
    const selected = this.selectedClass(pool, classId);
    const from = value.schemaVersion === 3 ? value.fromId : value.from, to = value.schemaVersion === 3 ? value.toId : value.to, sentinel = value.schemaVersion === 3 ? 65535 : 255;
    check((value.operation === 0 && to === selected && from === sentinel)
      || (value.operation === 2 && from === selected && to === sentinel), classId === undefined ? "SwapRequestNotBenchmark" : "SwapRequestClassMismatch");
    check(number(value.refundedAmount) <= number(value.amount), "SwapRequestRefundMismatch");
    return committedRequest(value, pool);
  }
  async request(owner: PublicKey, nonce: bigint, classId?: number) {
    const { pool } = await this.context();
    const value = await this.ownedRequest(owner, nonce, pool, classId);
    check(value.status >= 0 && value.status < statuses.length, "SwapRequestStatusUnknown");
    return { address: this.pdas.request(this.poolKey, nonce), owner, nonce, classId: this.selectedClass(pool, classId), status: statuses[value.status]!,
      feeTerms: { version: number(value.feeVersion), bps: value.feeBps, cap: number(value.feeCap) },
      gross: value.status === 1 ? (value.schemaVersion === 1 ? number(value.operation === 0 ? value.amount : value.proceeds) : number(value.gross)) : 0n,
      fee: value.status === 1 ? number(value.fee) : 0n,
      targetBatch: number(value.targetBatch), expiryBatch: number(value.expiryBatch),
      mintedUnits: value.status === 1 ? number(value.minted) : 0n,
      proceeds: value.status === 1 ? number(value.proceeds) : 0n,
      remainingRefund: number(value.amount) - number(value.refundedAmount),
      refundRequired: value.operation === 0 && [2, 3, 4, 5, 7].includes(value.status),
      createsPayable: value.operation === 2 && value.status === 1 && number(value.proceeds) > 0n };
  }
  async prepareWithdraw(input: WalletAccounts & { amount: bigint }): Promise<SwapPlan> {
    uint(input.amount, U64_MAX, true);
    const context = await this.context(input.owner);
    check(context.pool.schemaVersion === 3 || !context.halted, "SwapHalted");
    check(!!context.position && number(context.position.payable) >= input.amount, "SwapInsufficientPayable");
    check(context.selectedVaultBalance >= input.amount, "SwapSelectedCollateralShortfall");
    await this.token(input.tokenAccount, input.owner);
    const { request: _, ...keys } = this.keys(input, 0n, context.pool);
    return this.plan("withdraw", input.owner, context.pool, this.builder.withdraw(keys, input.amount));
  }
  async prepareRefund(input: WalletAccounts & { nonce: bigint; classId?: number; amount?: bigint }): Promise<SwapPlan> {
    const context = await this.context(input.owner);
    const request = await this.ownedRequest(input.owner, input.nonce, context.pool, input.classId);
    const remaining = number(request.amount) - number(request.refundedAmount);
    const amount = input.amount ?? remaining;
    uint(amount, U64_MAX, true);
    check(request.operation === 0 && [2, 3, 4, 5, 7].includes(request.status)
      && amount <= remaining && !!context.position && number(context.position.refundable) >= amount, "SwapNotRefundable");
    check(context.selectedVaultBalance >= amount, "SwapSelectedCollateralShortfall");
    check(input.amount === undefined || context.pool.schemaVersion >= 4, "SwapPartialRefundUnsupported");
    await this.token(input.tokenAccount, input.owner);
    return this.plan("refund", input.owner, context.pool, input.amount === undefined ? this.builder.refund(this.keys(input, input.nonce, context.pool))
      : this.builder.refundPartial(this.keys(input, input.nonce, context.pool), amount));
  }
  async prepareCancel(owner: PublicKey, nonce: bigint, classId?: number): Promise<SwapPlan> {
    return this.manage(owner, nonce, false, classId);
  }
  async prepareExpire(owner: PublicKey, nonce: bigint, classId?: number): Promise<SwapPlan> {
    return this.manage(owner, nonce, true, classId);
  }
  private async manage(owner: PublicKey, nonce: bigint, expire: boolean, classId?: number): Promise<SwapPlan> {
    const context = await this.context(owner);
    const { pool, now } = context;
    const request = await this.ownedRequest(owner, nonce, pool, classId);
    check(request.status === 0, "SwapRequestAlreadyProcessed");
    check(!request.evaluated || request.boundSequence.lte(pool.sequence), "SwapCancellationClosed");
    check(!pool.stage || nonce >= number(pool.stageClosedEnd) || request.targetBatch.gt(pool.stageBatch), "SwapCancellationClosed");
    if (expire) check((now - number(pool.origin)) / (pool.schemaVersion >= 4 ? 1n : 60n) > number(request.expiryBatch), "SwapNotExpired");
    else {
      const rolled = pool.lastBatch.gte(request.targetBatch) ? number(pool.lastBatch) + 1n : number(request.targetBatch);
      check(now < number(pool.origin) + rolled * (pool.schemaVersion >= 4 ? 1n : 60n) || context.halted || context.registry.paused, "SwapCancellationClosed");
    }
    const keys = { ...(pool.testCollateralMint ? { testVault: this.pdas.testVault(this.poolKey) } : {}), owner, pool: this.poolKey, vault: this.pdas.vault(this.poolKey), position: this.pdas.position(this.poolKey, owner), request: this.pdas.request(this.poolKey, nonce) };
    const { owner: _, ...expiryKeys } = keys;
    const instruction = expire ? this.builder.expire({ ...expiryKeys, authority: owner }) : this.builder.cancel(keys);
    return this.plan(expire ? "expire" : "cancel", owner, pool, instruction);
  }
  async transaction(plan: SwapPlan): Promise<PreparedTransaction> {
    check(plan.pool.equals(this.poolKey) && plan.collateralMint.equals(this.options.collateralMint) && plan.testOnly, "SwapPlanMismatch");
    if (plan.request) {
      const context = await this.context();
      this.trading(context);
      check(!!plan.feeTerms && plan.feeTerms.version === number(context.pool.feeVersion), "SwapFeeChangedRebuild");
      check(number(context.pool.nextRequestNonce) === plan.request.nonce, "SwapNonceChangedRebuild");
      this.reservation(context, plan.request.expiryBatch);
    }
    const { blockhash, lastValidBlockHeight } = await this.program.provider.connection.getLatestBlockhash("finalized");
    const message = new TransactionMessage({ payerKey: plan.owner, recentBlockhash: blockhash, instructions: [...plan.instructions] }).compileToV0Message();
    return { transaction: new VersionedTransaction(message), blockhash, lastValidBlockHeight };
  }
}
