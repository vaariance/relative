import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { RoleBindings } from "../src/config.js";
import { checkSolanaPolicy, PolicyRejection } from "../src/policy.js";

function rejects(fn: () => void, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof PolicyRejection && error.code === code);
}

const program = Keypair.generate().publicKey;
const discriminator = Buffer.from("0102030405060708", "hex");
const solanaBindings: RoleBindings = {
  solana: { maxComputeUnitPriceMicroLamports: "1000", programs: [{ programId: program.toBase58(), discriminators: [discriminator.toString("hex")] }] },
};

function solanaTransaction(payer: PublicKey, instructions: TransactionInstruction[], tables: AddressLookupTableAccount[] = []) {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions }).compileToV0Message(tables);
  return new VersionedTransaction(message);
}

const call = (payer: PublicKey, data = discriminator) =>
  new TransactionInstruction({ programId: program, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data });

test("permits a bound Solana instruction with compute budget settings", () => {
  const signer = Keypair.generate().publicKey;
  const tx = solanaTransaction(signer, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
    call(signer),
  ]);
  checkSolanaPolicy("oracle-operator", solanaBindings, tx, signer);
});

test("rejects Solana requests outside the bound policy", () => {
  const signer = Keypair.generate().publicKey;
  rejects(() => checkSolanaPolicy("oracle-operator", undefined, solanaTransaction(signer, [call(signer)]), signer), "TARGET_NOT_BOUND");
  rejects(
    () => checkSolanaPolicy("oracle-operator", solanaBindings, solanaTransaction(signer, [call(signer, Buffer.from("ffffffffffffffff", "hex"))]), signer),
    "OPERATION_NOT_PERMITTED",
  );
  rejects(
    () =>
      checkSolanaPolicy(
        "oracle-operator",
        solanaBindings,
        solanaTransaction(signer, [call(signer), SystemProgram.transfer({ fromPubkey: signer, toPubkey: Keypair.generate().publicKey, lamports: 5 })]),
        signer,
      ),
    "TARGET_NOT_BOUND",
  );
  rejects(
    () =>
      checkSolanaPolicy(
        "oracle-operator",
        solanaBindings,
        solanaTransaction(signer, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1001 }), call(signer)]),
        signer,
      ),
    "LIMIT_EXCEEDED",
  );
  rejects(
    () =>
      checkSolanaPolicy(
        "oracle-operator",
        solanaBindings,
        solanaTransaction(signer, [ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 }), call(signer)]),
        signer,
      ),
    "OPERATION_NOT_PERMITTED",
  );
  const otherPayer = Keypair.generate().publicKey;
  rejects(() => checkSolanaPolicy("oracle-operator", solanaBindings, solanaTransaction(otherPayer, [call(signer)]), signer), "OPERATION_NOT_PERMITTED");
});

test("rejects Solana transactions that use address lookup tables", () => {
  const signer = Keypair.generate().publicKey;
  const hidden = Keypair.generate().publicKey;
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [hidden] },
  });
  const instruction = new TransactionInstruction({
    programId: program,
    keys: [{ pubkey: hidden, isSigner: false, isWritable: true }],
    data: discriminator,
  });
  rejects(() => checkSolanaPolicy("oracle-operator", solanaBindings, solanaTransaction(signer, [instruction], [table]), signer), "OPERATION_NOT_PERMITTED");
});

test("enforces the compute unit limit and the bound accounts of each instruction", () => {
  const signer = Keypair.generate().publicKey;
  const registry = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const bound: RoleBindings = {
    solana: {
      maxComputeUnitPriceMicroLamports: "1000",
      maxComputeUnitLimit: "1400000",
      programs: [
        {
          programId: program.toBase58(),
          discriminators: [discriminator.toString("hex")],
          instructions: [{ discriminator: discriminator.toString("hex"), accounts: { "0": "$signer", "1": registry.toBase58(), "2": pool.toBase58() } }],
        },
      ],
    },
  };
  const crank = (accounts: PublicKey[]) =>
    new TransactionInstruction({ programId: program, keys: accounts.map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i !== 1 })), data: discriminator });
  checkSolanaPolicy("oracle-operator", bound, solanaTransaction(signer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), crank([signer, registry, pool])]), signer);
  rejects(
    () => checkSolanaPolicy("oracle-operator", bound, solanaTransaction(signer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_001 }), crank([signer, registry, pool])]), signer),
    "LIMIT_EXCEEDED",
  );
  rejects(() => checkSolanaPolicy("oracle-operator", bound, solanaTransaction(signer, [crank([signer, registry, Keypair.generate().publicKey])]), signer), "TARGET_NOT_BOUND");
  rejects(() => checkSolanaPolicy("oracle-operator", bound, solanaTransaction(signer, [crank([signer, registry])]), signer), "TARGET_NOT_BOUND");
  const other = Keypair.generate().publicKey;
  rejects(() => checkSolanaPolicy("oracle-operator", bound, solanaTransaction(signer, [crank([other, registry, pool])]), signer), "TARGET_NOT_BOUND");
});

test("heap frames require explicit opt-in and enforce the configured aligned maximum", () => {
  const signer = Keypair.generate().publicKey;
  const configured: RoleBindings = { solana: { ...solanaBindings.solana!, maxHeapBytes: 262144 } };
  checkSolanaPolicy("oracle-operator", configured, solanaTransaction(signer, [ComputeBudgetProgram.requestHeapFrame({ bytes: 262144 }), call(signer)]), signer);
  for (const bytes of [16384, 32769, 263168]) rejects(() => checkSolanaPolicy("oracle-operator", configured,
    solanaTransaction(signer, [ComputeBudgetProgram.requestHeapFrame({ bytes }), call(signer)]), signer), "LIMIT_EXCEEDED");
});
