import type { ReactNode } from "react";

export function Shimmer({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`shimmer rounded-control ${className}`} />;
}

export function ShimmerCard({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`flex flex-col gap-3 rounded-card border border-line bg-surface p-4 shadow-card ${className}`}>{children}</div>;
}
