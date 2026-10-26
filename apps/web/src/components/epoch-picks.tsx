"use client";

import type { Epoch } from "@eox/app-api";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { startingTeam, toggleMate, withToken } from "@/lib/epoch";

const STORE = "relative_epoch_picks";

interface Picks {
  opensAt: number | null;
  backed: string | null;
  mates: string[] | null;
}

const EMPTY: Picks = { opensAt: null, backed: null, mates: null };

interface Store {
  picks: Picks;
  ready: boolean;
  setPicks: (next: Picks) => void;
}

const PicksContext = createContext<Store | null>(null);

function readStored(): Picks {
  try {
    const raw = window.sessionStorage.getItem(STORE);
    const value = raw ? (JSON.parse(raw) as Partial<Picks>) : null;
    if (!value || typeof value.opensAt !== "number") return EMPTY;
    return { opensAt: value.opensAt, backed: typeof value.backed === "string" ? value.backed : null, mates: Array.isArray(value.mates) ? value.mates.filter((id): id is string => typeof id === "string") : null };
  } catch {
    return EMPTY;
  }
}

export function EpochPicksProvider({ children }: { children: ReactNode }) {
  const [picks, setState] = useState<Picks>(EMPTY);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setState(readStored());
    setReady(true);
  }, []);
  const setPicks = useCallback((next: Picks) => {
    setState(next);
    try {
      window.sessionStorage.setItem(STORE, JSON.stringify(next));
    } catch {}
  }, []);
  const value = useMemo(() => ({ picks, ready, setPicks }), [picks, ready, setPicks]);
  return <PicksContext.Provider value={value}>{children}</PicksContext.Provider>;
}

export interface EpochPicks {
  ready: boolean;
  backed: string | null;
  mates: string[];
  setPerformer: (id: string | null) => void;
  toggleBasket: (id: string) => void;
  clear: () => void;
}

export function useEpochPicks(epoch: Epoch | null, coins: string[]): EpochPicks {
  const store = useContext(PicksContext);
  if (!store) throw new Error("useEpochPicks needs EpochPicksProvider");
  const { picks, ready, setPicks } = store;
  const opensAt = epoch?.opensAt ?? null;
  const own = picks.opensAt === opensAt ? picks : { ...EMPTY, opensAt };
  const backed = own.backed && coins.includes(own.backed) ? own.backed : null;
  const mates = (own.mates ?? (backed ? startingTeam(coins, backed) : [])).filter((id) => coins.includes(id) && id !== backed);
  return {
    ready,
    backed,
    mates,
    setPerformer: (id) => {
      if (id !== null && id === backed) return;
      setPicks({ opensAt, ...withToken(coins, backed, own.mates, id) });
    },
    toggleBasket: (id) => {
      if (backed) setPicks({ opensAt, backed, mates: toggleMate(coins, backed, mates, id) });
    },
    clear: () => setPicks({ ...EMPTY, opensAt }),
  };
}
