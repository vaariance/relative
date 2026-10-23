import { sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import anchor from "@coral-xyz/anchor";
import { DEVNET_FAUCET_MINT, devnetFaucetTokenAccount } from "@cox/client/faucet";
import { createCoxApiClient, CoxApiError } from "@eox/app-api";
import type { RemoteSigner, SignResult, SignSolanaTransactionRequest } from "@eox/signing";
import { Keypair, PublicKey, SystemProgram, VersionedTransaction, type Connection } from "@solana/web3.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DocumentStore, DocumentTransaction } from "../src/cox/document-store.js";
import { CoxFaucet, FaucetError } from "../src/cox/faucet.js";
import { CoxFixtureSource } from "../src/cox/fixture-source.js";
import { createCoxApiServer } from "../src/cox/server.js";

const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const START = 1_792_800_000;

class MemoryStore implements DocumentStore {
  readonly docs = new Map<string, string>();
  private lock: Promise<unknown> = Promise.resolve();

  async get<T>(path: string): Promise<T | null> {
    const text = this.docs.get(path);
    return text === undefined ? null : (JSON.parse(text) as T);
  }

  transact<T>(work: (tx: DocumentTransaction) => Promise<T>): Promise<T> {
    const run = this.lock.then(async () => {
      const writes = new Map<string, string | null>();
      const tx: DocumentTransaction = {
        get: async <V>(path: string) => {
          const text = this.docs.get(path);
          return text === undefined ? null : (JSON.parse(text) as V);
        },
        set: (path, value) => void writes.set(path, JSON.stringify(value)),
        delete: (path) => void writes.set(path, null),
      };
      const result = await work(tx);
      for (const [path, value] of writes) {
        if (value === null) this.docs.delete(path);
        else this.docs.set(path, value);
      }
      return result;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }
}

function tokenAccount(owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  DEVNET_FAUCET_MINT.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data;
}

class Chain {
  treasury = 9_900_000_000n;
  faucetLamports = 1_250_000_000;
  balances = new Map<string, number>();
  sent: VersionedTransaction[] = [];
  statuses = new Map<string, { err: unknown; confirmationStatus: string } | null>();
  sendFails = false;
  landImmediately = true;
  height = 1000;
  lastValid = 1150;
  simulateError: unknown = null;

  constructor(private readonly faucet: PublicKey) {}

  connection(): Connection {
    return {
      getMultipleAccountsInfo: async (keys: PublicKey[]) =>
        keys.map((key) => {
          if (key.equals(this.faucet)) return { lamports: this.faucetLamports, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false };
          if (key.equals(devnetFaucetTokenAccount(this.faucet))) return { lamports: 2_039_280, data: tokenAccount(this.faucet, this.treasury), owner: SystemProgram.programId, executable: false };
          const lamports = this.balances.get(key.toBase58());
          return lamports === undefined ? null : { lamports, data: Buffer.alloc(0), owner: SystemProgram.programId, executable: false };
        }),
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: this.lastValid }),
      simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: this.simulateError, logs: [] } }),
      sendRawTransaction: async (bytes: Buffer) => {
        if (this.sendFails) throw new Error("connection reset");
        const transaction = VersionedTransaction.deserialize(bytes);
        this.sent.push(transaction);
        const signature = anchor.utils.bytes.bs58.encode(transaction.signatures[0]!);
        if (this.landImmediately) this.statuses.set(signature, { err: null, confirmationStatus: "confirmed" });
        return signature;
      },
      getSignatureStatuses: async (signatures: string[]) => ({ context: { slot: 1 }, value: signatures.map((s) => this.statuses.get(s) ?? null) }),
      getBlockHeight: async () => this.height,
    } as unknown as Connection;
  }
}

class LocalSigner implements Pick<RemoteSigner, "signSolanaTransaction"> {
  requests: Omit<SignSolanaTransactionRequest, "chain">[] = [];
  refuse = false;

  constructor(private readonly key: Keypair) {}

