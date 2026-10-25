import type {
  CoxApiErrorBody,
  CoxApiResponse,
  CoxAsset,
  CoxDeployment,
  CoxErrorCode,
  CoxPublicationEvent,
  CoxPublicationPage,
  CoxStatus,
  CoxStreamEvent,
  CryptoComposition,
  DepositInput,
  Preview,
  PreparePositionInput,
  PreviewHistory,
  PreviewPortfolio,
  DepositQuoteInput,
  Epoch,
  EpochEntryInput,
  EpochLot,
  EpochOverview,
  EpochFinalizeEmptyInput,
  EpochPreparation,
  EpochPrepareInput,
  EpochRefundInput,
  EpochWithdrawInput,
  FaucetChallenge,
  FaucetClaim,
  FaucetClaimInput,
  FaucetStatus,
  Portfolio,
  Publication,
  RedeemInput,
  RedeemQuoteInput,
  RequestActionInput,
  Submission,
  SwitchInput,
  SwitchQuoteInput,
  TradeQuote,
  UnsignedTransaction,
  WithdrawInput,
} from "./cox-types.js";
import { COX_APP_API_SCHEMA_VERSION } from "./cox-types.js";

export class CoxApiError extends Error {
  constructor(
    readonly code: CoxErrorCode,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "CoxApiError";
  }
}

export interface CoxApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export interface CoxPublicationSubscription {
  close(): void;
  closed: Promise<void>;
}

const ASSET_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const lines = buffer.slice(0, boundary).split("\n");
      buffer = buffer.slice(boundary + 2);
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
      const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
      if (data) onEvent(event, data);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function checkSequence(value: number | null, name: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new CoxApiError("INVALID_REQUEST", `invalid ${name}`, 0);
}

