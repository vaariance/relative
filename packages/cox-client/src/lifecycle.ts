import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { bytes32, integer } from "./wire.ts";

export type MarketLifecycle = "preparing" | "active" | "archived";
export type LifecycleValue = { preparing: object } | { active: object } | { archived: object };
export interface LifecycleAccount { lifecycleVersion: number; lifecycle: LifecycleValue }
export interface MarketGenerationIdentity {
  generation: Uint8Array;
  assetRegistry: PublicKey;
  basicPool: PublicKey;
  epochConfig: PublicKey;
}
export function marketLifecycle(account: LifecycleAccount & { schemaVersion?: number }): MarketLifecycle {
  if (account.lifecycleVersion === 0) return account.schemaVersion === 3 ? "archived" : "active";
  if (account.lifecycleVersion !== 1) throw new Error("UnsupportedLifecycleVersion");
  const keys = Object.keys(account.lifecycle);
  if (keys.length !== 1 || !["preparing", "active", "archived"].includes(keys[0]!)) throw new Error("InvalidLifecycleState");
  return keys[0] as MarketLifecycle;
}
export function assertMarketActive(account: LifecycleAccount & { schemaVersion?: number }): void {
  const lifecycle = marketLifecycle(account);
  if (lifecycle === "archived") throw new Error("MarketArchived");
  if (lifecycle !== "active") throw new Error("MarketPreparing");
}
export function marketGenerationKey(identity: MarketGenerationIdentity): string {
  const generation = bytes32(identity.generation);
  if (generation.every(byte => byte === 0) || [identity.assetRegistry, identity.basicPool, identity.epochConfig].some(key => key.equals(PublicKey.default))) throw new Error("InvalidMarketGeneration");
  return [Buffer.from(generation).toString("hex"), identity.assetRegistry.toBase58(), identity.basicPool.toBase58(), identity.epochConfig.toBase58()].join(":");
}
export function currentEpochWindow(timestamp: bigint): { opensAt: bigint; closesAt: bigint } {
  integer(timestamp, 8);
  const opensAt = timestamp / 14_400n * 14_400n;
  integer(opensAt + 14_400n, 8);
  return { opensAt, closesAt: opensAt + 14_400n };
}
