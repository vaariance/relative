import { createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import anchor from "@coral-xyz/anchor";
import {
  DEVNET_FAUCET_MINT,
  DEVNET_FAUCET_SOL_LIMIT,
  DEVNET_FAUCET_TOKEN_AMOUNT,
  DEVNET_FAUCET_TOKEN_DECIMALS,
  DEVNET_FAUCET_TOKEN_SYMBOL,
  devnetFaucetInstructions,
  devnetFaucetTokenAccount,
} from "@cox/client/faucet";
import { PublicKey, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import type { FaucetChallenge, FaucetClaim, FaucetClaimState, FaucetStatus } from "@eox/app-api";
import type { RemoteSigner } from "@eox/signing";
import type { DocumentStore, DocumentTransaction } from "./document-store.js";

const DAY = 86_400;
const CHALLENGE_SECONDS = 300;
const SIGNER_EXPIRY_SECONDS = 60;
const ABANDONED_SECONDS = 120;
const RECHECK_SECONDS = 5;
const CONFIRM_STEP_MS = 1_500;
const CONFIRM_CHECKS = 20;
const ATA_RENT_LAMPORTS = 2_039_280n;
const FEE_LAMPORTS = 10_000n;
const OWNER = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CHALLENGE_ID = /^[0-9a-f]{32}$/;
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

export type FaucetErrorCode = "FAUCET_DISABLED" | "FAUCET_COOLDOWN" | "FAUCET_LIMITED" | "FAUCET_EMPTY" | "FAUCET_BUSY" | "FAUCET_UNAVAILABLE" | "CHALLENGE_INVALID" | "INVALID_REQUEST";

const HTTP: Record<FaucetErrorCode, number> = {
  FAUCET_DISABLED: 409,
  FAUCET_COOLDOWN: 429,
  FAUCET_LIMITED: 429,
  FAUCET_EMPTY: 503,
  FAUCET_BUSY: 409,
  FAUCET_UNAVAILABLE: 503,
  CHALLENGE_INVALID: 401,
  INVALID_REQUEST: 400,
};

export class FaucetError extends Error {
  readonly status: number;

  constructor(
    readonly code: FaucetErrorCode,
    message: string,
    readonly retryAt: number | null = null,
  ) {
    super(message);
    this.name = "FaucetError";
    this.status = HTTP[code];
  }
}

interface ChallengeRecord {
  challengeId: string;
  owner: string;
  message: string;
  expiresAt: number;
}

interface WalletRecord {
  owner: string;
  claimId: string;
  cooldownUntil: number;
}

interface BudgetRecord {
  count: number;
}

export interface ClaimRecord {
  claimId: string;
  owner: string;
  ipKey: string;
  day: string;
  state: FaucetClaimState;
  tokenAmount: string;
  solLamports: string;
  previousCooldownUntil: number;
  requestId: string | null;
  signature: string | null;
  signedTransaction: string | null;
  lastValidBlockHeight: number | null;
  createdAt: number;
  updatedAt: number;
  checkedAt: number | null;
  confirmedAt: number | null;
  failure: string | null;
  version: number;
}

export interface FaucetLimits {
  cooldownSeconds: number;
  ipDaily: number;
  globalDaily: number;
  solGrantLamports: bigint;
  solBelowLamports: bigint;
  reserveLamports: bigint;
}

export interface CoxFaucetOptions {
  store: DocumentStore;
  connection: Connection;
  signer: RemoteSigner;
  faucet: PublicKey;
  keyVersion: string;
  network: string;
  networkLabel: string;
  enabled: boolean;
  allowlist: ReadonlySet<string>;
  ipKey: Buffer;
  limits: FaucetLimits;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  onError?: (error: unknown) => void;
}

const paths = {
  challenge: (id: string) => `coxFaucetChallenges/${id}`,
  wallet: (owner: string) => `coxFaucetWallets/${owner}`,
  claim: (id: string) => `coxFaucetClaims/${id}`,
  global: (day: string) => `coxFaucetBudgets/global-${day}`,
  ip: (day: string, key: string) => `coxFaucetBudgets/ip-${day}-${key}`,
};

const inFlight = (state: FaucetClaimState) => state === "reserved" || state === "signed" || state === "submitted";

function ed25519Key(bytes: Uint8Array) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(bytes).toString("base64url") }, format: "jwk" });
}

