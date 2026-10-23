"use client";

import { TrendingDown, TrendingUp } from "lucide-react";
import type { Point } from "@/lib/view";
import { ChangePill } from "./change";
import { CoinIcon } from "./coin-icon";
import { LiveSparkline, useLive } from "./live";
import { StatCard } from "./stat-card";

export interface Contender {
  id: string;
  standing: number;
  points: Point[];
}

export function LeaderCards({ contenders }: { contenders: Contender[] }) {
  const { estimate, freshness } = useLive();
  const ranked = contenders
    .map((item) => {
      const reference = estimate?.references[item.id];
      return { ...item, standing: reference === undefined ? item.standing : reference / 100 - 1 };
    })
    .sort((left, right) => right.standing - left.standing);
  const best = ranked[0] ?? null;
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  const dim = freshness === "stale" ? "opacity-60" : undefined;

  const card = (title: string, icon: typeof TrendingUp, item: (typeof ranked)[number] | null) => (
    <StatCard
      icon={icon}
      title={title}
      value={item ? <><CoinIcon id={item.id} size={28} />{item.id}</> : "—"}
      badge={item ? <span className={dim}><ChangePill ratio={item.standing} /></span> : null}
      caption="vs $CRYPTO"
      chart={item ? <LiveSparkline kind="reference" id={item.id} card fallback={item.points} /> : null}
    />
  );

  return (
    <>
      {card("Leading", TrendingUp, best)}
      {card("Trailing", TrendingDown, worst)}
    </>
  );
}
