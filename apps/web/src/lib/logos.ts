import ids from "./coingecko-ids.json";

export const COINGECKO_IDS: Record<string, string> = ids;

const LLAMA_PATHS: Record<string, string> = {
  BTC: "chains/rsz_bitcoin",
  ETH: "chains/rsz_ethereum",
  SOL: "chains/rsz_solana",
  XRP: "chains/rsz_ripple",
  BNB: "chains/rsz_bsc",
  TRX: "chains/rsz_tron",
  AVAX: "chains/rsz_avalanche",
  DOT: "chains/rsz_polkadot",
  NEAR: "chains/rsz_near",
  SUI: "chains/rsz_sui",
  APT: "chains/rsz_aptos",
  UNI: "protocols/uniswap",
  ARB: "chains/rsz_arbitrum",
  OP: "chains/rsz_optimism",
  INJ: "chains/rsz_injective",
  AAVE: "protocols/aave",
  ZEC: "chains/rsz_zcash",
  STRK: "chains/rsz_starknet",
  HYPE: "chains/rsz_hyperliquid",
  TAO: "chains/rsz_bittensor",
  WLD: "protocols/worldcoin",
  ONDO: "protocols/ondo-finance",
  ENA: "protocols/ethena",
  ZRO: "protocols/layerzero",
  JUP: "protocols/jupiter",
  AERO: "protocols/aerodrome",
  TIA: "chains/rsz_celestia",
  W: "protocols/wormhole",
};

export function llamaLogo(assetId: string): string | null {
  const path = LLAMA_PATHS[assetId];
  return path ? `https://icons.llamao.fi/icons/${path}?w=96&h=96` : null;
}
