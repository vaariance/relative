"use server";

import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import type { Outcome } from "@/lib/requests";

const connection = new Connection(process.env.COX_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");

export interface FaucetStatus {
  sol: number;
}

export async function faucetStatus(owner: string): Promise<Outcome<FaucetStatus>> {
  try {
    const lamports = await connection.getBalance(new PublicKey(owner));
    return { ok: true, value: { sol: lamports / LAMPORTS_PER_SOL } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "UNAVAILABLE", message: /429|Too Many/i.test(message) ? "The devnet connection is busy. Please try again in a moment." : "Your wallet could not be read." };
  }
}
