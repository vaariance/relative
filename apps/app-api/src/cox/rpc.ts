import { Connection, type Commitment } from "@solana/web3.js";

const REQUEST_TIMEOUT_MS = 15_000;
const UPSTREAM_REFUSED = new Set([401, 403, 408, 429]);

export const failsOver = (status: number): boolean => UPSTREAM_REFUSED.has(status) || status >= 500;

export function parseRpcUrls(text: string | undefined, name: string): string[] {
  const urls = (text ?? "").split(/\s+/).filter(Boolean);
  if (urls.length === 0) throw new Error(`${name} must list at least one https RPC URL`);
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${name} contains an invalid URL`);
    }
    if (parsed.protocol !== "https:") throw new Error(`${name} contains a non-https URL for ${parsed.host}`);
  }
  return urls;
}

export const rpcHost = (url: string): string => new URL(url).host;

export function failoverFetch(urls: readonly string[], onFailover?: (from: string, to: string, reason: string) => void): typeof fetch {
  let current = 0;
  return async (_input, init) => {
    let failure: unknown = new Error("no RPC URL answered");
    for (let attempt = 0; attempt < urls.length; attempt += 1) {
      const index = (current + attempt) % urls.length;
      const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      let reason: string;
      try {
        const response = await fetch(urls[index]!, { ...init, signal });
        if (!failsOver(response.status)) {
          if (index !== current) onFailover?.(rpcHost(urls[current]!), rpcHost(urls[index]!), "previous endpoint failed");
          current = index;
          return response;
        }
        reason = `HTTP ${response.status}`;
        failure = new Error(`RPC ${rpcHost(urls[index]!)} returned ${reason}`);
      } catch (error) {
        if (init?.signal?.aborted) throw error;
        reason = error instanceof Error ? error.name : "request failed";
        failure = new Error(`RPC ${rpcHost(urls[index]!)} failed: ${reason}`);
      }
    }
    throw failure;
  };
}

export async function checkGenesis(urls: readonly string[], genesis: string, onUnreachable?: (host: string, reason: string) => void): Promise<string[]> {
  const usable: string[] = [];
  for (const url of urls) {
    let result: unknown;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      result = ((await response.json()) as { result?: unknown }).result;
    } catch (error) {
      onUnreachable?.(rpcHost(url), error instanceof Error ? error.message : "request failed");
      continue;
    }
    if (result !== genesis) throw new Error(`RPC ${rpcHost(url)} is not on the expected network`);
    usable.push(url);
  }
  if (usable.length === 0) throw new Error("no RPC endpoint answered on the expected network");
  return usable;
}

export function failoverConnection(urls: readonly string[], commitment: Commitment, onFailover?: (from: string, to: string, reason: string) => void): Connection {
  return new Connection(urls[0]!, { commitment, fetch: failoverFetch(urls, onFailover), disableRetryOnRateLimit: true });
}
