import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { SIGNING_SCHEMA_VERSION } from "@eox/signing";
import { devnetFaucetInstructions, devnetFaucetTokenAccount, DEVNET_FAUCET_MINT } from "../../../packages/cox-client/src/faucet.js";
import { createSigningService, SignerUnavailable } from "../src/service.js";
import type { SignerConfig } from "../src/config.js";
import type { StoredDecision } from "../src/store.js";
import type { ResolvedKey } from "../src/directory.js";
import type { ChainAccount } from "../src/cox-linkage.js";

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const caller = "cox-api-live@colosseum-eox.iam.gserviceaccount.com";
const NOW = 1792756800;

function harness(options: { environment?: "dev" | "mainnet"; defect?: "mint" | "delegate" | "close" | "frozen" | "funds" | "destination"; reads?: boolean; readFailure?: boolean } = {}) {
  const faucet = Keypair.generate(), recipient = Keypair.generate().publicKey;
  const source = devnetFaucetTokenAccount(faucet.publicKey);
  const keyVersion = "projects/colosseum-eox/locations/us-central1/keyRings/eox-signing-dev/cryptoKeys/devnet-faucet/cryptoKeyVersions/1";
  const config: SignerConfig = { environment: options.environment ?? "dev", audience: "https://signer.test", directoryVersion: 3, retired: [],
    keys: { "oracle-operator": { keyVersion: keyVersion.replace("devnet-faucet", "oracle-operator"), network: NETWORK, validFrom: 0 }, "devnet-faucet": { keyVersion, network: NETWORK, validFrom: 0 } },
    callers: { [caller]: ["devnet-faucet"] }, bindings: { "devnet-faucet": { faucet: { mint: DEVNET_FAUCET_MINT.toBase58(), sourceTokenAccount: source.toBase58(), decimals: 6, maxTokenAmount: "100000000", maxSolLamports: "10000000" } } } };
  const entry: ResolvedKey = { derived: { chain: "solana", publicKey: faucet.publicKey.toBase58(), address: faucet.publicKey.toBase58(), rawPublicKey: faucet.publicKey.toBytes() }, entry: { role: "devnet-faucet", environment: "dev", chain: "solana", network: NETWORK, algorithm: "ed25519", publicKey: faucet.publicKey.toBase58(), address: faucet.publicKey.toBase58(), keyVersion, state: "active", validFrom: 0, validUntil: null } };
  const records = new Map<string, StoredDecision>();
  const calls = { sign: 0, read: 0 };
  const mint = Buffer.alloc(82); mint[44] = options.defect === "mint" ? 9 : 6; mint[45] = 1;
  const token = Buffer.alloc(165); DEVNET_FAUCET_MINT.toBuffer().copy(token); faucet.publicKey.toBuffer().copy(token, 32); token.writeBigUInt64LE(options.defect === "funds" ? 0n : 1000000000n, 64); token[108] = options.defect === "frozen" ? 2 : 1;
  if (options.defect === "delegate") token.writeUInt32LE(1, 72);
  if (options.defect === "close") token.writeUInt32LE(1, 129);
  const fetch = async (): Promise<(ChainAccount | null)[]> => { calls.read++; if (options.readFailure) throw Error("RPC unavailable"); return [{ owner: TOKEN, data: mint }, { owner: TOKEN, data: token }, options.defect === "destination" ? { owner: TOKEN, data: token } : null]; };
  const sign = createSigningService({ config, keys: new Map([["devnet-faucet", entry]]), now: () => NOW, log: () => {},
    store: { get: async id => records.get(id) ?? null, create: async value => { if (records.has(value.requestId)) return "exists"; records.set(value.requestId, value); return "created"; } },
    solanaAccounts: options.reads === false ? undefined : fetch,
    signers: { solana: async (_version, _public, bytes) => { calls.sign++; const tx = VersionedTransaction.deserialize(Buffer.from(bytes, "base64")); tx.sign([faucet]); return { signature: tx.signatures[0]!, signedTransaction: Buffer.from(tx.serialize()).toString("base64") }; } } });
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: faucet.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: devnetFaucetInstructions({ faucet: faucet.publicKey, recipient, solLamports: 10000000n }) }).compileToV0Message());
  const request = { schemaVersion: SIGNING_SCHEMA_VERSION, chain: "solana", role: "devnet-faucet", requestId: "faucet-claim-0001", keyVersion, network: NETWORK, operation: { operationId: "claim-0001/attempt-1", kind: "devnet-faucet-claim" }, expiresAt: NOW + 60, transactionBase64: Buffer.from(tx.serialize()).toString("base64") };
  return { sign, request, calls };
}

test("canonical SDK grant passes confirmed account checks and signer idempotency", async () => {
  const h = harness(); const first = await h.sign(caller, h.request); assert.equal(first.decision, "signed");
  assert.deepEqual(await h.sign(caller, h.request), first); assert.deepEqual(h.calls, { read: 1, sign: 1 });
  const conflict = await h.sign(caller, { ...h.request, expiresAt: NOW + 59 }); assert.equal(conflict.decision, "rejected"); if (conflict.decision === "rejected") assert.equal(conflict.code, "REQUEST_ID_CONFLICT");
});

test("faucet rejects unsafe confirmed mint, treasury and destination state before signing", async () => {
  for (const defect of ["mint", "delegate", "close", "frozen", "funds", "destination"] as const) {
    const h = harness({ defect }); assert.equal((await h.sign(caller, h.request)).decision, "rejected", defect); assert.equal(h.calls.sign, 0, defect);
  }
});

test("faucet refuses missing chain validation, wrong caller, mainnet and non-claim intents", async () => {
  for (const options of [{ reads: false }, { environment: "mainnet" as const }]) {
    const h = harness(options); assert.equal((await h.sign(caller, h.request)).decision, "rejected"); assert.equal(h.calls.sign, 0);
  }
  const h = harness(); assert.equal((await h.sign("unapproved@example.com", h.request)).decision, "rejected");
  assert.equal((await h.sign(caller, { ...h.request, requestId: "wrong-intent", operation: { operationId: "claim", kind: "arbitrary-transfer" } })).decision, "rejected"); assert.equal(h.calls.sign, 0);
  const expiry = harness(); assert.equal((await expiry.sign(caller, { ...expiry.request, expiresAt: NOW + 61 })).decision, "rejected"); assert.equal(expiry.calls.sign, 0);
});

test("temporary faucet account-read failures do not persist a decision or invoke KMS", async () => {
  const options = { readFailure: true }; const h = harness(options);
  await assert.rejects(h.sign(caller, h.request), SignerUnavailable); assert.equal(h.calls.sign, 0);
  options.readFailure = false; assert.equal((await h.sign(caller, h.request)).decision, "signed"); assert.equal(h.calls.sign, 1);
});
