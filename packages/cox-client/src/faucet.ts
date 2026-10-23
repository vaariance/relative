import { Buffer } from "buffer";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const DEVNET_FAUCET_MINT = new PublicKey("5rpGrekfBLHdF8PD8eKLzXQPPmhyF7FCKeE1VA5CwV3X");
export const DEVNET_FAUCET_TOKEN_SYMBOL = "rlUSD";
export const DEVNET_FAUCET_TOKEN_DECIMALS = 6;
export const DEVNET_FAUCET_TOKEN_AMOUNT = 100_000_000n;
export const DEVNET_FAUCET_SOL_LIMIT = 10_000_000n;
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export function devnetFaucetTokenAccount(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), DEVNET_FAUCET_MINT.toBuffer()], ASSOCIATED)[0];
}

export interface DevnetFaucetGrant {
  faucet: PublicKey;
  recipient: PublicKey;
  tokenAmount?: bigint;
  solLamports?: bigint;
}

export function devnetFaucetInstructions(input: DevnetFaucetGrant): TransactionInstruction[] {
  const amount = input.tokenAmount ?? DEVNET_FAUCET_TOKEN_AMOUNT;
  const sol = input.solLamports ?? 0n;
  if (amount <= 0n || amount > DEVNET_FAUCET_TOKEN_AMOUNT || sol < 0n || sol > DEVNET_FAUCET_SOL_LIMIT) throw new Error("FaucetGrantLimitExceeded");
  if (input.faucet.equals(input.recipient) || !PublicKey.isOnCurve(input.recipient.toBytes())) throw new Error("FaucetRecipientInvalid");
  const source = devnetFaucetTokenAccount(input.faucet), destination = devnetFaucetTokenAccount(input.recipient);
  const checked = Buffer.alloc(10); checked[0] = 12; checked.writeBigUInt64LE(amount, 1); checked[9] = DEVNET_FAUCET_TOKEN_DECIMALS;
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    new TransactionInstruction({ programId: ASSOCIATED, data: Buffer.from([1]), keys: [
      { pubkey: input.faucet, isSigner: true, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: input.recipient, isSigner: false, isWritable: false },
      { pubkey: DEVNET_FAUCET_MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ] }),
    new TransactionInstruction({ programId: TOKEN, data: checked, keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: DEVNET_FAUCET_MINT, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: input.faucet, isSigner: true, isWritable: false },
    ] }),
  ];
  if (sol > 0n) instructions.push(SystemProgram.transfer({ fromPubkey: input.faucet, toPubkey: input.recipient, lamports: sol }));
  return instructions;
}
