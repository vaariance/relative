import { Connection, type Commitment } from "@solana/web3.js";
import { DEV_GENESIS } from "./config.ts";

export const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";
export interface DirectRpcEnvironment { readonly ALCHEMY_API_KEY?: string }
export interface DirectRpcOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly retryPrimaryMs?: number;
  readonly now?: () => number;
  readonly onFallback?: (active: boolean) => void;
}

export function directDevnetRpcUrls(environment: DirectRpcEnvironment): readonly [string, string] {
  const key = environment.ALCHEMY_API_KEY;
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) throw new Error("InvalidAlchemyApiKey");
  return [`https://solana-devnet.g.alchemy.com/v2/${key}`, PUBLIC_DEVNET_RPC];
}

export function directDevnetFetch(environment: DirectRpcEnvironment, options: DirectRpcOptions = {}): typeof fetch {
  const urls = directDevnetRpcUrls(environment);
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryPrimaryMs = options.retryPrimaryMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(retryPrimaryMs) || retryPrimaryMs < 1) {
    throw new Error("InvalidRpcOptions");
  }
  const verified = new Set<number>();
  let retryPrimaryAt = 0;
  let fallback = false;
  const send = async (index: number, init: RequestInit | undefined): Promise<Response> => {
    const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    return request(urls[index]!, { ...init, signal });
  };
  return async (_input, init) => {
    const order = now() < retryPrimaryAt ? [1, 0] : [0, 1];
    for (const index of order) {
      try {
        if (!verified.has(index)) {
          const response = await send(index, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }), signal: init?.signal });
          if (!response.ok) throw new Error("RpcGenesisUnavailable");
          const body = await response.json() as { result?: unknown };
          if (body.result !== DEV_GENESIS) throw new Error("RpcGenesisMismatch");
          verified.add(index);
        }
        const response = await send(index, init);
        if ([401, 403, 408, 429].includes(response.status) || response.status >= 500) throw new Error("RpcUnavailable");
        if (index === 0) retryPrimaryAt = 0;
        if (fallback !== (index === 1)) {
          fallback = index === 1;
          try { options.onFallback?.(fallback); } catch {}
        }
        return response;
      } catch (error) {
        if (error instanceof Error && error.message === "RpcGenesisMismatch") throw error;
        if (init?.signal?.aborted) throw new Error("RpcRequestAborted");
        if (index === 0) retryPrimaryAt = now() + retryPrimaryMs;
      }
    }
    throw new Error("DirectRpcUnavailable");
  };
}

export function createDirectDevnetConnection(environment: DirectRpcEnvironment, commitment: Commitment = "confirmed", options: DirectRpcOptions = {}): Connection {
  const [url] = directDevnetRpcUrls(environment);
  return new Connection(url, { commitment, fetch: directDevnetFetch(environment, options), disableRetryOnRateLimit: true });
}