export function createCoxApiClient(options: CoxApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  async function get<T>(path: string, init?: RequestInit): Promise<CoxApiResponse<T>> {
    const res = await doFetch(`${baseUrl}/v1/${path}`, { ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) } });
    const body = (await res.json()) as CoxApiResponse<T> | CoxApiErrorBody;
    if (body.schemaVersion !== COX_APP_API_SCHEMA_VERSION) {
      throw new CoxApiError("INTERNAL_ERROR", `unsupported schema version ${String(body.schemaVersion)}`, res.status);
    }
    if ("error" in body) throw new CoxApiError(body.error.code, body.error.message, res.status);
    return body;
  }

  const post = <T>(path: string, body: unknown) => get<T>(path, { method: "POST", body: JSON.stringify(body) });

  return {
    deployment: () => get<CoxDeployment>("deployment"),
    quoteDeposit: (input: DepositQuoteInput) => post<TradeQuote>("quotes/deposit", input),
    quoteSwitch: (input: SwitchQuoteInput) => post<TradeQuote>("quotes/switch", input),
    quoteRedeem: (input: RedeemQuoteInput) => post<TradeQuote>("quotes/redeem", input),
    buildDeposit: (input: DepositInput) => post<UnsignedTransaction>("transactions/deposit", input),
    buildSwitch: (input: SwitchInput) => post<UnsignedTransaction>("transactions/switch", input),
    buildRedeem: (input: RedeemInput) => post<UnsignedTransaction>("transactions/redeem", input),
    buildCancel: (input: RequestActionInput) => post<UnsignedTransaction>("transactions/cancel", input),
    buildRefund: (input: RequestActionInput) => post<UnsignedTransaction>("transactions/refund", input),
    buildWithdraw: (input: WithdrawInput) => post<UnsignedTransaction>("transactions/withdraw", input),
    submitTransaction: (signedBase64: string) => post<Submission>("transactions/submit", { transaction: signedBase64 }),
    submission: (signature: string) => {
      if (!SIGNATURE_PATTERN.test(signature)) throw new CoxApiError("INVALID_REQUEST", "invalid signature", 0);
      return get<Submission>(`transactions/${signature}`);
    },
    status: () => get<CoxStatus>("status"),
    epochs: () => get<EpochOverview>("epochs"),
    epoch: (opensAt: number) => {
      if (!Number.isSafeInteger(opensAt) || opensAt <= 0) throw new CoxApiError("INVALID_REQUEST", "invalid Epoch opening time", 0);
      return get<Epoch>(`epochs/${opensAt}`);
    },
    epochLots: (opensAt: number, owner: string) => {
      if (!Number.isSafeInteger(opensAt) || opensAt <= 0) throw new CoxApiError("INVALID_REQUEST", "invalid Epoch opening time", 0);
      if (!OWNER_PATTERN.test(owner)) throw new CoxApiError("INVALID_REQUEST", "invalid owner", 0);
      return get<EpochLot[]>(`epochs/${opensAt}/lots?owner=${owner}`);
    },
    epochHistory: (opensAt: number, step: 60 | 300 = 60) => {
      if (!Number.isSafeInteger(opensAt) || opensAt <= 0) throw new CoxApiError("INVALID_REQUEST", "invalid Epoch opening time", 0);
      return get<PreviewHistory>(`epochs/${opensAt}/history?step=${step}`);
    },
    buildPreparePosition:(input: PreparePositionInput) => post<UnsignedTransaction>("transactions/prepare-position", input),
    buildEpochEntry: (input: EpochEntryInput) => post<UnsignedTransaction>("transactions/epoch-entry", input),
    buildEpochWithdraw: (input: EpochWithdrawInput) => post<UnsignedTransaction>("transactions/epoch-withdraw", input),
    buildEpochRefund: (input: EpochRefundInput) => post<UnsignedTransaction>("transactions/epoch-refund", input),
    buildEpochPrepare: (input: EpochPrepareInput) => post<EpochPreparation>("transactions/epoch-prepare", input),
    buildEpochFinalizeEmpty: (input: EpochFinalizeEmptyInput) => post<UnsignedTransaction>("transactions/epoch-finalize-empty", input),
    preview: () => get<Preview>("preview"),
    previewHistory: (from: number, to: number, step: 1 | 60 | 300 | 3600) => get<PreviewHistory>(`preview/history?from=${from}&to=${to}&step=${step}`),
    previewPortfolio: (owner: string) => {
      if (!OWNER_PATTERN.test(owner)) throw new CoxApiError("INVALID_REQUEST", "invalid owner", 0);
      return get<PreviewPortfolio>(`preview/portfolio?owner=${owner}`);
    },
    faucetStatus: (owner: string) => {
      if (!OWNER_PATTERN.test(owner)) throw new CoxApiError("INVALID_REQUEST", "invalid owner", 0);
      return get<FaucetStatus>(`faucet/status?owner=${owner}`);
    },
    faucetChallenge: (owner: string) => post<FaucetChallenge>("faucet/challenge", { owner }),
    faucetClaim: (input: FaucetClaimInput) => post<FaucetClaim>("faucet/claim", input),
    assets: () => get<CoxAsset[]>("assets"),
    crypto: () => get<CryptoComposition>("crypto"),
    latestPublication: () => get<Publication>("publications/latest"),
    publication: (sequence: number) => {
      checkSequence(sequence, "sequence");
      return get<Publication>(`publications/${sequence}`);
    },
    publications: (after: number | null = null, limit = 100) => {
      checkSequence(after, "after");
      if (!Number.isSafeInteger(limit) || limit < 1) throw new CoxApiError("INVALID_REQUEST", "invalid limit", 0);
      return get<CoxPublicationPage>(after === null ? `publications?limit=${limit}` : `publications?after=${after}&limit=${limit}`);
    },
    portfolio: (owner: string) => {
      if (!OWNER_PATTERN.test(owner)) throw new CoxApiError("INVALID_REQUEST", "invalid owner", 0);
      return get<Portfolio>(`wallets/${owner}/portfolio`);
    },
    asset: (assetId: string) => {
      if (!ASSET_PATTERN.test(assetId)) throw new CoxApiError("INVALID_REQUEST", "invalid asset", 0);
      return get<CoxAsset>(`assets/${assetId}`);
    },
    subscribePublications(after: number | null, onEvent: (event: CoxPublicationEvent) => void): CoxPublicationSubscription {
      checkSequence(after, "after");
      const controller = new AbortController();
      let lastSequence = after;
      const closed = (async () => {
        const res = await doFetch(`${baseUrl}/v1/publications/stream`, {
          headers: lastSequence === null ? { accept: "text/event-stream" } : { accept: "text/event-stream", "last-event-id": String(lastSequence) },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new CoxApiError("INTERNAL_ERROR", `stream failed with ${res.status}`, res.status);
        await readEvents(res.body, (_type, data) => {
          const event = JSON.parse(data) as CoxPublicationEvent;
          if (lastSequence === null || event.sequence > lastSequence) {
            lastSequence = event.sequence;
            onEvent(event);
          }
        });
      })().catch((error: unknown) => {
        if (controller.signal.aborted) return;
        throw error;
      });
      return { close: () => controller.abort(), closed };
    },
    subscribe(options: { after?: number | null; wallet?: string | null }, onEvent: (event: CoxStreamEvent) => void): CoxPublicationSubscription {
      const after = options.after ?? null;
      const wallet = options.wallet ?? null;
      checkSequence(after, "after");
      if (wallet !== null && !OWNER_PATTERN.test(wallet)) throw new CoxApiError("INVALID_REQUEST", "invalid owner", 0);
      const controller = new AbortController();
      let lastSequence = after;
      const closed = (async () => {
        const query = wallet === null ? "" : `?wallet=${wallet}`;
        const res = await doFetch(`${baseUrl}/v1/stream${query}`, {
          headers: lastSequence === null ? { accept: "text/event-stream" } : { accept: "text/event-stream", "last-event-id": String(lastSequence) },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new CoxApiError("INTERNAL_ERROR", `stream failed with ${res.status}`, res.status);
        await readEvents(res.body, (type, data) => {
          if (type === "publication") {
            const event = JSON.parse(data) as CoxPublicationEvent;
            if (lastSequence !== null && event.sequence <= lastSequence) return;
            lastSequence = event.sequence;
            onEvent({ type, data: event });
          } else if (type === "status") {
            onEvent({ type, data: JSON.parse(data) as CoxStatus });
          } else if (type === "portfolio") {
            onEvent({ type, data: JSON.parse(data) as Extract<CoxStreamEvent, { type: "portfolio" }>["data"] });
          } else if (type === "preview") {
            onEvent({ type, data: JSON.parse(data) as Preview });
          }
        });
      })().catch((error: unknown) => {
        if (controller.signal.aborted) return;
        throw error;
      });
      return { close: () => controller.abort(), closed };
    },
  };
}

export type CoxApiClient = ReturnType<typeof createCoxApiClient>;
