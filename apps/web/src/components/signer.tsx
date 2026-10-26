"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useSignMessage, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { type ReactNode, createContext, useContext, useMemo } from "react";

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
  login: (() => void) | null;
  logout: () => Promise<void>;
}

const SignerContext = createContext<Signer>({ address: null, label: null, account: null, connecting: false, profile: null, sign: null, signMessage: null, login: null, logout: async () => undefined });

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

export function AdapterSigner({ children }: { children: ReactNode }) {
  const { publicKey, wallet, connecting, signTransaction, signMessage, disconnect } = useWallet();
  const value = useMemo<Signer>(
    () => ({
      address: publicKey?.toBase58() ?? null,
      label: wallet?.adapter.name ?? null,
      account: null,
      connecting,
      profile: publicKey ? { name: null, email: null, wallets: [{ address: publicKey.toBase58(), label: wallet?.adapter.name ?? "Wallet" }] } : null,
      sign: signTransaction ? (transaction) => signTransaction(transaction) : null,
      signMessage: signMessage ? (message) => signMessage(message) : null,
      login: null,
      logout: () => disconnect(),
    }),
    [publicKey, wallet, connecting, signTransaction, signMessage, disconnect],
  );
  return <SignerContext.Provider value={value}>{children}</SignerContext.Provider>;
}

const EMBEDDED = "Privy";

export function PrivySigner({ children }: { children: ReactNode }) {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const { signMessage } = useSignMessage();
  const wallet = authenticated ? (wallets.find((item) => item.standardWallet.name === EMBEDDED) ?? wallets[0] ?? null) : null;
  const account = user?.google?.email ?? user?.email?.address ?? null;
  const name = user?.google?.name ?? null;

  const value = useMemo<Signer>(
    () => ({
      address: wallet?.address ?? null,
      label: wallet ? (wallet.standardWallet.name === EMBEDDED ? "Relative wallet" : wallet.standardWallet.name) : null,
      account,
      connecting: !ready || (authenticated && (!walletsReady || wallet === null)),
      profile: authenticated ? { name, email: account, wallets: wallets.map((item) => ({ address: item.address, label: item.standardWallet.name === EMBEDDED ? "Relative wallet" : item.standardWallet.name })) } : null,
      sign: wallet
        ? async (transaction) => {
            const { signedTransaction } = await signTransaction({ transaction: transaction.serialize(), wallet, chain: "solana:devnet" });
            return VersionedTransaction.deserialize(signedTransaction);
          }
        : null,
      signMessage: wallet
        ? async (message) => (await signMessage({ message, wallet, options: { uiOptions: { showWalletUIs: false } } })).signature
        : null,
      login: ready && !authenticated ? () => login() : null,
      logout: () => logout(),
    }),
    [ready, authenticated, walletsReady, wallet, wallets, account, name, signTransaction, signMessage, login, logout],
  );
  return <SignerContext.Provider value={value}>{children}</SignerContext.Provider>;
}
