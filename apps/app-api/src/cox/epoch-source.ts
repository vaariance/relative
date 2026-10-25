import anchor, { type Program } from "@coral-xyz/anchor";
import { discriminator, EPOCH_FEE_BPS, EPOCH_FEE_CAP, EpochInstructions, epochAddresses, marketLifecycle, type EpochSelection, type LifecycleValue } from "@cox/client";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import {
  EPOCH_BASKET_SIZE,
  EPOCH_SECONDS,
  type Epoch,
  type EpochConfiguration,
  type EpochEntryInput,
  type EpochLedger,
  type EpochLot,
  type EpochLotState,
  type EpochOverview,
  type EpochPhase,
  type EpochRegistryBinding,
  type EpochRefundInput,
  type EpochRefundReason,
  type EpochWithdrawInput,
  type UnsignedTransaction,
} from "@eox/app-api";
import { PROTOCOL_ASSET_IDS } from "./chain.js";
import { TradingClosedError, TransactionInputError, associatedTokenAddress, createTokenAccountIdempotent, integer, owner, unsignedTransaction } from "./transactions.js";

const U64_MAX = (1n << 64n) - 1n;
const TOKEN_AMOUNT_OFFSET = 64;
const LOT_EPOCH_OFFSET = 8;
const EPOCH_CONFIG_OFFSET = 8;
const EPOCH_OPENS_AT_OFFSET = 40;
const PAST_EPOCHS = 2;
const CLOSING_GRACE_SECONDS = 86_400;
const FUTURE_EPOCHS = 6;
const LOT_OWNER_OFFSET = 98;
const CACHE_LIMIT = 1_000;
const REFERENCE_SCALE = "1000000000000";
const DEFAULT_ASSET_IDS: ReadonlyMap<number, string> = new Map(PROTOCOL_ASSET_IDS.map((id, index) => [index, id]));
const PHASES: Record<string, EpochPhase> = { open: "open", scoring: "scoring", allocating: "allocating", settled: "settled", voided: "voided" };
const LOT_STATES: Record<string, EpochLotState> = { pending: "pending", executed: "executed", scored: "scored", claimable: "claimable", withdrawn: "withdrawn" };

type Integer = { toString(): string };
type Variant = Record<string, Record<string, Integer> | undefined>;

interface ConfigAccount {
  admin: PublicKey;
  configId: Integer;
  operator: PublicKey;
  mint: PublicKey;
  testMint: PublicKey | null;
  methodology: number[];
  originBenchmark: Integer;
  maxEntryPriceAge: Integer;
  maxLots: number;
  lifecycleVersion: number;
  lifecycle: LifecycleValue;
  assetRegistry: PublicKey;
}

interface UniverseAsset {
  id: number;
  originPrice: Integer;
}

interface EpochState {
  opensAt: Integer;
  closesAt: Integer;
  universe: UniverseAsset[];
  phase: Variant;
  nextNonce: Integer;
  executedLots: number;
  scoredLots: number;
  allocatedLots: number;
  totalWeight: Integer;
  settlementPot: Integer;
  allZero: boolean;
  closingReferences: { assetId: number; value: Integer }[];
  closingSnapshot: unknown | null;
  ledger: { pendingGross: Integer; activeNet: Integer; heldFees: Integer; claimable: Integer; committedFees: Integer; residual: Integer };
}

interface EpochAccount {
  config: PublicKey;
  opensAt: Integer;
  vault: PublicKey;
  testVault: PublicKey;
  universe: UniverseAsset[];
  state: EpochState | null;
  bindingVersion: number;
  registryVersion: PublicKey;
  registryOriginBenchmarks: Integer[];
  universeDigest: number[];
  emptyFinalized: boolean;
}

interface EntryLotState {
  epoch: Integer;
  nonce: Integer;
  owner: number[];
  grossStake: Integer;
  fee: Integer;
  admittedAt: Integer;
  basket: number[];
  backedAsset: number;
  execution: { timestamp: Integer; references: Integer[] } | null;
  state: Variant;
}

