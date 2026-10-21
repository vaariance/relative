import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  SIGNING_SCHEMA_VERSION,
  SigningClientError,
  validateSignRequest,
  type RejectionCode,
  type SignRequest,
  type SignResult,
} from "@eox/signing";
import type { SignerConfig } from "./config.js";
import type { ResolvedKey } from "./directory.js";
import { type AccountFetcher } from "./cox-linkage.js";
import { checkProtocolLinkage } from "./protocol-linkage.js";
import { checkSolanaPolicy, PolicyRejection } from "./policy.js";
import { parseSolanaTransaction, requiredSignerIndex } from "./solana.js";
import type { DecisionStore } from "./store.js";

export const MAX_EXPIRY_SECONDS = 600;

export interface ChainSigners {
  solana(keyVersion: string, rawPublicKey: Uint8Array, transactionBase64: string): Promise<{ signature: Uint8Array; signedTransaction: string }>;
}

export class SignerUnavailable extends Error {}

export interface SigningServiceDeps {
  config: SignerConfig;
  keys: Map<string, ResolvedKey>;
  store: DecisionStore;
  signers: ChainSigners;
  now: () => number;
  log: (entry: Record<string, unknown>) => void;
  solanaAccounts?: AccountFetcher;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestDigest(request: SignRequest): string {
  const { requestId, role, keyVersion, network, operation, expiresAt, chain } = request;
  const bytes = request.transactionBase64;
  return createHash("sha256")
    .update(canonical({ requestId, role, keyVersion, network, operation, expiresAt, chain, bytes }))
    .digest("hex");
}

function payloadDigest(request: SignRequest): string {
  return createHash("sha256").update(Buffer.from(request.transactionBase64, "base64")).digest("hex");
}

export function createSigningService(deps: SigningServiceDeps) {
  const { config, keys, store, signers, now, log } = deps;

  function rejection(requestId: string, payloadSha256: string | null, code: RejectionCode, reason: string): SignResult {
    return { schemaVersion: SIGNING_SCHEMA_VERSION, requestId, decision: "rejected", payloadSha256, code, reason, decidedAt: now() };
  }

  async function decide(caller: string, request: SignRequest, payloadSha256: string): Promise<SignResult> {
    const roles = config.callers[caller] ?? [];
    if (!roles.includes(request.role)) {
      return rejection(request.requestId, payloadSha256, "ROLE_NOT_PERMITTED", `${caller} may not sign as ${request.role}`);
    }
    const key = keys.get(request.role);
    if (!key || key.entry.state !== "active" || key.entry.keyVersion !== request.keyVersion) {
      return rejection(request.requestId, payloadSha256, "KEY_NOT_ACTIVE", `key version ${request.keyVersion} is not active for ${request.role}`);
    }
    if (request.network !== key.entry.network) {
      return rejection(request.requestId, payloadSha256, "NETWORK_NOT_PERMITTED", `${request.role} signs only on ${key.entry.network}`);
    }
    if (request.expiresAt > now() + MAX_EXPIRY_SECONDS) {
      return rejection(request.requestId, payloadSha256, "INVALID_REQUEST", `expiry must be within ${MAX_EXPIRY_SECONDS} seconds`);
    }
    const bindings = config.bindings[request.role];
    try {
      const transaction = parseSolanaTransaction(request.transactionBase64);
      const signer = new PublicKey(key.derived.rawPublicKey);
      requiredSignerIndex(transaction, signer);
      checkSolanaPolicy(request.role, bindings, transaction, signer);
      for (const program of bindings?.solana?.programs ?? []) {
        if (!program.linkage) continue;
        if (!deps.solanaAccounts) throw new PolicyRejection("TARGET_NOT_BOUND", "COX linkage needs a Solana RPC to verify accounts");
        await checkProtocolLinkage(program, program.linkage, transaction, deps.solanaAccounts);
      }
    } catch (error) {
      if (error instanceof PolicyRejection) return rejection(request.requestId, payloadSha256, error.code, error.message);
      return rejection(request.requestId, payloadSha256, "INVALID_REQUEST", error instanceof Error ? error.message : "invalid transaction");
    }
    try {
      const signed = await signers.solana(key.entry.keyVersion, key.derived.rawPublicKey, request.transactionBase64);
      const signature = Buffer.from(signed.signature).toString("base64");
      const signedTransaction = signed.signedTransaction;
      return {
        schemaVersion: SIGNING_SCHEMA_VERSION,
        requestId: request.requestId,
        decision: "signed",
        payloadSha256,
        signer: { role: request.role, address: key.entry.address, keyVersion: key.entry.keyVersion },
        signature,
        signedTransaction,
        decidedAt: now(),
      };
    } catch (error) {
      throw new SignerUnavailable(error instanceof Error ? error.message : "signing failed");
    }
  }

  async function replay(caller: string, request: SignRequest, digest: string): Promise<SignResult | null> {
    const existing = await store.get(request.requestId);
    if (!existing) return null;
    if (existing.caller === caller && existing.requestSha256 === digest) return existing.result;
    return rejection(request.requestId, null, "REQUEST_ID_CONFLICT", "this request id was already used for a different request");
  }

  return async function sign(caller: string, body: unknown): Promise<SignResult> {
    const request = body as SignRequest & { schemaVersion?: string };
    const requestId = typeof request?.requestId === "string" ? request.requestId : "";
    if (request?.schemaVersion !== SIGNING_SCHEMA_VERSION) {
      return rejection(requestId, null, "INVALID_REQUEST", "unsupported schema version");
    }
    try {
      validateSignRequest(request, now());
    } catch (error) {
      const message = error instanceof SigningClientError ? error.message : "invalid request";
      return rejection(requestId, null, message === "request expired" ? "REQUEST_EXPIRED" : "INVALID_REQUEST", message);
    }
    const digest = requestDigest(request);
    const replayed = await replay(caller, request, digest);
    if (replayed) {
      log({ caller, role: request.role, requestId, payloadSha256: replayed.payloadSha256, decision: replayed.decision, replay: true });
      return replayed;
    }
    const payloadSha256 = payloadDigest(request);
    const result = await decide(caller, request, payloadSha256);
    const stored = await store.create({ requestId, caller, role: request.role, requestSha256: digest, result });
    const final = stored === "created" ? result : ((await replay(caller, request, digest)) ?? result);
    log({
      caller,
      role: request.role,
      requestId,
      payloadSha256,
      decision: final.decision,
      code: final.decision === "rejected" ? final.code : undefined,
    });
    return final;
  };
}
