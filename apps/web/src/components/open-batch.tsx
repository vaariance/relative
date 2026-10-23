"use client";

import type { Batch } from "@eox/app-api";
import { useEffect, useState } from "react";
import { openBatch } from "@/lib/requests";
import { useAccount } from "./account";

export function useOpenBatch(known: Batch | null): { batch: Batch | null; seconds: number | null } {
  const { market } = useAccount();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!known || now === null) return { batch: known, seconds: null };
  const batch = openBatch(known, now, market.interval);
  return { batch, seconds: batch.cutoff - now };
}
