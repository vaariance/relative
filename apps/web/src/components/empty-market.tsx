import type { ReactNode } from "react";

const ROWS = [36, 58, 80, 102, 124];
const CX = 178;
const CY = 80;

function MarketIllustration({ pending }: { pending: boolean }) {
  return (
    <svg viewBox="0 0 260 160" className="h-auto w-[220px] max-w-full" aria-hidden="true">
      <rect x="20" y="14" width="220" height="132" rx="16" className="fill-white/[0.02] stroke-white/[0.07]" />
      {ROWS.map((y, index) => (
        <g key={y} opacity={1 - index * 0.17}>
          <circle cx="42" cy={y} r="7" className="fill-white/[0.03] stroke-white/15" />
          <rect x="56" y={y - 3} width="36" height="6" rx="3" className="fill-white/[0.08]" />
          <rect x="98" y={y - 3} width="16" height="6" rx="3" strokeDasharray="2 2" className="fill-none stroke-white/15" />
        </g>
      ))}
      <line x1="128" y1={CY} x2="228" y2={CY} strokeDasharray="3 4" className="stroke-white/15" />
      <g className={pending ? "motion-safe:animate-pulse" : undefined}>
        <circle cx={CX} cy={CY} r="40" className="fill-none stroke-accent/10" />
        <circle cx={CX} cy={CY} r="30" className="fill-none stroke-accent/25" />
      </g>
      <circle cx={CX} cy={CY} r="20" strokeWidth="1.5" className="fill-surface stroke-accent/60" />
      <line x1={CX - 9} y1={CY} x2={CX + 9} y2={CY} strokeWidth="2" strokeLinecap="round" className="stroke-accent" />
      <circle cx={CX - 9} cy={CY} r="2" className="fill-accent" />
      <circle cx={CX + 9} cy={CY} r="2" className="fill-accent" />
    </svg>
  );
}

export function EmptyMarket({ title, children, pending = false }: { title: string; children?: ReactNode; pending?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 pb-10 pt-2 text-center">
      <MarketIllustration pending={pending} />
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <p className="max-w-sm text-xs text-muted">{children}</p>}
    </div>
  );
}
