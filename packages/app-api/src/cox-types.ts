export type UnixSeconds = number;

export const COX_APP_API_SCHEMA_VERSION = "cox.app-api/v1";
export const COX_PRICE_SCALE = "100000000";
export const COX_SCALE = "1000000000000";
export const COX_REFERENCE_BASE = "100000000000000";
export const COX_TRANSFER_RULE = "COX/TRANSFER/MVP-0";
export const BATCH_SECONDS = 60;
export const ARCHIVE_DEADLINE_SECONDS = 30;
export const ACCEPTANCE_DEADLINE_SECONDS = 55;
export const ADAPTIVE_INTERVAL_SECONDS = 1;
export const ADAPTIVE_ACCEPTANCE_DEADLINE_SECONDS = 5;
export const MAX_TRADE_AGE_MINUTES = 30;
export const DELAYED_AFTER_MISSED_CUTOFFS = 3;
export const HALTED_AFTER_MISSED_CUTOFFS = 60;
export const CRYPTO_CLASS = "CRYPTO";
export const COX_FEE_POLICY = "COX/FEES/V1";

export type CoxOrigin = "fixture" | "live";
export type Scaled = string;
export type BaseUnits = string;
export type UnitQuanta = string;
export type ClassId = string;
export type PriceVenue = "kraken" | "coinbase" | "bybit" | "pyth";
export type FallbackStep = 0 | 1 | 2 | 3 | 4;
export type PoolMode = "minute" | "adaptive";
export type TradingGate = "open" | "paused" | "not-initialized" | "before-opening" | "retired" | "preparing" | "archived" | "unavailable";

export type MarketLifecycle = "preparing" | "active" | "archived";

export interface TradingStatus {
  open: boolean;
  gate: TradingGate;
  lifecycle: MarketLifecycle;
  opensAt: UnixSeconds | null;
}

export interface MarketGeneration {
  id: string;
  assetRegistry: string;
  epochConfig: string | null;
  key: string | null;
}

export interface Methodology {
  digest: string | null;
  label: string;
  status: "draft" | "sealed";
  assetCount: number;
}

export interface CoxDeployment {
  origin: CoxOrigin;
  network: string;
  program: string | null;
  poolId: string;
  poolAddress: string | null;
  collateralMint: string | null;
  collateralDecimals: number | null;
  secondaryCollateralMint: string | null;
  testCollateral: true;
  transferRule: typeof COX_TRANSFER_RULE;
  methodology: Methodology;
  mode: PoolMode;
  publicationIntervalSeconds: number;
  tradingOpensAt: UnixSeconds | null;
  cryptoClass: number | null;
  generation: MarketGeneration | null;
  fixtureSource: string | null;
}

export interface VenueSymbols {
  krakenWs: string | null;
  krakenRest: string | null;
  coinbase: string | null;
  bybit: string | null;
}

export interface CoxAsset {
  assetId: string;
  classIndex: number;
  name: string;
  venues: VenueSymbols;
  latest: { sequence: number; batch: number; priceE8: Scaled; venue: PriceVenue; step: FallbackStep; tradeAgeMinutes: number } | null;
}

export interface CryptoMember {
  assetId: string;
  weightNumerator: string;
  weightDenominator: string;
}

export interface CryptoComposition {
  label: string;
  methodologyDigest: string | null;
  members: CryptoMember[];
}

export interface PublicationIdentity {
  program: string | null;
  poolId: string;
  sequence: number;
  batch: number;
  predecessorSequence: number | null;
  predecessorBatch: number | null;
  missedBatches: number[];
  cutoff: UnixSeconds;
  manifestDigest: string | null;
  snapshotDigest: string | null;
  stateDigest: string | null;
  committedAt: UnixSeconds | null;
  finalization: { transaction: string | null; slot: number | null; finalized: boolean };
}

export interface PublishedPrice {
  assetId: string;
  priceE8: Scaled;
  venue: PriceVenue;
  step: FallbackStep;
  candleStart: UnixSeconds;
  tradeAgeMinutes: number;
}

export interface AssetReference {
  assetId: string;
  gross: Scaled | null;
  reference: Scaled;
}

export interface ClassState {
  backing: BaseUnits;
  units: UnitQuanta;
}

