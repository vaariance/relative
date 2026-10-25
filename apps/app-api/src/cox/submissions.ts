import { createPublicKey, verify } from "node:crypto";
import anchor from "@coral-xyz/anchor";
import { discriminator } from "@cox/client";
import { ComputeBudgetProgram, PublicKey, SendTransactionError, VersionedTransaction, type Connection } from "@solana/web3.js";
import type { Submission, TransactionOperation } from "@eox/app-api";
import type { StoredSubmission, SubmissionStore } from "./submission-store.js";
import { FeeChangedError, TransactionInputError, TransactionRejectedError } from "./transactions.js";

const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MAX_TRANSACTION_BYTES = 1232;
const OPERATIONS: readonly TransactionOperation[] = ["deposit", "switch", "redeem", "cancel", "refund", "withdraw"];
const POSITION_INSTRUCTIONS: readonly { operation: TransactionOperation; name: string }[] = [
  { operation: "prepare-position", name: "initialize_dynamic_position" },
  { operation: "prepare-position", name: "grow_dynamic_account" },
];
const TRADES = new Set<TransactionOperation>(["deposit", "switch", "redeem"]);
const FEE_INSTRUCTIONS: readonly { operation: TransactionOperation; name: string; length: number }[] = [
  { operation: "deposit", name: "deposit_with_fee", length: 49 },
  { operation: "switch", name: "switch_with_fee", length: 58 },
  { operation: "redeem", name: "redeem_with_fee", length: 49 },
  { operation: "deposit", name: "deposit_v2", length: 50 },
  { operation: "switch", name: "switch_v2", length: 60 },
  { operation: "redeem", name: "redeem_v2", length: 50 },
];
const EPOCH_INSTRUCTIONS: readonly { operation: TransactionOperation; name: string }[] = [
  { operation: "epoch-entry", name: "queue" },
  { operation: "epoch-withdraw", name: "withdraw" },
  { operation: "epoch-withdraw", name: "withdraw_partial" },
  { operation: "epoch-refund", name: "refund" },
  { operation: "epoch-prepare", name: "initialize_current_epoch" },
  { operation: "epoch-prepare", name: "grow_current_epoch" },
  { operation: "epoch-prepare", name: "copy_registry_assets" },
  { operation: "epoch-prepare", name: "seal_current_epoch" },
  { operation: "epoch-finalize-empty", name: "finalize_empty" },
  { operation: "epoch-void", name: "void_epoch" },
];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export interface CoxSubmissionsOptions {
  connection: Connection;
  programId: PublicKey;
  epochProgramId?: PublicKey | null;
  store: SubmissionStore;
  feeVersion: () => Promise<bigint>;
  now?: () => number;
}

interface Kind {
  operation: TransactionOperation;
  prefix: Buffer;
  feeLength: number | null;
}

function ed25519Key(bytes: Uint8Array) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(bytes).toString("base64url") }, format: "jwk" });
}

export class CoxSubmissions {
  private readonly now: () => number;
  private readonly kinds: Kind[];
  private readonly epochKinds: Kind[];

  constructor(private readonly options: CoxSubmissionsOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.kinds = [
      ...OPERATIONS.map((operation) => ({ operation, prefix: discriminator("global", operation), feeLength: null })),
      ...FEE_INSTRUCTIONS.map(({ operation, name, length }) => ({ operation, prefix: discriminator("global", name), feeLength: length })),
      ...POSITION_INSTRUCTIONS.map(({ operation, name }) => ({ operation, prefix: discriminator("global", name), feeLength: null })),
    ];
    this.epochKinds = EPOCH_INSTRUCTIONS.map(({ operation, name }) => ({ operation, prefix: discriminator("global", name), feeLength: null }));
  }

