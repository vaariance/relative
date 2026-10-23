import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { devnetFaucetInstructions, devnetFaucetTokenAccount, DEVNET_FAUCET_MINT } from "../src/faucet.ts";
import { build } from "esbuild";

test("devnet grant creates canonical ATA and encodes one checked token transfer", () => {
  const faucet = Keypair.generate().publicKey, recipient = Keypair.generate().publicKey;
  const instructions = devnetFaucetInstructions({ faucet, recipient });
  assert.equal(instructions.length, 3); assert.equal(instructions[1]!.data.toString("hex"), "01");
  assert(instructions[1]!.keys[1]!.pubkey.equals(devnetFaucetTokenAccount(recipient)));
  const transfer = instructions[2]!; assert.equal(transfer.data[0], 12); assert.equal(transfer.data.readBigUInt64LE(1), 100000000n); assert.equal(transfer.data[9], 6);
  assert(transfer.keys[0]!.pubkey.equals(devnetFaucetTokenAccount(faucet))); assert(transfer.keys[1]!.pubkey.equals(DEVNET_FAUCET_MINT));
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: faucet, recentBlockhash: SystemProgram.programId.toBase58(), instructions: devnetFaucetInstructions({ faucet, recipient, solLamports: 10000000n }) }).compileToV0Message());
  assert(transaction.serialize().length <= 1232); assert.equal(transaction.message.header.numRequiredSignatures, 1);
});

test("devnet grant bounds and recipient validation fail before transaction construction", () => {
  const faucet = Keypair.generate().publicKey, recipient = Keypair.generate().publicKey;
  for (const tokenAmount of [0n, -1n, 100000001n]) assert.throws(() => devnetFaucetInstructions({ faucet, recipient, tokenAmount }), /FaucetGrantLimit/);
  for (const solLamports of [-1n, 10000001n]) assert.throws(() => devnetFaucetInstructions({ faucet, recipient, solLamports }), /FaucetGrantLimit/);
  assert.throws(() => devnetFaucetInstructions({ faucet, recipient: faucet }), /FaucetRecipient/);
});

test("faucet SDK browser entry excludes server signing and credential dependencies", async () => {
  const result = await build({ entryPoints: [new URL("../src/faucet.ts", import.meta.url).pathname], bundle: true, platform: "browser", format: "esm", write: false, metafile: true });
  assert(Object.keys(result.metafile!.inputs).every(path => !/apps\/signer|google-auth|node:fs|node:crypto/.test(path)));
});
