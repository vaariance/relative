import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrivateKey, sign } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { compileTransaction, getTransactionEncoder } from "@solana/transactions";
import { setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/transaction-messages";
import { parseSolanaTransaction, verifyEd25519 } from "../src/solana.js";
import { checkSolanaPolicy, PolicyRejection } from "../src/policy.js";
import { type RoleBindings } from "../src/config.js";
const payer = Keypair.fromSeed(new Uint8Array(32).fill(1)), program = new PublicKey(new Uint8Array(32).fill(2)), other = new PublicKey(new Uint8Array(32).fill(3));
const address = (key: PublicKey) => key.toBase58() as Parameters<typeof setTransactionMessageFeePayer>[0];
function encoded(config = { computeUnitLimit: 200000, heapSize: 32768, priorityFeeLamports: 0n }, writable = false, extraSigner = false) {
  const message = setTransactionMessageFeePayer(address(payer.publicKey), {
version: 1 as const, config, instructions: [{
      programAddress: address(program), data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), accounts: [{ address: address(payer.publicKey), role: 3 as const }, { address: address(other), role: extraSigner ? 2 as const : writable ? 1 as const : 0 as const }]
}]
});
  const timed = setTransactionMessageLifetimeUsingBlockhash({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100n } as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0], message);
  return Buffer.from(getTransactionEncoder().encode(compileTransaction(timed))).toString("base64");
}
const bindings = (enabled = true): RoleBindings => ({
solana: {
maxComputeUnitPriceMicroLamports: "1000", maxComputeUnitLimit: "200000", programs: [{
      programId: program.toBase58(), allowTransactionV1: enabled, discriminators: ["0102030405060708"], instructions: [{ discriminator: "0102030405060708", accounts: { "0": "$signer", "1": other.toBase58() }, v1WritableAccounts: [] }]
}]
}
});
const deny = (fn: () => void, code: string) => assert.throws(fn, error => error instanceof PolicyRejection && error.code === code);
test("V1 preserves its exact message and appends the sole Ed25519 signature", () => {
  const original = encoded(), transaction = parseSolanaTransaction(original);
  assert.equal(transaction.version, 1);
  assert.equal(Buffer.from(transaction.serialize()).toString("base64"), original);
  const message = transaction.message.serialize();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), payer.secretKey.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const signature = sign(null, message, key); transaction.addSignature(payer.publicKey, signature);
  assert.equal(verifyEd25519(payer.publicKey.toBytes(), message, signature), true);
  const signed = transaction.serialize(); assert.deepEqual(new Uint8Array(signed.subarray(0, -64)), new Uint8Array(message)); assert.deepEqual(new Uint8Array(signed.subarray(-64)), new Uint8Array(signature));
  assert.deepEqual(parseSolanaTransaction(Buffer.from(signed).toString("base64")).message.serialize(), message);
});
test("V1 requires explicit opt-in and preserves program and account allowlists", () => {
  const transaction = parseSolanaTransaction(encoded());
  checkSolanaPolicy("oracle-operator", bindings(), transaction, payer.publicKey);
  deny(() => checkSolanaPolicy("oracle-operator", bindings(false), transaction, payer.publicKey), "OPERATION_NOT_PERMITTED");
  const missing = bindings(); delete missing.solana!.programs[0]!.allowTransactionV1;
  deny(() => checkSolanaPolicy("oracle-operator", missing, transaction, payer.publicKey), "OPERATION_NOT_PERMITTED");
  deny(() => checkSolanaPolicy("oracle-operator", bindings(), parseSolanaTransaction(encoded(undefined, true)), payer.publicKey), "OPERATION_NOT_PERMITTED");
  const wrong = bindings(); wrong.solana!.programs[0]!.instructions![0]!.accounts["1"] = program.toBase58();
  deny(() => checkSolanaPolicy("oracle-operator", wrong, transaction, payer.publicKey), "TARGET_NOT_BOUND");
});
test("V1 inline compute, heap and total priority fees obey equivalent caps", () => {
  for (const config of [{ computeUnitLimit: 200001, heapSize: 32768, priorityFeeLamports: 0n }, { computeUnitLimit: 200000, heapSize: 262144, priorityFeeLamports: 0n },
  { computeUnitLimit: 200000, heapSize: 32768, priorityFeeLamports: 201n }]) {
    deny(() => checkSolanaPolicy("oracle-operator", bindings(), parseSolanaTransaction(encoded(config)), payer.publicKey), "LIMIT_EXCEEDED");
  }
  checkSolanaPolicy("oracle-operator", bindings(), parseSolanaTransaction(encoded({ computeUnitLimit: 200000, heapSize: 32768, priorityFeeLamports: 200n })), payer.publicKey);
});
test("V1 rejects trailing and truncated transaction framing", () => {
  const bytes = Buffer.from(encoded(), "base64");
  assert.throws(() => parseSolanaTransaction(Buffer.concat([bytes, Buffer.from([0])]).toString("base64")));
  assert.throws(() => parseSolanaTransaction(bytes.subarray(0, -1).toString("base64")));
});
test("V1 decisions replay by exact bytes and reject a changed request id", async () => {
  const { createSigningService } = await import("../src/service.js");
  const { SIGNING_SCHEMA_VERSION } = await import("@eox/signing");
  const records = new Map<string, import("../src/store.js").StoredDecision>(); let calls = 0;
  const network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", version = "kv/oracle-operator/1", caller = "publisher";
  const config = { callers: { [caller]: ["oracle-operator"] }, bindings: { "oracle-operator": bindings() } } as unknown as import("../src/config.js").SignerConfig;
  const keys = new Map([["oracle-operator", { derived: { rawPublicKey: payer.publicKey.toBytes() }, entry: { state: "active", keyVersion: version, network, address: payer.publicKey.toBase58() } } as unknown as import("../src/directory.js").ResolvedKey]]);
  const service = createSigningService({
config, keys, now: () => 100, log: () => { }, store: { get: async id => records.get(id) ?? null, create: async item => { if (records.has(item.requestId)) return "exists"; records.set(item.requestId, item); return "created"; } },
    signers: { solana: async (_version, _key, bytes) => { calls++; const transaction = parseSolanaTransaction(bytes); const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), payer.secretKey.subarray(0, 32)]), format: "der", type: "pkcs8" }); const signature = sign(null, transaction.message.serialize(), key); transaction.addSignature(payer.publicKey, signature); return { signature, signedTransaction: Buffer.from(transaction.serialize()).toString("base64") }; } }
});
  const request = { schemaVersion: SIGNING_SCHEMA_VERSION, requestId: "v1-idempotency", chain: "solana", role: "oracle-operator", keyVersion: version, network, operation: { operationId: "batch-1/publish", kind: "cox-publish" }, expiresAt: 200, transactionBase64: encoded() };
  const first = await service(caller, request); assert.equal(first.decision, "signed", JSON.stringify(first)); assert.deepEqual(await service(caller, request), first); assert.equal(calls, 1);
  const changed = await service(caller, { ...request, transactionBase64: encoded({ computeUnitLimit: 200000, heapSize: 32768, priorityFeeLamports: 1n }) });
  assert.equal(changed.decision, "rejected"); if (changed.decision === "rejected") assert.equal(changed.code, "REQUEST_ID_CONFLICT"); assert.equal(calls, 1);
});

test("V1 rejects additional required signers before policy or KMS", () => {
  assert.throws(() => parseSolanaTransaction(encoded(undefined, false, true)), /sole writable signer/);
});
test("official Rust native publisher V1 fixture decodes with the identical message hash", async () => {
  const { createHash } = await import("node:crypto");
  const encoded = "gQEAAhcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQECAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAAAAAAAAAABADQMAAIAAAAECCAAAAgECAwQFBgcIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
  const transaction = parseSolanaTransaction(encoded);
  assert.equal(createHash("sha256").update(transaction.message.serialize()).digest("hex"), "3b262a11a2ece06c3030b3f21d4c1722682dd5238f7cb999104b27062eb04324");
  checkSolanaPolicy("oracle-operator", bindings(), transaction, new PublicKey(new Uint8Array(32).fill(1)));
});
