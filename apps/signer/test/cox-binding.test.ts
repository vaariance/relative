import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { loadSignerConfig } from "../src/config.js";
import { checkSolanaPolicy, PolicyRejection } from "../src/policy.js";

const config = loadSignerConfig(new URL("../config/dev.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const binding = config.bindings["oracle-operator"]!;
const cox = binding.solana!.programs[0]!;
const program = new PublicKey(cox.programId);
const poolId = Buffer.alloc(8);
poolId.writeBigUInt64LE(1n);
const registry = PublicKey.findProgramAddressSync([Buffer.from("registry")], program)[0];
const pool = PublicKey.findProgramAddressSync([Buffer.from("pool"), poolId], program)[0];
const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), pool.toBuffer()], program)[0];
const discriminator = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");
const operator = new PublicKey("GNmM11ZMFqEu3FYewGNDunpSSJBw8KnkDxzCGpSbpGj6");
const batch = PublicKey.findProgramAddressSync([Buffer.from("batch"), pool.toBuffer()], program)[0];
const publication = PublicKey.findProgramAddressSync([Buffer.from("publication"), pool.toBuffer()], program)[0];

test("binds the deployed COX program, pool 1 and only the publisher service", () => {
  assert.equal(cox.programId, "G6iQGoupNSfduw1QJxQ9vcVi9FnCC6cbippXsi4QQzJF");
  assert.deepEqual(cox.discriminators, ["publish", "evaluate", "safety", "seal_evaluation", "execute", "finalize"].map(discriminator));
  assert.deepEqual(config.callers, { "cox-publisher@colosseum-eox.iam.gserviceaccount.com": ["oracle-operator"] });
  for (const rule of cox.instructions!) {
    for (const account of Object.values(rule.accounts)) {
      assert.ok([registry, pool, vault, batch, publication, SystemProgram.programId].some((k) => k.toBase58() === account) || account === "$signer", account);
    }
  }
  const rule = (name: string) => cox.instructions!.find((r) => r.discriminator === discriminator(name))!.accounts;
  assert.deepEqual(rule("publish"), { "0": "$signer", "1": "$signer", "2": registry.toBase58(), "3": pool.toBase58(), "5": batch.toBase58(), "6": vault.toBase58(), "7": SystemProgram.programId.toBase58() });
  assert.deepEqual(rule("execute"), { "0": registry.toBase58(), "1": pool.toBase58(), "2": batch.toBase58(), "5": vault.toBase58() });
  assert.deepEqual(rule("finalize"), { "0": "$signer", "1": registry.toBase58(), "2": pool.toBase58(), "3": batch.toBase58(), "5": publication.toBase58(), "6": vault.toBase58(), "7": SystemProgram.programId.toBase58() });
});

function publish(poolAccount: PublicKey) {
  const keys = [operator, operator, registry, poolAccount, new PublicKey("5h3fnfD9BFbJ1iRmRTy7fd6DPy1xEWNg4h2KGheRxFT6"), batch, vault, SystemProgram.programId];
  const instruction = new TransactionInstruction({
    programId: program,
    keys: keys.map((pubkey, i) => ({ pubkey, isSigner: i < 2, isWritable: [0, 2, 3, 5].includes(i) })),
    data: Buffer.concat([Buffer.from(discriminator("publish"), "hex"), Buffer.alloc(64)]),
  });
  const message = new TransactionMessage({
    payerKey: operator,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), instruction],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

test("binds activated pool 1, its sealed methodology and its reusable batch and publication accounts", () => {
  assert.deepEqual(cox.linkage, { kind: "cox-v2", poolId: "1", pool: pool.toBase58(), methodology: "5h3fnfD9BFbJ1iRmRTy7fd6DPy1xEWNg4h2KGheRxFT6" });
  assert.equal(pool.toBase58(), "F44g6A58N3cu9TGaDE1LiDB3r1BCxCrfFkMQV1DcEv37");
  assert.equal(batch.toBase58(), "585NzfdUEPMQCBcxWNzzDiap5rTB5jUNyJZMqEGYWbAv");
  assert.equal(publication.toBase58(), "CeWq5nVR9wzcJGqeegEQhXXfJqBRtdp8bVVSm4PtF6e");
});

test("refuses every request while the binding is disabled", () => {
  const disabled = { solana: { ...binding.solana!, programs: [{ ...cox, enabled: false }] } };
  assert.throws(() => checkSolanaPolicy("oracle-operator", disabled, publish(pool), operator), (e) => e instanceof PolicyRejection && /not enabled/.test(e.message));
});

test("is enabled, accepts a well-formed publish and refuses one aimed at another pool", () => {
  assert.equal(cox.enabled, true);
  checkSolanaPolicy("oracle-operator", binding, publish(pool), operator);
  assert.throws(() => checkSolanaPolicy("oracle-operator", binding, publish(Keypair.generate().publicKey), operator), (e) => e instanceof PolicyRejection && e.code === "TARGET_NOT_BOUND");
});

test("refuses fee administration, treasury withdrawal and user trades", () => {
  for (const name of ["migrate_pool", "schedule_fees", "cancel_fees", "withdraw_fees", "deposit_with_fee", "switch_with_fee", "redeem_with_fee", "quote_request_with_fee", "deposit", "withdraw"]) {
    const instruction = new TransactionInstruction({ programId: program, keys: [{ pubkey: operator, isSigner: true, isWritable: true }, { pubkey: registry, isSigner: false, isWritable: true }, { pubkey: pool, isSigner: false, isWritable: true }], data: Buffer.from(discriminator(name), "hex") });
    const message = new TransactionMessage({ payerKey: operator, recentBlockhash: "11111111111111111111111111111111", instructions: [instruction] }).compileToV0Message();
    assert.throws(() => checkSolanaPolicy("oracle-operator", binding, new VersionedTransaction(message), operator), (e) => e instanceof PolicyRejection, name);
  }
});

test("the current IDL preserves legacy runtime indices with one trailing optional vault", () => {
  const idl = JSON.parse(readFileSync(new URL("../../../packages/cox/idl/cox.json", import.meta.url), "utf8")) as { instructions: { name: string; discriminator: number[]; accounts: { name: string; optional?: boolean; writable?: boolean }[] }[] };
  const expected: Record<string, string[]> = {
    publish: ["payer", "runtime", "registry", "pool", "methodology", "batch", "vault", "system_program"],
    evaluate: ["registry", "pool", "batch", "request", "position", "vault"],
    safety: ["registry", "pool", "batch", "request", "position", "vault"],
    seal_evaluation: ["registry", "pool", "batch", "vault"],
    execute: ["registry", "pool", "batch", "request", "position", "vault"],
    finalize: ["payer", "registry", "pool", "batch", "methodology", "publication", "vault", "system_program"],
  };
  for (const name of ["publish", "evaluate", "safety", "seal_evaluation", "execute", "finalize"]) {
    const entry = idl.instructions.find((i) => i.name === name)!;
    assert.equal(Buffer.from(entry.discriminator).toString("hex"), discriminator(name), name);
    assert.deepEqual(entry.accounts.slice(0, -1).map((a) => a.name), expected[name], name);
    assert.deepEqual(entry.accounts.at(-1), { name: "test_vault", optional: true });
  }
});