export interface ClassValuation {
  classId: ClassId;
  classIndex: number;
  transferFactor: Scaled | null;
  preRevaluation: ClassState;
  fixed: ClassState | null;
  final: ClassState;
}

export interface LedgerTotals {
  active: BaseUnits;
  pending: BaseUnits;
  refundable: BaseUnits | null;
  payable: BaseUnits;
  residual: BaseUnits;
  fees: BaseUnits;
  vault: BaseUnits;
}

export interface BatchFlows {
  acceptedDeposits: BaseUnits | null;
  newPayable: BaseUnits | null;
  transferResidual: BaseUnits | null;
  flowResidual: BaseUnits | null;
  fees: BaseUnits;
  executed: number;
  rejected: number;
}

export interface FeeTerms {
  version: string;
  bps: number;
  cap: BaseUnits;
}

export interface ScheduledFeeTerms extends FeeTerms {
  activationCutoff: UnixSeconds;
}

export interface FeeConfiguration {
  policy: typeof COX_FEE_POLICY | null;
  active: FeeTerms;
  scheduled: ScheduledFeeTerms | null;
}

export interface FeeStatus extends FeeConfiguration {
  migrated: boolean;
  committed: BaseUnits;
}

export interface Publication {
  identity: PublicationIdentity;
  prices: PublishedPrice[];
  benchmarkGross: Scaled | null;
  benchmark: Scaled;
  references: AssetReference[];
  classes: ClassValuation[];
  flows: BatchFlows;
  ledger: LedgerTotals;
  fees: FeeConfiguration | null;
  receiptRoot: string | null;
}

export interface Batch {
  batch: number;
  cutoff: UnixSeconds;
  acceptanceDeadline: UnixSeconds;
}

export type SystemState = "fresh" | "delayed" | "halted" | "incident" | "paused";
export type MonitorVerdict = "match" | "mismatch" | "pending";

export interface CoxStatus {
  asOf: UnixSeconds;
  latestSequence: number | null;
  latestBatch: number | null;
  latestCutoff: UnixSeconds | null;
  ageSeconds: number | null;
  missedCutoffs: number;
  state: SystemState;
  executing: boolean;
  monitor: { sequence: number; verdict: MonitorVerdict } | null;
  reconciliation: VaultReconciliation | null;
  fees: FeeStatus | null;
  currentBatch: Batch | null;
  trading: TradingStatus;
  chain?: ChainReadStatus;
}

export interface ChainReadStatus {
  readAt: UnixSeconds | null;
  slot: number | null;
  feed: "healthy" | "unhealthy" | "polling";
  methodology?: { digest: string; adoption: "current" | "rejected"; reason: string | null };
}

export interface VaultReconciliation {
  sequence: number;
  vault: BaseUnits;
  ledger: BaseUnits;
  fees: BaseUnits;
  covered: boolean;
}

export type RequestOperation = "deposit" | "switch" | "redeem";
export type ReceiptStatus = "filled" | "condition-failed" | "expired" | "zero-value-class" | "safety-rejected";
export type RequestState = "queued" | ReceiptStatus | "cancelled" | "refunded";

export interface Receipt {
  requestId: string;
  sequence: number;
  batch: number;
  status: ReceiptStatus;
  minted: UnitQuanta;
  proceeds: BaseUnits;
  gross: BaseUnits | null;
  fee: BaseUnits;
}

export interface CoxRequest {
  requestId: string;
  owner: string;
  operation: RequestOperation;
  fromClass: ClassId | null;
  toClass: ClassId | null;
  amount: BaseUnits | null;
  units: UnitQuanta | null;
  minimumUnits: UnitQuanta | null;
  minimumProceeds: BaseUnits | null;
  targetBatch: number;
  expiryBatch: number;
  state: RequestState;
  feeTerms: FeeTerms;
  receipt: Receipt | null;
}

export interface Position {
  classId: ClassId;
  units: UnitQuanta;
  locked: UnitQuanta;
}

export interface Portfolio {
  owner: string;
  appliedSequence: number | null;
  positions: Position[];
  payable: BaseUnits;
  refundable: BaseUnits;
  pending: BaseUnits;
  requests: CoxRequest[];
}

export interface CoxPublicationEvent {
  sequence: number;
  publication: Publication;
}

export interface WalletPortfolioEvent {
  owner: string;
  portfolio: Portfolio | null;
}

