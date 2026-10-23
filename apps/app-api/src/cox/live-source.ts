import anchor, { type Program } from "@coral-xyz/anchor";
import { checkedPublication, CoxReader, committedRequest, decodeAccount, discriminator, type Batch, type Pool, type Registry, type Request } from "@cox/client";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import {
  ACCEPTANCE_DEADLINE_SECONDS,
  ADAPTIVE_ACCEPTANCE_DEADLINE_SECONDS,
  ADAPTIVE_INTERVAL_SECONDS,
  BATCH_SECONDS,
  batchFor,
  COX_TRANSFER_RULE,
  systemState,
  type CoxAsset,
  type CoxDeployment,
  type CoxRequest,
  type CoxStatus,
  type CryptoComposition,
  type FeeStatus,
  type Portfolio,
  type Publication,
  type ReceiptStatus,
  type RequestState,
  type TradingStatus,
  type VaultReconciliation,
} from "@eox/app-api";
import { setTimeout as sleep } from "node:timers/promises";
import type { ChainChangeFeed } from "./chain-changes.js";
import { batchOf, classIds, feeConfiguration, parseManifest, toPublication, type ChainPublication, type Manifest } from "./chain.js";
import { PublicationArchiveMissing, type PublicationArchive } from "./publication-archive.js";

const RETIRED_POOL_SCHEMA = 3;
const ADAPTIVE_POOL_SCHEMA = 4;
const DYNAMIC_POOL_SCHEMA = 5;
const DYNAMIC_REQUEST_SCHEMA = 3;
const DYNAMIC_NO_CLASS = 65535;
export const adaptivePool = (pool: Pool): boolean => pool.schemaVersion === ADAPTIVE_POOL_SCHEMA || pool.schemaVersion === DYNAMIC_POOL_SCHEMA;
import { PublicationHistory, type SegmentStore } from "./publication-history.js";
import type { CoxSource } from "./source.js";

const REQUEST_STATES: readonly RequestState[] = ["queued", "filled", "condition-failed", "expired", "zero-value-class", "cancelled", "refunded", "safety-rejected"];
const RECEIPT_STATUSES: readonly ReceiptStatus[] = ["filled", "condition-failed", "expired", "zero-value-class", "safety-rejected"];
const OPERATIONS = ["deposit", "switch", "redeem"] as const;
const NO_CLASS = 255;
const READ_ATTEMPTS = 3;
const TOKEN_AMOUNT_OFFSET = 64;
const MINT_DECIMALS_OFFSET = 44;
const BACKFILL_CONCURRENCY = 16;
const DEFAULT_PAGE = 1000;
const SAFETY_MS = 20 * 60_000;
const FINALITY_WAIT_MS = 4_000;
const FINALITY_DOUBLINGS = 3;
const PORTFOLIO_CACHE_LIMIT = 1_000;

export interface LiveCoxSourceOptions {
  connection: Connection;
  program: Program;
  poolId: bigint;
  network: string;
  history: { path: string; store: SegmentStore; segmentSize?: number; cacheSegments?: number };
  pollMs?: number;
  archive?: PublicationArchive | null;
  changes?: ChainChangeFeed | null;
  safetyMs?: number;
  finalityWaitMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

interface ChainView {
  registry: Registry;
  pool: Pool;
  vault: bigint;
  publication: ChainPublication | null;
  batch: Batch | null;
  slot: number;
  readAt: number;
  reconciliation: VaultReconciliation | null;
}

const big = (value: { toString(): string }): bigint => BigInt(value.toString());

function tokenAmount(info: AccountInfo<Buffer> | null, mint: PublicKey): bigint {
  if (!info || info.data.length < TOKEN_AMOUNT_OFFSET + 8) throw new Error("VaultAccountMissing");
  if (!info.data.subarray(0, 32).equals(mint.toBuffer())) throw new Error("VaultIdentityMismatch");
  return info.data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET);
}

export const feesMigrated = (pool: Pool): boolean => pool.schemaVersion === 2 || adaptivePool(pool);

