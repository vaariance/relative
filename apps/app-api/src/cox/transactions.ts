import type { Program } from "@coral-xyz/anchor";
import { CoxInstructions, CoxSimulations, decodeAccount, type OwnerKeys, type Pool } from "@cox/client";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import {
  batchFor,
  type DepositInput,
  type DepositQuoteInput,
  type FeeTerms,
  type RedeemInput,
  type RedeemQuoteInput,
  type RequestActionInput,
  type ScheduledFeeTerms,
  type SwitchInput,
  type SwitchQuoteInput,
  type TradeQuote,
  type TransactionOperation,
  type UnsignedTransaction,
  type WithdrawInput,
} from "@eox/app-api";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const INTEGER = /^(0|[1-9][0-9]{0,38})$/;
const OWNER = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_EXPIRY_SECONDS = 604_800;
const NO_CLASS = 255;
const FEE_VERSION_CHANGED = /FeeVersionChanged|"Custom":6038\b/;

export class TransactionInputError extends Error {}

export class TradingClosedError extends Error {}

export class FeeChangedError extends Error {
  constructor() {
    super("the pool's fee terms changed; request a fresh quote before signing");
  }
}

export class TransactionRejectedError extends Error {
  constructor(
    message: string,
    readonly logs: string[],
  ) {
    super(message);
  }
}

export interface CoxTransactionContext {
  connection: Connection;
  program: Program;
  poolId: bigint;
  pool: PublicKey;
  vault: PublicKey;
  mint: PublicKey;
  testVault?: PublicKey | null;
  testMint?: PublicKey | null;
  origin: number;
  interval?: number;
  acceptanceDeadline?: number;
  classes: readonly string[];
}

interface Built {
  operation: TransactionOperation;
  owner: PublicKey;
  instructions: TransactionInstruction[];
  details: Partial<Omit<UnsignedTransaction, "operation" | "owner" | "transaction" | "recentBlockhash" | "lastValidBlockHeight">>;
}

function owner(value: unknown): PublicKey {
  if (typeof value !== "string" || !OWNER.test(value)) throw new TransactionInputError("owner must be a base58 wallet address");
  const key = new PublicKey(value);
  if (!PublicKey.isOnCurve(key.toBytes())) throw new TransactionInputError("owner must be a wallet that can sign");
  return key;
}

function integer(value: unknown, name: string, max: bigint, positive: boolean): bigint {
  if (typeof value !== "string" || !INTEGER.test(value)) throw new TransactionInputError(`${name} must be an integer string`);
  const parsed = BigInt(value);
  if (parsed > max || (positive && parsed === 0n)) throw new TransactionInputError(`${name} is out of range`);
  return parsed;
}

export const feeTerms = (pool: Pool): FeeTerms => ({ version: pool.feeVersion.toString(), bps: pool.feeBps, cap: pool.feeCap.toString() });

export const scheduledFees = (pool: Pool): ScheduledFeeTerms | null =>
  pool.feePending ? { version: pool.feePendingVersion.toString(), bps: pool.feePendingBps, cap: pool.feePendingCap.toString(), activationCutoff: Number(pool.feePendingCutoff.toString()) } : null;

const migrated = (pool: Pool): boolean => pool.schemaVersion === 2 || pool.schemaVersion === 4;