export const PREVIEW_SCHEMA = "relative.preview/v1";

export interface PreviewAsset {
  classId: number;
  assetId: string;
  priceE8: string;
  reference: string;
}

export interface PreviewProjectionClass {
  classId: number;
  backing: BaseUnits;
  units: UnitQuanta;
}

export interface PreviewProjection {
  sequence: number;
  stateDigest: string;
  publicationTimestamp: UnixSeconds;
  addedResidual: BaseUnits;
  classes: PreviewProjectionClass[];
}

export interface PreviewRecord {
  schema: typeof PREVIEW_SCHEMA;
  status: "estimate";
  timestamp: UnixSeconds;
  network: string;
  program: string;
  pool: string;
  methodologyDigest: string;
  universeDigest: string;
  benchmark: string;
  assets: PreviewAsset[];
  cryptoClass: number;
  cryptoReference: string;
  scales: { price: number | string; reference: number | string; collateral: number | string };
  basicProjection: PreviewProjection | null;
  chainChange?: ChainChangeMetadata;
}

export interface ChainChangeMetadata {
  schema: "relative.chain-change/v1";
  generation: string;
  revision: string;
  observedSlot: number;
  commitment: "confirmed";
  streamHealthy: boolean;
}

export interface Preview {
  record: PreviewRecord;
  ageSeconds: number;
  stale: boolean;
}

export interface PreviewHistoryPoint {
  end: UnixSeconds;
  timestamp: UnixSeconds;
  benchmark: string;
  prices: string[];
  references: string[];
}

export interface PreviewHistory {
  assets: string[];
  step: number;
  from: UnixSeconds;
  to: UnixSeconds;
  points: PreviewHistoryPoint[];
}

export interface PreviewPosition {
  classId: ClassId;
  units: UnitQuanta;
  locked: UnitQuanta;
  estimatedValue: BaseUnits | null;
}

export interface PreviewPortfolio {
  owner: string;
  timestamp: UnixSeconds;
  stale: boolean;
  basisSequence: number | null;
  unavailable: "no-projection" | "basis-mismatch" | null;
  positions: PreviewPosition[];
  estimatedValue: BaseUnits | null;
}

export type CoxStreamEvent =
  | { type: "publication"; data: CoxPublicationEvent }
  | { type: "status"; data: CoxStatus }
  | { type: "portfolio"; data: WalletPortfolioEvent }
  | { type: "preview"; data: Preview };

export interface CoxPublicationPage {
  events: CoxPublicationEvent[];
  nextAfter: number | null;
}

export interface CoxApiResponse<T> {
  schemaVersion: typeof COX_APP_API_SCHEMA_VERSION;
  deployment: CoxDeployment;
  status: CoxStatus;
  data: T;
}

export type CoxErrorCode =
  | "NO_PUBLICATION"
  | "NO_PREVIEW"
  | "PUBLICATION_NOT_FOUND"
  | "UNKNOWN_ASSET"
  | "UNKNOWN_CLASS"
  | "UNKNOWN_WALLET"
  | "NOT_LIVE"
  | "NOTHING_TO_DO"
  | "TRANSACTION_REJECTED"
  | "TRANSACTION_NOT_FOUND"
  | "RATE_LIMITED"
  | "FEE_CHANGED"
  | "TRADING_CLOSED"
  | "UNKNOWN_EPOCH"
  | "HISTORY_EXPIRED"
  | "NOT_CONFIGURED"
  | "FAUCET_DISABLED"
  | "FAUCET_COOLDOWN"
  | "FAUCET_LIMITED"
  | "FAUCET_EMPTY"
  | "FAUCET_BUSY"
  | "FAUCET_UNAVAILABLE"
  | "CHALLENGE_INVALID"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "INTERNAL_ERROR";

export interface CoxApiErrorBody {
  schemaVersion: typeof COX_APP_API_SCHEMA_VERSION;
  error: { code: CoxErrorCode; message: string };
}

export type TransactionOperation = "deposit" | "switch" | "redeem" | "cancel" | "refund" | "withdraw" | "epoch-entry" | "epoch-withdraw" | "epoch-refund" | "epoch-prepare" | "epoch-finalize-empty" | "epoch-void" | "prepare-position";