  private inspect(bytes: Buffer): { signature: string; owner: PublicKey; operation: TransactionOperation; recentBlockhash: string; expectedFeeVersion: bigint | null } {
    if (bytes.length === 0 || bytes.length > MAX_TRANSACTION_BYTES) throw new TransactionInputError("transaction size is invalid");
    let transaction: VersionedTransaction;
    try {
      transaction = VersionedTransaction.deserialize(bytes);
    } catch {
      throw new TransactionInputError("transaction is not a serialized Solana transaction");
    }
    const { message } = transaction;
    if (message.addressTableLookups.length > 0) throw new TransactionInputError("address lookup tables are not accepted");
    const keys = message.staticAccountKeys;
    const signed = message.serialize();
    for (let i = 0; i < message.header.numRequiredSignatures; i += 1) {
      const signature = transaction.signatures[i];
      if (!signature || signature.every((b) => b === 0) || !verify(null, signed, ed25519Key(keys[i]!.toBytes()), signature)) {
        throw new TransactionInputError("transaction is not fully signed");
      }
    }
    const operations = new Set<TransactionOperation>();
    let expectedFeeVersion: bigint | null = null;
    for (const instruction of message.compiledInstructions) {
      const program = keys[instruction.programIdIndex]!;
      if (program.equals(this.options.programId)) {
        const data = Buffer.from(instruction.data);
        const kind = this.kinds.find((k) => data.subarray(0, 8).equals(k.prefix));
        if (!kind) throw new TransactionInputError("only wallet request instructions are accepted");
        if (kind.feeLength !== null) {
          if (data.length !== kind.feeLength) throw new TransactionInputError("fee-aware request instruction has an invalid length");
          expectedFeeVersion = data.readBigUInt64LE(data.length - 8);
        }
        operations.add(kind.operation);
      } else if (this.options.epochProgramId && program.equals(this.options.epochProgramId)) {
        const data = Buffer.from(instruction.data);
        const kind = this.epochKinds.find((k) => data.subarray(0, 8).equals(k.prefix));
        if (!kind) throw new TransactionInputError("only wallet Epoch entry, withdrawal, refund and round preparation instructions are accepted");
        operations.add(kind.operation);
      } else if (!program.equals(ASSOCIATED_TOKEN_PROGRAM) && !program.equals(ComputeBudgetProgram.programId)) {
        throw new TransactionInputError("transaction calls a program outside COX");
      }
    }
    if (operations.has("epoch-refund")) operations.delete("epoch-withdraw");
    if (operations.size !== 1) throw new TransactionInputError("transaction must carry exactly one COX request operation");
    return { signature: anchor.utils.bytes.bs58.encode(transaction.signatures[0]!), owner: keys[0]!, operation: [...operations][0]!, recentBlockhash: message.recentBlockhash, expectedFeeVersion };
  }

  async submit(encoded: unknown): Promise<Submission> {
    if (typeof encoded !== "string" || !BASE64.test(encoded)) throw new TransactionInputError("transaction must be base64");
    const bytes = Buffer.from(encoded, "base64");
    const inspected = this.inspect(bytes);
    const known = await this.options.store.get(inspected.signature);
    if (known) return (await this.get(known.signature))!;
    if (TRADES.has(inspected.operation) && (await this.options.feeVersion()) !== (inspected.expectedFeeVersion ?? 0n)) throw new FeeChangedError();
    let signature: string;
    try {
      signature = await this.options.connection.sendRawTransaction(bytes, { preflightCommitment: "confirmed", maxRetries: 5 });
    } catch (error) {
      if (error instanceof SendTransactionError) throw new TransactionRejectedError(error.message, error.logs ?? []);
      throw error;
    }
    if (signature !== inspected.signature) throw new Error("submitted signature differs from the transaction's first signature");
    const entry: StoredSubmission = {
      signature,
      owner: inspected.owner.toBase58(),
      operation: inspected.operation,
      transaction: encoded,
      submittedAt: this.now(),
      state: "submitted",
      slot: null,
      error: null,
      recentBlockhash: inspected.recentBlockhash,
    };
    if ((await this.options.store.create(entry)) === "exists") return (await this.get(signature))!;
    return this.view(entry);
  }

  async get(signature: string): Promise<Submission | null> {
    if (!SIGNATURE.test(signature)) throw new TransactionInputError("invalid signature");
    const entry = await this.options.store.get(signature);
    if (!entry) return null;
    if (entry.state === "submitted" || entry.state === "confirmed") await this.refresh(entry);
    return this.view(entry);
  }

  private async refresh(entry: StoredSubmission): Promise<void> {
    const connection = this.options.connection;
    const before = JSON.stringify(entry);
    const [status] = (await connection.getSignatureStatuses([entry.signature], { searchTransactionHistory: true })).value;
    if (status) {
      entry.slot = status.slot;
      if (status.err) {
        entry.state = "failed";
        entry.error = JSON.stringify(status.err);
      } else if (status.confirmationStatus === "finalized") {
        entry.state = "finalized";
      } else if (status.confirmationStatus === "confirmed") {
        entry.state = "confirmed";
      }
    } else if (!(await connection.isBlockhashValid(entry.recentBlockhash, { commitment: "confirmed" })).value) {
      entry.state = "expired";
    }
    if (JSON.stringify(entry) !== before) await this.options.store.update(entry);
  }

  private view(entry: StoredSubmission): Submission {
    const { recentBlockhash: _, ...submission } = entry;
    return submission;
  }
}