export class PoolMethodologyChanged extends Error {
  constructor() {
    super("PoolMethodologyChanged");
  }
}

export function tradingStatus(pool: Pool, registry: Registry, now: number): TradingStatus {
  const opensAt = adaptivePool(pool) ? Number(pool.tradingOpensAt.toString()) : null;
  const gate = pool.schemaVersion === RETIRED_POOL_SCHEMA ? "retired"
    : registry.paused ? "paused"
    : !pool.initialized ? "not-initialized"
    : opensAt !== null && now < opensAt ? "before-opening"
    : "open";
  return { open: gate === "open", gate, opensAt };
}

export class LiveCoxSource implements CoxSource {
  private readonly reader: CoxReader;
  private readonly listeners = new Set<(publication: Publication) => void>();
  private readonly poolKey: PublicKey;
  private readonly vaultKey: PublicKey;
  private readonly testVaultKey: PublicKey | null;
  private view: ChainView | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly refreshListeners = new Set<() => void>();
  private readonly portfolios = new Map<string, Promise<Portfolio | null>>();
  private readonly manifests = new Map<string, Manifest>();
  private refreshing: Promise<void> | null = null;
  private pending = false;
  private pendingSlot: number | null = null;
  private unsubscribeChanges: (() => void) | null = null;
  readonly onChainRefresh?: (listener: () => void) => () => void;

  private constructor(
    private readonly options: LiveCoxSourceOptions,
    readonly manifest: Manifest,
    readonly collateralMint: PublicKey,
    readonly collateralDecimals: number,
    readonly secondaryMint: PublicKey | null,
    readonly tradingOpensAt: number | null,
    private readonly log: PublicationHistory,
    private readonly methodologyKey: PublicKey,
  ) {
    this.reader = new CoxReader(options.program);
    this.poolKey = this.reader.pdas.pool(options.poolId);
    this.vaultKey = this.reader.pdas.vault(this.poolKey);
    this.testVaultKey = secondaryMint ? this.reader.pdas.testVault(this.poolKey) : null;
    if (options.changes) {
      this.onChainRefresh = (listener) => {
        this.refreshListeners.add(listener);
        return () => this.refreshListeners.delete(listener);
      };
    }
  }

  static async open(options: LiveCoxSourceOptions): Promise<LiveCoxSource> {
    const reader = new CoxReader(options.program);
    const pool = await reader.pool(options.poolId);
    const methodology = await reader.methodology(pool.methodology);
    if (!methodology.sealed) throw new Error("PoolMethodologyNotSealed");
    const manifest = parseManifest(methodology);
    if (manifest.classes.length !== pool.classes.length || manifest.origin !== Number(pool.origin.toString())) throw new Error("PoolManifestMismatch");
    const mint = await options.connection.getAccountInfo(pool.collateralMint, "finalized");
    if (!mint || mint.data.length <= MINT_DECIMALS_OFFSET) throw new Error("CollateralMintMissing");
    const log = await PublicationHistory.open({ ...options.history, identity: { program: options.program.programId.toBase58(), pool: reader.pdas.pool(options.poolId).toBase58() } });
    const adaptive = adaptivePool(pool);
    if (adaptive !== (manifest.mode === "adaptive")) throw new Error("PoolManifestMismatch");
    const opensAt = adaptive ? Number(pool.tradingOpensAt.toString()) : null;
    return new LiveCoxSource(options, manifest, pool.collateralMint, mint.data[MINT_DECIMALS_OFFSET]!, adaptive ? pool.testCollateralMint : null, opensAt, log, pool.methodology);
  }

  private async manifestFor(digest: string): Promise<Manifest> {
    if (digest === this.manifest.digest) return this.manifest;
    const known = this.manifests.get(digest);
    if (known) return known;
    const methodology = await this.reader.methodology(this.reader.pdas.methodology(Buffer.from(digest, "hex")));
    if (!methodology.sealed) throw new Error("PublicationMethodologyNotSealed");
    const manifest = parseManifest(methodology);
    if (manifest.digest !== digest) throw new Error("PublicationManifestMismatch");
    this.manifests.set(digest, manifest);
    return manifest;
  }

