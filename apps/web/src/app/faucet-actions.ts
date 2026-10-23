"use server";

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { FAUCET_CLAIMS_PER_DAY, FAUCET_GRANT, TEST_COLLATERAL } from "@/lib/config";
import { type ClaimAllowance, claimAllowance, faucetMemo } from "@/lib/faucet";
import type { Outcome } from "@/lib/requests";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const HISTORY_LIMIT = 1000;
const connection = new Connection(process.env.COX_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const claiming = new Set<string>();

function tokenAccountOf(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}

function faucetKey(): Keypair | null {
  const secret = process.env.TUSDC_FAUCET_SECRET_KEY?.trim();
  if (!secret) return null;
  try {
    const bytes = secret.startsWith("[") ? Uint8Array.from(JSON.parse(secret) as number[]) : bs58.decode(secret);
    return Keypair.fromSecretKey(bytes);
  } catch {
    console.error("TUSDC_FAUCET_SECRET_KEY is not a valid Solana secret key");
    return null;
  }
}

async function allowanceFor(faucet: PublicKey, owner: string): Promise<ClaimAllowance> {
  const history = await connection.getSignaturesForAddress(faucet, { limit: HISTORY_LIMIT }, "confirmed");
  const records = history.map((item) => ({ memo: item.memo, blockTime: item.blockTime ?? null, failed: item.err !== null }));
  return claimAllowance(records, owner, Math.floor(Date.now() / 1000), FAUCET_CLAIMS_PER_DAY);
}

function busy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|Too Many/i.test(message);
}

export async function faucetClaims(owner: string): Promise<Outcome<ClaimAllowance | null>> {
  try {
    new PublicKey(owner);
    const faucet = faucetKey();
    return { ok: true, value: faucet ? await allowanceFor(faucet.publicKey, owner) : null };
  } catch (error) {
    return { ok: false, code: "UNAVAILABLE", message: busy(error) ? "The devnet connection is busy. Please try again in a moment." : "Your remaining claims could not be read." };
  }
}

export async function claimTestTokens(owner: string): Promise<Outcome<{ signature: string; claims: ClaimAllowance }>> {
  let recipient: PublicKey;
  try {
    recipient = new PublicKey(owner);
  } catch {
    return { ok: false, code: "INVALID_REQUEST", message: "Connect a wallet first." };
  }
  const faucet = faucetKey();
  if (!faucet) return { ok: false, code: "UNAVAILABLE", message: `The ${TEST_COLLATERAL.symbol} faucet is not available right now.` };
  if (claiming.has(owner)) return { ok: false, code: "RATE_LIMITED", message: "Your last claim is still being sent." };
  claiming.add(owner);
  try {
    const allowance = await allowanceFor(faucet.publicKey, owner);
    if (allowance.left === 0) {
      const next = allowance.nextAt === null ? "tomorrow" : `after ${new Date(allowance.nextAt * 1000).toUTCString().slice(17, 22)} UTC`;
      return { ok: false, code: "RATE_LIMITED", message: `Each wallet can claim ${TEST_COLLATERAL.symbol} ${FAUCET_CLAIMS_PER_DAY} times a day. Try again ${next}.` };
    }

    const mint = new PublicKey(TEST_COLLATERAL.mint);
    const mintInfo = await connection.getAccountInfo(mint);
    const authority = mintInfo && mintInfo.data.length >= 36 && mintInfo.data.readUInt32LE(0) === 1 ? new PublicKey(mintInfo.data.subarray(4, 36)) : null;
    if (!authority?.equals(faucet.publicKey)) {
      console.error("The faucet key is not the mint authority of", TEST_COLLATERAL.mint);
      return { ok: false, code: "UNAVAILABLE", message: `The ${TEST_COLLATERAL.symbol} faucet is not available right now.` };
    }

    const tokenAccount = tokenAccountOf(recipient, mint);
    const amount = Buffer.alloc(9);
    amount.writeUInt8(7, 0);
    amount.writeBigUInt64LE(BigInt(FAUCET_GRANT) * 10n ** BigInt(TEST_COLLATERAL.decimals), 1);
    const transaction = new Transaction().add(
      new TransactionInstruction({
        programId: ASSOCIATED_TOKEN_PROGRAM,
        keys: [
          { pubkey: faucet.publicKey, isSigner: true, isWritable: true },
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: recipient, isSigner: false, isWritable: false },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
      new TransactionInstruction({
        programId: TOKEN_PROGRAM,
        keys: [
          { pubkey: mint, isSigner: false, isWritable: true },
          { pubkey: tokenAccount, isSigner: false, isWritable: true },
          { pubkey: faucet.publicKey, isSigner: true, isWritable: false },
        ],
        data: amount,
      }),
      new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(faucetMemo(owner), "utf8") }),
    );
    const latest = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = latest.blockhash;
    transaction.feePayer = faucet.publicKey;
    transaction.sign(faucet);
    const signature = await connection.sendRawTransaction(transaction.serialize());
    const confirmed = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
    if (confirmed.value.err) return { ok: false, code: "TRANSACTION_REJECTED", message: `The ${TEST_COLLATERAL.symbol} transfer did not go through. Please try again.` };
    return { ok: true, value: { signature, claims: { left: allowance.left - 1, nextAt: null } } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("tUSDC faucet claim failed:", message.split("\n")[0]);
    if (/insufficient (funds|lamports)|no record of a prior credit/i.test(message)) return { ok: false, code: "UNAVAILABLE", message: `The ${TEST_COLLATERAL.symbol} faucet is empty right now. Please try again later.` };
    return { ok: false, code: "UNAVAILABLE", message: busy(error) ? "The devnet connection is busy. Please try again in a moment." : `The ${TEST_COLLATERAL.symbol} faucet is not available right now.` };
  } finally {
    claiming.delete(owner);
  }
}
