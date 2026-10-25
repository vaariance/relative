"use client";

import type { Submission, UnsignedTransaction } from "@eox/app-api";
import { useConnection } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { useEffect, useRef, useState } from "react";
import { buildTransaction, submissionState, submitSigned } from "@/app/actions";
import { COLLATERAL } from "@/lib/config";
import { humanError, walletError } from "@/lib/errors";
import { closedLabel, tradingClosed } from "@/lib/market";
import type { Intent } from "@/lib/requests";
import { useAccount } from "./account";
import { openLogin, useSigner } from "./signer";
import { useSnackbar } from "./snackbar";

const POLL_MS = 2000;
const POSITION_BYTES = 4096;
const REQUEST_BYTES = 320;
const FEE_LAMPORTS = 10_000;

function sol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(4);
}
const POLLS = 45;

function decode(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function done(built: UnsignedTransaction): { title: string; text: string } {
  if (built.operation === "cancel") return { title: "Request cancelled", text: "It will not be filled." };
  if (built.operation === "refund") return { title: "Refund sent", text: "The money is on its way back to your wallet." };
  if (built.operation === "epoch-entry") return { title: "Entry placed", text: "It starts from the next price, within a few seconds." };
  if (built.operation === "epoch-withdraw") return { title: "Withdrawal sent", text: `The ${COLLATERAL.symbol} is on its way to your wallet.` };
  if (built.operation === "epoch-refund") return { title: "Refund sent", text: "Your stake is on its way back to your wallet." };
  if (built.operation === "epoch-void") return { title: "Round cancelled", text: "Every entry in it can now be refunded." };
  if (built.operation === "withdraw") return { title: "Withdrawal sent", text: `The ${COLLATERAL.symbol} is on its way to your wallet.` };
  return { title: "Order placed", text: "It fills at the next price update, usually within a minute." };
}

interface SendButtonProps {
  intent: Intent | null;
  label: string;
  connectLabel: string;
  problem?: string | null;
  className: string;
  quiet?: boolean;
  hideSuccess?: boolean;
  describe?: string;
  trading?: boolean;
  onDone?: () => void;
}

export function SendButton({ intent, label, connectLabel, problem = null, className, quiet = false, describe, trading = false, onDone }: SendButtonProps) {
  const { live, owner, market, refresh } = useAccount();
  const { sign } = useSigner();
  const { connection } = useConnection();
  const { show, fail } = useSnackbar();
  const [mounted, setMounted] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    setMounted(true);
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const wallet = mounted ? owner : null;
  const trade = trading || (intent !== null && (intent.operation === "deposit" || intent.operation === "switch" || intent.operation === "redeem"));
  const closed = live && trade && tradingClosed(market.trading) && working === null;
  const ready = live && wallet !== null && intent !== null && problem === null && working === null && !closed;
  const clickable = ready || (mounted && wallet === null);

  const track = async (first: Submission) => {
    let submission = first;
    for (let poll = 0; poll < POLLS && submission.state === "submitted" && alive.current; poll += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
      const next = await submissionState(submission.signature);
      if (next.ok) submission = next.value;
    }
    if (submission.state === "failed") fail(humanError("TRANSACTION_REJECTED", submission.error ?? ""), "The network refused it");
    if (submission.state === "expired") fail("It was not picked up in time. Nothing moved. Please try again.", "Timed out");
    await refresh();
    onDone?.();
  };

  const shortOfSol = async (): Promise<boolean> => {
    if (!wallet || !intent || !market.program || !market.pool) return false;
    if (intent.operation !== "deposit" && intent.operation !== "switch" && intent.operation !== "redeem") return false;
    try {
      const owner = new PublicKey(wallet);
      const position = PublicKey.findProgramAddressSync([new TextEncoder().encode("position"), new PublicKey(market.pool).toBuffer(), owner.toBuffer()], new PublicKey(market.program))[0];
      const [accounts, positionRent, requestRent] = await Promise.all([
        connection.getMultipleAccountsInfo([owner, position]),
        connection.getMinimumBalanceForRentExemption(POSITION_BYTES),
        connection.getMinimumBalanceForRentExemption(REQUEST_BYTES),
      ]);
      const balance = accounts[0]?.lamports ?? 0;
      const first = accounts[1] === null;
      const needed = (first ? positionRent : 0) + requestRent + FEE_LAMPORTS;
      if (balance >= needed) return false;
      show({
        tone: "bad",
        title: "Not enough SOL",
        text: `You need ${sol(needed)} SOL and have ${sol(balance)}.`,
        link: { href: "/faucet", label: "Get SOL" },
      });
      return true;
    } catch {
      return false;
    }
  };

  const send = async () => {
    if (!wallet || !intent) return;
    if (!sign) return fail("This wallet cannot sign this kind of request. Try a different wallet.");
    setWorking("Preparing");
    try {
      if (await shortOfSol()) return;
      const built = await buildTransaction(wallet, intent);
      if (!built.ok) return fail(humanError(built.code, built.message));
      const transaction = VersionedTransaction.deserialize(decode(built.value.transaction));
      if (built.value.owner !== wallet || transaction.message.staticAccountKeys[0]?.toBase58() !== wallet || transaction.message.header.numRequiredSignatures !== 1) {
        return fail("The prepared request did not match your wallet, so it was not signed. Please try again.");
      }
      setWorking("Waiting for your wallet");
      const signed = await sign(transaction);
      setWorking("Sending");
      const submitted = await submitSigned(encode(signed.serialize()));
      if (!submitted.ok) return fail(humanError(submitted.code, submitted.message));
      const message = done(built.value);
      const trade = built.value.operation === "deposit" || built.value.operation === "switch" || built.value.operation === "redeem";
      show({ tone: "good", title: message.title, text: describe ?? message.text, link: trade ? { href: "/portfolio", label: "View portfolio" } : undefined });
      onDone?.();
      void track(submitted.value);
    } catch (error) {
      fail(walletError(error));
    } finally {
      if (alive.current) setWorking(null);
    }
  };

  const shut = closed && mounted ? closedLabel(market.trading, Math.floor(Date.now() / 1000)) : null;
  const text = !wallet ? connectLabel : !live ? "Not available on demo data" : (shut ?? working ?? label);

  return (
    <>
      <button type="button" disabled={!clickable} onClick={wallet === null ? openLogin : send} className={`${className} transition-opacity duration-150 ${clickable ? "cursor-pointer hover:opacity-90" : "opacity-50"}`}>
        {text}
      </button>
      {wallet && live && problem && working === null && !closed && !quiet && <p className="text-xs text-muted">{problem}</p>}
    </>
  );
}
