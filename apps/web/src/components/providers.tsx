"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { clusterApiUrl } from "@solana/web3.js";
import type { FeeTerms, Portfolio } from "@eox/app-api";
import type { ReactNode } from "react";
import type { Market } from "@/lib/market";
import { AccountProvider } from "./account";
import { LogoProvider } from "./coin-icon";
import { AdapterSigner, PrivySigner } from "./signer";
import { SnackbarProvider } from "./snackbar";

const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? clusterApiUrl("devnet");
const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
const wallets: never[] = [];

function Signing({ children }: { children: ReactNode }) {
  if (!privyAppId) return <AdapterSigner>{children}</AdapterSigner>;
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        loginMethods: ["google", "wallet"],
        appearance: { theme: "dark", accentColor: "#F2622E", walletChainType: "solana-only", walletList: ["phantom", "solflare", "backpack", "detected_solana_wallets"] },
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" }, ethereum: { createOnLogin: "off" }, showWalletUIs: false },
        externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
      }}
    >
      <PrivySigner>{children}</PrivySigner>
    </PrivyProvider>
  );
}

export function Providers({ live, demo, apiUrl, sequence, fee, market, logos, children }: { live: boolean; demo: Portfolio | null; apiUrl: string; sequence: number | null; fee: FeeTerms | null; market: Market; logos: Record<string, string>; children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={!privyAppId}>
        <Signing>
          <SnackbarProvider>
            <AccountProvider live={live} demo={demo} apiUrl={apiUrl} sequence={sequence} fee={fee} market={market}>
              <LogoProvider logos={logos}>{children}</LogoProvider>
            </AccountProvider>
          </SnackbarProvider>
        </Signing>
      </WalletProvider>
    </ConnectionProvider>
  );
}
