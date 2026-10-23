export const COLLATERAL = { symbol: "USDC", name: "devnet USDC" };

export const NETWORKS = [
  { id: "devnet", label: "Devnet", live: true },
  { id: "mainnet", label: "Mainnet", live: false },
] as const;

export const FIXTURE_DEMO_WALLET = "HgC4Jn7XMLzNsDjVdsr1x7BDuGBb2SBvx5TFLSUYaEyU";

export const CIRCLE_DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const CIRCLE_FAUCET_URL = "https://faucet.circle.com";
export const SOL_FAUCET_URL = "https://faucet.solana.com";

export const TEST_COLLATERAL = { symbol: "tUSDC", name: "test USDC", mint: "5rpGrekfBLHdF8PD8eKLzXQPPmhyF7FCKeE1VA5CwV3X", decimals: 6 };
export const FAUCET_GRANT = 20;
export const FAUCET_CLAIMS_PER_DAY = 2;
export const MIN_GAS_SOL = 0.01;