export interface DepositInput {
  owner: string;
  toClass: ClassId;
  amount: BaseUnits;
  minimumUnits: UnitQuanta;
  expiryBatch: number;
  expectedFeeVersion?: string;
  collateralMint?: string;
}

export interface SwitchInput {
  owner: string;
  fromClass: ClassId;
  toClass: ClassId;
  units: UnitQuanta;
  minimumUnits: UnitQuanta;
  expiryBatch: number;
  expectedFeeVersion?: string;
}

export interface RedeemInput {
  owner: string;
  fromClass: ClassId;
  units: UnitQuanta;
  minimumProceeds: BaseUnits;
  expiryBatch: number;
  expectedFeeVersion?: string;
}

export interface PreparePositionInput {
  owner: string;
}

export interface PositionPreparation {
  position: string;
  bytes: string;
  requiredBytes: string;
  ready: boolean;
}

export interface RequestActionInput {
  owner: string;
  requestId: string;
  collateralMint?: string;
}

export interface WithdrawInput {
  owner: string;
  amount: BaseUnits;
  collateralMint?: string;
}

export type QuoteOperation = "deposit" | "switch" | "redeem";

export interface DepositQuoteInput {
  owner: string;
  toClass: ClassId;
  amount: BaseUnits;
}

export interface SwitchQuoteInput {
  owner: string;
  fromClass: ClassId;
  toClass: ClassId;
  units: UnitQuanta;
}

export interface RedeemQuoteInput {
  owner: string;
  fromClass: ClassId;
  units: UnitQuanta;
}

export interface TradeQuote {
  operation: QuoteOperation;
  fromClass: ClassId | null;
  toClass: ClassId | null;
  amount: BaseUnits | null;
  units: UnitQuanta | null;
  gross: BaseUnits;
  fee: BaseUnits;
  net: BaseUnits;
  mintedUnits: UnitQuanta | null;
  proceeds: BaseUnits | null;
  feeTerms: FeeTerms;
  scheduledFees: ScheduledFeeTerms | null;
  observedSequence: number;
  estimate: true;
}

export interface UnsignedTransaction {
  operation: TransactionOperation;
  owner: string;
  transaction: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  requestId: string | null;
  nonce: string | null;
  targetBatch: Batch | null;
  expiryBatch: number | null;
  fromClass: ClassId | null;
  toClass: ClassId | null;
  amount: BaseUnits | null;
  units: UnitQuanta | null;
  minimumUnits: UnitQuanta | null;
  minimumProceeds: BaseUnits | null;
  feeTerms: FeeTerms | null;
  preparation?: PositionPreparation;
}

export type SubmissionState = "submitted" | "confirmed" | "finalized" | "failed" | "expired";

export interface Submission {
  signature: string;
  owner: string;
  operation: TransactionOperation | null;
  transaction: string;
  submittedAt: UnixSeconds;
  state: SubmissionState;
  slot: number | null;
  error: string | null;
}

export const EPOCH_SECONDS = 14_400;
export const EPOCH_BASKET_SIZE = 30;

export type EpochPhase = "draft" | "open" | "scoring" | "allocating" | "settled" | "voided" | "empty";
export type EpochLotState = "pending" | "executed" | "scored" | "claimable" | "withdrawn";
export type EpochRefundReason = "not-executed" | "voided";

export interface EpochConfiguration {
  program: string;
  config: string;
  configId: string;
  operator: string;
  collateralMint: string;
  secondaryCollateralMint: string | null;
  methodologyDigest: string;
  originBenchmark: Scaled;
  maxLots: number;
  maxEntryPriceAgeSeconds: number;
  epochSeconds: number;
  entryFee: { bps: number; cap: BaseUnits };
  lifecycle: MarketLifecycle;
  assetRegistry: string | null;
}

export interface EpochUniverseMember {
  id: number;
  assetId: string;
  originPrice: Scaled;
}

export interface EpochLedger {
  pendingGross: BaseUnits;
  activeNet: BaseUnits;
  heldFees: BaseUnits;
  claimable: BaseUnits;
  committedFees: BaseUnits;
  residual: BaseUnits;
  liabilities: BaseUnits;
  vault: BaseUnits;
  covered: boolean;
}

