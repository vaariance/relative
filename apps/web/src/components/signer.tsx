"use client";

import { useLoginWithOAuth, usePrivy } from "@privy-io/react-auth";
import { useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { type ReactNode, createContext, useContext, useEffect, useMemo } from "react";

export interface Profile {
  name: string | null;
  email: string | null;
  wallets: { address: string; label: string }[];
}

export interface Signer {
  address: string | null;
  label: string | null;
  account: string | null;
  connecting: boolean;
  profile: Profile | null;
  sign: ((transaction: VersionedTransaction) => Promise<VersionedTransaction>) | null;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | null;
  google: (() => Promise<void>) | null;
  logout: () => Promise<void>;
}

const SignerContext = createContext<Signer>({ address: null, label: null, account: null, connecting: false, profile: null, sign: null, signMessage: null, google: null, logout: async () => undefined });

export function useSigner(): Signer {
  return useContext(SignerContext);
}

const LOGIN_EVENT = "relative:login";

export function openLogin(): void {
  window.dispatchEvent(new Event(LOGIN_EVENT));
}

export function onLogin(listener: () => void): () => void {
  window.addEventListener(LOGIN_EVENT, listener);
  return () => window.removeEventListener(LOGIN_EVENT, listener);
}

function useAdapterSigner(): Signer {
  const { publicKey, wallet, connecting, signTransaction, signMessage, disconnect } = useWallet();
  return useMemo<Signer>(
    () => ({
      address: publicKey?.toBase58() ?? null,
      label: wallet?.adapter.name ?? null,
      account: null,
      connecting,
      profile: publicKey ? { name: null, email: null, wallets: [{ address: publicKey.toBase58(), label: wallet?.adapter.name ?? "Wallet" }] } : null,
      sign: signTransaction ? (transaction) => signTransaction(transaction) : null,
      signMessage: signMessage ? (message) => signMessage(message) : null,
      google: null,
      logout: () => disconnect(),
    }),
    [publicKey, wallet, connecting, signTransaction, signMessage, disconnect],
  );
}

export function AdapterSigner({ children }: { children: ReactNode }) {
  const value = useAdapterSigner();
  return <SignerContext.Provider value={value}>{children}</SignerContext.Provider>;
}

const EMBEDDED = "Privy";
const EMBEDDED_LABEL = "Relative wallet";

export function PrivySigner({ children }: { children: ReactNode }) {
  const adapter = useAdapterSigner();
  const { ready, authenticated, user, logout } = usePrivy();
  const { wallets } = useWallets();
  const { initOAuth } = useLoginWithOAuth();
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();
  const google = authenticated ? (user?.google ?? null) : null;
  const legacy = ready && authenticated && google === null;
  const wallet = google ? (wallets.find((item) => item.standardWallet.name === EMBEDDED) ?? null) : null;

  useEffect(() => {
    if (legacy) logout().catch(() => undefined);
  }, [legacy, logout]);

  const value = useMemo<Signer>(() => {
    if (!google) return { ...adapter, google: ready && !authenticated ? () => initOAuth({ provider: "google" }) : null };
    return {
      address: wallet?.address ?? null,
      label: wallet ? EMBEDDED_LABEL : null,
      account: google.email,
      connecting: wallet === null,
      profile: { name: google.name, email: google.email, wallets: wallet ? [{ address: wallet.address, label: EMBEDDED_LABEL }] : [] },
      sign: wallet
        ? async (transaction) => {
            const { signedTransaction } = await signTransaction({ transaction: transaction.serialize(), wallet, chain: "solana:devnet" });
            return VersionedTransaction.deserialize(signedTransaction);
          }
        : null,
      signMessage: wallet
        ? async (message) => (await signMessage({ message, wallet, options: { uiOptions: { showWalletUIs: false } } })).signature
        : null,
      google: null,
      logout: () => logout(),
    };
  }, [adapter, ready, authenticated, google, wallet, initOAuth, signTransaction, signMessage, logout]);
  return <SignerContext.Provider value={value}>{children}</SignerContext.Provider>;
}
