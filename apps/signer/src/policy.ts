import type { PolicyTransaction } from "./solana.js";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import type { RejectionCode, SigningRole } from "@eox/signing";
import { SIGNER_ACCOUNT, type RoleBindings } from "./config.js";

export class PolicyRejection extends Error {
  constructor(
    readonly code: RejectionCode,
    message: string,
  ) {
    super(message);
  }
}

const deny = (code: RejectionCode, message: string): never => {
  throw new PolicyRejection(code, message);
};

const COMPUTE_BUDGET = ComputeBudgetProgram.programId;
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;

export function checkSolanaPolicy(
  role: SigningRole,
  bindings: RoleBindings | undefined,
  transaction: PolicyTransaction,
  signer: PublicKey,
): void {
  const message = transaction.message;
  if (message.addressTableLookups.length > 0) deny("OPERATION_NOT_PERMITTED", "address lookup tables are not permitted");
  if (!message.staticAccountKeys[0]?.equals(signer)) deny("OPERATION_NOT_PERMITTED", "the signing key must be the fee payer");
  const policy = bindings?.solana;
  if (!policy || policy.programs.length === 0) deny("TARGET_NOT_BOUND", `${role} has no bound Solana programs`);
  if (message.compiledInstructions.length === 0) deny("OPERATION_NOT_PERMITTED", "transaction has no instructions");
  if ("inlineConfig" in transaction) {
    const config = transaction.inlineConfig;
    const units = config.computeUnitLimit;
    if (units === undefined || !Number.isSafeInteger(units) || units < 1 || units > Number(policy!.maxComputeUnitLimit ?? 1400000)) deny("LIMIT_EXCEEDED", "V1 compute unit limit missing or exceeds policy");
    const heap = config.heapSize ?? 32768;
    if (heap < 32768 || heap % 1024 !== 0 || heap > (policy!.maxHeapBytes ?? 32768)) deny("LIMIT_EXCEEDED", "V1 heap exceeds policy");
    if ((config.loadedAccountsDataSizeLimit ?? 67108864) > 67108864) deny("LIMIT_EXCEEDED", "V1 loaded data exceeds policy");
    const maxFee = (BigInt(units!) * BigInt(policy!.maxComputeUnitPriceMicroLamports) + 999999n) / 1000000n;
    if ((config.priorityFeeLamports ?? 0n) > maxFee) deny("LIMIT_EXCEEDED", "V1 priority fee exceeds policy");
  }
  for (const instruction of message.compiledInstructions) {
    const programId = message.staticAccountKeys[instruction.programIdIndex];
    if (!programId) deny("INVALID_REQUEST", "instruction references a missing program account");
    if ("writableAccounts" in transaction && transaction.writableAccounts.has(instruction.programIdIndex)) deny("OPERATION_NOT_PERMITTED", "V1 program account must be readonly");
    const data = Buffer.from(instruction.data);
    if (programId!.equals(COMPUTE_BUDGET)) {
      if (transaction.version === 1) deny("OPERATION_NOT_PERMITTED", "V1 compute settings must be inline");
      if (data[0] === SET_COMPUTE_UNIT_LIMIT && data.length === 5) {
        if (policy!.maxComputeUnitLimit !== undefined && data.readUInt32LE(1) > Number(policy!.maxComputeUnitLimit)) {
          deny("LIMIT_EXCEEDED", "compute unit limit exceeds the permitted maximum");
        }
        continue;
      }
      if (data[0] === SET_COMPUTE_UNIT_PRICE && data.length === 9) {
        if (data.readBigUInt64LE(1) > BigInt(policy!.maxComputeUnitPriceMicroLamports)) {
          deny("LIMIT_EXCEEDED", "compute unit price exceeds the permitted maximum");
        }
        continue;
      }
      deny("OPERATION_NOT_PERMITTED", "only compute unit limit and price instructions are permitted");
    }
    const program = policy!.programs.find((p) => p.programId === programId!.toBase58());
    if (!program) deny("TARGET_NOT_BOUND", `program ${programId!.toBase58()} is not bound for ${role}`);
    if (transaction.version === 1 && program!.allowTransactionV1 !== true) deny("OPERATION_NOT_PERMITTED", "V1 is not enabled for this program binding");
    if (program!.enabled === false) deny("TARGET_NOT_BOUND", `program ${programId!.toBase58()} is prepared for ${role} but not enabled`);
    const discriminator = data.subarray(0, 8).toString("hex");
    if (!program!.discriminators.includes(discriminator)) {
      deny("OPERATION_NOT_PERMITTED", `instruction ${discriminator} is not permitted on ${programId!.toBase58()}`);
    }
    const rule = program!.instructions?.find((r) => r.discriminator === discriminator);
    if (program!.instructions && !rule) deny("OPERATION_NOT_PERMITTED", `instruction ${discriminator} has no account rule`);
    if ("writableAccounts" in transaction) {
      if (!rule?.v1WritableAccounts) deny("OPERATION_NOT_PERMITTED", "V1 requires explicit writable account rules");
      instruction.accountKeyIndexes.forEach((key, index) => {
        if (transaction.writableAccounts.has(key) && key !== 0 && !rule!.v1WritableAccounts!.includes(index)) deny("OPERATION_NOT_PERMITTED", "V1 writable account is not authorized");
      });
    }
    for (const [index, expected] of Object.entries(rule?.accounts ?? {})) {
      const key = message.staticAccountKeys[instruction.accountKeyIndexes[Number(index)]!];
      const want = expected === SIGNER_ACCOUNT ? signer : new PublicKey(expected);
      if (!key || !key.equals(want)) {
        deny("TARGET_NOT_BOUND", `instruction ${discriminator} account ${index} is ${key?.toBase58() ?? "missing"}, not ${want.toBase58()}`);
      }
    }
  }
}
