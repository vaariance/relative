import type { Batch } from "@eox/app-api";
import { parseScaled } from "./amounts";

const QUANTA_DIGITS = 12;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export type Operation = "deposit" | "switch" | "redeem";

export type Intent =
  | { operation: "deposit"; toClass: string; amount: string; minimumUnits: string; expiryBatch: number; collateralMint?: string }
  | { operation: "switch"; fromClass: string; toClass: string; units: string; minimumUnits: string; expiryBatch: number }
  | { operation: "redeem"; fromClass: string; units: string; minimumProceeds: string; expiryBatch: number }
  | { operation: "cancel"; requestId: string }
  | { operation: "refund"; requestId: string; collateralMint?: string }
  | { operation: "withdraw"; amount: string; collateralMint?: string }
  | { operation: "epoch-entry"; opensAt: number; grossStake: string; basket: string[]; backedAsset: string }
  | { operation: "epoch-withdraw"; opensAt: number; nonce: string };

export type Outcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

export interface PlanInput {
  operation: Operation;
  fromClass: string | null;
  toClass: string | null;
  amount: string;
  minimum: string;
  validForBatches: number;
  targetBatch: number | null;
  collateralDecimals: number;
  collateralMint?: string;
}

export type Planned = { intent: Intent; problem: null } | { intent: null; problem: string };

const refuse = (problem: string): Planned => ({ intent: null, problem });

function minimumOf(text: string, digits: number, max: bigint): bigint | null {
  if (text.trim() === "") return 0n;
  const value = parseScaled(text, digits);
  return value === null || value > max ? null : value;
}

export function openBatch(known: Batch, now: number, interval = 60): Batch {
  if (now < known.cutoff) return known;
  const step = Number.isSafeInteger(interval) && interval > 0 ? interval : 60;
  const ahead = Math.floor((now - known.cutoff) / step) + 1;
  return { batch: known.batch + ahead, cutoff: known.cutoff + ahead * step, acceptanceDeadline: known.acceptanceDeadline + ahead * step };
}

export function planRequest(input: PlanInput): Planned {
  const { operation, collateralDecimals, fromClass, toClass } = input;
  const unitDigits = QUANTA_DIGITS + collateralDecimals;
  if (input.targetBatch === null || !Number.isSafeInteger(input.targetBatch) || input.targetBatch < 0) return refuse("There is no open batch to join.");
  if (!Number.isSafeInteger(input.validForBatches) || input.validForBatches < 1) return refuse("Choose how many batches the request stays valid for.");
  const expiryBatch = input.targetBatch + input.validForBatches - 1;

  if (operation === "deposit") {
    if (toClass === null) return refuse("Choose a class to buy into.");
    const amount = parseScaled(input.amount, collateralDecimals);
    if (amount === null) return refuse(`Enter an amount with at most ${collateralDecimals} decimal places.`);
    if (amount <= 0n || amount > U64_MAX) return refuse("Enter an amount above zero.");
    const minimumUnits = minimumOf(input.minimum, unitDigits, U128_MAX);
    if (minimumUnits === null) return refuse("The minimum units is not a valid number.");
    const collateral = input.collateralMint ? { collateralMint: input.collateralMint } : {};
    return { intent: { operation, toClass, amount: amount.toString(), minimumUnits: minimumUnits.toString(), expiryBatch, ...collateral }, problem: null };
  }

  if (fromClass === null) return refuse("Choose the class to take units from.");
  const units = parseScaled(input.amount, unitDigits);
  if (units === null) return refuse(`Enter an amount with at most ${unitDigits} decimal places.`);
  if (units <= 0n || units > U128_MAX) return refuse("Enter an amount above zero.");

  if (operation === "redeem") {
    const minimumProceeds = minimumOf(input.minimum, collateralDecimals, U64_MAX);
    if (minimumProceeds === null) return refuse("The minimum proceeds is not a valid amount.");
    return { intent: { operation, fromClass, units: units.toString(), minimumProceeds: minimumProceeds.toString(), expiryBatch }, problem: null };
  }

  if (toClass === null) return refuse("Choose a class to switch into.");
  if (toClass === fromClass) return refuse("A switch cannot end in the class it started from.");
  const minimumUnits = minimumOf(input.minimum, unitDigits, U128_MAX);
  if (minimumUnits === null) return refuse("The minimum units is not a valid number.");
  return { intent: { operation, fromClass, toClass, units: units.toString(), minimumUnits: minimumUnits.toString(), expiryBatch }, problem: null };
}
