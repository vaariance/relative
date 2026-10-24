"use client";

import type { FaucetChallenge, FaucetClaim, FaucetStatus as ClaimStatus } from "@eox/app-api";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type FaucetStatus, faucetStatus } from "@/app/faucet-actions";
import { CIRCLE_FAUCET_URL, MIN_GAS_SOL, SOL_FAUCET_URL, TEST_COLLATERAL } from "@/lib/config";
import { humanError, walletError } from "@/lib/errors";
import { formatAmount } from "@/lib/format";
import { useAccount } from "./account";
import { openLogin, useSigner } from "./signer";
import { useSnackbar } from "./snackbar";

type TokenId = "sol" | "rlusd" | "usdc";

interface Token {
  id: TokenId;
  symbol: string;
  caption: string;
  icon: string;
  test?: boolean;
}

const TOKENS: Token[] = [
  { id: "rlusd", symbol: TEST_COLLATERAL.symbol, caption: "Free claim, once a day", icon: "/tokens/usdc.svg", test: true },
  { id: "usdc", symbol: "USDC", caption: "Circle devnet USDC", icon: "/tokens/usdc.svg" },
  { id: "sol", symbol: "SOL", caption: "Network fees", icon: "/tokens/sol.svg" },
];

const PENDING = new Set(["reserved", "signed", "submitted"]);
const label = "mb-2 block text-sm font-medium";
const box = "flex h-12 w-full items-center gap-3 rounded-control border border-line bg-bg px-3 text-sm";
const primary = "flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-pill bg-accent px-4 text-sm font-medium text-accent-ink transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