function wallet(owner: unknown): PublicKey {
  if (typeof owner !== "string" || !OWNER.test(owner)) throw new FaucetError("INVALID_REQUEST", "owner must be a wallet address");
  let key: PublicKey;
  try {
    key = new PublicKey(owner);
  } catch {
    throw new FaucetError("INVALID_REQUEST", "owner must be a wallet address");
  }
  if (!PublicKey.isOnCurve(key.toBytes())) throw new FaucetError("INVALID_REQUEST", "owner must be a wallet that can sign");
  return key;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function utcDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function claimView(record: ClaimRecord): FaucetClaim {
  return {
    claimId: record.claimId,
    owner: record.owner,
    state: record.state,
    tokenAmount: record.tokenAmount,
    solLamports: record.solLamports,
    signature: record.signature,
    createdAt: record.createdAt,
    confirmedAt: record.confirmedAt,
    failure: record.failure,
  };
}

export class CoxFaucet {
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly source: PublicKey;

  constructor(private readonly options: CoxFaucetOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.wait = options.wait ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.source = devnetFaucetTokenAccount(options.faucet);
    if (options.limits.solGrantLamports < 0n || options.limits.solGrantLamports > DEVNET_FAUCET_SOL_LIMIT) throw new Error("faucet SOL grant exceeds the signer limit");
    if (options.ipKey.length < 32) throw new Error("faucet IP key must be at least 32 bytes");
  }

  private open(owner: string): boolean {
    return this.options.enabled || this.options.allowlist.has(owner);
  }

  private require(owner: string): void {
    if (!this.open(owner)) throw new FaucetError("FAUCET_DISABLED", "the faucet is not open yet");
  }

  async challenge(input: unknown): Promise<FaucetChallenge> {
    const owner = wallet((input as { owner?: unknown } | null)?.owner).toBase58();
    this.require(owner);
    const now = this.now();
    const challengeId = randomBytes(16).toString("hex");
    const expiresAt = now + CHALLENGE_SECONDS;
    const message = [
      "Relative devnet faucet",
      `Wallet: ${owner}`,
      `Challenge: ${challengeId}`,
      `Network: ${this.options.networkLabel}`,
      `Issued at: ${iso(now)}`,
      `Expires at: ${iso(expiresAt)}`,
      "Signing this message proves you own this wallet. It does not approve a transaction or move funds.",
    ].join("\n");
    const record: ChallengeRecord = { challengeId, owner, message, expiresAt };
    await this.options.store.transact(async (tx) => tx.set(paths.challenge(challengeId), record, expiresAt + DAY));
    return { challengeId, owner, message, expiresAt };
  }

  async status(ownerText: unknown): Promise<FaucetStatus> {
    const owner = wallet(ownerText).toBase58();
    const now = this.now();
    const found = await this.options.store.get<WalletRecord>(paths.wallet(owner));
    let claim = found ? await this.options.store.get<ClaimRecord>(paths.claim(found.claimId)) : null;
    if (claim && inFlight(claim.state)) claim = await this.reconcile(claim);
    const current = await this.options.store.get<WalletRecord>(paths.wallet(owner));
    const cooldownUntil = current?.cooldownUntil ?? 0;
    return {
      enabled: this.open(owner),
      owner,
      token: { mint: DEVNET_FAUCET_MINT.toBase58(), symbol: DEVNET_FAUCET_TOKEN_SYMBOL, decimals: DEVNET_FAUCET_TOKEN_DECIMALS, amount: DEVNET_FAUCET_TOKEN_AMOUNT.toString() },
      sol: { amount: this.options.limits.solGrantLamports.toString(), whenBelow: this.options.limits.solBelowLamports.toString() },
      cooldownSeconds: this.options.limits.cooldownSeconds,
      nextClaimAt: cooldownUntil > now ? cooldownUntil : null,
      claim: claim ? claimView(claim) : null,
    };
  }

  async claim(input: unknown, clientAddress: string): Promise<FaucetClaim> {
    const body = (input ?? {}) as { owner?: unknown; challengeId?: unknown; signature?: unknown };
    const ownerKey = wallet(body.owner);
    const owner = ownerKey.toBase58();
    this.require(owner);
    if (typeof body.challengeId !== "string" || !CHALLENGE_ID.test(body.challengeId)) throw new FaucetError("CHALLENGE_INVALID", "the challenge is missing or invalid");
    if (typeof body.signature !== "string" || !SIGNATURE_BASE64.test(body.signature)) throw new FaucetError("CHALLENGE_INVALID", "signature must be a base64 ed25519 signature");
    const challengeId = body.challengeId;
    const now = this.now();
    const challenge = await this.options.store.get<ChallengeRecord>(paths.challenge(challengeId));
    if (!challenge || challenge.owner !== owner || challenge.expiresAt < now) throw new FaucetError("CHALLENGE_INVALID", "the challenge is unknown, used or expired; ask for a new one");
    if (!verify(null, Buffer.from(challenge.message, "utf8"), ed25519Key(ownerKey.toBytes()), Buffer.from(body.signature, "base64"))) {
      throw new FaucetError("CHALLENGE_INVALID", "the signature does not match the challenge and wallet");
    }

    const existing = await this.options.store.get<WalletRecord>(paths.wallet(owner));
    if (existing) {
      const previous = await this.options.store.get<ClaimRecord>(paths.claim(existing.claimId));
      if (previous && inFlight(previous.state)) {
        const settled = await this.reconcile(previous);
        if (inFlight(settled.state)) throw new FaucetError("FAUCET_BUSY", "an earlier claim for this wallet is still being confirmed");
      }
    }

    const { solLamports } = await this.checkTreasury(ownerKey);
    const ipKey = createHmac("sha256", this.options.ipKey).update(clientAddress).digest("hex").slice(0, 40);
    const day = utcDay(now);
    const claimId = randomBytes(16).toString("hex");
    const { limits } = this.options;
    const reserved = await this.options.store.transact(async (tx) => {
      const stored = await tx.get<ChallengeRecord>(paths.challenge(challengeId));
      if (!stored || stored.owner !== owner || stored.expiresAt < now) throw new FaucetError("CHALLENGE_INVALID", "the challenge is unknown, used or expired; ask for a new one");
      const walletRecord = await tx.get<WalletRecord>(paths.wallet(owner));
      if (walletRecord) {
        const previous = await tx.get<ClaimRecord>(paths.claim(walletRecord.claimId));
        if (previous && inFlight(previous.state)) throw new FaucetError("FAUCET_BUSY", "an earlier claim for this wallet is still being confirmed");
        if (walletRecord.cooldownUntil > now) throw new FaucetError("FAUCET_COOLDOWN", "this wallet has already claimed in the last 24 hours", walletRecord.cooldownUntil);
      }
      const global = (await tx.get<BudgetRecord>(paths.global(day)))?.count ?? 0;
      if (global >= limits.globalDaily) throw new FaucetError("FAUCET_LIMITED", "the faucet has reached today's limit", Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + DAY);
      const ip = (await tx.get<BudgetRecord>(paths.ip(day, ipKey)))?.count ?? 0;
      if (ip >= limits.ipDaily) throw new FaucetError("FAUCET_LIMITED", "too many claims from this network today", Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + DAY);
      const record: ClaimRecord = {
        claimId,
        owner,
        ipKey,
        day,
        state: "reserved",
        tokenAmount: DEVNET_FAUCET_TOKEN_AMOUNT.toString(),
        solLamports: solLamports.toString(),
        previousCooldownUntil: walletRecord?.cooldownUntil ?? 0,
        requestId: null,
        signature: null,
        signedTransaction: null,
        lastValidBlockHeight: null,
        createdAt: now,
        updatedAt: now,
        checkedAt: null,
        confirmedAt: null,
        failure: null,
        version: 1,
      };
      const cooldownUntil = now + limits.cooldownSeconds;
      tx.delete(paths.challenge(challengeId));
      tx.set(paths.claim(claimId), record, now + 90 * DAY);
      tx.set(paths.wallet(owner), { owner, claimId, cooldownUntil } satisfies WalletRecord, cooldownUntil + 7 * DAY);
      tx.set(paths.global(day), { count: global + 1 } satisfies BudgetRecord, now + 3 * DAY);
      tx.set(paths.ip(day, ipKey), { count: ip + 1 } satisfies BudgetRecord, now + 3 * DAY);
      return record;
    });
    return claimView(await this.grant(reserved, ownerKey));
  }

  private async checkTreasury(owner: PublicKey): Promise<{ solLamports: bigint }> {
    const [faucet, source, recipient] = await this.options.connection.getMultipleAccountsInfo([this.options.faucet, this.source, owner], "confirmed");
    if (!source || source.data.length !== 165) throw new FaucetError("FAUCET_EMPTY", "the faucet has no rlUSD left");
    if (Buffer.from(source.data).readBigUInt64LE(64) < DEVNET_FAUCET_TOKEN_AMOUNT) throw new FaucetError("FAUCET_EMPTY", "the faucet has no rlUSD left");
    const balance = BigInt(recipient?.lamports ?? 0);
    const solLamports = balance < this.options.limits.solBelowLamports ? this.options.limits.solGrantLamports : 0n;
    const needed = solLamports + ATA_RENT_LAMPORTS + FEE_LAMPORTS + this.options.limits.reserveLamports;
    if (BigInt(faucet?.lamports ?? 0) < needed) throw new FaucetError("FAUCET_EMPTY", "the faucet cannot pay for more claims right now");
    return { solLamports };
  }

  private async update(current: ClaimRecord, change: Partial<ClaimRecord>): Promise<ClaimRecord | null> {
    const now = this.now();
    const next: ClaimRecord = { ...current, ...change, updatedAt: now, version: current.version + 1 };
    return this.options.store.transact(async (tx) => {
      const stored = await tx.get<ClaimRecord>(paths.claim(current.claimId));
      if (!stored || stored.version !== current.version) return null;
      tx.set(paths.claim(current.claimId), next, next.createdAt + 90 * DAY);
      return next;
    });
  }

  private async release(current: ClaimRecord, failure: string): Promise<ClaimRecord> {
    const now = this.now();
    const next: ClaimRecord = { ...current, state: "failed", failure, updatedAt: now, checkedAt: now, version: current.version + 1 };
    const result = await this.options.store.transact(async (tx: DocumentTransaction) => {
      const stored = await tx.get<ClaimRecord>(paths.claim(current.claimId));
      if (!stored || stored.version !== current.version) return stored;
      const walletRecord = await tx.get<WalletRecord>(paths.wallet(current.owner));
      const global = await tx.get<BudgetRecord>(paths.global(current.day));
      const ip = await tx.get<BudgetRecord>(paths.ip(current.day, current.ipKey));
      tx.set(paths.claim(current.claimId), next, next.createdAt + 90 * DAY);
      if (walletRecord?.claimId === current.claimId) {
        tx.set(paths.wallet(current.owner), { ...walletRecord, cooldownUntil: current.previousCooldownUntil } satisfies WalletRecord, Math.max(now, current.previousCooldownUntil) + 7 * DAY);
      }
      if (global && global.count > 0) tx.set(paths.global(current.day), { count: global.count - 1 } satisfies BudgetRecord, now + 3 * DAY);
      if (ip && ip.count > 0) tx.set(paths.ip(current.day, current.ipKey), { count: ip.count - 1 } satisfies BudgetRecord, now + 3 * DAY);
      return next;
    });
    if (!result) throw new Error(`faucet claim ${current.claimId} disappeared`);
    return result;
  }

  private async grant(reserved: ClaimRecord, owner: PublicKey): Promise<ClaimRecord> {
    const { connection, signer, faucet } = this.options;
    let unsigned: VersionedTransaction;
    let lastValidBlockHeight: number;
    try {
      const latest = await connection.getLatestBlockhash("confirmed");
      lastValidBlockHeight = latest.lastValidBlockHeight;
      const instructions = devnetFaucetInstructions({ faucet, recipient: owner, solLamports: BigInt(reserved.solLamports) });
      unsigned = new VersionedTransaction(new TransactionMessage({ payerKey: faucet, recentBlockhash: latest.blockhash, instructions }).compileToV0Message());
      const simulated = await connection.simulateTransaction(unsigned, { sigVerify: false, commitment: "confirmed" });
      if (simulated.value.err) {
        this.options.onError?.(new Error(`faucet simulation failed: ${JSON.stringify(simulated.value.err)} ${(simulated.value.logs ?? []).join(" | ")}`));
        await this.release(reserved, "the grant could not be prepared");
        throw new FaucetError("FAUCET_UNAVAILABLE", "the faucet could not prepare this grant; try again later");
      }
    } catch (error) {
      if (error instanceof FaucetError) throw error;
      await this.release(reserved, "the grant could not be prepared");
      throw error;
    }
    const requestId = `faucet.${reserved.claimId}.${reserved.version}`;
    const message = Buffer.from(unsigned.message.serialize());
    let signedBytes: Buffer;
    let signature: string;
    try {
      const result = await signer.signSolanaTransaction({
        requestId,
        role: "devnet-faucet",
        keyVersion: this.options.keyVersion,
        network: this.options.network,
        operation: { operationId: reserved.claimId, kind: "devnet-faucet-claim" },
        expiresAt: this.now() + SIGNER_EXPIRY_SECONDS,
        transactionBase64: Buffer.from(unsigned.serialize()).toString("base64"),
      });
      if (result.decision !== "signed") {
        this.options.onError?.(new Error(`faucet signer refused ${requestId}: ${result.code} ${result.reason}`));
        await this.release(reserved, "the grant was not approved");
        throw new FaucetError("FAUCET_UNAVAILABLE", "the faucet could not approve this grant; try again later");
      }
      signedBytes = Buffer.from(result.signedTransaction, "base64");
      const signed = VersionedTransaction.deserialize(signedBytes);
      const first = signed.signatures[0];
      if (!Buffer.from(signed.message.serialize()).equals(message) || signed.signatures.length !== 1 || !first || !verify(null, message, ed25519Key(faucet.toBytes()), first)) {
        throw new Error(`faucet signer returned a transaction that does not match ${requestId}`);
      }
      signature = anchor.utils.bytes.bs58.encode(first);
      if (signature !== result.signature) throw new Error(`faucet signer reported a different signature for ${requestId}`);
    } catch (error) {
      if (error instanceof FaucetError) throw error;
      await this.release(reserved, "the grant was not approved");
      throw error;
    }
    const recorded = await this.update(reserved, { state: "signed", requestId, signature, signedTransaction: signedBytes.toString("base64"), lastValidBlockHeight });
    if (!recorded) {
      const current = await this.options.store.get<ClaimRecord>(paths.claim(reserved.claimId));
      if (!current) throw new Error(`faucet claim ${reserved.claimId} disappeared`);
      return current;
    }
    return this.follow(await this.broadcast(recorded));
  }

  private async broadcast(record: ClaimRecord): Promise<ClaimRecord> {
    try {
      await this.options.connection.sendRawTransaction(Buffer.from(record.signedTransaction!, "base64"), { skipPreflight: true, maxRetries: 5 });
    } catch (error) {
      this.options.onError?.(error);
      return record;
    }
    if (record.state === "submitted") return record;
    return (await this.update(record, { state: "submitted" })) ?? record;
  }

  private async follow(record: ClaimRecord): Promise<ClaimRecord> {
    let current = record;
    for (let check = 0; inFlight(current.state) && check < CONFIRM_CHECKS; check += 1) {
      await this.wait(CONFIRM_STEP_MS);
      const outcome = await this.outcome(current);
      if (outcome === "pending") continue;
      current = await this.settle(current, outcome);
    }
    return current;
  }

  private async outcome(record: ClaimRecord): Promise<"pending" | "confirmed" | "failed" | "expired"> {
    const { value } = await this.options.connection.getSignatureStatuses([record.signature!], { searchTransactionHistory: true });
    const status = value[0];
    if (status) {
      if (status.err) return "failed";
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return "confirmed";
      return "pending";
    }
    const height = await this.options.connection.getBlockHeight("finalized");
    return height > record.lastValidBlockHeight! ? "expired" : "pending";
  }

  private async settle(record: ClaimRecord, outcome: "confirmed" | "failed" | "expired"): Promise<ClaimRecord> {
    if (outcome === "confirmed") {
      const now = this.now();
      const done = await this.update(record, { state: "confirmed", confirmedAt: now, checkedAt: now });
      return done ?? (await this.options.store.get<ClaimRecord>(paths.claim(record.claimId))) ?? record;
    }
    return this.release(record, outcome === "failed" ? "the grant failed on chain" : "the grant expired before it landed");
  }

  async reconcile(record: ClaimRecord): Promise<ClaimRecord> {
    const now = this.now();
    if (record.state === "reserved") {
      return now - record.updatedAt > ABANDONED_SECONDS ? this.release(record, "the grant was interrupted before signing") : record;
    }
    if (!inFlight(record.state) || (record.checkedAt !== null && now - record.checkedAt < RECHECK_SECONDS)) return record;
    try {
      const outcome = await this.outcome(record);
      if (outcome !== "pending") return await this.settle(record, outcome);
      const checked = (await this.update(record, { checkedAt: now })) ?? record;
      return await this.broadcast(checked);
    } catch (error) {
      this.options.onError?.(error);
      return record;
    }
  }
}