export function associatedTokenAddress(wallet: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([wallet.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}

function createTokenAccountIdempotent(payer: PublicKey, wallet: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(wallet, mint), isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export class CoxTransactions {
  private readonly instructions: CoxInstructions;

  constructor(
    private readonly context: CoxTransactionContext,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.instructions = new CoxInstructions(context.program);
  }

  private classIndex(value: unknown, name: string): number {
    const index = typeof value === "string" ? this.context.classes.indexOf(value) : -1;
    if (index < 0) throw new TransactionInputError(`${name} is not a class of this pool`);
    return index;
  }

  private get interval(): number {
    return this.context.interval ?? 60;
  }

  private expiry(value: unknown): { target: ReturnType<typeof batchFor>; expiry: bigint } {
    const target = this.context.acceptanceDeadline === undefined
      ? batchFor(this.now(), this.context.origin, this.interval)
      : batchFor(this.now(), this.context.origin, this.interval, this.context.acceptanceDeadline);
    const span = Math.floor(MAX_EXPIRY_SECONDS / this.interval);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < target.batch || value > target.batch + span) {
      throw new TransactionInputError(`expiryBatch must be a batch from ${target.batch} to ${target.batch + span}`);
    }
    return { target, expiry: BigInt(value) };
  }

  private collateral(value: unknown): PublicKey {
    if (value === undefined || value === this.context.mint.toBase58()) return this.context.mint;
    if (this.context.testMint && value === this.context.testMint.toBase58()) return this.context.testMint;
    throw new TransactionInputError("collateralMint must be one of this pool's collateral mints");
  }

  private poolKeys(): { pool: PublicKey; vault: PublicKey; testVault?: PublicKey } {
    return { pool: this.context.pool, vault: this.context.vault, ...(this.context.testVault ? { testVault: this.context.testVault } : {}) };
  }

  private open(pool: Pool): void {
    if (pool.schemaVersion === 3) throw new TradingClosedError("this pool is retired and accepts no new requests");
    if (!pool.initialized) throw new TradingClosedError("this pool has not published its first prices yet");
    if (pool.schemaVersion === 4) {
      const opensAt = Number(pool.tradingOpensAt.toString());
      if (this.now() < opensAt) throw new TradingClosedError(`trading opens at ${new Date(opensAt * 1000).toISOString()}`);
    }
  }

  private async pool(commitment: "confirmed" | "finalized" = "confirmed"): Promise<Pool> {
    const info = await this.context.connection.getAccountInfo(this.context.pool, commitment);
    if (!info) throw new TransactionInputError("the pool does not exist");
    return decodeAccount(this.context.program, "pool", info);
  }

  async feeVersion(): Promise<bigint> {
    return BigInt((await this.pool()).feeVersion.toString());
  }

  private expectedFee(pool: Pool, value: unknown): bigint | null {
    const current = BigInt(pool.feeVersion.toString());
    if (value === undefined) {
      if (migrated(pool)) throw new TransactionInputError("expectedFeeVersion is required: quote the trade first and pass its feeTerms.version");
      return null;
    }
    const expected = integer(value, "expectedFeeVersion", U64_MAX, false);
    if (expected !== current) throw new FeeChangedError();
    return migrated(pool) ? expected : null;
  }

  private submission(pool: Pool, wallet: PublicKey, mint: PublicKey = this.context.mint): { keys: OwnerKeys; nonce: bigint } {
    this.open(pool);
    const nonce = BigInt(pool.nextRequestNonce.toString());
    const pdas = this.instructions.pdas;
    return {
      nonce,
      keys: {
        ...this.poolKeys(),
        owner: wallet,
        position: pdas.position(this.context.pool, wallet),
        request: pdas.request(this.context.pool, nonce),
        userToken: associatedTokenAddress(wallet, mint),
      },
    };
  }

  async deposit(input: DepositInput): Promise<UnsignedTransaction> {
    const wallet = owner(input.owner);
    const to = this.classIndex(input.toClass, "toClass");
    const amount = integer(input.amount, "amount", U64_MAX, true);
    const minimumUnits = integer(input.minimumUnits, "minimumUnits", U128_MAX, false);
    const { target, expiry } = this.expiry(input.expiryBatch);
    const mint = this.collateral(input.collateralMint);
    const pool = await this.pool();
    const fee = this.expectedFee(pool, input.expectedFeeVersion);
    const { keys, nonce } = this.submission(pool, wallet, mint);
    return this.finish({
      operation: "deposit",
      owner: wallet,
      instructions: [fee === null ? this.instructions.deposit(keys, to, amount, minimumUnits, expiry) : this.instructions.depositWithFee(keys, to, amount, minimumUnits, expiry, fee)],
      details: { requestId: keys.request.toBase58(), nonce: nonce.toString(), targetBatch: target, expiryBatch: Number(expiry), toClass: this.context.classes[to]!, amount: amount.toString(), minimumUnits: minimumUnits.toString(), feeTerms: feeTerms(pool) },
    });
  }

  async switch(input: SwitchInput): Promise<UnsignedTransaction> {
    const wallet = owner(input.owner);
    const from = this.classIndex(input.fromClass, "fromClass");
    const to = this.classIndex(input.toClass, "toClass");
    if (from === to) throw new TransactionInputError("fromClass and toClass must differ");
    const units = integer(input.units, "units", U128_MAX, true);
    const minimumUnits = integer(input.minimumUnits, "minimumUnits", U128_MAX, false);
    const { target, expiry } = this.expiry(input.expiryBatch);
    const pool = await this.pool();
    const fee = this.expectedFee(pool, input.expectedFeeVersion);
    const { keys, nonce } = this.submission(pool, wallet);
    return this.finish({
      operation: "switch",
      owner: wallet,
      instructions: [
        createTokenAccountIdempotent(wallet, wallet, this.context.mint),
        fee === null ? this.instructions.switch(keys, from, to, units, minimumUnits, expiry) : this.instructions.switchWithFee(keys, from, to, units, minimumUnits, expiry, fee),
      ],
      details: { requestId: keys.request.toBase58(), nonce: nonce.toString(), targetBatch: target, expiryBatch: Number(expiry), fromClass: this.context.classes[from]!, toClass: this.context.classes[to]!, units: units.toString(), minimumUnits: minimumUnits.toString(), feeTerms: feeTerms(pool) },
    });
  }

  async redeem(input: RedeemInput): Promise<UnsignedTransaction> {
    const wallet = owner(input.owner);
    const from = this.classIndex(input.fromClass, "fromClass");
    const units = integer(input.units, "units", U128_MAX, true);
    const minimumProceeds = integer(input.minimumProceeds, "minimumProceeds", U64_MAX, false);
    const { target, expiry } = this.expiry(input.expiryBatch);
    const pool = await this.pool();
    const fee = this.expectedFee(pool, input.expectedFeeVersion);
    const { keys, nonce } = this.submission(pool, wallet);
    return this.finish({
      operation: "redeem",
      owner: wallet,
      instructions: [
        createTokenAccountIdempotent(wallet, wallet, this.context.mint),
        fee === null ? this.instructions.redeem(keys, from, units, minimumProceeds, expiry) : this.instructions.redeemWithFee(keys, from, units, minimumProceeds, expiry, fee),
      ],
      details: { requestId: keys.request.toBase58(), nonce: nonce.toString(), targetBatch: target, expiryBatch: Number(expiry), fromClass: this.context.classes[from]!, units: units.toString(), minimumProceeds: minimumProceeds.toString(), feeTerms: feeTerms(pool) },
    });
  }

  async quoteDeposit(input: DepositQuoteInput): Promise<TradeQuote> {
    const wallet = owner(input.owner);
    const to = this.classIndex(input.toClass, "toClass");
    const amount = integer(input.amount, "amount", U64_MAX, true);
    return this.quote(wallet, "deposit", NO_CLASS, to, amount, 0n);
  }

  async quoteSwitch(input: SwitchQuoteInput): Promise<TradeQuote> {
    const wallet = owner(input.owner);
    const from = this.classIndex(input.fromClass, "fromClass");
    const to = this.classIndex(input.toClass, "toClass");
    if (from === to) throw new TransactionInputError("fromClass and toClass must differ");
    const units = integer(input.units, "units", U128_MAX, true);
    return this.quote(wallet, "switch", from, to, 0n, units);
  }

  async quoteRedeem(input: RedeemQuoteInput): Promise<TradeQuote> {
    const wallet = owner(input.owner);
    const from = this.classIndex(input.fromClass, "fromClass");
    const units = integer(input.units, "units", U128_MAX, true);
    return this.quote(wallet, "redeem", from, NO_CLASS, 0n, units);
  }

  private async quote(wallet: PublicKey, operation: TradeQuote["operation"], from: number, to: number, amount: bigint, units: bigint): Promise<TradeQuote> {
    const pool = await this.pool("finalized");
    this.open(pool);
    const code = operation === "deposit" ? 0 : operation === "switch" ? 1 : 2;
    const simulations = new CoxSimulations(this.context.program, wallet);
    let read: { sequence: { toString(): string }; minted: { toString(): string }; proceeds: { toString(): string } };
    let gross: bigint;
    let fee = 0n;
    try {
      if (migrated(pool)) {
        const result = await simulations.quoteWithFee(this.context.pool, code, from, to, amount, units, BigInt(pool.feeVersion.toString()));
        if (result.feeVersion.toString() !== pool.feeVersion.toString()) throw new FeeChangedError();
        read = result;
        gross = BigInt(result.gross.toString());
        fee = BigInt(result.fee.toString());
      } else {
        read = await simulations.quote(this.context.pool, code, from, to, amount, units);
        gross = operation === "deposit" ? amount : BigInt(read.proceeds.toString());
      }
    } catch (error) {
      if (error instanceof FeeChangedError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (FEE_VERSION_CHANGED.test(message)) throw new FeeChangedError();
      throw new TransactionRejectedError(`quote simulation failed: ${message}`, []);
    }
    if (read.sequence.toString() !== pool.sequence.toString()) throw new TransactionRejectedError("the pool advanced while quoting; quote again", []);
    return {
      operation,
      fromClass: from === NO_CLASS ? null : this.context.classes[from]!,
      toClass: to === NO_CLASS ? null : this.context.classes[to]!,
      amount: operation === "deposit" ? amount.toString() : null,
      units: operation === "deposit" ? null : units.toString(),
      gross: gross.toString(),
      fee: fee.toString(),
      net: (gross - fee).toString(),
      mintedUnits: operation === "redeem" ? null : read.minted.toString(),
      proceeds: operation === "redeem" ? read.proceeds.toString() : null,
      feeTerms: feeTerms(pool),
      scheduledFees: scheduledFees(pool),
      observedSequence: Number(read.sequence.toString()),
      estimate: true,
    };
  }

  private async existingRequest(input: RequestActionInput): Promise<{ wallet: PublicKey; request: PublicKey; nonce: string }> {
    const wallet = owner(input.owner);
    if (typeof input.requestId !== "string" || !OWNER.test(input.requestId)) throw new TransactionInputError("requestId must be a request account address");
    const request = new PublicKey(input.requestId);
    const info = await this.context.connection.getAccountInfo(request, "confirmed");
    if (!info) throw new TransactionInputError("the request does not exist");
    const value = decodeAccount(this.context.program, "request", info);
    if (!value.pool.equals(this.context.pool) || !value.owner.equals(wallet) || !this.instructions.pdas.request(this.context.pool, BigInt(value.nonce.toString())).equals(request)) {
      throw new TransactionInputError("the request does not belong to this owner and pool");
    }
    return { wallet, request, nonce: value.nonce.toString() };
  }

  async cancel(input: RequestActionInput): Promise<UnsignedTransaction> {
    const { wallet, request, nonce } = await this.existingRequest(input);
    const position = this.instructions.pdas.position(this.context.pool, wallet);
    return this.finish({
      operation: "cancel",
      owner: wallet,
      instructions: [this.instructions.cancel({ ...this.poolKeys(), owner: wallet, position, request })],
      details: { requestId: request.toBase58(), nonce },
    });
  }

  async refund(input: RequestActionInput): Promise<UnsignedTransaction> {
    const { wallet, request, nonce } = await this.existingRequest(input);
    const mint = this.collateral(input.collateralMint);
    const keys: OwnerKeys = {
      ...this.poolKeys(),
      owner: wallet,
      position: this.instructions.pdas.position(this.context.pool, wallet),
      request,
      userToken: associatedTokenAddress(wallet, mint),
    };
    return this.finish({
      operation: "refund",
      owner: wallet,
      instructions: [createTokenAccountIdempotent(wallet, wallet, mint), this.instructions.refund(keys)],
      details: { requestId: request.toBase58(), nonce },
    });
  }

  async withdraw(input: WithdrawInput): Promise<UnsignedTransaction> {
    const wallet = owner(input.owner);
    const amount = integer(input.amount, "amount", U64_MAX, true);
    const mint = this.collateral(input.collateralMint);
    const keys = {
      ...this.poolKeys(),
      owner: wallet,
      position: this.instructions.pdas.position(this.context.pool, wallet),
      userToken: associatedTokenAddress(wallet, mint),
    };
    return this.finish({
      operation: "withdraw",
      owner: wallet,
      instructions: [createTokenAccountIdempotent(wallet, wallet, mint), this.instructions.withdraw(keys, amount)],
      details: { amount: amount.toString() },
    });
  }

  private async finish(built: Built): Promise<UnsignedTransaction> {
    const { blockhash, lastValidBlockHeight } = await this.context.connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({ payerKey: built.owner, recentBlockhash: blockhash, instructions: built.instructions }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    const simulation = await this.context.connection.simulateTransaction(transaction, { sigVerify: false, commitment: "confirmed" });
    if (simulation.value.err) {
      const logs = simulation.value.logs ?? [];
      const reason = logs.find((line) => line.includes("Error Message:")) ?? JSON.stringify(simulation.value.err);
      if (logs.some((line) => line.includes("FeeVersionChanged"))) throw new FeeChangedError();
      throw new TransactionRejectedError(reason, logs);
    }
    return {
      operation: built.operation,
      owner: built.owner.toBase58(),
      transaction: Buffer.from(transaction.serialize()).toString("base64"),
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      requestId: null,
      nonce: null,
      targetBatch: null,
      expiryBatch: null,
      fromClass: null,
      toClass: null,
      amount: null,
      units: null,
      minimumUnits: null,
      minimumProceeds: null,
      feeTerms: null,
      ...built.details,
    };
  }
}
