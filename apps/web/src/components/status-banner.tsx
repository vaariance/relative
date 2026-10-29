import type { CoxOrigin, CoxStatus, SystemState } from "@eox/app-api";
import { CircleAlert, CircleCheck, CirclePause } from "lucide-react";
import { closedNote } from "@/lib/market";

const states: Record<SystemState, { label: string; bar: string; Icon: typeof CircleCheck }> = {
  fresh: { label: "Notice", bar: "bg-accent text-accent-ink", Icon: CircleCheck },
  delayed: { label: "Delayed", bar: "bg-[#8338EC] text-white", Icon: CircleAlert },
  incident: { label: "Incident", bar: "bg-[#8338EC] text-white", Icon: CircleAlert },
  halted: { label: "Halted", bar: "bg-down text-bg", Icon: CirclePause },
  paused: { label: "Paused", bar: "bg-down text-bg", Icon: CirclePause },
};

const verdicts = { match: "matches", mismatch: "mismatch", pending: "checking" };

export function StatusBanner({ status, origin }: { status: CoxStatus; origin: CoxOrigin }) {
  const mismatch = status.monitor?.verdict === "mismatch";
  const trading = status.trading ?? null;
  const closed = closedNote(trading, status.asOf);

  if (status.state === "fresh" && !mismatch && !closed && origin !== "fixture") return null;

  const state = states[mismatch && status.state === "fresh" ? "incident" : status.state];
  const extras = [
    status.latestSequence === null ? "Prices have not started yet." : null,
    status.executing ? "Orders are being filled." : null,
    status.monitor ? `Monitor: ${verdicts[status.monitor.verdict]}.` : null,
    origin === "fixture" ? "Fixture data: synthetic assets, not market prices." : null,
  ].filter(Boolean);

  const text = [closed, ...extras].filter(Boolean).join(" ") || state.label;

  return (
    <div role="status" className={state.bar}>
      <p className="flex w-full items-center justify-center gap-2 px-4 py-3 text-[13px] font-semibold leading-snug sm:px-6">
        <state.Icon size={18} strokeWidth={2.5} className="shrink-0" aria-label={state.label} />
        <span>{text}</span>
      </p>
    </div>
  );
}
