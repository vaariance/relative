"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { claimTestTokens, faucetClaims } from "@/app/faucet-actions";
import { CIRCLE_FAUCET_URL, FAUCET_CLAIMS_PER_DAY, FAUCET_GRANT, SOL_FAUCET_URL, TEST_COLLATERAL } from "@/lib/config";
import type { ClaimAllowance } from "@/lib/faucet";
import { openLogin, useSigner } from "./signer";
import { useSnackbar } from "./snackbar";

type TokenId = "sol" | "tusdc" | "usdc";

interface Token {
  id: TokenId;
  symbol: string;
  caption: string;
  icon: string;
  test?: boolean;
}

const TOKENS: Token[] = [
  { id: "tusdc", symbol: TEST_COLLATERAL.symbol, caption: "Relative test collateral", icon: "/tokens/usdc.svg", test: true },
  { id: "usdc", symbol: "USDC", caption: "Circle devnet collateral", icon: "/tokens/usdc.svg" },
  { id: "sol", symbol: "SOL", caption: "Network fees", icon: "/tokens/sol.svg" },
];

const label = "mb-2 block text-sm font-medium";
const box = "flex h-12 w-full items-center gap-3 rounded-control border border-line bg-bg px-3 text-sm";
const primary = "flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-pill bg-accent px-4 text-sm font-medium text-accent-ink transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

function TokenIcon({ token, size }: { token: Token; size: number }) {
  return (
    <span className="relative inline-grid shrink-0" style={{ width: size, height: size }}>
      <img src={token.icon} alt="" className={`h-full w-full rounded-full ${token.test ? "grayscale" : ""}`} />
      {token.test && (
        <span className="absolute -bottom-1 -right-2 rounded-pill bg-accent px-1.5 py-0.5 text-[10px] font-semibold leading-none text-accent-ink">TEST</span>
      )}
    </span>
  );
}

function clock(seconds: number): string {
  return `${new Date(seconds * 1000).toUTCString().slice(17, 22)} UTC`;
}

export function FaucetPanel() {
  const { address } = useSigner();
  const [mounted, setMounted] = useState(false);
  const [picked, setPicked] = useState<TokenId>("tusdc");
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

  const copy = async () => {
    if (!owner) return false;
    try {
      await navigator.clipboard.writeText(owner);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      return true;
    } catch {
      setCopied(false);
      return false;
    }
  };

  const claim = async () => {
    if (!owner || claiming) return;
    setClaiming(true);
    const result = await claimTestTokens(owner);
    setClaiming(false);
    if (!result.ok) return fail(result.message, `${TEST_COLLATERAL.symbol} not sent`);
    notify({ tone: "good", title: `${FAUCET_GRANT} ${TEST_COLLATERAL.symbol} sent`, link: { href: `https://explorer.solana.com/tx/${result.value.signature}?cluster=devnet`, label: "View on explorer", external: true } });
    void refresh();
  };

  const outside = picked === "sol" ? SOL_FAUCET_URL : picked === "usdc" ? CIRCLE_FAUCET_URL : null;
  const note =
    picked === "tusdc"
      ? owner && claims !== null
        ? spent
          ? `No claims left today. Next claim after ${claims.nextAt === null ? "24 hours" : clock(claims.nextAt)}.`
          : `Sends ${FAUCET_GRANT} ${TEST_COLLATERAL.symbol} to your wallet. ${claims.left} of ${FAUCET_CLAIMS_PER_DAY} claims left today.`
        : `Sends ${FAUCET_GRANT} ${TEST_COLLATERAL.symbol} to your wallet. ${FAUCET_CLAIMS_PER_DAY} claims a day.`
      : picked === "usdc"
        ? "Opens Circle's faucet with your address copied. Choose USDC and Solana Devnet, then paste it."
        : "Opens Solana's faucet with your address copied. Paste it there. Every trade costs a tiny fee in SOL.";

  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-xl text-base text-muted">
        Get test collateral and devnet SOL to try Relative for free. {TEST_COLLATERAL.symbol} and USDC both work as collateral; you also need a little SOL for network fees.
      </p>

      <div role="radiogroup" aria-label="Token" className="grid grid-cols-3 gap-3">
        {TOKENS.map((token) => {
          const on = picked === token.id;
          return (
            <button
              key={token.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setPicked(token.id)}
              className={`flex cursor-pointer flex-col items-center gap-3 rounded-card border bg-surface px-2 py-5 text-center transition-colors duration-150 sm:py-7 ${on ? "border-accent ring-1 ring-accent" : "border-line hover:bg-surface-2"}`}
            >
              <TokenIcon token={token} size={48} />
              <span className="text-base font-semibold">{token.symbol}</span>
              <span className="hidden text-xs text-muted sm:block">{token.caption}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-5">
        <div>
          <span className={label}>Network</span>
          <div className={box}>
            <img src="/tokens/sol.svg" alt="" className="h-5 w-5 rounded-full" />
            Solana Devnet
          </div>
        </div>

        <div>
          <span className={label}>Wallet address</span>
          {owner ? (
            <div className={box}>
              <code className="num min-w-0 flex-1 truncate text-sm">{owner}</code>
              <button type="button" onClick={() => void copy()} aria-label="Copy your wallet address" className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-pill px-2 text-xs text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink">
                {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : (
            <div className={`${box} text-muted`}>Connect a wallet to fill this in</div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {!owner ? (
            <button type="button" onClick={openLogin} className={primary}>Connect wallet</button>
          ) : outside ? (
            <a href={outside} target="_blank" rel="noreferrer" onClick={() => void copy()} className={primary}>
              {picked === "sol" ? "Open the Solana faucet" : "Open the Circle faucet"} <ExternalLink size={14} aria-hidden="true" />
            </a>
          ) : (
            <button type="button" onClick={() => void claim()} disabled={claiming || spent} className={primary}>
              {claiming ? "Sending" : `Send ${FAUCET_GRANT} ${TEST_COLLATERAL.symbol}`}
            </button>
          )}
          <p className="num text-center text-xs text-muted">{note}</p>
        </div>
      </div>
    </div>
  );
}
