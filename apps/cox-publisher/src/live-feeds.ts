import type { JsonOrBinaryResponse, LazerClientConfig, PythLazerClient, Request } from "@pythnetwork/pyth-lazer-sdk";
import type { ReconnectEvent, SubscribeRequest } from "@triton-one/yellowstone-grpc";
import { PublicKey } from "@solana/web3.js";
import type { PythBatch } from "./pyth-cache.ts";

export type FeedStatus = "starting" | "streaming" | "unavailable" | "invalid-update" | "consumer-error" | "stopped";
export interface FeedHandle { stop(): void }
export interface PythFeedIdentity { readonly assetId: string; readonly priceFeedId: number }
export interface UnverifiedPythUpdate {
  readonly verification: "unverified";
  readonly subscriptionId: number;
  readonly batch: PythBatch;
}
export type PythClientPort = Pick<PythLazerClient,
  "addMessageListener" | "addAllConnectionsDownListener" | "addConnectionRestoredListener" | "subscribe" | "shutdown">;
export interface PythProOptions {
  readonly token: string;
  readonly catalogue: readonly PythFeedIdentity[];
  readonly subscriptionId: number;
  readonly maxFeedAgeUs: bigint;
  readonly signal?: AbortSignal;
  readonly onUpdate: (update: UnverifiedPythUpdate) => void;
  readonly onMessage?: (message: JsonOrBinaryResponse) => void;
  readonly onStatus?: (status: FeedStatus) => void;
  readonly createClient?: (config: LazerClientConfig) => Promise<PythClientPort>;
}

const PYTH_URLS = [
  "wss://pyth-lazer-0.dourolabs.app/v1/stream",
  "wss://pyth-lazer-1.dourolabs.app/v1/stream",
  "wss://pyth-lazer-2.dourolabs.app/v1/stream",
];
const silentLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const safeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function status(callback: PythProOptions["onStatus"], value: FeedStatus): void {
  try { callback?.(value); } catch {}
}

function catalogueMap(catalogue: readonly PythFeedIdentity[]): Map<number, string> {
  const feeds = new Map<number, string>();
  const assets = new Set<string>();
  for (const item of catalogue) {
    if (!item.assetId || assets.has(item.assetId) || !safeInteger(item.priceFeedId) || item.priceFeedId < 1 || feeds.has(item.priceFeedId)) {
      throw new Error("InvalidPythCatalogue");
    }
    feeds.set(item.priceFeedId, item.assetId);
    assets.add(item.assetId);
  }
  if (feeds.size === 0) throw new Error("InvalidPythCatalogue");
  return feeds;
}

export function parsePythProUpdate(message: unknown, catalogue: readonly PythFeedIdentity[], subscriptionId: number, maxFeedAgeUs: bigint): UnverifiedPythUpdate | null {
  if (maxFeedAgeUs < 0n) throw new Error("InvalidPythConfiguration");
  const feeds = catalogueMap(catalogue);
  if (!record(message) || (message.type !== "json" && message.type !== "binary") || !record(message.value)) {
    throw new Error("InvalidPythUpdate");
  }
  const value = message.value;
  if (message.type === "json" && value.type !== "streamUpdated") {
    if (value.type === "error" || value.type === "subscriptionError" || value.type === "subscribedWithInvalidFeedIdsIgnored") {
      throw new Error("PythSubscriptionRejected");
    }
    if (["subscribed", "unsubscribed"].includes(String(value.type))) return null;
    throw new Error("InvalidPythUpdate");
  }
  if (value.subscriptionId !== subscriptionId) return null;
  if (!record(value.parsed) || !decimal(value.parsed.timestampUs) || !Array.isArray(value.parsed.priceFeeds)) {
    throw new Error("InvalidPythUpdate");
  }
  const parsed = value.parsed;
  const timestampUs = BigInt(parsed.timestampUs as string);
  const prices: PythBatch["prices"][number][] = [];
  const seen = new Set<number>();
  for (const feed of parsed.priceFeeds as unknown[]) {
    if (!record(feed) || !safeInteger(feed.priceFeedId) || seen.has(feed.priceFeedId) || !feeds.has(feed.priceFeedId)
      || !decimal(feed.price) || BigInt(feed.price) <= 0n || !safeInteger(feed.exponent)
      || !safeInteger(feed.confidence) || feed.confidence < 0
      || !safeInteger(feed.feedUpdateTimestamp) || feed.feedUpdateTimestamp < 0) throw new Error("InvalidPythUpdate");
    const feedTimestampUs = BigInt(feed.feedUpdateTimestamp);
    if (feedTimestampUs > timestampUs || timestampUs - feedTimestampUs > maxFeedAgeUs) throw new Error("StalePythFeed");
    seen.add(feed.priceFeedId);
    prices.push({ feedId: String(feed.priceFeedId), price: BigInt(feed.price), exponent: feed.exponent, confidence: BigInt(feed.confidence) });
  }
  if (seen.size !== feeds.size) throw new Error("IncompletePythUpdate");
  let signedSolana: Uint8Array;
  if (message.type === "binary") {
    if (!(value.solana instanceof Uint8Array) || value.solana.length === 0) throw new Error("InvalidPythUpdate");
    signedSolana = new Uint8Array(value.solana);
  } else {
    if (!record(value.solana) || value.solana.encoding !== "base64" || typeof value.solana.data !== "string") {
      throw new Error("InvalidPythUpdate");
    }
    const bytes = Buffer.from(value.solana.data, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== value.solana.data) throw new Error("InvalidPythUpdate");
    signedSolana = bytes;
  }
  return { verification: "unverified", subscriptionId,
    batch: { timestampUs, prices, signedSolana } };
}

