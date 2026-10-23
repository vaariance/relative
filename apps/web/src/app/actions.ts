"use server";

import { CoxApiError, type Portfolio, type Submission, type UnsignedTransaction } from "@eox/app-api";
import { api } from "@/lib/data";
import type { Intent, Outcome } from "@/lib/requests";

async function attempt<T>(call: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (error instanceof CoxApiError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "UNAVAILABLE", message: "The Relative API could not be reached." };
  }
}

export async function walletPortfolio(owner: string): Promise<Outcome<Portfolio | null>> {
  return attempt(async () => {
    try {
      return (await api.portfolio(owner)).data;
    } catch (error) {
      if (error instanceof CoxApiError && error.code === "UNKNOWN_WALLET") return null;
      throw error;
    }
  });
}

async function feeVersion(): Promise<string | undefined> {
  return (await api.status()).data.fees?.active.version;
}

export async function buildTransaction(owner: string, intent: Intent): Promise<Outcome<UnsignedTransaction>> {
  return attempt(async () => {
    switch (intent.operation) {
      case "deposit": {
        const expectedFeeVersion = await feeVersion();
        return (await api.buildDeposit({ owner, toClass: intent.toClass, amount: intent.amount, minimumUnits: intent.minimumUnits, expiryBatch: intent.expiryBatch, expectedFeeVersion })).data;
      }
      case "switch": {
        const expectedFeeVersion = await feeVersion();
        return (await api.buildSwitch({ owner, fromClass: intent.fromClass, toClass: intent.toClass, units: intent.units, minimumUnits: intent.minimumUnits, expiryBatch: intent.expiryBatch, expectedFeeVersion })).data;
      }
      case "redeem": {
        const expectedFeeVersion = await feeVersion();
        return (await api.buildRedeem({ owner, fromClass: intent.fromClass, units: intent.units, minimumProceeds: intent.minimumProceeds, expiryBatch: intent.expiryBatch, expectedFeeVersion })).data;
      }
      case "cancel":
        return (await api.buildCancel({ owner, requestId: intent.requestId })).data;
      case "refund":
        return (await api.buildRefund({ owner, requestId: intent.requestId })).data;
      case "withdraw":
        return (await api.buildWithdraw({ owner, amount: intent.amount })).data;
      default:
        throw new CoxApiError("INVALID_REQUEST", "unknown operation", 0);
    }
  });
}

export async function submitSigned(transaction: string): Promise<Outcome<Submission>> {
  return attempt(async () => (await api.submitTransaction(transaction)).data);
}

export async function submissionState(signature: string): Promise<Outcome<Submission>> {
  return attempt(async () => (await api.submission(signature)).data);
}