export interface Epoch {
  address: string;
  opensAt: UnixSeconds;
  closesAt: UnixSeconds;
  phase: EpochPhase;
  sealed: boolean;
  entriesOpen: boolean;
  universe: EpochUniverseMember[];
  nextNonce: string | null;
  lots: { executed: number; scored: number; allocated: number } | null;
  totalWeight: Scaled | null;
  settlementPot: BaseUnits | null;
  allZero: boolean | null;
  closingReferences: { assetId: string; reference: Scaled }[];
  closingDeadline: UnixSeconds;
  voidable: boolean;
  terminal: boolean;
  ledger: EpochLedger | null;
  registry: EpochRegistryBinding | null;
}

export interface EpochRegistryBinding {
  version: string;
  universeDigest: string;
  originBenchmarks: { assetId: string; benchmark: Scaled }[];
  scale: Scaled;
}

export interface EpochOverview {
  configuration: EpochConfiguration;
  epochs: Epoch[];
}

export interface EpochLot {
  address: string;
  epochOpensAt: UnixSeconds;
  nonce: string;
  owner: string;
  grossStake: BaseUnits;
  fee: BaseUnits;
  admittedAt: UnixSeconds;
  basket: string[];
  backedAsset: string;
  execution: { timestamp: UnixSeconds; references: Scaled[] } | null;
  state: EpochLotState;
  score: Scaled | null;
  weight: Scaled | null;
  claimable: BaseUnits | null;
  refund: EpochRefundReason | null;
}

export interface EpochEntryInput {
  owner: string;
  opensAt: UnixSeconds;
  grossStake: BaseUnits;
  basket: string[];
  backedAsset: string;
  collateralMint?: string;
}

export interface EpochPrepareInput {
  owner: string;
}

export interface EpochPreparation {
  opensAt: UnixSeconds;
  remainingInstructions: number;
  transaction: UnsignedTransaction;
}

export interface EpochFinalizeEmptyInput {
  owner: string;
  opensAt: UnixSeconds;
}

export interface EpochVoidInput {
  owner: string;
  opensAt: UnixSeconds;
}

export interface EpochRefundInput {
  owner: string;
  opensAt: UnixSeconds;
  nonce: string;
  collateralMint?: string;
}

export interface EpochWithdrawInput {
  owner: string;
  opensAt: UnixSeconds;
  nonce: string;
  amount?: BaseUnits;
  collateralMint?: string;
}

export function batchFor(now: UnixSeconds, origin: UnixSeconds, interval = BATCH_SECONDS, deadline = ACCEPTANCE_DEADLINE_SECONDS): Batch {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(origin) || !Number.isSafeInteger(interval) || interval < 1 || origin % interval !== 0) {
    throw new Error("batch times must be whole seconds with an origin aligned to the publication interval");
  }
  const batch = now < origin ? 0 : Math.floor((now - origin) / interval) + 1;
  const cutoff = origin + batch * interval;
  return { batch, cutoff, acceptanceDeadline: cutoff + deadline };
}

export function systemState(missedCutoffs: number, paused: boolean, incident: boolean): SystemState {
  if (paused) return "paused";
  if (missedCutoffs >= HALTED_AFTER_MISSED_CUTOFFS) return "halted";
  if (incident) return "incident";
  if (missedCutoffs >= DELAYED_AFTER_MISSED_CUTOFFS) return "delayed";
  return "fresh";
}

export type FaucetClaimState = "reserved" | "signed" | "submitted" | "confirmed" | "failed";

export interface FaucetChallenge {
  challengeId: string;
  owner: string;
  message: string;
  expiresAt: UnixSeconds;
}

export interface FaucetClaimInput {
  owner: string;
  challengeId: string;
  signature: string;
}

export interface FaucetClaim {
  claimId: string;
  owner: string;
  state: FaucetClaimState;
  tokenAmount: BaseUnits;
  solLamports: string;
  signature: string | null;
  createdAt: UnixSeconds;
  confirmedAt: UnixSeconds | null;
  failure: string | null;
}

export interface FaucetStatus {
  enabled: boolean;
  owner: string;
  token: { mint: string; symbol: string; decimals: number; amount: BaseUnits };
  sol: { amount: string; whenBelow: string };
  cooldownSeconds: number;
  nextClaimAt: UnixSeconds | null;
  claim: FaucetClaim | null;
}