export async function startPythPro(options: PythProOptions): Promise<FeedHandle> {
  const catalogue = options.catalogue.map((item) => ({ ...item }));
  const feeds = catalogueMap(catalogue);
  if (!options.token || !safeInteger(options.subscriptionId) || options.subscriptionId < 0 || options.maxFeedAgeUs < 0n) throw new Error("InvalidPythConfiguration");
  status(options.onStatus, "starting");
  let stopped = false;
  let client: PythClientPort | undefined;
  try {
    const create = options.createClient ?? (async (config: LazerClientConfig) => {
      const sdk = await import("@pythnetwork/pyth-lazer-sdk");
      return sdk.PythLazerClient.create(config);
    });
    client = await create({ token: options.token, abortSignal: options.signal, logger: silentLogger,
      webSocketPoolConfig: { numConnections: 3, urls: [...PYTH_URLS],
        onWebSocketError: () => status(options.onStatus, "unavailable"),
        onWebSocketPoolError: () => status(options.onStatus, "unavailable") } });
    const liveClient = client;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      options.signal?.removeEventListener("abort", stop);
      try { liveClient.shutdown(); } catch {}
      status(options.onStatus, "stopped");
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    if (options.signal?.aborted) { stop(); return { stop }; }
    client.addAllConnectionsDownListener(() => { if (!stopped) status(options.onStatus, "unavailable"); });
    client.addConnectionRestoredListener(() => { if (!stopped) status(options.onStatus, "starting"); });
    client.addMessageListener((message) => {
      if (stopped) return;
      let update: UnverifiedPythUpdate | null;
      try { update = parsePythProUpdate(message, catalogue, options.subscriptionId, options.maxFeedAgeUs); }
      catch { status(options.onStatus, "invalid-update"); return; }
      try {
        options.onMessage?.(message);
        if (update) { options.onUpdate(update); status(options.onStatus, "streaming"); }
      } catch { status(options.onStatus, "consumer-error"); }
    });
    const request: Request = { type: "subscribe", subscriptionId: options.subscriptionId,
      priceFeedIds: [...feeds.keys()], properties: ["price", "exponent", "confidence", "feedUpdateTimestamp"], formats: ["solana"],
      deliveryFormat: "json", jsonBinaryEncoding: "base64", parsed: true, ignoreInvalidFeedIds: false, channel: "fixed_rate@1000ms" };
    client.subscribe(request);
    return { stop };
  } catch {
    stopped = true;
    try { client?.shutdown(); } catch {}
    status(options.onStatus, "unavailable");
    throw new Error("PythConnectionFailed");
  }
}