function TokenIcon({ token, size }: { token: Token; size: number }) {
  return (
    <span className="relative inline-grid shrink-0" style={{ width: size, height: size }}>
      <img src={token.icon} alt="" className={`h-full w-full rounded-full ${token.test ? "hue-rotate-[150deg] saturate-150" : ""}`} />
      {token.test && <span className="absolute -bottom-1 -right-2 rounded-pill bg-accent px-1.5 py-0.5 text-[10px] font-semibold leading-none text-accent-ink">TEST</span>}
    </span>
  );
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function wait(seconds: number): string {
  const left = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${left}s`;
}

async function call<T>(url: string, init?: RequestInit): Promise<{ data: T | null; code: string; message: string }> {
  try {
    const response = await fetch(url, init);
    const payload = (await response.json().catch(() => null)) as { data?: T; error?: { code?: string; message?: string } } | null;
    if (response.ok && payload?.data) return { data: payload.data, code: "", message: "" };
    return { data: null, code: payload?.error?.code ?? "UNAVAILABLE", message: payload?.error?.message ?? "" };
  } catch {
    return { data: null, code: "UNAVAILABLE", message: "" };
  }
}

function useClaimStatus(owner: string | null) {
  const { apiUrl, live } = useAccount();
  const [status, setStatus] = useState<ClaimStatus | null>(null);
  const refresh = useCallback(async () => {
    if (!owner || !live) return setStatus(null);
    const result = await call<ClaimStatus>(`${apiUrl}/v1/faucet/status?owner=${owner}`);
    setStatus(result.data);
  }, [apiUrl, live, owner]);
  return { status, setStatus, refresh };
}

export function FaucetPanel() {
  const { address, signMessage } = useSigner();
  const { apiUrl } = useAccount();
  const { show, fail } = useSnackbar();
  const [mounted, setMounted] = useState(false);
  const [picked, setPicked] = useState<TokenId>("rlusd");
  const [gas, setGas] = useState<FaucetStatus | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [phase, setPhase] = useState<"idle" | "sign" | "send">("idle");
  const attempt = useRef(0);
  const claiming = phase !== "idle";
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const steered = useRef<string | null>(null);
  const owner = mounted ? address : null;
  const claims = useClaimStatus(owner);

  useEffect(() => setMounted(true), []);

  const refresh = useCallback(async () => {
    if (!owner) {
      setGas(null);
      setChecked(null);
      return;
    }
    const [result] = await Promise.all([faucetStatus(owner), claims.refresh()]);
    setGas(result.ok ? result.value : null);
    setChecked(owner);
  }, [owner, claims.refresh]);

  useEffect(() => {
    setGas(null);
    void refresh();
    const again = () => void refresh();
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [refresh]);

  const status = claims.status;
  const nextAt = status?.nextClaimAt ?? null;
  useEffect(() => {
    if (nextAt === null || nextAt <= Date.now() / 1000) return;
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [nextAt]);

  const checking = owner !== null && checked !== owner;
  const hasGas = gas !== null && gas.sol >= MIN_GAS_SOL;
  const needsGas = owner !== null && !checking && !hasGas;
  const locked = picked === "usdc" && owner !== null && !hasGas;
  const tokenAmount = status ? formatAmount(Number(status.token.amount) / 10 ** status.token.decimals, 0) : "100";
  const confirming = status?.claim ? PENDING.has(status.claim.state) : false;
  const cooling = nextAt !== null && nextAt > now;

  useEffect(() => {
    if (!needsGas || !owner || steered.current === owner || picked !== "usdc") return;
    steered.current = owner;
    setPicked("sol");
  }, [needsGas, owner, picked]);

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
    if (!owner || !signMessage || claiming) return;
    const mine = ++attempt.current;
    const current = () => attempt.current === mine;
    setPhase("sign");
    try {
      const challenge = await call<FaucetChallenge>(`${apiUrl}/v1/faucet/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }) });
      if (!challenge.data) return fail(humanError(challenge.code, challenge.message), "Claim not sent");
      const expires = Math.max(5_000, challenge.data.expiresAt * 1000 - Date.now());
      let signature: Uint8Array;
      try {
        signature = await Promise.race([
          signMessage(new TextEncoder().encode(challenge.data.message)),
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("timeout")), expires)),
        ]);
      } catch (error) {
        if (!current()) return;
        return fail(error instanceof Error && error.message === "timeout" ? "Your wallet did not sign in time. Nothing was sent. Please try again." : walletError(error), "Claim not sent");
      }
      if (!current()) return;
      setPhase("send");
      const result = await call<FaucetClaim>(`${apiUrl}/v1/faucet/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner, challengeId: challenge.data.challengeId, signature: base64(signature) }),
      });
      if (!result.data) return fail(humanError(result.code, result.message), "Claim not sent");
      const link = result.data.signature ? { href: `https://explorer.solana.com/tx/${result.data.signature}?cluster=devnet`, label: "View on explorer", external: true } : undefined;
      if (result.data.state === "confirmed") {
        const sol = BigInt(result.data.solLamports) > 0n ? " and a little devnet SOL for fees" : "";
        show({ tone: "good", title: `${tokenAmount} ${TEST_COLLATERAL.symbol} sent`, text: `Your wallet received ${tokenAmount} ${TEST_COLLATERAL.symbol}${sol}.`, link });
      } else if (result.data.state === "failed") {
        fail("The faucet could not send this time. Nothing moved, and you can try again.", "Claim failed");
      } else {
        show({ tone: "good", title: "Claim sent", text: "It is still confirming. Check back in a moment.", link });
      }
    } finally {
      if (current()) {
        setPhase("idle");
        void refresh();
      }
    }
  };

  const outside = picked === "sol" ? SOL_FAUCET_URL : picked === "usdc" ? CIRCLE_FAUCET_URL : null;
  const note =
    picked === "rlusd"
      ? !owner
        ? `Log in to claim ${tokenAmount} free ${TEST_COLLATERAL.symbol}. Use it like USDC to buy, swap and enter Epochs.`
        : status && !status.enabled
          ? "Test token claims are closed right now. Get devnet USDC from Circle instead."
          : phase === "sign"
            ? "Approve the signature request in your wallet. If its window is stuck, close it, unlock the wallet and press the button again."
            : cooling
            ? `You claimed in the last 24 hours. Your next claim opens in ${wait((nextAt ?? now) - now)}.`
            : confirming
              ? "Your last claim is still confirming. Check back in a moment."
              : `One free claim every 24 hours. You sign a message to prove the wallet is yours; nothing is charged. Wallets low on SOL also get 0.01 devnet SOL.`
      : picked === "sol" && needsGas && gas !== null
        ? `You have ${gas.sol.toFixed(4)} SOL. A first trade needs about ${MIN_GAS_SOL} SOL to open your position on chain.`
        : locked
        ? checking
          ? "Checking your SOL balance."
          : gas === null
            ? "Your SOL balance could not be checked. Please try again shortly."
            : `Get at least ${MIN_GAS_SOL} devnet SOL first: a first trade uses about that much to open your position on chain. Pick SOL above.`
        : picked === "usdc"
          ? "Opens Circle's faucet with your address copied. Choose USDC and Solana Devnet, then paste it."
          : "Opens Solana's faucet with your address copied. Paste it there. Every trade costs a tiny fee in SOL.";

  const claimButton = !owner ? (
    <button type="button" onClick={openLogin} className={primary}>Connect wallet</button>
  ) : status && !status.enabled ? (
    <button type="button" disabled className={primary}>Claims closed</button>
  ) : cooling ? (
    <button type="button" disabled className={primary}>Next claim in {wait((nextAt ?? now) - now)}</button>
  ) : confirming ? (
    <button type="button" onClick={() => void refresh()} className={primary}>Confirming · check again</button>
  ) : (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={() => void claim()} disabled={claiming || !signMessage} className={primary}>
        {phase === "sign" ? "Waiting for your wallet…" : phase === "send" ? `Sending your ${TEST_COLLATERAL.symbol}…` : `Get ${tokenAmount} ${TEST_COLLATERAL.symbol}`}
      </button>
      {phase === "sign" && (
        <button type="button" onClick={() => { attempt.current += 1; setPhase("idle"); }} className="mx-auto cursor-pointer text-xs text-muted underline-offset-4 hover:text-ink hover:underline">
          Cancel
        </button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-8">
      <p className="max-w-xl text-base text-muted">
        Claim free {TEST_COLLATERAL.symbol}, Relative&apos;s test dollar, or get devnet USDC from Circle. Both work as collateral to try Relative. Neither has real value.
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
              {needsGas && token.id === "sol" && picked === "usdc" && <span className="rounded-pill bg-accent px-2 py-0.5 text-[10px] font-semibold text-accent-ink">START HERE</span>}
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
          {picked === "rlusd" ? (
            claimButton
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
          {picked === "rlusd" && needsGas && gas !== null && (
            <p className="text-center text-xs text-warn">
              You have {gas.sol.toFixed(4)} SOL. A first trade needs about {MIN_GAS_SOL} SOL to open your position on chain.{" "}
              <button type="button" onClick={() => setPicked("sol")} className="cursor-pointer underline underline-offset-4">Get SOL</button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