  async signSolanaTransaction(request: Omit<SignSolanaTransactionRequest, "chain">): Promise<SignResult> {
    this.requests.push(request);
    if (this.refuse) return { schemaVersion: "eox.signing/v1", requestId: request.requestId, decision: "rejected", payloadSha256: null, code: "LIMIT_EXCEEDED", reason: "test refusal", decidedAt: 0 };
    const transaction = VersionedTransaction.deserialize(Buffer.from(request.transactionBase64, "base64"));
    transaction.sign([this.key]);
    return {
      schemaVersion: "eox.signing/v1",
      requestId: request.requestId,
      decision: "signed",
      payloadSha256: "",
      signer: { role: "devnet-faucet", address: this.key.publicKey.toBase58(), keyVersion: request.keyVersion },
      signature: anchor.utils.bytes.bs58.encode(transaction.signatures[0]!),
      signedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
      decidedAt: 0,
    };
  }
}

function signMessage(wallet: Keypair, message: string): string {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(wallet.secretKey.subarray(0, 32))]);
  return sign(null, Buffer.from(message, "utf8"), { key: pkcs8, format: "der", type: "pkcs8" }).toString("base64");
}

let now = START;
let store: MemoryStore;
let chain: Chain;
let signer: LocalSigner;
let faucetKey: Keypair;

function faucet(overrides: Partial<ConstructorParameters<typeof CoxFaucet>[0]> = {}): CoxFaucet {
  return new CoxFaucet({
    store,
    connection: chain.connection(),
    signer: signer as unknown as RemoteSigner,
    faucet: faucetKey.publicKey,
    keyVersion: "projects/p/locations/l/keyRings/r/cryptoKeys/devnet-faucet/cryptoKeyVersions/1",
    network: NETWORK,
    networkLabel: "solana-devnet",
    enabled: true,
    allowlist: new Set(),
    ipKey: Buffer.alloc(32, 7),
    limits: { cooldownSeconds: 86_400, ipDaily: 3, globalDaily: 50, solGrantLamports: 10_000_000n, solBelowLamports: 5_000_000n, reserveLamports: 50_000_000n },
    now: () => now,
    wait: async () => undefined,
    ...overrides,
  });
}

async function claimFor(service: CoxFaucet, wallet: Keypair, ip = "203.0.113.7") {
  const challenge = await service.challenge({ owner: wallet.publicKey.toBase58() });
  return service.claim({ owner: wallet.publicKey.toBase58(), challengeId: challenge.challengeId, signature: signMessage(wallet, challenge.message) }, ip);
}

async function rejects(promise: Promise<unknown>, code: string): Promise<FaucetError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(FaucetError);
  expect((error as FaucetError).code).toBe(code);
  return error as FaucetError;
}

beforeEach(() => {
  now = START;
  store = new MemoryStore();
  faucetKey = Keypair.generate();
  chain = new Chain(faucetKey.publicKey);
  signer = new LocalSigner(faucetKey);
});

