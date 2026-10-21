import assert from "node:assert/strict";
import test from "node:test";
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { compilePublicationTransaction, type PublicationTransactionInput } from "../src/transaction.ts";
const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const instruction = (bytes: number, keys = [key(3), key(4)]) => new TransactionInstruction({ programId: key(2), data: Buffer.alloc(bytes),
  keys: keys.map(pubkey => ({ pubkey, isSigner: false, isWritable: true })) });
const input = (instructions = [instruction(32)]): PublicationTransactionInput => ({
  feePayer: key(1), blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100n,
  instructions, allowedPrograms: [key(2)], computeUnitLimit: 1_400_000, priorityFeeLamports: 1000n,
});
test("publication compiles standard v0 within current packet limit", () => {
  const result = compilePublicationTransaction(input());
  assert.ok(result.bytes.length <= 1232);
  assert.equal(result.message[0], 0x80);
  assert.equal(VersionedTransaction.deserialize(result.bytes).message.version, 0);
  assert.equal(result.accountCount, 5);
});
test("full Pyth and thirty-price Epoch payloads require bounded pages", () => {
  assert.throws(() => compilePublicationTransaction(input([instruction(1196)])), /PublicationTransactionTooLarge/);
  assert.throws(() => compilePublicationTransaction(input([instruction(1500)])), /PublicationTransactionTooLarge/);
});
test("compiler rejects unexpected programs, signers, accounts and compute overrides", () => {
  assert.throws(() => compilePublicationTransaction(input([instruction(10, Array.from({length: 63}, (_, i) => key(i + 3)))])), /PublicationAccountLimit/);
  assert.throws(() => compilePublicationTransaction({ ...input(), allowedPrograms: [] }), /PublicationProgramNotAllowed/);
  const signed = instruction(1); signed.keys[0]!.isSigner = true;
  assert.throws(() => compilePublicationTransaction(input([signed])), /UnexpectedPublicationSigner/);
  assert.throws(() => compilePublicationTransaction({...input(), instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1})],
    allowedPrograms:[ComputeBudgetProgram.programId]}), /PublicationComputeBudgetOverride/);
});
test("compute and fee budgets are bounded", () => {
  assert.throws(() => compilePublicationTransaction({ ...input(), computeUnitLimit: 1_400_001 }), /InvalidPublicationTransaction/);
  assert.throws(() => compilePublicationTransaction({ ...input(), priorityFeeLamports: -1n }), /InvalidPublicationTransaction/);
  assert.throws(() => compilePublicationTransaction({ ...input(), heapBytes: 32_769 }), /InvalidPublicationTransaction/);
  assert.equal(compilePublicationTransaction({ ...input(), heapBytes: 262_144 }).version, 0);
});
test("explicit v1 opt-in carries larger payload without asserting RPC acceptance",()=>{
  const result=compilePublicationTransaction({...input([instruction(1196)]),version:1});
  assert.equal(result.version,1);assert.equal(result.message[0],0x81);
  assert.ok(result.bytes.length>1232&&result.bytes.length<=4096);
});
