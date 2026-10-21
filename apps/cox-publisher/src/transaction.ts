import { createHash } from "node:crypto";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";

import { address } from "@solana/addresses";
import { blockhash } from "@solana/rpc-types";
import { appendTransactionMessageInstructions, setTransactionMessageComputeUnitLimit, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, setTransactionMessagePriorityFeeLamports, setTransactionMessageHeapSize, type TransactionMessage as KitTransactionMessage } from "@solana/transaction-messages";
import { compileTransaction, getTransactionEncoder } from "@solana/transactions";

export interface PublicationTransactionInput {
  readonly version?: 0 | 1;
  readonly feePayer: PublicKey;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly instructions: readonly TransactionInstruction[];
  readonly allowedPrograms: readonly PublicKey[];
  readonly computeUnitLimit: number;
  readonly priorityFeeLamports: bigint;
  readonly heapBytes?: number;
}
export interface UnsignedPublicationTransaction {
  readonly version: 0 | 1;
  readonly bytes: Uint8Array;
  readonly message: Uint8Array;
  readonly messageSha256: string;
  readonly accountCount: number;
}

export function compilePublicationTransaction(input: PublicationTransactionInput): UnsignedPublicationTransaction {
  if (!Number.isSafeInteger(input.computeUnitLimit) || input.computeUnitLimit < 1 || input.computeUnitLimit > 1_400_000
      || input.priorityFeeLamports < 0n || input.priorityFeeLamports > (1n << 64n) - 1n
      || input.lastValidBlockHeight < 0n || input.instructions.length === 0 || input.instructions.length > 64
      || (input.heapBytes !== undefined && (!Number.isSafeInteger(input.heapBytes) || input.heapBytes < 32_768
        || input.heapBytes > 262_144 || input.heapBytes % 1024 !== 0))) throw new Error("InvalidPublicationTransaction");
  const allowed = new Set(input.allowedPrograms.map(key => key.toBase58()));
  const accounts = new Set([input.feePayer.toBase58(), ComputeBudgetProgram.programId.toBase58()]);
  for (const instruction of input.instructions) {
    if (!allowed.has(instruction.programId.toBase58())) throw new Error("PublicationProgramNotAllowed");
    if (instruction.programId.equals(ComputeBudgetProgram.programId)) throw new Error("PublicationComputeBudgetOverride");
    accounts.add(instruction.programId.toBase58());
    for (const account of instruction.keys) {
      accounts.add(account.pubkey.toBase58());
      if (account.isSigner && !account.pubkey.equals(input.feePayer)) throw new Error("UnexpectedPublicationSigner");
    }
  }
  if (accounts.size > 64) throw new Error("PublicationAccountLimit");
  if (input.version === 1) {
    const empty: Extract<KitTransactionMessage, { version: 1 }> = { version: 1, instructions: [] };
    const base = setTransactionMessageFeePayer(address(input.feePayer.toBase58()), empty);
    const timed = setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(input.blockhash), lastValidBlockHeight: input.lastValidBlockHeight }, base);
    const configured = setTransactionMessageHeapSize(input.heapBytes, setTransactionMessagePriorityFeeLamports(input.priorityFeeLamports,
      setTransactionMessageComputeUnitLimit(input.computeUnitLimit, timed)));
    const compiled = compileTransaction(appendTransactionMessageInstructions(input.instructions.map(instruction => ({
      programAddress: address(instruction.programId.toBase58()), data: new Uint8Array(instruction.data),
      accounts: instruction.keys.map(key => ({ address: address(key.pubkey.toBase58()),
        role: (key.isSigner ? key.isWritable ? 3 : 2 : key.isWritable ? 1 : 0) as 0 | 1 | 2 | 3 })) })), configured));
    const bytes = new Uint8Array(getTransactionEncoder().encode(compiled));
    if (bytes.length > 4096) throw new Error("PublicationTransactionTooLarge");
    const message = new Uint8Array(compiled.messageBytes);
    return { version: 1, bytes, message, messageSha256: createHash("sha256").update(message).digest("hex"), accountCount: accounts.size - 1 };
  }
  const microLamports = input.priorityFeeLamports * 1_000_000n / BigInt(input.computeUnitLimit);
  if (microLamports > (1n << 64n) - 1n) throw new Error("InvalidPublicationTransaction");
  const budgets = [ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports })];
  if (input.heapBytes !== undefined) budgets.push(ComputeBudgetProgram.requestHeapFrame({ bytes: input.heapBytes }));
  const message = new TransactionMessage({ payerKey: input.feePayer, recentBlockhash: input.blockhash,
    instructions: [...budgets, ...input.instructions] }).compileToV0Message();
  let bytes: Uint8Array;
  try { bytes = new VersionedTransaction(message).serialize(); }
  catch { throw new Error("PublicationTransactionTooLarge"); }
  if (bytes.length > 1232) throw new Error("PublicationTransactionTooLarge");
  const messageBytes = message.serialize();
  return { version: 0, bytes, message: messageBytes,
    messageSha256: createHash("sha256").update(messageBytes).digest("hex"), accountCount: accounts.size };
}
