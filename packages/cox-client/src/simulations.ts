import { Buffer } from "buffer";
import type anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { decodeAccount } from "./readers.ts";
import { CoxInstructions } from "./builders.ts";

type Integer = anchor.BN;
export interface ReferenceRead { sequence: Integer; batch: Integer; cutoff: Integer; reference: Integer; backing: Integer; units: Integer; stateDigest: number[] }
export interface PositionRead { sequence: Integer; classes: { units: Integer; locked: Integer }[]; payable: Integer; refundable: Integer }
export interface QuoteRead { sequence: Integer; minted: Integer; proceeds: Integer }
export interface FeeQuoteRead extends QuoteRead { gross: Integer; fee: Integer; feeVersion: Integer }
interface Returns { feeQuoteRead: FeeQuoteRead; referenceRead: ReferenceRead; positionRead: PositionRead; quoteRead: QuoteRead }
export class CoxSimulations {
  readonly instructions;
  readonly program: Program;
  readonly feePayer: PublicKey;
  constructor(program: Program, feePayer: PublicKey) { this.program = program; this.feePayer = feePayer; this.instructions = new CoxInstructions(program); }
  private async simulate<K extends keyof Returns>(instruction: TransactionInstruction, returns: K, dynamic = false): Promise<Returns[K]> {
    const connection = this.program.provider.connection;
    const blockhash = await connection.getLatestBlockhash("finalized");
    const message = new TransactionMessage({ payerKey: this.feePayer, recentBlockhash: blockhash.blockhash, instructions: dynamic ? [ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }), instruction] : [instruction] }).compileToV0Message();
    const simulation = await connection.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, commitment: "finalized" });
    if (simulation.value.err) throw new Error(`CoxSimulationFailed:${JSON.stringify(simulation.value.err)}`);
    const result = simulation.value.returnData;
    if (!result || result.programId !== this.program.programId.toBase58() || result.data[1] !== "base64") throw new Error("InvalidSimulationReturnData");
    return this.program.coder.types.decode(returns, Buffer.from(result.data[0], "base64")) as Returns[K];
  }
  reference(pool: PublicKey, classIndex: number) { return this.simulate(this.instructions.readReference(pool, classIndex), "referenceRead"); }
  async position(pool: PublicKey, owner: PublicKey) {
    const info = await this.program.provider.connection.getAccountInfo(pool, "finalized");
    if (!info) throw new Error("CoxAccountNotFound");
    const value = decodeAccount(this.program, "pool", info);
    if (value.schemaVersion === 5 && value.classes.length > 31) throw new Error("CoxPositionSimulationLimit:UseCoxReader.position");
    return this.simulate(this.instructions.readPosition(pool, owner), "positionRead", value.schemaVersion === 5);
  }
  referenceV2(pool: PublicKey, classIndex: number) { return this.simulate(this.instructions.readReferenceV2(pool, classIndex), "referenceRead", true); }
  quote(pool: PublicKey, operation: 0 | 1 | 2, from: number, to: number, amount: bigint, units: bigint) { return this.simulate(this.instructions.quoteRequest(pool, operation, from, to, amount, units), "quoteRead"); }
  quoteV2(pool: PublicKey, operation: 0 | 1 | 2, from: number, to: number, amount: bigint, units: bigint, expectedFeeVersion: bigint) { return this.simulate(this.instructions.quoteRequestV2(pool, operation, from, to, amount, units, expectedFeeVersion), "feeQuoteRead", true); }
  quoteWithFee(pool: PublicKey, operation: 0 | 1 | 2, from: number, to: number, amount: bigint, units: bigint, expectedFeeVersion: bigint) { return this.simulate(this.instructions.quoteRequestWithFee(pool, operation, from, to, amount, units, expectedFeeVersion), "feeQuoteRead"); }
}
