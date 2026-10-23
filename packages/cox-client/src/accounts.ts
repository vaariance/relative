import type anchor from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";

type Integer = anchor.BN;
interface Header { schemaVersion: number; bump: number }
export interface Class { backing: Integer; units: Integer }
export interface Retirement extends Header { pool: PublicKey; sequence: Integer; stateDigest: number[]; classes: Class[] }
export interface PriceWire { priceE8: Integer; venue: number; step: number; candleStart: Integer; tradeAgeMinutes: number }
export interface Registry extends Header { admin: PublicKey; runtime: PublicKey; pendingRuntime: PublicKey | null; runtimeEffectiveBatch: Integer; paused: boolean; nextPoolId: Integer; maxAcceptedBatch: Integer; activeBatches: Integer }
export interface Methodology extends Header { digest: number[]; canonical: number[]; sealed: boolean; activationBatch: Integer; expectedLength: number; roster: number[]; origin: Integer; bybit: boolean }
export interface Pool extends Header {
  poolId: Integer; registry: PublicKey; methodology: PublicKey; collateralMint: PublicKey; vault: PublicKey; origin: Integer; lastBatch: Integer; sequence: Integer;
  stateDigest: number[]; benchmark: Integer; originPrices: Integer[]; lastPrices: Integer[]; references: Integer[]; classes: Class[];
  active: Integer; pending: Integer; payable: Integer; residual: Integer; nextRequestNonce: Integer; stage: PublicKey | null; initialized: boolean; queueStart: Integer; stageBatch: Integer; stageClosedEnd: Integer;
  feeVersion: Integer; feeBps: number; feeCap: Integer; fees: Integer; feeNextVersion: Integer; feePending: boolean; feePendingVersion: Integer; feePendingBps: number; feePendingCap: Integer; feePendingCutoff: Integer; feeInitialScheduled: boolean; tradingOpensAt: Integer; testCollateralMint: PublicKey | null;
}
export interface Position extends Header {
  pool: PublicKey; owner: PublicKey; appliedSequence: Integer; classes: { units: Integer; locked: Integer }[]; payable: Integer; refundable: Integer;
  staged: boolean; stagedSequence: Integer; stagedBurns: Integer[]; stagedMints: Integer[]; stagedUnlocks: Integer[]; stagedPayable: Integer; stagedRefundable: Integer;
}
export interface Request extends Header {
  pool: PublicKey; owner: PublicKey; nonce: Integer; targetBatch: Integer; expiryBatch: Integer; operation: number; from: number; to: number; amount: Integer; units: Integer;
  minimumUnits: Integer; minimumProceeds: Integer; status: number; eligibleBatch: Integer; evaluated: boolean; boundBatch: Integer; boundSequence: Integer;
  receiptStatus: number; minted: Integer; proceeds: Integer; applied: boolean;
  feeVersion: Integer; feeBps: number; feeCap: Integer; gross: Integer; fee: Integer; refundedAmount: Integer; fromId: number; toId: number;
}
export interface Batch extends Header {
  pool: PublicKey; batchId: Integer; sequence: Integer; cutoff: Integer; predecessorSequence: Integer; predecessorDigest: number[]; snapshotDigest: number[];
  prices: PriceWire[]; benchmark: Integer; references: Integer[]; fixed: Class[]; burns: Integer[]; mints: Integer[]; incoming: Integer[]; blocked: boolean[];
  acceptedDeposits: Integer; newPayable: Integer; transferResidual: Integer; executed: number; rejected: number; closedQueueEnd: Integer; queueStart: Integer; cursor: Integer;
  nextQueueStart: Integer; stagedRoot: number[]; receiptRoot: number[]; acceptedAt: Integer; phase: number; safetyChanged: boolean; fees: Integer;
}
export interface Publication extends Header {
  pool: PublicKey; sequence: Integer; batch: Integer; stateDigest: number[]; snapshotDigest: number[]; manifestDigest: number[]; statePreimage: number[]; prices: PriceWire[]; committedAt: Integer;
}
export interface UniverseSchedule extends Header { pool: PublicKey; predecessorDigest: number[]; sourceMethodology: number[]; version: Integer; identitiesDigest: number[]; expectedInstruments: number; activationTimestamp: Integer; expiresAt: Integer; cancelled: boolean; consumed: boolean }
export interface Accounts { universeSchedule: UniverseSchedule; registry: Registry; methodology: Methodology; pool: Pool; position: Position; request: Request; batch: Batch; publication: Publication; retirement: Retirement }
