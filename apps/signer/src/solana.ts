import { createPublicKey, verify } from "node:crypto";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getTransactionDecoder, getTransactionEncoder } from "@solana/transactions";
import { getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder, decompileTransactionMessage } from "@solana/transaction-messages";
import { signData, type AccessToken } from "./kms.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyEd25519(rawPublicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]), format: "der", type: "spki" });
  return verify(null, message, key, signature);
}

export interface PolicyMessage {
  readonly header: { numRequiredSignatures: number };
  readonly staticAccountKeys: readonly PublicKey[];
  readonly addressTableLookups: readonly unknown[];
  readonly compiledInstructions: readonly { programIdIndex: number; accountKeyIndexes: readonly number[]; data: Uint8Array }[];
  serialize(): Uint8Array;
}
export interface V1Transaction {
  readonly version: 1;
  readonly writableAccounts: ReadonlySet<number>;
  readonly inlineConfig: { computeUnitLimit?: number; heapSize?: number; loadedAccountsDataSizeLimit?: number; priorityFeeLamports?: bigint };
  readonly message: PolicyMessage;
  readonly signatures: Uint8Array[];
  addSignature(signer: PublicKey, signature: Uint8Array): void;
  serialize(): Uint8Array;
}
export type PolicyTransaction = VersionedTransaction | V1Transaction;

function parseV1(bytes: Buffer): V1Transaction {
  if (bytes.length > 4096) throw new Error("V1 transaction exceeds packet limit");
  const decoded = getTransactionDecoder().decode(bytes);
  if (!Buffer.from(getTransactionEncoder().encode(decoded)).equals(bytes)) throw new Error("transaction bytes are not canonical");
  const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  if (compiled.version !== 1 || !Buffer.from(getCompiledTransactionMessageEncoder().encode(compiled)).equals(Buffer.from(decoded.messageBytes))) throw new Error("noncanonical V1 message");
  if ((compiled.configMask & ~31) !== 0 || compiled.header.numReadonlyNonSignerAccounts > compiled.staticAccounts.length - 1
    || compiled.numStaticAccounts !== compiled.staticAccounts.length || compiled.numInstructions !== compiled.instructionHeaders.length
    || compiled.instructionPayloads.length !== compiled.numInstructions) throw new Error("invalid V1 header");
  if (compiled.header.numSignerAccounts !== 1 || compiled.header.numReadonlySignerAccounts !== 0) throw new Error("V1 requires a sole writable signer");
  const keys = compiled.staticAccounts.map(key => new PublicKey(key));
  if (new Set(keys.map(key => key.toBase58())).size !== keys.length || keys.length > 64) throw new Error("invalid V1 account list");
  const instructions = compiled.instructionHeaders.map((header, index) => {
    const payload = compiled.instructionPayloads[index];
    if (!payload || header.numInstructionAccounts !== payload.instructionAccountIndices.length || header.numInstructionDataBytes !== payload.instructionData.length
      || header.programAccountIndex >= keys.length || payload.instructionAccountIndices.some(key => key >= keys.length)) throw new Error("invalid V1 instruction accounts");
    return { programIdIndex: header.programAccountIndex, accountKeyIndexes: payload.instructionAccountIndices, data: new Uint8Array(payload.instructionData) };
  });
  const signature = Object.values(decoded.signatures)[0];
  const signatures = [signature ? new Uint8Array(signature) : new Uint8Array(64)];
  if (bytes.length !== decoded.messageBytes.length + 64) throw new Error("invalid V1 framing");
  const source = decompileTransactionMessage(compiled);
  const writableAccounts = new Set(keys.map((_, index) => index).filter(index => index < compiled.header.numSignerAccounts - compiled.header.numReadonlySignerAccounts
    || (index >= compiled.header.numSignerAccounts && index < keys.length - compiled.header.numReadonlyNonSignerAccounts)));
  return {
version: 1, writableAccounts, inlineConfig: "config" in source ? source.config ?? {} : {}, signatures,
    message: { header: { numRequiredSignatures: 1 }, staticAccountKeys: keys, addressTableLookups: [], compiledInstructions: instructions, serialize: () => new Uint8Array(decoded.messageBytes) },
    addSignature(signer, value) { if (!keys[0]!.equals(signer) || value.length !== 64) throw new Error("invalid V1 signature"); signatures[0] = new Uint8Array(value); },
    serialize() { return Buffer.concat([new Uint8Array(decoded.messageBytes), signatures[0]!]); }
};
}

export function parseSolanaTransaction(transactionBase64: string): PolicyTransaction {
  const bytes = Buffer.from(transactionBase64, "base64");
  if (bytes.toString("base64") !== transactionBase64) throw new Error("transaction is not canonical base64");
  if (bytes[0] === 0x81) return parseV1(bytes);
  const transaction = VersionedTransaction.deserialize(bytes);
  if (Buffer.from(transaction.serialize()).toString("base64") !== transactionBase64) {
    throw new Error("transaction bytes are not canonical");
  }
  return transaction;
}

export function requiredSignerIndex(transaction: PolicyTransaction, signer: PublicKey): number {
  const required = transaction.message.header.numRequiredSignatures;
  const index = transaction.message.staticAccountKeys.slice(0, required).findIndex((key) => key.equals(signer));
  if (index === -1) throw new Error(`${signer.toBase58()} is not a required signer of this transaction`);
  return index;
}

export async function signSolanaTransaction(
  token: AccessToken,
  keyVersion: string,
  rawPublicKey: Uint8Array,
  transactionBase64: string,
): Promise<{ signature: Uint8Array; signedTransaction: string; message: Uint8Array }> {
  const transaction = parseSolanaTransaction(transactionBase64);
  const signer = new PublicKey(rawPublicKey);
  requiredSignerIndex(transaction, signer);
  const message = transaction.message.serialize();
  const signature = await signData(token, keyVersion, message);
  if (signature.length !== 64 || !verifyEd25519(rawPublicKey, message, signature)) {
    throw new Error("KMS signature does not verify against the expected Solana key");
  }
  transaction.addSignature(signer, signature);
  return { signature, signedTransaction: Buffer.from(transaction.serialize()).toString("base64"), message };
}