describe("devnet faucet", () => {
  it("grants 100 rlUSD after a signed ownership challenge and starts a 24-hour cooldown", async () => {
    const service = faucet();
    const wallet = Keypair.generate();
    chain.balances.set(wallet.publicKey.toBase58(), 50_000_000);
    const claim = await claimFor(service, wallet);
    expect(claim).toMatchObject({ owner: wallet.publicKey.toBase58(), state: "confirmed", tokenAmount: "100000000", solLamports: "0", failure: null });
    expect(chain.sent).toHaveLength(1);
    expect(claim.signature).toBe(anchor.utils.bytes.bs58.encode(chain.sent[0]!.signatures[0]!));
    const request = signer.requests[0]!;
    expect(request).toMatchObject({ role: "devnet-faucet", network: NETWORK, operation: { operationId: claim.claimId, kind: "devnet-faucet-claim" } });
    expect(request.requestId).toMatch(/^faucet\.[0-9a-f]{32}\.1$/);
    expect(request.expiresAt - now).toBeLessThanOrEqual(60);
    const status = await service.status(wallet.publicKey.toBase58());
    expect(status).toMatchObject({ enabled: true, nextClaimAt: START + 86_400, claim: { state: "confirmed" }, token: { symbol: "rlUSD", decimals: 6, amount: "100000000" } });
    await rejects(claimFor(service, wallet), "FAUCET_COOLDOWN");
    now = START + 86_401;
    expect((await claimFor(service, wallet)).state).toBe("confirmed");
  });

  it("adds 0.01 devnet SOL only for a wallet below the threshold", async () => {
    const service = faucet();
    const empty = Keypair.generate();
    const claim = await claimFor(service, empty);
    expect(claim.solLamports).toBe("10000000");
    const keys = chain.sent[0]!.message.staticAccountKeys;
    const programs = chain.sent[0]!.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]!.toBase58());
    expect(programs.at(-1)).toBe(SystemProgram.programId.toBase58());
  });

  it("refuses a wrong signature and a challenge used twice", async () => {
    const service = faucet();
    const wallet = Keypair.generate();
    const other = Keypair.generate();
    const challenge = await service.challenge({ owner: wallet.publicKey.toBase58() });
    await rejects(service.claim({ owner: wallet.publicKey.toBase58(), challengeId: challenge.challengeId, signature: signMessage(other, challenge.message) }, "1.1.1.1"), "CHALLENGE_INVALID");
    const good = { owner: wallet.publicKey.toBase58(), challengeId: challenge.challengeId, signature: signMessage(wallet, challenge.message) };
    await service.claim(good, "1.1.1.1");
    await rejects(service.claim(good, "1.1.1.1"), "CHALLENGE_INVALID");
    now = START + 400;
    const late = await service.challenge({ owner: other.publicKey.toBase58() });
    now = START + 800;
    await rejects(service.claim({ owner: other.publicKey.toBase58(), challengeId: late.challengeId, signature: signMessage(other, late.message) }, "1.1.1.1"), "CHALLENGE_INVALID");
  });

  it("stays closed except for allowlisted wallets until enabled", async () => {
    const tester = Keypair.generate();
    const service = faucet({ enabled: false, allowlist: new Set([tester.publicKey.toBase58()]) });
    await rejects(service.challenge({ owner: Keypair.generate().publicKey.toBase58() }), "FAUCET_DISABLED");
    expect((await claimFor(service, tester)).state).toBe("confirmed");
    expect((await service.status(Keypair.generate().publicKey.toBase58())).enabled).toBe(false);
  });

  it("limits claims per network address and per day across all wallets", async () => {
    const service = faucet({ limits: { cooldownSeconds: 86_400, ipDaily: 2, globalDaily: 3, solGrantLamports: 0n, solBelowLamports: 0n, reserveLamports: 0n } });
    await claimFor(service, Keypair.generate(), "198.51.100.1");
    await claimFor(service, Keypair.generate(), "198.51.100.1");
    const limited = await rejects(claimFor(service, Keypair.generate(), "198.51.100.1"), "FAUCET_LIMITED");
    expect(limited.retryAt).toBe(Math.floor(Date.parse("2026-10-25T00:00:00Z") / 1000));
    await claimFor(service, Keypair.generate(), "198.51.100.2");
    await rejects(claimFor(service, Keypair.generate(), "198.51.100.3"), "FAUCET_LIMITED");
  });

  it("refuses before reserving anything when the treasury is short", async () => {
    const service = faucet();
    chain.treasury = 99_999_999n;
    const wallet = Keypair.generate();
    await rejects(claimFor(service, wallet), "FAUCET_EMPTY");
    expect(signer.requests).toHaveLength(0);
    expect([...store.docs.keys()].some((key) => key.startsWith("coxFaucetWallets/"))).toBe(false);
  });

  it("releases the cooldown and budgets when the signer refuses", async () => {
    const service = faucet();
    const wallet = Keypair.generate();
    signer.refuse = true;
    await rejects(claimFor(service, wallet), "FAUCET_UNAVAILABLE");
    const status = await service.status(wallet.publicKey.toBase58());
    expect(status).toMatchObject({ nextClaimAt: null, claim: { state: "failed" } });
    expect([...store.docs.entries()].filter(([key]) => key.startsWith("coxFaucetBudgets/")).map(([, v]) => JSON.parse(v).count)).toEqual([0, 0]);
    signer.refuse = false;
    expect((await claimFor(service, wallet)).state).toBe("confirmed");
  });

  it("keeps an unclear broadcast pending until the chain shows it landed or expired", async () => {
    const service = faucet();
    const wallet = Keypair.generate();
    chain.sendFails = true;
    chain.landImmediately = false;
    const claim = await claimFor(service, wallet);
    expect(claim.state).toBe("signed");
    expect(claim.signature).not.toBeNull();
    await rejects(claimFor(service, wallet), "FAUCET_BUSY");
    chain.sendFails = false;
    now += 10;
    expect((await service.status(wallet.publicKey.toBase58())).claim!.state).toBe("submitted");
    expect(chain.sent).toHaveLength(1);
    chain.height = 1151;
    now += 10;
    const expired = await service.status(wallet.publicKey.toBase58());
    expect(expired).toMatchObject({ nextClaimAt: null, claim: { state: "failed", failure: "the grant expired before it landed" } });
    chain.landImmediately = true;
    expect((await claimFor(service, wallet)).state).toBe("confirmed");
  });

  it("confirms an unclear broadcast that did land without sending it again", async () => {
    const service = faucet();
    const wallet = Keypair.generate();
    chain.landImmediately = false;
    const claim = await claimFor(service, wallet);
    expect(claim.state).toBe("submitted");
    chain.statuses.set(claim.signature!, { err: null, confirmationStatus: "finalized" });
    now += 10;
    const status = await service.status(wallet.publicKey.toBase58());
    expect(status).toMatchObject({ claim: { state: "confirmed", signature: claim.signature }, nextClaimAt: START + 86_400 });
    expect(chain.sent).toHaveLength(1);
  });

  it("releases a claim that stopped before signing", async () => {
    const service = faucet();
    const wallet = Keypair.generate();
    const stalled = faucet({ signer: { signSolanaTransaction: () => new Promise<SignResult>(() => undefined) } as unknown as RemoteSigner });
    void claimFor(stalled, wallet);
    await new Promise((done) => setTimeout(done, 20));
    expect((await service.status(wallet.publicKey.toBase58())).claim!.state).toBe("reserved");
    now += 121;
    expect((await service.status(wallet.publicKey.toBase58())).claim).toMatchObject({ state: "failed", failure: "the grant was interrupted before signing" });
    expect((await claimFor(service, wallet)).state).toBe("confirmed");
  });
});

