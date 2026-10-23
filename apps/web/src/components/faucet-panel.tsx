"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { claimTestTokens, faucetClaims } from "@/app/faucet-actions";
import { CIRCLE_FAUCET_URL, FAUCET_CLAIMS_PER_DAY, FAUCET_GRANT, SOL_FAUCET_URL, TEST_COLLATERAL } from "@/lib/config";
import type { ClaimAllowance } from "@/lib/faucet";
import { useSigner } from "./signer";
import { useSnackbar } from "./snackbar";

const card = "rounded-card border border-line bg-surface p-4 shadow-card";
const link = "flex h-11 items-center justify-center gap-2 rounded-pill bg-accent px-4 text-sm font-medium text-accent-ink transition-opacity duration-150 hover:opacity-90";
const action = `${link} w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50`;
const quiet = "flex h-9 cursor-pointer items-center gap-1.5 rounded-pill border border-line px-3 text-xs transition-colors duration-150 hover:bg-surface-2";

export function FaucetPanel() {
  const { address } = useSigner();
  const [mounted, setMounted] = useState(false);
  const [claims, setClaims] = useState<ClaimAllowance | null>(null);
  const { fail, show: notify } = useSnackbar();
  const [claiming, setClaiming] = useState(false);
  const [copied, setCopied] = useState(false);
  const owner = mounted ? address : null;

  useEffect(() => setMounted(true), []);

  const refresh = useCallback(async () => {
    if (!owner) return setClaims(null);
    const result = await faucetClaims(owner);
    setClaims(result.ok ? result.value : null);
  }, [owner]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const spent = claims !== null && claims.left === 0;

  const claim = async () => {
    if (!owner || claiming) return;
    setClaiming(true);
    const result = await claimTestTokens(owner);
    setClaiming(false);
    if (!result.ok) return fail(result.message, `${TEST_COLLATERAL.symbol} not sent`);
    notify({ tone: "good", title: `${FAUCET_GRANT} ${TEST_COLLATERAL.symbol} sent`, link: { href: `https://explorer.solana.com/tx/${result.value.signature}?cluster=devnet`, label: "View on explorer", external: true } });
    void refresh();
  };

  const copy = async () => {
    if (!owner) return;
    try {
      await navigator.clipboard.writeText(owner);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className={card}>
        <h2 className="text-sm font-medium">1. Copy your wallet address</h2>
        {owner ? (
          <div className="mt-3 flex items-center gap-2">
            <code className="num min-w-0 flex-1 truncate rounded-control bg-surface-2 px-3 py-2.5 text-xs">{owner}</code>
            <button type="button" onClick={copy} className={quiet} aria-label="Copy your wallet address">
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">Connect a wallet first, using the button at the top right. Set the wallet to devnet.</p>
        )}
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium">2. Get devnet SOL for fees</h2>
        <p className="mt-1 text-xs text-muted">Every request costs a tiny network fee, paid in devnet SOL. Paste your address on Solana's faucet page.</p>
        <a href={SOL_FAUCET_URL} target="_blank" rel="noreferrer" className={`${link} mt-3`}>
          Open the Solana faucet <ExternalLink size={14} aria-hidden="true" />
        </a>
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium">3. Get {FAUCET_GRANT} {TEST_COLLATERAL.symbol}</h2>
        <p className="mt-1 text-xs text-muted">{TEST_COLLATERAL.symbol} is Relative's own test token, sent straight to your wallet. Each wallet can claim {FAUCET_CLAIMS_PER_DAY} times a day.</p>
        <button type="button" onClick={() => void claim()} disabled={!owner || claiming || spent} className={`${action} mt-3`}>
          {claiming ? "Sending" : `Get ${FAUCET_GRANT} ${TEST_COLLATERAL.symbol}`}
        </button>
        {owner && claims !== null && (
          <p className="num mt-2 text-xs text-muted">
            {spent
              ? `No claims left today. Next claim after ${claims.nextAt === null ? "24 hours" : `${new Date(claims.nextAt * 1000).toUTCString().slice(17, 22)} UTC`}.`
              : `${claims.left} of ${FAUCET_CLAIMS_PER_DAY} claims left today.`}
          </p>
        )}
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium">4. Get devnet USDC from Circle</h2>
        <p className="mt-1 text-xs text-muted">On Circle's faucet page choose USDC, choose Solana Devnet as the network, paste your address and send. Circle limits how often one address can ask.</p>
        <a href={CIRCLE_FAUCET_URL} target="_blank" rel="noreferrer" className={`${link} mt-3`}>
          Open the Circle faucet <ExternalLink size={14} aria-hidden="true" />
        </a>
      </section>
    </div>
  );
}
