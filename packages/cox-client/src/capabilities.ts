import type { Connection, PublicKey } from "@solana/web3.js";

export const SWAP_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export type SwapCapabilityReason = "network-mismatch" | "router-not-configured" | "provider-not-configured"
  | "provider-network-mismatch" | "express-not-enabled" | "router-not-executable";
export type SwapCapability = { available: true } | { available: false; reason: SwapCapabilityReason };
export interface SwapCapabilities { directEntry: SwapCapability; express: SwapCapability }
export interface ExpressConfiguration {
  expressEnabled?: boolean;
  routerProgramId?: PublicKey;
  providerGenesisHash?: string;
}

export async function swapCapabilities(connection: Connection, genesisHash: string, express: ExpressConfiguration = {}): Promise<SwapCapabilities> {
  if (genesisHash !== SWAP_DEVNET_GENESIS || await connection.getGenesisHash() !== genesisHash) {
    return { directEntry: { available: false, reason: "network-mismatch" }, express: { available: false, reason: "network-mismatch" } };
  }
  const directEntry: SwapCapability = { available: true };
  const unavailable = (reason: SwapCapabilityReason): SwapCapabilities => ({ directEntry, express: { available: false, reason } });
  if (!express.routerProgramId) return unavailable("router-not-configured");
  if (!express.providerGenesisHash) return unavailable("provider-not-configured");
  if (express.providerGenesisHash !== genesisHash) return unavailable("provider-network-mismatch");
  if (express.expressEnabled !== true) return unavailable("express-not-enabled");
  const router = await connection.getAccountInfo(express.routerProgramId, "finalized");
  if (!router?.executable) return unavailable("router-not-executable");
  return { directEntry, express: { available: true } };
}
