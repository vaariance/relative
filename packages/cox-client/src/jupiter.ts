import { Buffer } from "buffer";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { SwapSdkError } from "./swap.ts";
import { routedCollateralAccount, type DexRoute, type DexRouteProvider, type DexRouteRequest } from "./routed.ts";

export const JUPITER_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
interface ApiInstruction { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }
interface BuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  swapInstruction: ApiInstruction;
  setupInstructions: ApiInstruction[];
  cleanupInstruction: ApiInstruction | null;
  otherInstructions: ApiInstruction[];
  tipInstruction: ApiInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
}
export interface JupiterRouteOptions {
  connection: Connection;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  maxAccounts?: number;
}
function check(condition: boolean, code: string): asserts condition {
  if (!condition) throw new SwapSdkError(code);
}
function amount(value: string): bigint {
  check(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value), "SwapRouteMismatch");
  const result = BigInt(value);
  check(result > 0n && result <= (1n << 64n) - 1n, "SwapRouteMismatch");
  return result;
}
function instruction(value: ApiInstruction): TransactionInstruction {
  check(!!value && typeof value.programId === "string" && Array.isArray(value.accounts)
    && typeof value.data === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value.data), "SwapRouteMismatch");
  return new TransactionInstruction({ programId: new PublicKey(value.programId),
    keys: value.accounts.map(key => {
      check(typeof key.pubkey === "string" && typeof key.isSigner === "boolean" && typeof key.isWritable === "boolean", "SwapRouteMismatch");
      return { pubkey: new PublicKey(key.pubkey), isSigner: key.isSigner, isWritable: key.isWritable };
    }), data: Buffer.from(value.data, "base64") });
}
export class JupiterRouteProvider implements DexRouteProvider {
  readonly genesisHash = JUPITER_MAINNET_GENESIS;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly maxAccounts: number;
  private readonly options: JupiterRouteOptions;
  constructor(options: JupiterRouteOptions) {
    this.options = { ...options };
    check(options.apiKey.trim().length > 0, "SwapRouteApiKeyMissing");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.maxAccounts = options.maxAccounts ?? 32;
    check(Number.isInteger(this.maxAccounts) && this.maxAccounts >= 1 && this.maxAccounts <= 48, "SwapRouteAccountLimit");
  }
  async route(request: DexRouteRequest): Promise<DexRoute> {
    check(request.genesisHash === this.genesisHash
      && await this.options.connection.getGenesisHash() === this.genesisHash, "SwapNetworkMismatch");
    check(request.inputTokenAccount.equals(routedCollateralAccount(request.owner, request.inputMint)), "SwapRouteSourceAccountUnsupported");
    check(typeof request.inputAmount === "bigint" && request.inputAmount > 0n && request.inputAmount <= (1n << 64n) - 1n
      && Number.isInteger(request.slippageBps) && request.slippageBps >= 0 && request.slippageBps < 10_000, "InvalidSwapAmount");
    const url = new URL("https://api.jup.ag/swap/v2/build");
    url.search = new URLSearchParams({ inputMint: request.inputMint.toBase58(), outputMint: request.outputMint.toBase58(),
      amount: request.inputAmount.toString(), taker: request.owner.toBase58(), destinationTokenAccount: request.outputTokenAccount.toBase58(),
      slippageBps: String(request.slippageBps), platformFeeBps: "0", wrapAndUnwrapSol: "false", maxAccounts: String(this.maxAccounts) }).toString();
    const response = await this.fetcher(url, { headers: { "x-api-key": this.options.apiKey }, signal: AbortSignal.timeout(15_000) });
    check(response.ok, response.status === 429 ? "SwapRouteRateLimited" : "SwapRouteUnavailable");
    const build = await response.json() as BuildResponse;
    check(build.inputMint === request.inputMint.toBase58() && build.outputMint === request.outputMint.toBase58()
      && build.swapMode === "ExactIn" && amount(build.inAmount) === request.inputAmount, "SwapRouteMismatch");
    check(Array.isArray(build.setupInstructions) && Array.isArray(build.otherInstructions)
      && build.otherInstructions.length === 0 && !build.cleanupInstruction && !build.tipInstruction, "SwapRouteInstructionsUnsupported");
    const expectedOutputAmount = amount(build.outAmount), minimumOutputAmount = amount(build.otherAmountThreshold);
    check(expectedOutputAmount >= minimumOutputAmount, "SwapRouteMismatch");
    const lookupTables = [];
    for (const [key, expected] of Object.entries(build.addressesByLookupTableAddress ?? {})) {
      check(Array.isArray(expected) && expected.every(address => typeof address === "string"), "SwapLookupTableMismatch");
      const { value } = await this.options.connection.getAddressLookupTable(new PublicKey(key), { commitment: "finalized" });
      check(!!value && value.isActive() && value.state.addresses.length === expected.length
        && value.state.addresses.every((address, index) => address.toBase58() === expected[index]), "SwapLookupTableMismatch");
      lookupTables.push(value);
    }
    return { ...request, expectedOutputAmount, minimumOutputAmount, swapInstruction: instruction(build.swapInstruction),
      setupInstructions: build.setupInstructions.map(instruction), lookupTables };
  }
}
