"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { type Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Droplets } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CIRCLE_DEVNET_USDC, TEST_COLLATERAL } from "@/lib/config";
import { useSigner } from "./signer";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export interface Balances {
  sol: number;
  usdc: number;
  testUsdc: number;
}

function tokenAccountOf(owner: PublicKey, mint: string): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()], ASSOCIATED_TOKEN_PROGRAM)[0];
}

function tokenAmount(info: { owner: PublicKey; data: Uint8Array } | null, decimals: number): number {
  if (!info || !info.owner.equals(TOKEN_PROGRAM) || info.data.length !== 165) return 0;
  return Number(new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength).getBigUint64(64, true)) / 10 ** decimals;
}

export async function readBalances(connection: Connection, address: string): Promise<Balances> {
  const owner = new PublicKey(address);
  const [account, usdc, testUsdc] = await connection.getMultipleAccountsInfo([owner, tokenAccountOf(owner, CIRCLE_DEVNET_USDC), tokenAccountOf(owner, TEST_COLLATERAL.mint)]);
  return { sol: (account?.lamports ?? 0) / LAMPORTS_PER_SOL, usdc: tokenAmount(usdc ?? null, 6), testUsdc: tokenAmount(testUsdc ?? null, TEST_COLLATERAL.decimals) };
}

function useEmptyWallet(): boolean {
  const { connection } = useConnection();
  const { address } = useSigner();
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    setEmpty(false);
    if (!address) return;
    let current = true;
    const check = () =>
      readBalances(connection, address)
        .then((balances) => {
          if (current) setEmpty(balances.sol === 0 && balances.usdc === 0 && balances.testUsdc === 0);
        })
        .catch(() => undefined);
    void check();
    window.addEventListener("focus", check);
    return () => {
      current = false;
      window.removeEventListener("focus", check);
    };
  }, [connection, address]);

  return empty;
}

export function FundsHint() {
  if (!useEmptyWallet()) return null;
  return (
    <Link href="/faucet" className="flex items-center gap-2 rounded-control bg-accent/10 px-3 py-2 text-xs text-accent transition-colors duration-150 hover:bg-accent/15">
      <Droplets size={14} aria-hidden="true" className="shrink-0" />
      Your wallet is empty. Get free test funds from the faucet.
    </Link>
  );
}
