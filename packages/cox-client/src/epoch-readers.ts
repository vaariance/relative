import { Buffer } from "buffer";
import { type BN, type Program } from "@coral-xyz/anchor";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { decodeMarkedAccount } from "./account-extension.ts";
import { epochAddresses, type EpochSelection } from "./epoch.ts";
import { marketLifecycle, type LifecycleAccount } from "./lifecycle.ts";

export interface EpochAssetAccount { id: number; feedId: number[]; originPrice: BN }
export interface EpochPriceAccount { assetId: number; feedId: number[]; value: BN }
export interface EpochSnapshot { id: number[]; methodology: number[]; sequence: BN; oracleTimestamp: BN; benchmark: BN; prices: EpochPriceAccount[] }
export interface EpochLedgerAccount { pendingGross: BN; activeNet: BN; heldFees: BN; claimable: BN; committedFees: BN; residual: BN }
export type EpochPhaseAccount = { open: object } | { scoring: object } | { allocating: object } | { settled: object } | { voided: object };
export interface EpochEngineConfig { pool: number[]; admin: number[]; operator: number[]; collateralMint: number[]; collateralDecimals: number; methodology: number[]; originBenchmark: BN; maxEntryPriceAge: BN; maxLots: number }
export interface EpochStateAccount {
  config: EpochEngineConfig; opensAt: BN; closesAt: BN; universe: EpochAssetAccount[]; phase: EpochPhaseAccount;
  nextNonce: BN; executedLots: number; scoredLots: number; allocatedLots: number; totalWeight: BN; settlementPot: BN;
  allZero: boolean; closingSnapshot: EpochSnapshot | null; closingReferences: { assetId: number; value: BN }[];
  lastEntrySnapshot: EpochSnapshot | null; ledger: EpochLedgerAccount;
}
export interface EpochConfigAccount extends LifecycleAccount {
  admin: PublicKey; configId: BN; operator: PublicKey; mint: PublicKey; testMint: PublicKey | null;
  methodology: number[]; originBenchmark: BN; maxEntryPriceAge: BN; maxLots: number; bump: number; assetRegistry: PublicKey;
}
export interface EpochRoundAccount {
  config: PublicKey; opensAt: BN; vault: PublicKey; testVault: PublicKey; bump: number;
  universe: EpochAssetAccount[]; state: EpochStateAccount | null; bindingVersion: number; registryVersion: PublicKey;
  registryOriginBenchmarks: BN[]; universeDigest: number[]; emptyFinalized: boolean;
}
export type EpochLotStateAccount = { pending: object } | { executed: object } | { scored: { score: BN; weight: BN } } | { claimable: { amount: BN } } | { withdrawn: object };
export interface EpochLotAccount {
  epoch: PublicKey; nonce: BN; bump: number;
  state: { pool: number[]; epoch: BN; nonce: BN; owner: number[]; grossStake: BN; fee: BN; admittedAt: BN; basket: number[]; backedAsset: number;
    execution: { snapshotId: number[]; timestamp: BN; references: BN[] } | null; state: EpochLotStateAccount } | null;
}
export interface EpochSnapshotAccount { config: PublicKey; sequence: BN; oracleTimestamp: BN; benchmark: BN; expectedPrices: number; methodology: number[]; prices: EpochPriceAccount[]; sealed: boolean; digest: number[]; bump: number }
export interface EpochAccounts { poolConfig: EpochConfigAccount; epochAccount: EpochRoundAccount; lotAccount: EpochLotAccount; snapshotAccount: EpochSnapshotAccount }