export interface ChainWake {
  readonly transaction: boolean;
  readonly slot: boolean;
  readonly reconcile: boolean;
  readonly latestSlot: bigint | null;
}
export interface YellowstoneStreamPort {
  on(event: "data", listener: (event: ReconnectEvent) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  write(request: SubscribeRequest, callback: (error?: Error | null) => void): boolean;
  destroy(): unknown;
}
export interface YellowstoneClientPort {
  connect(): Promise<void>;
  subscribeWithReconnect(request: SubscribeRequest): Promise<YellowstoneStreamPort>;
}
export interface AlchemyGrpcOptions {
  readonly endpoint: string;
  readonly token?: string;
  readonly programIds: readonly PublicKey[];
  readonly onWake: (wake: ChainWake) => void;
  readonly onEvent?: (event: ReconnectEvent) => void;
  readonly onStatus?: (status: FeedStatus) => void;
  readonly createClient?: (endpoint: string, token: string | undefined) => YellowstoneClientPort;
}

export function publisherSubscription(programIds: readonly PublicKey[]): SubscribeRequest {
  const programs = [...new Set(programIds.map((program) => program.toBase58()))];
  if (programs.length === 0) throw new Error("MissingProgramFilter");
  const filter = { vote: false, failed: false, accountInclude: programs, accountExclude: [], accountRequired: [] };
  return { accounts: {}, slots: { progress: { filterByCommitment: false } }, transactions: { predictions: filter },
    transactionsStatus: { progress: { ...filter } }, blocks: {}, blocksMeta: {}, entry: {}, blockFooter: {},
    commitment: 0, accountsDataSlice: [] };
}

export async function startAlchemyGrpc(options: AlchemyGrpcOptions): Promise<FeedHandle> {
  try {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) throw new Error();
  } catch { throw new Error("InvalidGrpcEndpoint"); }
  const request = publisherSubscription(options.programIds);
  status(options.onStatus, "starting");
  let stopped = false;
  let stream: YellowstoneStreamPort | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation: string | undefined;
  let buffered: ChainWake = { transaction: false, slot: false, reconcile: false, latestSlot: null };
  const wake = (transaction: boolean, slot: boolean, reconcile: boolean, latestSlot: bigint | null = null) => {
    if (stopped) return;
    buffered = { transaction: transaction || buffered.transaction, slot: slot || buffered.slot,
      reconcile: reconcile || buffered.reconcile,
      latestSlot: latestSlot === null ? buffered.latestSlot : buffered.latestSlot === null || latestSlot > buffered.latestSlot ? latestSlot : buffered.latestSlot };
    timer ??= setTimeout(() => {
      timer = undefined;
      const pending = buffered;
      buffered = { transaction: false, slot: false, reconcile: false, latestSlot: null };
      try { options.onWake(pending); } catch { status(options.onStatus, "consumer-error"); }
    }, 0);
  };
  try {
    let client: YellowstoneClientPort;
    if (options.createClient) client = options.createClient(options.endpoint, options.token);
    else {
      const sdk = await import("@triton-one/yellowstone-grpc");
      client = new sdk.default(options.endpoint, options.token, undefined);
    }
    await client.connect();
    stream = await client.subscribeWithReconnect(request);
    const liveStream = stream;
    liveStream.on("data", (event: ReconnectEvent) => {
      if (stopped) return;
      try {
        if (event.type === "DiscardBanks") { wake(false, false, true); }
        else {
          if (generation !== undefined && generation !== event.generation) wake(false, false, true);
          generation = event.generation;
          const update = event.update;
          const slotValue = update.transaction?.slot ?? update.transactionStatus?.slot ?? update.slot?.slot;
          if (slotValue !== undefined && !decimal(slotValue)) throw new Error();
          const latestSlot = slotValue === undefined ? null : BigInt(slotValue);
          if (update.transaction || update.transactionStatus) wake(true, false, false, latestSlot);
          if (update.slot) wake(false, true, update.slot.status === 6, latestSlot);
          if (update.ping) liveStream.write({ ...request, ping: { id: 1 } }, (error?: Error | null) => {
            if (error && !stopped) { status(options.onStatus, "unavailable"); wake(false, false, true); }
          });
        }
        options.onEvent?.(event);
        status(options.onStatus, "streaming");
      } catch { status(options.onStatus, "invalid-update"); wake(false, false, true); }
    });
    liveStream.on("error", () => { if (!stopped) { status(options.onStatus, "unavailable"); wake(false, false, true); } });
    liveStream.on("end", () => { if (!stopped) { status(options.onStatus, "unavailable"); wake(false, false, true); } });
    return { stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      try { liveStream.destroy(); } catch {}
      status(options.onStatus, "stopped");
    } };
  } catch {
    stopped = true;
    try { stream?.destroy(); } catch {}
    status(options.onStatus, "unavailable");
    throw new Error("GrpcSubscriptionFailed");
  }
}