  get poolAddress(): PublicKey {
    return this.poolKey;
  }

  get vaultAddress(): PublicKey {
    return this.vaultKey;
  }

  get testVaultAddress(): PublicKey | null {
    return this.testVaultKey;
  }

  get interval(): number {
    return this.manifest.mode === "adaptive" ? ADAPTIVE_INTERVAL_SECONDS : BATCH_SECONDS;
  }

  get acceptanceDeadline(): number {
    return this.manifest.mode === "adaptive" ? ADAPTIVE_ACCEPTANCE_DEADLINE_SECONDS : ACCEPTANCE_DEADLINE_SECONDS;
  }

  get classes(): string[] {
    return classIds(this.manifest);
  }

  start(): void {
    const changes = this.options.changes;
    if (changes) {
      this.unsubscribeChanges = changes.onChange((slot) => void this.refresh(slot));
      this.timer = setInterval(() => void this.refresh(null), this.options.safetyMs ?? SAFETY_MS);
      this.timer.unref();
      void this.refresh(null);
      return;
    }
    const loop = async () => {
      try {
        await this.tick();
      } catch (error) {
        this.options.onError?.(error);
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.options.pollMs ?? 5_000);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribeChanges?.();
  }

  refresh(observedSlot: number | null): Promise<void> {
    this.pending = true;
    if (observedSlot !== null) this.pendingSlot = Math.max(this.pendingSlot ?? 0, observedSlot);
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      while (this.pending && !this.stopped) {
        this.pending = false;
        const target = this.pendingSlot;
        this.pendingSlot = null;
        try {
          await this.tick();
          const first = this.options.finalityWaitMs ?? FINALITY_WAIT_MS;
          for (let wait = first; target !== null && (this.view?.slot ?? 0) < target && wait <= first * 2 ** FINALITY_DOUBLINGS && !this.stopped; wait *= 2) {
            await sleep(wait, undefined, { ref: false });
            await this.tick();
          }
        } catch (error) {
          this.options.onError?.(error);
        }
        this.portfolios.clear();
        for (const listener of this.refreshListeners) listener();
      }
      this.refreshing = null;
    })();
    return this.refreshing;
  }

  async tick(): Promise<void> {
    const view = await this.readView();
    this.view = view;
    this.portfolios.clear();
    const latest = view.publication;
    if (!view.pool.initialized || !latest) return;
    const last = Number(latest.sequence.toString());
    if (last !== Number(view.pool.sequence.toString())) throw new Error("InconsistentRead");
    while (this.log.nextSequence < last) {
      const archive = this.options.archive;
      if (!archive) throw new PublicationArchiveMissing(`publications ${this.log.nextSequence} to ${last - 1} are only in the publisher archive, which is not configured`);
      const from = this.log.nextSequence;
      const count = Math.min(BACKFILL_CONCURRENCY, last - from);
      const archived = await Promise.all(Array.from({ length: count }, (_, i) => archive.read(BigInt(from + i))));
      for (const record of archived) await this.append(record.publication, null, record.slot, record.finalized);
    }
    if (this.log.nextSequence === last) await this.append(latest, batchOf(latest, view.batch), view.slot, true);
    this.view = { ...view, reconciliation: this.log.latest()?.identity.sequence === last ? this.reconcile(view, last) : null };
  }

  async pool(): Promise<Pool> {
    return (await this.readView()).pool;
  }

  private async readView(): Promise<ChainView> {
    const program = this.options.program;
    const registryKey = this.reader.pdas.registry();
    const publicationKey = this.reader.pdas.publication(this.poolKey);
    const batchKey = this.reader.pdas.batch(this.poolKey);
    const keys = [registryKey, this.poolKey, this.vaultKey, publicationKey, batchKey, ...(this.testVaultKey ? [this.testVaultKey] : [])];
    const { context, value } = await this.options.connection.getMultipleAccountsInfoAndContext(keys, "finalized");
    const [registryInfo, poolInfo, vaultInfo, publicationInfo, batchInfo, testVaultInfo] = value;
    if (!registryInfo || !poolInfo) throw new Error("CoxAccountNotFound");
    const registry = decodeAccount(program, "registry", registryInfo);
    const pool = decodeAccount(program, "pool", poolInfo);
    if (pool.poolId.toString() !== this.options.poolId.toString() || !pool.registry.equals(registryKey) || !pool.vault.equals(this.vaultKey) || !pool.collateralMint.equals(this.collateralMint)) {
      throw new Error("PoolIdentityMismatch");
    }
    if (!pool.methodology.equals(this.methodologyKey)) throw new PoolMethodologyChanged();
    if (adaptivePool(pool) && (pool.testCollateralMint?.toBase58() ?? null) !== (this.secondaryMint?.toBase58() ?? null)) throw new Error("PoolCollateralMismatch");
    const vault = tokenAmount(vaultInfo ?? null, this.collateralMint) + (this.secondaryMint ? tokenAmount(testVaultInfo ?? null, this.secondaryMint) : 0n);
    const publication = publicationInfo ? checkedPublication(program.programId, this.poolKey, decodeAccount(program, "publication", publicationInfo)) : null;
    const batch = batchInfo ? decodeAccount(program, "batch", batchInfo) : null;
    if (batch && !batch.pool.equals(this.poolKey)) throw new Error("BatchIdentityMismatch");
    return { registry, pool, vault, publication, batch, slot: context.slot, readAt: Math.floor((this.options.now?.() ?? Date.now()) / 1000), reconciliation: null };
  }

  private reconcile(view: ChainView, sequence: number): VaultReconciliation {
    const fees = big(view.pool.fees);
    const ledger = big(view.pool.active) + big(view.pool.pending) + big(view.pool.payable) + big(view.pool.residual) + fees;
    return { sequence, vault: view.vault.toString(), ledger: ledger.toString(), fees: fees.toString(), covered: view.vault >= ledger };
  }

  private fees(pool: Pool): FeeStatus {
    const migrated = feesMigrated(pool);
    return { ...feeConfiguration(pool, migrated), migrated, committed: pool.fees.toString() };
  }

  private async append(publication: ChainPublication, batch: Batch | null, slot: number, finalized: boolean): Promise<void> {
    const previous = this.log.latest();
    const previousDigest = previous ? Buffer.from(previous.identity.stateDigest!, "hex") : Buffer.alloc(32);
    if (!Buffer.from(publication.state.previousState).equals(previousDigest)) throw new Error("PublicationPredecessorMismatch");
    const manifest = await this.manifestFor(Buffer.from(publication.manifestDigest).toString("hex"));
    const value = toPublication(publication, batch, {
      program: this.options.program.programId.toBase58(),
      poolId: this.options.poolId.toString(),
      manifest,
      predecessorBatch: previous?.identity.batch ?? null,
      finalization: { transaction: null, slot, finalized },
    });
    await this.log.append(value);
    for (const listener of this.listeners) listener(value);
  }

  async deployment(): Promise<CoxDeployment> {
    const sealed = this.manifest.sealed;
    return {
      origin: "live",
      network: this.options.network,
      program: this.options.program.programId.toBase58(),
      poolId: this.options.poolId.toString(),
      poolAddress: this.poolKey.toBase58(),
      collateralMint: this.collateralMint.toBase58(),
      collateralDecimals: this.collateralDecimals,
      secondaryCollateralMint: this.secondaryMint?.toBase58() ?? null,
      testCollateral: true,
      transferRule: COX_TRANSFER_RULE,
      methodology: { digest: this.manifest.digest, label: this.label(), status: sealed ? "sealed" : "draft", assetCount: this.manifest.assets.length },
      mode: this.manifest.mode,
      publicationIntervalSeconds: this.interval,
      tradingOpensAt: this.tradingOpensAt,
      fixtureSource: null,
    };
  }

  private label(): string {
    return `CRYPTO (pilot, ${this.manifest.assets.length} assets)`;
  }

  async status(now: number): Promise<CoxStatus> {
    const latest = this.log.latest();
    const current = batchFor(now, this.manifest.origin, this.interval, this.acceptanceDeadline);
    const missedCutoffs = this.manifest.mode === "adaptive" ? 0 : Math.max(0, current.batch - (latest?.identity.batch ?? -1) - 1);
    const view = this.view;
    const reconciliation = view?.reconciliation ?? null;
    return {
      asOf: now,
      latestSequence: latest?.identity.sequence ?? null,
      latestBatch: latest?.identity.batch ?? null,
      latestCutoff: latest?.identity.cutoff ?? null,
      ageSeconds: latest ? now - latest.identity.cutoff : null,
      missedCutoffs,
      state: systemState(missedCutoffs, view?.registry.paused ?? false, reconciliation !== null && !reconciliation.covered),
      executing: view?.pool.stage !== null && view?.pool.stage !== undefined,
      monitor: null,
      reconciliation,
      fees: view ? this.fees(view.pool) : null,
      currentBatch: current,
      trading: view ? tradingStatus(view.pool, view.registry, now) : { open: false, gate: "not-initialized", opensAt: this.tradingOpensAt },
      chain: {
        readAt: view?.readAt ?? null,
        slot: view?.slot ?? null,
        feed: this.options.changes ? (this.options.changes.state().healthy ? "healthy" : "unhealthy") : "polling",
      },
    };
  }

  async assets(): Promise<CoxAsset[]> {
    const latest = this.log.latest();
    return this.manifest.assets.map((asset, position) => {
      const price = latest?.prices[position] ?? null;
      return {
        assetId: asset.assetId,
        classIndex: asset.classIndex,
        name: asset.assetId,
        venues: asset.venues,
        latest: latest && price ? { sequence: latest.identity.sequence, batch: latest.identity.batch, priceE8: price.priceE8, venue: price.venue, step: price.step, tradeAgeMinutes: price.tradeAgeMinutes } : null,
      };
    });
  }

  async crypto(): Promise<CryptoComposition> {
    return {
      label: this.label(),
      methodologyDigest: this.manifest.digest,
      members: this.manifest.assets.map((a) => ({ assetId: a.assetId, weightNumerator: a.weightNumerator, weightDenominator: a.weightDenominator })),
    };
  }

  async latest(): Promise<Publication | null> {
    return this.log.latest();
  }

  async publication(sequence: number): Promise<Publication | null> {
    return this.log.get(sequence);
  }

  async publications(_now = 0, after: number | null = null, limit = DEFAULT_PAGE): Promise<readonly Publication[]> {
    return this.log.page(after, limit);
  }

  onPublication(listener: (publication: Publication) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ownerRequests(owner: PublicKey, pool: Pool): Promise<{ address: PublicKey; request: Request }[]> {
    const program = this.options.program;
    const accounts = await this.options.connection.getProgramAccounts(program.programId, {
      commitment: "finalized",
      filters: [
        { memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(discriminator("account", "Request")) } },
        { memcmp: { offset: 11, bytes: this.poolKey.toBase58() } },
        { memcmp: { offset: 43, bytes: owner.toBase58() } },
      ],
    });
    return accounts
      .map(({ pubkey, account }) => {
        const request = committedRequest(decodeAccount(program, "request", account), pool);
        if (!request.pool.equals(this.poolKey) || !request.owner.equals(owner) || !this.reader.pdas.request(this.poolKey, big(request.nonce)).equals(pubkey)) throw new Error("RequestIdentityMismatch");
        return { address: pubkey, request };
      })
      .sort((a, b) => (big(a.request.nonce) < big(b.request.nonce) ? -1 : 1));
  }

  async portfolio(owner: string): Promise<Portfolio | null> {
    if (!this.options.changes) return this.freshPortfolio(owner);
    const cached = this.portfolios.get(owner);
    if (cached) return cached;
    if (this.portfolios.size >= PORTFOLIO_CACHE_LIMIT) this.portfolios.clear();
    const read = this.freshPortfolio(owner);
    this.portfolios.set(owner, read);
    read.catch(() => {
      if (this.portfolios.get(owner) === read) this.portfolios.delete(owner);
    });
    return read;
  }

  private async freshPortfolio(owner: string): Promise<Portfolio | null> {
    const key = new PublicKey(owner);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.readPortfolio(key);
      } catch (error) {
        if (!(error instanceof Error && error.message === "InconsistentRead") || attempt >= READ_ATTEMPTS) throw error;
      }
    }
  }

  private async readPortfolio(owner: PublicKey): Promise<Portfolio | null> {
    const pool = await this.reader.pool(this.options.poolId);
    const position = await this.reader.position(this.options.poolId, owner).catch((error: unknown) => {
      if (error instanceof Error && error.message === "CoxAccountNotFound") return null;
      throw error;
    });
    const requests = await this.ownerRequests(owner, pool);
    if (!position && requests.length === 0) return null;
    const ids = this.classes;
    const mapped = requests.map(({ address, request }) => this.request(address, request, ids));
    const refundable = position ? big(position.refundable) : 0n;
    const queuedDeposits = requests.filter(({ request }) => request.status === 0 && request.operation === 0).reduce((sum, { request }) => sum + big(request.amount), 0n);
    return {
      owner: owner.toBase58(),
      appliedSequence: position ? Number(position.appliedSequence.toString()) : null,
      positions: position
        ? position.classes.flatMap((c, i) => (c.units.isZero() && c.locked.isZero() ? [] : [{ classId: ids[i]!, units: c.units.toString(), locked: c.locked.toString() }]))
        : [],
      payable: position ? position.payable.toString() : "0",
      refundable: refundable.toString(),
      pending: (refundable + queuedDeposits).toString(),
      requests: mapped,
    };
  }

  private request(address: PublicKey, request: Request, ids: string[]): CoxRequest {
    const operation = OPERATIONS[request.operation];
    const state = REQUEST_STATES[request.status];
    if (!operation || !state) throw new Error("RequestCodeInvalid");
    const dynamic = request.schemaVersion === DYNAMIC_REQUEST_SCHEMA;
    const cls = (index: number): string | null => {
      if (index === (dynamic ? DYNAMIC_NO_CLASS : NO_CLASS)) return null;
      const id = ids[index];
      if (!id) throw new Error("RequestClassInvalid");
      return id;
    };
    const requestId = address.toBase58();
    const receiptStatus = RECEIPT_STATUSES[request.receiptStatus];
    const receipt = request.status !== 0 && request.status !== 5 && request.applied && receiptStatus
      ? { requestId, sequence: Number(request.boundSequence.toString()), batch: Number(request.boundBatch.toString()), status: receiptStatus, minted: request.minted.toString(), proceeds: request.proceeds.toString(), gross: request.schemaVersion === 1 ? null : request.gross.toString(), fee: request.fee.toString() }
      : null;
    return {
      requestId,
      owner: request.owner.toBase58(),
      operation,
      fromClass: cls(dynamic ? request.fromId : request.from),
      toClass: cls(dynamic ? request.toId : request.to),
      amount: operation === "deposit" ? request.amount.toString() : null,
      units: operation === "deposit" ? null : request.units.toString(),
      minimumUnits: operation === "redeem" ? null : request.minimumUnits.toString(),
      minimumProceeds: operation === "redeem" ? request.minimumProceeds.toString() : null,
      targetBatch: Number(request.targetBatch.toString()),
      expiryBatch: Number(request.expiryBatch.toString()),
      state,
      feeTerms: { version: request.feeVersion.toString(), bps: request.feeBps, cap: request.feeCap.toString() },
      receipt,
    };
  }
}
