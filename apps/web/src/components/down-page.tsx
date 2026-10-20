"use client";

import { stencilPath } from "@/landing/stencil-glyphs";

const wordmark = stencilPath("RELATIVE", 1, 0.34);

export function DownPage({ fill = "screen" }: { fill?: "screen" | "area" }) {
  return (
    <div className={`flex flex-col items-center justify-center bg-bg px-5 text-center font-sans text-ink ${fill === "screen" ? "min-h-screen" : "min-h-[60vh]"}`}>
      <svg aria-label="Relative" role="img" viewBox={`-0.5 -0.5 ${wordmark.width + 1} 7`} className="h-5 w-auto overflow-visible">
        <path d={wordmark.path} fill="none" stroke="currentColor" strokeWidth={1} />
      </svg>
      <span className="mt-10 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Temporarily down</span>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">We'll be back in a few minutes</h1>
      <p className="mt-3 max-w-sm text-sm leading-6 text-muted">Your positions and requests are safe on chain.</p>
      <button type="button" onClick={() => window.location.reload()} className="mt-8 h-10 cursor-pointer rounded-control bg-accent px-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-ink transition-opacity duration-150 hover:opacity-90">
        Try again
      </button>
    </div>
  );
}
