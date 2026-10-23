"use client";

import type { CoxStatus, FeeTerms, Portfolio, WalletPortfolioEvent } from "@eox/app-api";
import { useRouter } from "next/navigation";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { walletPortfolio } from "@/app/actions";
import { type Market, NO_MARKET } from "@/lib/market";
import { useSigner } from "./signer";

const PORTFOLIO_MS = 15000;
const PAGE_MS = 30000;
const SETTLE_MS = 400;

interface Account {
  live: boolean;
  owner: string | null;
  portfolio: Portfolio | null;
  loading: boolean;
  fee: FeeTerms | null;
  apiUrl: string;
  sequence: number | null;
  market: Market;
  refresh: () => Promise<void>;
}

const AccountContext = createContext<Account>({ live: false, owner: null, portfolio: null, loading: false, fee: null, apiUrl: "", sequence: null, market: NO_MARKET, refresh: async () => undefined });

function parse<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

export function AccountProvider({
  live,
  demo,
  apiUrl,
  sequence,
  fee,
  market,
  children,
}: {
  live: boolean;
  demo: Portfolio | null;
  apiUrl: string;
  sequence: number | null;
  fee: FeeTerms | null;
  market: Market;
  children: ReactNode;
}) {
  const { address } = useSigner();
  const router = useRouter();
  const owner = address;
  const current = useRef<string | null>(null);
  const start = useRef(sequence);
  const [own, setOwn] = useState<{ owner: string; portfolio: Portfolio | null } | null>(null);
  const [streaming, setStreaming] = useState(false);
  const watched = live ? owner : null;

  const refresh = useCallback(async () => {
    if (!live || !owner) return;
    const result = await walletPortfolio(owner);
    if (result.ok && current.current === owner) setOwn({ owner, portfolio: result.value });
  }, [live, owner]);

  useEffect(() => {
    current.current = owner;
    if (live && owner) void refresh();
  }, [live, owner, refresh]);

  useEffect(() => {
    const query = new URLSearchParams();
    if (start.current !== null) query.set("after", String(start.current));
    if (watched) query.set("wallet", watched);
    const text = query.toString();
    const stream = new EventSource(`${apiUrl}/v1/stream${text ? `?${text}` : ""}`);
    let timer = 0;
    let known: string | null = null;

    const reload = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => router.refresh(), SETTLE_MS);
    };

    stream.addEventListener("open", () => setStreaming(true));
    stream.addEventListener("error", () => setStreaming(false));
    stream.addEventListener("publication", (event) => {
      const data = parse<{ sequence: number }>(event);
      if (data) start.current = data.sequence;
      reload();
    });
    stream.addEventListener("status", (event) => {
      const status = parse<CoxStatus>(event);
      if (!status) return;
      const { asOf: _asOf, ageSeconds: _age, ...rest } = status;
      const next = JSON.stringify(rest);
      if (known !== null && known !== next) reload();
      known = next;
    });
    stream.addEventListener("portfolio", (event) => {
      const data = parse<WalletPortfolioEvent>(event);
      if (data && data.owner === current.current) setOwn({ owner: data.owner, portfolio: data.portfolio });
    });

    return () => {
      window.clearTimeout(timer);
      stream.close();
      setStreaming(false);
    };
  }, [apiUrl, watched, router]);

  useEffect(() => {
    if (streaming) return;
    const page = window.setInterval(() => router.refresh(), PAGE_MS);
    const wallet = window.setInterval(() => void refresh(), PORTFOLIO_MS);
    return () => {
      window.clearInterval(page);
      window.clearInterval(wallet);
    };
  }, [streaming, router, refresh]);

  const value = useMemo<Account>(() => {
    if (!live) return { live, owner, portfolio: demo, loading: false, fee, apiUrl, sequence, market, refresh };
    const loaded = own !== null && own.owner === owner;
    return { live, owner, portfolio: loaded ? own.portfolio : null, loading: owner !== null && !loaded, fee, apiUrl, sequence, market, refresh };
  }, [live, owner, demo, own, fee, apiUrl, sequence, market, refresh]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): Account {
  return useContext(AccountContext);
}