describe("faucet routes", () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cox-fixture.json");
  const servers: ReturnType<typeof createCoxApiServer>[] = [];
  const start = async (options: Partial<Parameters<typeof createCoxApiServer>[0]>) => {
    const server = createCoxApiServer({ source: new CoxFixtureSource(fixture), trustForwardedFor: true, ...options });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  afterAll(() => servers.forEach((server) => server.close()));

  it("serves challenge, claim and status, and forwards them from another deployment", async () => {
    const service = faucet();
    const direct = await start({ faucet: service });
    const forwarded = await start({ faucetForward: direct });
    const client = createCoxApiClient({ baseUrl: forwarded });
    const wallet = Keypair.generate();
    const owner = wallet.publicKey.toBase58();
    const challenge = (await client.faucetChallenge(owner)).data;
    const claim = (await client.faucetClaim({ owner, challengeId: challenge.challengeId, signature: signMessage(wallet, challenge.message) })).data;
    expect(claim.state).toBe("confirmed");
    expect((await client.faucetStatus(owner)).data.claim!.claimId).toBe(claim.claimId);
    const again = (await client.faucetChallenge(owner)).data;
    const response = await fetch(`${forwarded}/v1/faucet/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, challengeId: again.challengeId, signature: signMessage(wallet, again.message) }),
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(80_000);
    expect((await response.json()).error.code).toBe("FAUCET_COOLDOWN");
  });

  it("keys the network limit on the visitor address the gateway forwards", async () => {
    const base = await start({ faucet: faucet({ limits: { cooldownSeconds: 86_400, ipDaily: 1, globalDaily: 50, solGrantLamports: 0n, solBelowLamports: 0n, reserveLamports: 0n } }) });
    const claimVia = async (forwardedFor: string) => {
      const wallet = Keypair.generate();
      const owner = wallet.publicKey.toBase58();
      const challenge = await (await fetch(`${base}/v1/faucet/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) })).json();
      const response = await fetch(`${base}/v1/faucet/claim`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
        body: JSON.stringify({ owner, challengeId: challenge.data.challengeId, signature: signMessage(wallet, challenge.data.message) }),
      });
      return response.status;
    };
    expect(await claimVia("192.0.2.10, 104.16.0.1")).toBe(200);
    expect(await claimVia("192.0.2.11, 104.16.0.1")).toBe(200);
    expect(await claimVia("192.0.2.10, 104.16.0.2")).toBe(429);
  });

  it("answers NOT_CONFIGURED where no faucet is set up", async () => {
    const client = createCoxApiClient({ baseUrl: await start({}) });
    const error = await client.faucetStatus(Keypair.generate().publicKey.toBase58()).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(CoxApiError);
    expect((error as CoxApiError).code).toBe("NOT_CONFIGURED");
  });
});