interface LotAccount {
  epoch: PublicKey;
  nonce: Integer;
  state: EntryLotState | null;
}

export interface EpochSourceOptions {
  connection: Connection;
  program: Program;
  config: PublicKey;
  assetIds?: ReadonlyMap<number, string>;
  now?: () => number;
}

const text = (value: Integer): string => value.toString();
const refundReason = (state: EpochLotState, phase: EpochPhase | null, ended: boolean): EpochRefundReason | null => {
  if (state === "pending" && ended) return "not-executed";
  if (state === "executed" && phase === "voided") return "voided";
  return null;
};
const members = (account: EpochAccount): UniverseAsset[] => (account.state ? account.state.universe : account.universe);
const seconds = (value: Integer): number => {
  const parsed = Number(value.toString());
  if (!Number.isSafeInteger(parsed)) throw new Error("EpochTimeOutOfRange");
  return parsed;
};

function variant<T extends string>(value: Variant, names: Record<string, T>): { name: T; fields: Record<string, Integer> } {
  const keys = Object.keys(value);
  const name = keys.length === 1 ? names[keys[0]!] : undefined;
  if (!name) throw new Error("EpochVariantInvalid");
  return { name, fields: value[keys[0]!] ?? {} };
}

function tokenAmount(info: AccountInfo<Buffer> | null, mint: PublicKey): bigint {
  if (!info || info.data.length < TOKEN_AMOUNT_OFFSET + 8 || !info.data.subarray(0, 32).equals(mint.toBuffer())) throw new Error("EpochVaultInvalid");
  return info.data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET);
}

export class EpochSource {
  private readonly pdas;
  private readonly instructions: EpochInstructions;
  private readonly now: () => number;
  private readonly cache = new Map<string, Promise<unknown>>();
  private caching = false;
  private assetIds: ReadonlyMap<number, string>;

  private constructor(
    private readonly options: EpochSourceOptions,
    private readonly account: ConfigAccount,
  ) {
    this.pdas = epochAddresses(options.program.programId);
    this.instructions = new EpochInstructions(options.program);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.assetIds = options.assetIds ?? DEFAULT_ASSET_IDS;
  }

  nameAssets(assetIds: ReadonlyMap<number, string>): void {
    this.assetIds = assetIds;
    this.cache.clear();
  }

  static async open(options: EpochSourceOptions): Promise<EpochSource> {
    const info = await options.connection.getAccountInfo(options.config, "finalized");
    if (!info) throw new Error("EpochConfigNotFound");
    if (!info.owner.equals(options.program.programId)) throw new Error("EpochConfigOwnerMismatch");
    const account = options.program.coder.accounts.decode("poolConfig", info.data) as ConfigAccount;
    if (!epochAddresses(options.program.programId).config(account.admin, BigInt(text(account.configId))).equals(options.config)) throw new Error("EpochConfigIdentityMismatch");
    return new EpochSource(options, account);
  }

  get programId(): PublicKey {
    return this.options.program.programId;
  }

  get collateralMint(): PublicKey {
    return this.account.mint;
  }

  get secondaryMint(): PublicKey | null {
    return this.account.testMint;
  }

  configuration(): EpochConfiguration {
    return {
      program: this.options.program.programId.toBase58(),
      config: this.options.config.toBase58(),
      configId: text(this.account.configId),
      operator: this.account.operator.toBase58(),
      collateralMint: this.account.mint.toBase58(),
      secondaryCollateralMint: this.account.testMint?.toBase58() ?? null,
      methodologyDigest: Buffer.from(this.account.methodology).toString("hex"),
      originBenchmark: text(this.account.originBenchmark),
      maxLots: this.account.maxLots,
      maxEntryPriceAgeSeconds: seconds(this.account.maxEntryPriceAge),
      epochSeconds: EPOCH_SECONDS,
      entryFee: { bps: Number(EPOCH_FEE_BPS), cap: EPOCH_FEE_CAP.toString() },
      lifecycle: marketLifecycle(this.account),
      assetRegistry: this.account.assetRegistry.equals(PublicKey.default) ? null : this.account.assetRegistry.toBase58(),
    };
  }

