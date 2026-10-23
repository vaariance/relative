import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Point } from "@/lib/view";
import { ChangePill } from "./change";
import { Sparkline } from "./sparkline";

export function Figure({ text, unit }: { text: string; unit?: string }) {
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const rest = dot === -1 ? "" : text.slice(dot);
  return (
    <span className="num">
      {whole}
      {rest && <span className="text-muted">{rest}</span>}
      {unit && <span className="ml-1.5 text-xs text-muted">{unit}</span>}
    </span>
  );
}

export function CardTitle({ icon: Icon, children, aside }: { icon: LucideIcon; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm font-medium">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ink text-bg">
        <Icon size={13} aria-hidden="true" />
      </span>
      <span>{children}</span>
      {aside && <span className="ml-auto text-xs font-normal text-muted">{aside}</span>}
    </div>
  );
}

export function StatCard({
  icon,
  title,
  aside,
  value,
  change,
  badge,
  caption,
  spark,
  chart,
  children,
}: {
  icon: LucideIcon;
  title: string;
  aside?: ReactNode;
  value: ReactNode;
  change?: number | null;
  badge?: ReactNode;
  caption?: ReactNode;
  spark?: { points: Point[]; tone: "up" | "down" | "flat" } | null;
  chart?: ReactNode;
  children?: ReactNode;
}) {
  const showSpark = spark && spark.points.length > 1;
  return (
    <div className="flex flex-col rounded-card border border-line bg-surface p-4 shadow-card">
      <CardTitle icon={icon} aside={aside}>{title}</CardTitle>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="shrink-0">
          <div className="flex items-center gap-2 text-3xl font-medium tracking-tight">{value}</div>
          {(change !== undefined && change !== null) || badge || caption ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              {badge ?? (change !== undefined && change !== null && <ChangePill ratio={change} />)}
              {caption && <span>{caption}</span>}
            </div>
          ) : null}
        </div>
        {(chart || showSpark) && (
          <div className="flex min-w-0 flex-1 justify-end">
            {chart ?? (showSpark && <Sparkline points={spark.points} tone={spark.tone} width={132} height={48} area fluid />)}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
