"use client";

import type { CoxRequest, CoxStatus, RequestState } from "@eox/app-api";
import { CircleCheck, CircleX, Clock, Undo2 } from "lucide-react";
import { COLLATERAL } from "@/lib/config";
import { formatAmount } from "@/lib/format";
import { CRYPTO_CLASS, nameOf, toNumber, unitDigits } from "@/lib/view";
import { useAccount } from "./account";
import { SendButton } from "./send-button";
import { openLogin } from "./signer";

const states: Record<RequestState, { label: string; tone: string; Icon: typeof Clock; note: string | null }> = {
  queued: { label: "Queued", tone: "text-warn", Icon: Clock, note: null },
  filled: { label: "Filled", tone: "text-up", Icon: CircleCheck, note: null },
  "condition-failed": { label: "Rejected", tone: "text-down", Icon: CircleX, note: "The result was below your minimum, so nothing moved." },
  expired: { label: "Expired", tone: "text-down", Icon: CircleX, note: "It was not filled in time, so nothing moved." },
  "zero-value-class": { label: "Rejected", tone: "text-down", Icon: CircleX, note: "That class has units but no value, so it cannot take new money." },
  "safety-rejected": { label: "Rejected", tone: "text-down", Icon: CircleX, note: "The pool could not take this request safely, so nothing moved." },
  cancelled: { label: "Cancelled", tone: "text-muted", Icon: CircleX, note: null },
  refunded: { label: "Refunded", tone: "text-muted", Icon: Undo2, note: null },
};

function operationLabel(request: CoxRequest): string {
  if (request.operation === "deposit") return request.toClass === CRYPTO_CLASS ? "Swap in" : "Buy";
  if (request.operation === "redeem") return request.fromClass === CRYPTO_CLASS ? "Swap out" : "Sell";
  if (request.fromClass === CRYPTO_CLASS) return "Buy";
  if (request.toClass === CRYPTO_CLASS) return "Sell";
  return "Switch";
}

function unitsOf(classId: string): string {
  return classId === CRYPTO_CLASS ? nameOf(classId) : `${classId} units`;
}

function subject(request: CoxRequest): string {
  if (request.fromClass && request.toClass) return `${nameOf(request.fromClass)} → ${nameOf(request.toClass)}`;
  return nameOf(request.toClass ?? request.fromClass ?? "");
}

function size(request: CoxRequest, decimals: number): string {
  if (request.amount !== null) return `${formatAmount(toNumber(request.amount, decimals))} ${COLLATERAL.symbol}`;
  return `${formatAmount(toNumber(request.units ?? "0", unitDigits(decimals)))} ${unitsOf(request.fromClass ?? "")}`;
}

function minimum(request: CoxRequest, decimals: number): string {
  if (request.minimumProceeds !== null && BigInt(request.minimumProceeds) > 0n) return `Min ${formatAmount(toNumber(request.minimumProceeds, decimals))} ${COLLATERAL.symbol}`;
  if (request.minimumUnits !== null && BigInt(request.minimumUnits) > 0n) return `Min ${formatAmount(toNumber(request.minimumUnits, unitDigits(decimals)))} ${unitsOf(request.toClass ?? "")}`;
  return "No minimum";
}

function detail(request: CoxRequest, decimals: number): string {
  const state = states[request.state];
  if (request.state === "queued") return `Fills at the next price update · ${minimum(request, decimals)}`;
  if (request.state === "filled" && request.receipt) {
    if (request.operation === "redeem") return `Got ${formatAmount(toNumber(request.receipt.proceeds, decimals))} ${COLLATERAL.symbol}`;
    return `Got ${formatAmount(toNumber(request.receipt.minted, unitDigits(decimals)))} ${unitsOf(request.toClass ?? "")}`;
  }
  return state.note ?? "";
}

const action = "h-9 rounded-pill border border-line px-3 text-xs";
const REFUNDABLE: RequestState[] = ["condition-failed", "expired", "zero-value-class", "safety-rejected", "cancelled"];

export function RequestList({ classId = null, status, decimals }: { classId?: string | null; status: CoxStatus; decimals: number }) {
  const { portfolio, owner, live, loading } = useAccount();
  const all = portfolio?.requests ?? [];
  const requests = classId === null ? all : all.filter((request) => request.fromClass === classId || request.toClass === classId);
  const empty = loading ? (
    "Loading your requests."
  ) : live && !owner ? (
    <>
      <button type="button" onClick={openLogin} className="cursor-pointer font-medium text-accent underline underline-offset-4 hover:opacity-80">Login</button> to Relative to see your requests.
    </>
  ) : (
    "No requests yet."
  );
  return (
    <section className="rounded-card border border-line bg-surface shadow-card">
      <h2 className="border-b border-line px-4 py-3 text-sm font-medium">Your requests</h2>
      {requests.length === 0 && <p className="px-4 py-6 text-sm text-muted">{empty}</p>}
      <ul>
        {requests.map((request) => {
          const state = states[request.state];
          return (
            <li key={request.requestId} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-b-0">
              <span className={`flex w-24 items-center gap-1.5 ${state.tone}`}>
                <state.Icon size={14} aria-hidden="true" />
                {state.label}
              </span>
              <span className="w-40">
                {operationLabel(request)} <span className="text-muted">{subject(request)}</span>
              </span>
              <span className="num w-36">{size(request, decimals)}</span>
              <span className="min-w-64 flex-1 text-xs text-muted">{detail(request, decimals)}</span>
              {request.state === "queued" && (
                <span className="flex flex-col items-end gap-1">
                  <SendButton intent={{ operation: "cancel", requestId: request.requestId }} label="Cancel" connectLabel="Cancel" className={action} quiet />
                </span>
              )}
              {request.operation === "deposit" && REFUNDABLE.includes(request.state) && (
                <span className="flex flex-col items-end gap-1">
                  <SendButton intent={{ operation: "refund", requestId: request.requestId }} label="Refund" connectLabel="Refund" className={action} quiet />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