  private selection(opensAt: number): EpochSelection {
    if (!Number.isSafeInteger(opensAt) || opensAt <= 0 || opensAt % EPOCH_SECONDS !== 0) throw new TransactionInputError(`opensAt must be a positive multiple of ${EPOCH_SECONDS} seconds`);
    return { config: this.options.config, opensAt: BigInt(opensAt) };
  }

  private decodeEpoch(info: AccountInfo<Buffer>, address: PublicKey, opensAt: number): EpochAccount {
    if (!info.owner.equals(this.options.program.programId)) throw new Error("EpochOwnerMismatch");
    const value = this.options.program.coder.accounts.decode("epochAccount", info.data) as EpochAccount;
    if (!value.config.equals(this.options.config) || seconds(value.opensAt) !== opensAt) throw new Error("EpochIdentityMismatch");
    if (!value.vault.equals(this.pdas.vault(address)) || !value.testVault.equals(this.pdas.testVault(address))) throw new Error("EpochVaultMismatch");
    return value;
  }

  private ticker(id: number): string {
    const value = this.assetIds.get(id);
    if (!value) throw new Error("EpochAssetUnknown");
    return value;
  }

  cacheUntilInvalidated(): void {
    this.caching = true;
  }

  invalidate(): void {
    this.cache.clear();
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.caching) return load();
    const hit = this.cache.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    const value = load();
    this.cache.set(key, value);
    value.catch(() => {
      if (this.cache.get(key) === value) this.cache.delete(key);
    });
    return value;
  }

  private accounts(keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    return this.cached(`accounts:${keys.map((key) => key.toBase58()).join(",")}`, () => this.options.connection.getMultipleAccountsInfo(keys, "finalized"));
  }

  private async read(opensAts: number[]): Promise<Epoch[]> {
    const addresses = opensAts.map((opensAt) => this.pdas.epoch(this.selection(opensAt)));
    const infos = await this.accounts(addresses);
    const found = opensAts.flatMap((opensAt, i) => (infos[i] ? [{ opensAt, address: addresses[i]!, account: this.decodeEpoch(infos[i]!, addresses[i]!, opensAt) }] : []));
    const vaultKeys = found.flatMap(({ account }) => (account.state ? [account.vault, account.testVault] : []));
    const vaults = vaultKeys.length ? await this.accounts(vaultKeys) : [];
    let cursor = 0;
    return found.map(({ opensAt, address, account }) => {
      if (!account.state) return this.view(address, opensAt, account, null);
      const primary = tokenAmount(vaults[cursor] ?? null, this.account.mint);
      const secondary = tokenAmount(vaults[cursor + 1] ?? null, this.account.testMint ?? this.account.mint);
      cursor += 2;
      return this.view(address, opensAt, account, primary + secondary);
    });
  }

  private view(address: PublicKey, opensAt: number, account: EpochAccount, vault: bigint | null): Epoch {
    const state = account.state;
    const closesAt = opensAt + EPOCH_SECONDS;
    const universe = members(account).map((asset) => ({ id: asset.id, assetId: this.ticker(asset.id), originPrice: text(asset.originPrice) }));
    const registry = this.registry(account);
    if (!state || vault === null) {
      return { address: address.toBase58(), opensAt, closesAt, phase: account.emptyFinalized ? "empty" : "draft", sealed: false, entriesOpen: false, universe, nextNonce: null, lots: null, totalWeight: null, settlementPot: null, allZero: null, closingReferences: [], closingDeadline: closesAt + CLOSING_GRACE_SECONDS, voidable: false, ledger: null, registry };
    }
    if (seconds(state.opensAt) !== opensAt || seconds(state.closesAt) !== closesAt) throw new Error("EpochScheduleMismatch");
    const phase = account.emptyFinalized ? "empty" : variant(state.phase, PHASES).name;
    const l = state.ledger;
    const liabilities = [l.pendingGross, l.activeNet, l.heldFees, l.claimable, l.committedFees, l.residual].reduce<bigint>((sum, value) => sum + BigInt(text(value)), 0n);
    const ledger: EpochLedger = {
      pendingGross: text(l.pendingGross), activeNet: text(l.activeNet), heldFees: text(l.heldFees), claimable: text(l.claimable),
      committedFees: text(l.committedFees), residual: text(l.residual), liabilities: liabilities.toString(), vault: vault.toString(), covered: vault >= liabilities,
    };
    const now = this.now();
    const nextNonce = BigInt(text(state.nextNonce));
    return {
      address: address.toBase58(),
      opensAt,
      closesAt,
      phase,
      sealed: true,
      entriesOpen: phase === "open" && now >= opensAt && now < closesAt && nextNonce < BigInt(this.account.maxLots),
      universe,
      nextNonce: nextNonce.toString(),
      lots: { executed: state.executedLots, scored: state.scoredLots, allocated: state.allocatedLots },
      totalWeight: text(state.totalWeight),
      settlementPot: text(state.settlementPot),
      allZero: state.allZero,
      closingReferences: state.closingReferences.map((r) => ({ assetId: this.ticker(r.assetId), reference: text(r.value) })),
      closingDeadline: closesAt + CLOSING_GRACE_SECONDS,
      voidable: phase === "open" && !state.closingSnapshot && now > closesAt + CLOSING_GRACE_SECONDS,
      ledger,
      registry,
    };
  }

  private registry(account: EpochAccount): EpochRegistryBinding | null {
    if (account.bindingVersion === 0) return null;
    const assets = members(account);
    if (account.registryOriginBenchmarks.length !== assets.length) throw new Error("EpochRegistryBenchmarksMismatch");
    return {
      version: account.registryVersion.toBase58(),
      universeDigest: Buffer.from(account.universeDigest).toString("hex"),
      originBenchmarks: assets.map((asset, i) => ({ assetId: this.ticker(asset.id), benchmark: text(account.registryOriginBenchmarks[i]!) })),
      scale: REFERENCE_SCALE,
    };
  }

  async overview(): Promise<EpochOverview> {
    const listed = await this.cached("epochs", () =>
      this.options.connection.getProgramAccounts(this.options.program.programId, {
        commitment: "finalized",
        dataSlice: { offset: EPOCH_OPENS_AT_OFFSET, length: 8 },
        filters: [
          { memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(discriminator("account", "EpochAccount")) } },
          { memcmp: { offset: EPOCH_CONFIG_OFFSET, bytes: this.options.config.toBase58() } },
        ],
      }),
    );
    const now = this.now();
    const times = listed.map(({ account }) => Number(account.data.readBigUInt64LE(0))).filter((value) => Number.isSafeInteger(value) && value % EPOCH_SECONDS === 0).sort((a, b) => a - b);
    const past = times.filter((value) => value + EPOCH_SECONDS <= now).slice(-PAST_EPOCHS);
    const upcoming = times.filter((value) => value + EPOCH_SECONDS > now).slice(0, FUTURE_EPOCHS);
    return { configuration: this.configuration(), epochs: await this.read([...past, ...upcoming]) };
  }

  async epoch(opensAt: number): Promise<Epoch | null> {
    return (await this.read([opensAt]))[0] ?? null;
  }

  async lots(opensAt: number, wallet: string): Promise<EpochLot[]> {
    const holder = owner(wallet);
    const address = this.pdas.epoch(this.selection(opensAt));
    const program = this.options.program;
    const accounts = await this.cached(`lots:${address.toBase58()}:${holder.toBase58()}`, () =>
      this.options.connection.getProgramAccounts(program.programId, {
        commitment: "finalized",
        filters: [
          { memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(discriminator("account", "LotAccount")) } },
          { memcmp: { offset: LOT_EPOCH_OFFSET, bytes: address.toBase58() } },
          { memcmp: { offset: LOT_OWNER_OFFSET, bytes: holder.toBase58() } },
        ],
      }),
    );
    const epochInfo = await this.cached(`epoch:${address.toBase58()}`, () => this.options.connection.getAccountInfo(address, "finalized"));
    const epochState = epochInfo ? this.decodeEpoch(epochInfo, address, opensAt).state : null;
    const phase = epochState ? variant(epochState.phase, PHASES).name : null;
    return accounts
      .map(({ pubkey, account }) => this.lot(pubkey, account, address, opensAt, holder, phase))
      .sort((a, b) => (BigInt(a.nonce) < BigInt(b.nonce) ? -1 : 1));
  }

  private lot(address: PublicKey, info: AccountInfo<Buffer>, epoch: PublicKey, opensAt: number, holder: PublicKey, phase: EpochPhase | null): EpochLot {
    const value = this.options.program.coder.accounts.decode("lotAccount", info.data) as LotAccount;
    const state = value.state;
    if (!state || !value.epoch.equals(epoch) || !this.pdas.lot(epoch, BigInt(text(value.nonce))).equals(address) || !address.equals(this.pdas.lot(epoch, BigInt(text(state.nonce))))
      || seconds(state.epoch) !== opensAt || !Buffer.from(state.owner).equals(holder.toBuffer())) {
      throw new Error("EpochLotIdentityMismatch");
    }
    const { name, fields } = variant(state.state, LOT_STATES);
    return {
      address: address.toBase58(),
      epochOpensAt: opensAt,
      nonce: text(state.nonce),
      owner: holder.toBase58(),
      grossStake: text(state.grossStake),
      fee: text(state.fee),
      admittedAt: seconds(state.admittedAt),
      basket: state.basket.map((id) => this.ticker(id)),
      backedAsset: this.ticker(state.backedAsset),
      execution: state.execution ? { timestamp: seconds(state.execution.timestamp), references: state.execution.references.map(text) } : null,
      state: name,
      score: name === "scored" ? text(fields.score!) : null,
      weight: name === "scored" ? text(fields.weight!) : null,
      claimable: name === "claimable" ? text(fields.amount!) : null,
      refund: refundReason(name, phase, this.now() >= opensAt + EPOCH_SECONDS),
    };
  }

  private collateral(value: unknown): PublicKey {
    if (value === undefined || value === this.account.mint.toBase58()) return this.account.mint;
    if (this.account.testMint && value === this.account.testMint.toBase58()) return this.account.testMint;
    throw new TransactionInputError("collateralMint must be one of this Epoch configuration's collateral mints");
  }

  private async state(selection: EpochSelection): Promise<{ address: PublicKey; account: EpochAccount }> {
    const address = this.pdas.epoch(selection);
    const info = await this.options.connection.getAccountInfo(address, "confirmed");
    if (!info) throw new TransactionInputError("this Epoch does not exist");
    return { address, account: this.decodeEpoch(info, address, Number(selection.opensAt)) };
  }

  async entry(input: EpochEntryInput): Promise<UnsignedTransaction> {
    const wallet = owner(input.owner);
    const selection = this.selection(input.opensAt);
    const grossStake = integer(input.grossStake, "grossStake", U64_MAX, true);
    if (!Array.isArray(input.basket) || input.basket.length !== EPOCH_BASKET_SIZE) throw new TransactionInputError(`basket must list ${EPOCH_BASKET_SIZE} assets`);
    const mint = this.collateral(input.collateralMint);
    const { address, account } = await this.state(selection);
    const ids = new Map(members(account).map((asset) => [this.ticker(asset.id), asset.id]));
    const basket = input.basket.map((asset) => {
      const id = typeof asset === "string" ? ids.get(asset) : undefined;
      if (id === undefined) throw new TransactionInputError(`basket asset ${String(asset)} is not in this Epoch's universe`);
      return id;
    });
    if (new Set(basket).size !== basket.length) throw new TransactionInputError("basket must not repeat an asset");
    const backed = typeof input.backedAsset === "string" ? ids.get(input.backedAsset) : undefined;
    if (backed === undefined || !basket.includes(backed)) throw new TransactionInputError("backedAsset must be one of the basket's assets");
    const lifecycle = marketLifecycle(this.account);
    if (lifecycle !== "active") throw new TradingClosedError(lifecycle === "archived" ? "this Epoch market is archived" : "this Epoch market is still being prepared");
    const state = account.state;
    if (account.emptyFinalized) throw new TradingClosedError("this Epoch has ended with no entries");
    if (!state) throw new TradingClosedError("this Epoch is a draft and does not accept entries yet");
    const now = this.now();
    if (variant(state.phase, PHASES).name !== "open" || now < input.opensAt || now >= input.opensAt + EPOCH_SECONDS) throw new TradingClosedError("this Epoch is not accepting entries now");
    const nonce = BigInt(text(state.nextNonce));
    if (nonce >= BigInt(this.account.maxLots)) throw new TradingClosedError("this Epoch has reached its entry limit");
    const lot = this.pdas.lot(address, nonce);
    return unsignedTransaction(this.options.connection, {
      operation: "epoch-entry",
      owner: wallet,
      instructions: [this.instructions.queue(selection, { nonce, owner: wallet, collateralAccount: associatedTokenAddress(wallet, mint), grossStake, basket, backedAsset: backed })],
      details: { requestId: lot.toBase58(), nonce: nonce.toString(), amount: grossStake.toString() },
    });
  }

  async withdraw(input: EpochWithdrawInput): Promise<UnsignedTransaction> {
    const wallet = owner(input.owner);
    const selection = this.selection(input.opensAt);
    const nonce = integer(input.nonce, "nonce", U64_MAX, false);
    const amount = input.amount === undefined ? null : integer(input.amount, "amount", U64_MAX, true);
    const mint = this.collateral(input.collateralMint);
    const address = this.pdas.epoch(selection);
    const lot = this.pdas.lot(address, nonce);
    const info = await this.options.connection.getAccountInfo(lot, "confirmed");
    if (!info) throw new TransactionInputError("this lot does not exist");
    const value = this.lot(lot, info, address, input.opensAt, wallet, null);
    if (value.state !== "claimable") throw new TransactionInputError("this lot has nothing to withdraw");
    const destination = associatedTokenAddress(wallet, mint);
    return unsignedTransaction(this.options.connection, {
      operation: "epoch-withdraw",
      owner: wallet,
      instructions: [
        createTokenAccountIdempotent(wallet, wallet, mint),
        amount === null ? this.instructions.withdraw(wallet, destination, selection, nonce) : this.instructions.withdrawPartial(wallet, destination, selection, nonce, amount),
      ],
      details: { requestId: lot.toBase58(), nonce: nonce.toString(), amount: (amount ?? BigInt(value.claimable!)).toString() },
    });
  }

  async refund(input: EpochRefundInput): Promise<UnsignedTransaction> {
    const wallet = owner(input.owner);
    const selection = this.selection(input.opensAt);
    const nonce = integer(input.nonce, "nonce", U64_MAX, false);
    const mint = this.collateral(input.collateralMint);
    const address = this.pdas.epoch(selection);
    const lot = this.pdas.lot(address, nonce);
    const [lotInfo, epochInfo] = await this.options.connection.getMultipleAccountsInfo([lot, address], "confirmed");
    if (!lotInfo) throw new TransactionInputError("this lot does not exist");
    if (!epochInfo) throw new TransactionInputError("this Epoch does not exist");
    const account = this.decodeEpoch(epochInfo, address, input.opensAt);
    const phase = account.state ? variant(account.state.phase, PHASES).name : null;
    const value = this.lot(lot, lotInfo, address, input.opensAt, wallet, phase);
    if (!value.refund) throw new TransactionInputError("this lot cannot be refunded now");
    const destination = associatedTokenAddress(wallet, mint);
    return unsignedTransaction(this.options.connection, {
      operation: "epoch-refund",
      owner: wallet,
      instructions: [
        createTokenAccountIdempotent(wallet, wallet, mint),
        this.instructions.refund(selection, nonce),
        this.instructions.withdraw(wallet, destination, selection, nonce),
      ],
      details: { requestId: lot.toBase58(), nonce: nonce.toString(), amount: value.grossStake },
    });
  }
}