export function decodeEpochAccount<K extends keyof EpochAccounts>(program: Program, name: K, info: AccountInfo<Buffer>): EpochAccounts[K] {
  if (!info.owner.equals(program.programId)) throw new Error("AccountOwnerMismatch");
  const extension = name === "poolConfig" ? "lifecycleExtension" : name === "epochAccount" ? "registryBinding" : null;
  const tagged = extension && program.idl.types?.some(type => type.name === name && type.type.kind === "struct"
    && type.type.fields?.some(field => typeof field === "object" && "name" in field && field.name === extension));
  const value = (tagged ? decodeMarkedAccount(program, name, info.data, extension!, name === "poolConfig" ? "RLCFG001" : "RLEPCH01").account
    : program.coder.accounts.decode<Record<string, unknown>>(name, info.data)) as unknown as EpochAccounts[K];
  if (name === "poolConfig") {
    const config = value as EpochConfigAccount;
    if (!("lifecycleVersion" in config)) Object.assign(config, { lifecycleVersion: 0, lifecycle: { active: {} }, assetRegistry: PublicKey.default });
    marketLifecycle(config);
  } else if (name === "epochAccount") {
    const round = value as EpochRoundAccount;
    if (!("bindingVersion" in round)) Object.assign(round, { bindingVersion: 0, registryVersion: PublicKey.default, registryOriginBenchmarks: [], universeDigest: Array(32).fill(0), emptyFinalized: false });
    if (round.bindingVersion !== 0 && round.bindingVersion !== 1) throw new Error("UnsupportedEpochBindingVersion");
    if (round.bindingVersion === 1 && (round.registryVersion.equals(PublicKey.default) || round.universeDigest.every(byte => byte === 0)
      || round.registryOriginBenchmarks.length !== epochRoster(round).length)) throw new Error("InvalidEpochRegistryBinding");
  }
  return value;
}

export function epochRoster(round: EpochRoundAccount): readonly EpochAssetAccount[] {
  return round.state ? round.state.universe : round.universe;
}
export function isEpochTerminal(round: EpochRoundAccount): boolean {
  if (round.emptyFinalized) return true;
  const state = round.state;
  return !!state && ("settled" in state.phase || "voided" in state.phase)
    && [state.ledger.pendingGross, state.ledger.activeNet, state.ledger.heldFees].every(value => value.isZero());
}

export class EpochReader {
  readonly pdas;
  readonly program: Program;
  constructor(program: Program) { this.program = program; this.pdas = epochAddresses(program.programId); }
  private async read<K extends keyof EpochAccounts>(name: K, address: PublicKey): Promise<EpochAccounts[K]> {
    const info = await this.program.provider.connection.getAccountInfo(address, "confirmed");
    if (!info) throw new Error("EpochAccountNotFound");
    return decodeEpochAccount(this.program, name, info);
  }
  async config(admin: PublicKey, configId: bigint): Promise<EpochConfigAccount> {
    const value = await this.read("poolConfig", this.pdas.config(admin, configId));
    if (!value.admin.equals(admin) || value.configId.toString() !== configId.toString()) throw new Error("EpochIdentityMismatch");
    return value;
  }
  async epoch(selection: EpochSelection): Promise<EpochRoundAccount> {
    const address = this.pdas.epoch(selection), value = await this.read("epochAccount", address);
    if (!value.config.equals(selection.config) || value.opensAt.toString() !== selection.opensAt.toString()
      || !value.vault.equals(this.pdas.vault(address)) || !value.testVault.equals(this.pdas.testVault(address))) throw new Error("EpochIdentityMismatch");
    return value;
  }
  async lot(selection: EpochSelection, nonce: bigint): Promise<EpochLotAccount> {
    const epoch = this.pdas.epoch(selection), value = await this.read("lotAccount", this.pdas.lot(epoch, nonce));
    if (!value.epoch.equals(epoch) || value.nonce.toString() !== nonce.toString()) throw new Error("EpochIdentityMismatch");
    return value;
  }
  async snapshot(config: PublicKey, sequence: bigint): Promise<EpochSnapshotAccount> {
    const value = await this.read("snapshotAccount", this.pdas.snapshot(config, sequence));
    if (!value.config.equals(config) || value.sequence.toString() !== sequence.toString()) throw new Error("EpochIdentityMismatch");
    return value;
  }
}
