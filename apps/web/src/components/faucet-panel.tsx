"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type FaucetStatus, faucetStatus } from "@/app/faucet-actions";
import { CIRCLE_FAUCET_URL, MIN_GAS_SOL, SOL_FAUCET_URL, TEST_COLLATERAL } from "@/lib/config";
import { openLogin, useSigner } from "./signer";

type TokenId = "sol" | "tusdc" | "usdc";

interface Token {
  id: TokenId;
  symbol: string;
  caption: string;
  icon: string;
  test?: boolean;
}

const TOKENS: Token[] = [
  { id: "usdc", symbol: "USDC", caption: "Circle devnet collateral", icon: "/tokens/usdc.svg" },
  { id: "sol", symbol: "SOL", caption: "Network fees", icon: "/tokens/sol.svg" },
  { id: "tusdc", symbol: TEST_COLLATERAL.symbol, caption: "Relative test token · soon", icon: "/tokens/usdc.svg", test: true },
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

export function FaucetPanel() {
  const { address } = useSigner();
  const [mounted, setMounted] = useState(false);
  const [picked, setPicked] = useState<TokenId>("usdc");
  const [status, setStatus] = useState<FaucetStatus | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const steered = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);
  const owner = mounted ? address : null;

  useEffect(() => setMounted(true), []);

  const refresh = useCallback(async () => {
    if (!owner) {
      setStatus(null);
      setChecked(null);
      return;
    }
    const result = await faucetStatus(owner);
    setStatus(result.ok ? result.value : null);
    setChecked(owner);
  }, [owner]);

  useEffect(() => {
    setStatus(null);
    void refresh();
    const again = () => void refresh();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [refresh]);

  const checking = owner !== null && checked !== owner;
  const hasGas = status !== null && status.sol >= MIN_GAS_SOL;
  const needsGas = owner !== null && !checking && !hasGas;
  const locked = picked === "usdc" && owner !== null && !hasGas;

  useEffect(() => {
    if (!needsGas || !owner || steered.current === owner) return;
    steered.current = owner;
    setPicked("sol");
  }, [needsGas, owner]);

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

  const outside = picked === "sol" ? SOL_FAUCET_URL : picked === "usdc" ? CIRCLE_FAUCET_URL : null;
  const note = locked
    ? checking
      ? "Checking your SOL balance."
      : status === null
        ? "Your SOL balance could not be checked. Please try again shortly."
        : `Get at least ${MIN_GAS_SOL} devnet SOL for network fees first. Pick SOL above.`
    : picked === "sol" && needsGas && status !== null
      ? `You have ${status.sol.toFixed(4)} SOL. Get at least ${MIN_GAS_SOL} SOL, then come back for collateral.`
      : picked === "tusdc"
        ? `Free ${TEST_COLLATERAL.symbol} claims open once the faucet service is ready. Until then, get devnet USDC from Circle.`
      : picked === "usdc"
        ? "Opens Circle's faucet with your address copied. Choose USDC and Solana Devnet, then paste it."
        : "Opens Solana's faucet with your address copied. Paste it there. Every trade costs a tiny fee in SOL.";

  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-xl text-base text-muted">
        Get devnet USDC, plus a little devnet SOL for network fees, to try Relative for free. Relative's own test token, {TEST_COLLATERAL.symbol}, will be claimable here soon.
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
              {needsGas && token.id === "sol" && <span className="rounded-pill bg-accent px-2 py-0.5 text-[10px] font-semibold text-accent-ink">START HERE</span>}
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
          {picked === "tusdc" ? (
            <button type="button" disabled className={primary}>{TEST_COLLATERAL.symbol} claims not open yet</button>
          ) : !owner ? (
            <button type="button" onClick={openLogin} className={primary}>Connect wallet</button>
          ) : locked ? (
            <button type="button" disabled className={primary}>{checking ? "Checking" : "Get SOL first"}</button>
          ) : (
            outside && (
              <a href={outside} target="_blank" rel="noreferrer" onClick={() => void copy()} className={primary}>
                {picked === "sol" ? "Open the Solana faucet" : "Open the Circle faucet"} <ExternalLink size={14} aria-hidden="true" />
              </a>
            )
          )}
          <p className="num text-center text-xs text-muted">{note}</p>
        </div>
      </div>
    </div>
  );
}
