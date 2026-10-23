import { ComputeBudgetProgram, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import type { RejectionCode } from "@eox/signing";
import type { PolicyTransaction } from "./solana.js";
import { PolicyRejection } from "./policy-errors.js";

export interface DevnetFaucetBinding {
  mint: string;
  sourceTokenAccount: string;
  decimals: number;
  maxTokenAmount: string;
  maxSolLamports: string;
}

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const NATIVE = new PublicKey("So11111111111111111111111111111111111111112");
const deny = (message: string, code: RejectionCode = "OPERATION_NOT_PERMITTED"): never => {
  throw new PolicyRejection(code, message);
};
const ata = (owner: PublicKey, mint: PublicKey): PublicKey => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ASSOCIATED)[0];

export function checkFaucetPolicy(binding: DevnetFaucetBinding, transaction: PolicyTransaction, signer: PublicKey): void {
  if (!(transaction instanceof VersionedTransaction) || transaction.version === 1) deny("faucet supports legacy and v0 transactions only");
  const message = (transaction as VersionedTransaction).message;
  if (message.addressTableLookups.length !== 0) deny("faucet address lookup tables are forbidden");
  if (message.header.numRequiredSignatures !== 1 || !message.staticAccountKeys[0]?.equals(signer) || !message.isAccountWritable(0)) deny("faucet must be the sole signer and fee payer");
  if (new Set(message.staticAccountKeys.map(key => key.toBase58())).size !== message.staticAccountKeys.length) deny("duplicate message accounts");
  let mint: PublicKey;
  let source: PublicKey;
  let tokenCap: bigint;
  let solCap: bigint;
  try {
    mint = new PublicKey(binding.mint);
    source = new PublicKey(binding.sourceTokenAccount);
    if (!/^[1-9][0-9]*$/.test(binding.maxTokenAmount) || !/^(0|[1-9][0-9]*)$/.test(binding.maxSolLamports)) deny("invalid faucet caps", "TARGET_NOT_BOUND");
    tokenCap = BigInt(binding.maxTokenAmount);
    solCap = BigInt(binding.maxSolLamports);
  } catch {
    deny("invalid faucet binding", "TARGET_NOT_BOUND");
  }
  if (binding.decimals !== 6 || mint!.equals(NATIVE) || tokenCap! > 100000000n || solCap! > 10000000n || !source!.equals(ata(signer, mint!))) deny("unsafe faucet binding", "TARGET_NOT_BOUND");
  const instructions = message.compiledInstructions;
  if (instructions.length < 1 || instructions.length > 5) deny("invalid faucet instruction count");
  let phase = 0;
  let recipient: PublicKey | undefined;
  let destination: PublicKey | undefined;
  let transferred = false;
  let created = false;
  let funded = false;
  const computes = new Set<number>();
  const used = new Set<number>([0]);
  const writable = new Set<string>([signer.toBase58(), source!.toBase58()]);
  const setRecipient = (key: PublicKey): void => {
    if (key.equals(signer) || key.equals(mint!) || key.equals(source!) || !PublicKey.isOnCurve(key.toBytes()) || (recipient && !recipient.equals(key))) deny("inconsistent faucet recipient");
    recipient = key;
  };
  for (const instruction of instructions) {
    const program = message.staticAccountKeys[instruction.programIdIndex];
    if (!program || message.isAccountWritable(instruction.programIdIndex) || instruction.programIdIndex < message.header.numRequiredSignatures) deny("unsafe faucet program account");
    used.add(instruction.programIdIndex);
    const indexes = Array.from(instruction.accountKeyIndexes);
    if (indexes.some(index => !Number.isInteger(index) || index < 0 || index >= message.staticAccountKeys.length) || new Set(indexes).size !== indexes.length) deny("invalid faucet instruction accounts");
    indexes.forEach(index => used.add(index));
    const keys = indexes.map(index => message.staticAccountKeys[index]!);
    const data = Buffer.from(instruction.data);
    if (program!.equals(ComputeBudgetProgram.programId)) {
      if (phase !== 0 || indexes.length !== 0 || computes.size >= 2 || computes.has(data[0]!)) deny("duplicate or misplaced compute instruction");
      if (data[0] === 2 && data.length === 5) {
        const units = data.readUInt32LE(1);
        if (units < 1 || units > 200000) deny("faucet compute limit exceeded", "LIMIT_EXCEEDED");
      } else if (data[0] === 3 && data.length === 9) {
        if (data.readBigUInt64LE(1) > 1000n) deny("faucet compute price exceeded", "LIMIT_EXCEEDED");
      } else deny("unsupported faucet compute instruction");
      computes.add(data[0]!);
      continue;
    }
    if (program!.equals(ASSOCIATED)) {
      if (phase > 1 || created || data.length !== 1 || data[0] !== 1 || keys.length !== 6 || !keys[0]!.equals(signer) || !keys[3]!.equals(mint!) || !keys[4]!.equals(SystemProgram.programId) || !keys[5]!.equals(TOKEN)) deny("invalid faucet associated-account creation");
      setRecipient(keys[2]!);
      if (!keys[1]!.equals(ata(recipient!, mint!))) deny("faucet destination is not recipient ATA");
      destination = keys[1]!;
      writable.add(destination.toBase58());
      phase = 1;
      created = true;
      continue;
    }
    if (program!.equals(TOKEN)) {
      if (phase !== 1 || !created || transferred || data.length !== 10 || data[0] !== 12 || data[9] !== 6 || keys.length !== 4 || !keys[0]!.equals(source!) || !keys[1]!.equals(mint!) || !keys[3]!.equals(signer)) deny("invalid faucet checked transfer");
      const amount = data.readBigUInt64LE(1);
      if (amount < 1n || amount > tokenCap!) deny("faucet token amount exceeded", "LIMIT_EXCEEDED");
      if (keys[2]!.equals(source!) || (destination && !destination.equals(keys[2]!))) deny("invalid faucet token destination");
      destination = keys[2]!;
      writable.add(destination.toBase58());
      phase = 2;
      transferred = true;
      continue;
    }
    if (program!.equals(SystemProgram.programId)) {
      if (phase !== 2 || funded || data.length !== 12 || data.readUInt32LE(0) !== 2 || keys.length !== 2 || !keys[0]!.equals(signer)) deny("invalid faucet SOL transfer");
      const amount = data.readBigUInt64LE(4);
      if (amount < 1n || amount > solCap!) deny("faucet SOL amount exceeded", "LIMIT_EXCEEDED");
      setRecipient(keys[1]!);
      writable.add(recipient!.toBase58());
      phase = 3;
      funded = true;
      continue;
    }
    deny("faucet program not permitted");
  }
  if (computes.has(3) && !computes.has(2)) deny("faucet priority pricing requires an explicit bounded unit limit");
  if (!created || !transferred || !recipient || !destination || !destination.equals(ata(recipient, mint!))) deny("faucet requires a checked transfer to a verified recipient ATA");
  for (let index = 0; index < message.staticAccountKeys.length; index++) {
    const key = message.staticAccountKeys[index]!;
    if (!used.has(index) || message.isAccountWritable(index) !== writable.has(key.toBase58())) deny("unexpected faucet account privilege");
  }
}
