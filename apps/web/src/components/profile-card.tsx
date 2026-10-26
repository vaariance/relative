"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { shortAddress } from "@/lib/address";
import { useSigner } from "./signer";

const AVATAR_STYLE = "https://api.dicebear.com/9.x/glass/svg";

async function seedOf(address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function useAvatar(address: string | null): string | null {
  const [held, setHeld] = useState<{ address: string; url: string } | null>(null);
  useEffect(() => {
    if (!address) return;
    let current = true;
    void seedOf(address).then((seed) => current && setHeld({ address, url: `${AVATAR_STYLE}?seed=${seed}` }));
    return () => {
      current = false;
    };
  }, [address]);
  return address && held?.address === address ? held.url : null;
}

function CopyAddress({ address, label }: { address: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <li className="flex items-center gap-2 rounded-pill bg-bg/60 py-1 pl-3 pr-1 text-xs">
      <span className="text-muted">{label}</span>
      <span className="num" title={address}>
        {shortAddress(address)}
      </span>
      <button type="button" onClick={copy} aria-label={`Copy ${label} address`} className="grid size-6 cursor-pointer place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink">
        {copied ? <Check size={12} aria-hidden="true" className="text-up" /> : <Copy size={12} aria-hidden="true" />}
      </button>
    </li>
  );
}

export function ProfileCard() {
  const { address, profile } = useSigner();
  const avatar = useAvatar(address);
  if (!address || !profile) return null;
  const title = profile.name ?? shortAddress(address);

  return (
    <section className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4 shadow-card sm:flex-row sm:items-center">
      <span className="size-14 shrink-0 overflow-hidden rounded-full bg-surface-2">{avatar && <img src={avatar} alt="" width={56} height={56} className="size-14" />}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-lg font-semibold">{title}</span>
        {profile.email && <span className="truncate text-sm text-muted">{profile.email}</span>}
      </div>
      <ul className="flex flex-wrap gap-2">
        {profile.wallets.map((wallet) => (
          <CopyAddress key={wallet.address} address={wallet.address} label={wallet.label} />
        ))}
      </ul>
    </section>
  );
}
