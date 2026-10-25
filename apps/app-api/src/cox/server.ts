import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { COX_APP_API_SCHEMA_VERSION, type CoxErrorCode, type CoxPublicationEvent, type CoxPublicationPage, type Publication } from "@eox/app-api";
import { CoxLiveStream, StreamLimitError } from "./live-stream.js";
import { previewPortfolio, type PreviewFeed } from "./preview.js";
import { HistoryRangeError, type PreviewHistory } from "./preview-history.js";
import { replay } from "./replay.js";
import type { CoxSource } from "./source.js";
import type { EpochSource } from "./epoch-source.js";
import type { CoxSubmissions } from "./submissions.js";
import { FaucetError, type CoxFaucet } from "./faucet.js";
import { FeeChangedError, NothingToDoError, TradingClosedError, TransactionInputError, TransactionRejectedError, type CoxTransactions } from "./transactions.js";

const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;
const HEARTBEAT_MS = 15_000;
const SEQUENCE_PATTERN = /^(0|[1-9][0-9]{0,15})$/;
const ASSET_PATTERN = /^[A-Z0-9]{2,12}$/;
const OWNER_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_BODY_BYTES = 8192;
const BUILDERS = ["deposit", "switch", "redeem", "cancel", "refund", "withdraw"] as const;
const EPOCH_BUILDERS = { "epoch-entry": "entry", "epoch-withdraw": "withdraw", "epoch-refund": "refund", "epoch-prepare": "prepare", "epoch-finalize-empty": "finalizeEmpty", "epoch-void": "voidRound" } as const;
const OPENS_AT_PATTERN = /^[1-9][0-9]{0,12}$/;
const QUOTES = { deposit: "quoteDeposit", switch: "quoteSwitch", redeem: "quoteRedeem" } as const;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: CoxErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CoxApiServerOptions {
  source: CoxSource;
  now?: () => number;
  onError?: (error: unknown) => void;
  corsOrigin?: string | null;
  transactions?: CoxTransactions | null;
  submissions?: CoxSubmissions | null;
  epochs?: EpochSource | null;
  preview?: PreviewFeed | null;
  previewHistory?: PreviewHistory | null;
  classes?: readonly string[];
  faucet?: CoxFaucet | null;
  faucetForward?: string | null;
  gatewaySecret?: string | null;
  postLimit?: { perMinute: number; trustForwardedFor: boolean } | null;
  trustForwardedFor?: boolean;
  stream?: { statusMs?: number; portfolioMs?: number; maxConnections?: number; maxPerClient?: number; maxWallets?: number };
}

export const GATEWAY_HEADER = "x-relative-gateway";

function forwardedEntries(req: IncomingMessage): string[] {
  const forwarded = req.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "";
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function fromGateway(req: IncomingMessage, secret: Buffer): boolean {
  const header = req.headers[GATEWAY_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  return timingSafeEqual(createHash("sha256").update(value).digest(), secret);
}

function clientAddress(req: IncomingMessage, trustForwardedFor: boolean, gatewaySecret: Buffer | null): string {
  const entries = forwardedEntries(req);
  if (!trustForwardedFor || entries.length === 0) return req.socket.remoteAddress ?? "unknown";
  if (gatewaySecret && !fromGateway(req, gatewaySecret)) return entries.at(-1)!;
  return entries[0]!;
}

function cors(res: ServerResponse, origin: string | null): void {
  if (!origin) return;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-expose-headers", "content-type");
  if (origin !== "*") res.setHeader("vary", "origin");
}

function write(res: ServerResponse, status: number, body: unknown, cacheControl = "no-store"): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

function sequence(value: string, name: string): number {
  if (!SEQUENCE_PATTERN.test(value)) throw new ApiError(400, "INVALID_REQUEST", `invalid ${name}`);
  return Number(value);
}

function after(value: string | null | undefined): number | null {
  return value === null || value === undefined || value === "" ? null : sequence(value, "after");
}

const event = (publication: Publication): CoxPublicationEvent => ({ sequence: publication.identity.sequence, publication });

export function createCoxApiServer(options: CoxApiServerOptions): Server {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const { source } = options;
  const corsOrigin = options.corsOrigin ?? null;
  const transactions = options.transactions ?? null;
  const submissions = options.submissions ?? null;
  const epochs = options.epochs ?? null;
  const previews = options.preview ?? null;

  function latestPreview() {
    if (!previews) throw new ApiError(409, "NOT_CONFIGURED", "this deployment serves no live preview");
    const preview = previews.latest(now());
    if (!preview) throw new ApiError(404, "NO_PREVIEW", "no preview has been received yet");
    return preview;
  }

  function epochSource(): EpochSource {
    if (!epochs) throw new ApiError(409, "NOT_CONFIGURED", "this deployment serves no Epoch configuration");
    return epochs;
  }

  function opensAt(value: string | undefined): number {
    if (!value || !OPENS_AT_PATTERN.test(value)) throw new ApiError(400, "INVALID_REQUEST", "invalid Epoch opening time");
    return Number(value);
  }
  const postLimit = options.postLimit ?? null;
  const buckets = new Map<string, { tokens: number; at: number }>();
  const trustForwardedFor = options.trustForwardedFor ?? postLimit?.trustForwardedFor ?? false;
  const gatewaySecret = options.gatewaySecret ? createHash("sha256").update(options.gatewaySecret).digest() : null;
  const visitor = (req: IncomingMessage) => clientAddress(req, trustForwardedFor, gatewaySecret);
  const live = new CoxLiveStream({ source, preview: previews, now, onError: options.onError, ...options.stream });

  function admit(req: IncomingMessage, res: ServerResponse): void {
    if (!postLimit) return;
    const key = visitor(req);
    const nowMs = Date.now();
    if (buckets.size > 10_000) for (const [k, b] of buckets) if (nowMs - b.at > 60_000) buckets.delete(k);
    const bucket = buckets.get(key) ?? { tokens: postLimit.perMinute, at: nowMs };
    bucket.tokens = Math.min(postLimit.perMinute, bucket.tokens + ((nowMs - bucket.at) / 60_000) * postLimit.perMinute);
    bucket.at = nowMs;
    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      res.setHeader("retry-after", String(Math.ceil(((1 - bucket.tokens) * 60) / postLimit.perMinute)));
      throw new ApiError(429, "RATE_LIMITED", "too many transaction requests; try again shortly");
    }
    bucket.tokens -= 1;
    buckets.set(key, bucket);
  }

  async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const type = req.headers["content-type"] ?? "";
    if (!/^application\/json(;|$)/i.test(type)) throw new ApiError(415, "INVALID_REQUEST", "content-type must be application/json");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new ApiError(413, "INVALID_REQUEST", "request body is too large");
      chunks.push(chunk as Buffer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ApiError(400, "INVALID_REQUEST", "request body is not JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "INVALID_REQUEST", "request body must be a JSON object");
    return parsed as Record<string, unknown>;
  }

  const faucet = options.faucet ?? null;
  const faucetForward = options.faucetForward ? options.faucetForward.replace(/\/+$/, "") : null;

  async function forwardFaucet(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const headers: Record<string, string> = { accept: "application/json", "x-forwarded-for": visitor(req) };
    let payload: string | undefined;
    if (req.method === "POST") {
      admit(req, res);
      payload = JSON.stringify(await body(req));
      headers["content-type"] = "application/json";
    }
    const upstream = await fetch(`${faucetForward}${url.pathname}${url.search}`, { method: req.method, headers, body: payload, signal: AbortSignal.timeout(60_000) });
    const text = await upstream.text();
    const retryAfter = upstream.headers.get("retry-after");
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
    });
    res.end(text);
  }

  async function faucetRoute(req: IncomingMessage, res: ServerResponse, url: URL, path: string[]): Promise<void> {
    if (faucetForward) return forwardFaucet(req, res, url);
    if (!faucet) throw new ApiError(409, "NOT_CONFIGURED", "this deployment serves no faucet");
    const [, , b] = path;
    if (path.length !== 3) throw new ApiError(404, "NOT_FOUND", "not found");
    if (req.method === "GET" && b === "status") return send(res, await faucet.status(url.searchParams.get("owner")));
    if (req.method === "POST" && (b === "challenge" || b === "claim")) {
      admit(req, res);
      const input = await body(req);
      if (b === "challenge") return send(res, await faucet.challenge(input));
      return send(res, await faucet.claim(input, visitor(req)));
    }
    if (b === "status" || b === "challenge" || b === "claim") {
      res.setHeader("allow", b === "status" ? "GET" : "POST");
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "method not allowed");
    }
    throw new ApiError(404, "NOT_FOUND", "not found");
  }

  async function post(req: IncomingMessage, res: ServerResponse, path: string[]): Promise<void> {
    const [, a, b] = path;
    if (path.length !== 3 || (a !== "transactions" && a !== "quotes")) throw new ApiError(404, "NOT_FOUND", "not found");
    if (!transactions || !submissions) throw new ApiError(409, "NOT_LIVE", "transactions are built and quoted only by a live deployment");
    admit(req, res);
    const input = await body(req);
    if (a === "quotes") {
      if (!Object.hasOwn(QUOTES, b!)) throw new ApiError(404, "NOT_FOUND", "not found");
      return send(res, await (transactions[QUOTES[b as keyof typeof QUOTES]] as (value: unknown) => ReturnType<CoxTransactions["quoteDeposit"]>).call(transactions, input));
    }
    if (b === "submit") return send(res, await submissions.submit(input.transaction));
    if (b === "prepare-position") return send(res, await (transactions.preparePosition as (value: unknown) => ReturnType<CoxTransactions["preparePosition"]>).call(transactions, input));
    if (a === "transactions" && Object.hasOwn(EPOCH_BUILDERS, b!)) {
      const source = epochSource();
      const method = EPOCH_BUILDERS[b as keyof typeof EPOCH_BUILDERS];
      return send(res, await (source[method] as (value: unknown) => ReturnType<EpochSource["entry"]>).call(source, input));
    }
    const builder = BUILDERS.find((name) => name === b);
    if (!builder) throw new ApiError(404, "NOT_FOUND", "not found");
    const built = await (transactions[builder] as (value: unknown) => ReturnType<CoxTransactions["deposit"]>).call(transactions, input);
    return send(res, built);
  }

  async function send(res: ServerResponse, data: unknown, at = now()): Promise<void> {
    const [deployment, status] = await Promise.all([source.deployment(), source.status(at)]);
    write(res, 200, { schemaVersion: COX_APP_API_SCHEMA_VERSION, deployment, status, data });
  }

  async function publication(res: ServerResponse, which: string): Promise<void> {
    const at = now();
    if (which === "latest") {
      const latest = await source.latest(at);
      if (!latest) throw new ApiError(404, "NO_PUBLICATION", "no publication has been committed yet");
      return send(res, latest, at);
    }
    const wanted = sequence(which, "sequence");
    const found = await source.publication(wanted, at);
    if (!found) throw new ApiError(404, "PUBLICATION_NOT_FOUND", `publication ${wanted} not found`);
    return send(res, found, at);
  }

  async function page(url: URL, res: ServerResponse): Promise<void> {
    const from = after(url.searchParams.get("after"));
    const limitText = url.searchParams.get("limit");
    const limit = limitText === null ? DEFAULT_PAGE : sequence(limitText, "limit");
    if (limit < 1 || limit > MAX_PAGE) throw new ApiError(400, "INVALID_REQUEST", `limit must be between 1 and ${MAX_PAGE}`);
    const at = now();
    const events = (await source.publications(at, from, limit)).map(event);
    const body: CoxPublicationPage = { events, nextAfter: events.at(-1)?.sequence ?? from };
    return send(res, body, at);
  }

  async function stream(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const header = req.headers["last-event-id"];
    let last = after(Array.isArray(header) ? header[0] : header ?? url.searchParams.get("after"));
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
    const emit = (p: Publication) => {
      if (last !== null && p.identity.sequence <= last) return;
      last = p.identity.sequence;
      res.write(`id: ${last}\nevent: publication\ndata: ${JSON.stringify(event(p))}\n\n`);
    };
    const pending: Publication[] = [];
    let replaying = true;
    const unsubscribe = source.onPublication((p) => (replaying ? pending.push(p) : emit(p)));
    for (const p of await replay(source, now(), last)) emit(p);
    replaying = false;
    for (const p of pending) emit(p);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    cors(res, corsOrigin);
    if (req.method === "OPTIONS" && corsOrigin) {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "accept, content-type, last-event-id, cache-control",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (path[0] === "v1" && path[1] === "faucet") return faucetRoute(req, res, url, path);
    if (req.method === "POST" && path[0] === "v1" && (path[1] === "transactions" || path[1] === "quotes")) return post(req, res, path);
    if (req.method !== "GET") {
      res.setHeader("allow", path[1] === "transactions" ? "POST" : "GET");
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "method not allowed");
    }
    if (url.pathname === "/health") return write(res, 200, { status: "ok" });
    if (path[0] !== "v1") throw new ApiError(404, "NOT_FOUND", "not found");
    const [, a, b, c] = path;
    if (path.length === 2 && a === "deployment") return send(res, await source.deployment());
    if (path.length === 2 && a === "status") return send(res, await source.status(now()));
    if (path.length === 2 && a === "crypto") return send(res, await source.crypto());
    if (path.length === 2 && a === "assets") return send(res, await source.assets(now()));
    if (path.length === 3 && a === "assets") {
      if (!ASSET_PATTERN.test(b!)) throw new ApiError(400, "INVALID_REQUEST", "invalid asset");
      const asset = (await source.assets(now())).find((x) => x.assetId === b);
      if (!asset) throw new ApiError(404, "UNKNOWN_ASSET", `asset ${b} is not in the roster`);
      return send(res, asset);
    }
    if (path.length === 2 && a === "stream") {
      const wallet = url.searchParams.get("wallet");
      if (wallet !== null && !OWNER_PATTERN.test(wallet)) throw new ApiError(400, "INVALID_REQUEST", "invalid wallet");
      const header = req.headers["last-event-id"];
      const from = after(Array.isArray(header) ? header[0] : header ?? url.searchParams.get("after"));
      return live.open(req, res, visitor(req), wallet, from);
    }
    if (path.length === 2 && a === "publications") return page(url, res);
    if (path.length === 2 && a === "preview") return send(res, latestPreview());
    if (path.length === 3 && a === "preview" && b === "history") {
      const history = options.previewHistory;
      if (!history) throw new ApiError(409, "NOT_CONFIGURED", "this deployment serves no preview history");
      const number = (name: string): number => {
        const value = url.searchParams.get(name);
        if (value === null || !/^[0-9]{1,12}$/.test(value)) throw new ApiError(400, "INVALID_REQUEST", `${name} must be a whole number`);
        return Number(value);
      };
      let result: ReturnType<PreviewHistory["query"]>;
      try {
        result = history.query(number("from"), number("to"), number("step"));
      } catch (error) {
        if (error instanceof HistoryRangeError) throw new ApiError(400, "INVALID_REQUEST", error.message);
        throw error;
      }
      const body = { schemaVersion: COX_APP_API_SCHEMA_VERSION, deployment: await source.deployment(), data: result.data };
      return write(res, 200, body, result.complete ? "public, max-age=86400, immutable" : "no-store");
    }
    if (path.length === 3 && a === "preview" && b === "portfolio") {
      const wallet = url.searchParams.get("owner");
      if (wallet === null || !OWNER_PATTERN.test(wallet)) throw new ApiError(400, "INVALID_REQUEST", "owner is required");
      const preview = latestPreview();
      const [portfolio, status] = await Promise.all([source.portfolio(wallet), source.status(now())]);
      if (!portfolio) throw new ApiError(404, "UNKNOWN_WALLET", "wallet has no positions or requests");
      return send(res, previewPortfolio(preview, portfolio, status.latestSequence, options.classes ?? []));
    }
    if (path.length === 3 && a === "publications" && b === "stream") return stream(req, url, res);
    if (path.length === 3 && a === "publications") return publication(res, b!);
    if (path.length === 2 && a === "epochs") return send(res, await epochSource().overview());
    if (path.length === 3 && a === "epochs") {
      const found = await epochSource().epoch(opensAt(b));
      if (!found) throw new ApiError(404, "UNKNOWN_EPOCH", `no Epoch opens at ${b}`);
      return send(res, found);
    }
    if (path.length === 4 && a === "epochs" && c === "history") {
      const history = options.previewHistory;
      if (!history) throw new ApiError(409, "NOT_CONFIGURED", "this deployment serves no preview history");
      const step = Number(url.searchParams.get("step") ?? "60");
      if (step !== 60 && step !== 300) throw new ApiError(400, "INVALID_REQUEST", "step must be 60 or 300");
      const epoch = await epochSource().epoch(opensAt(b));
      if (!epoch) throw new ApiError(404, "UNKNOWN_EPOCH", `no Epoch opens at ${b}`);
      const assets = epoch.universe.map((asset) => asset.assetId);
      const to = Math.min(epoch.closesAt, Math.floor(now() / step) * step);
      const empty = { data: { assets, step, from: epoch.opensAt, to: epoch.opensAt, points: [] }, complete: false };
      let result: ReturnType<PreviewHistory["window"]>;
      try {
        result = to > epoch.opensAt ? history.window(epoch.opensAt, to, step, assets) : empty;
      } catch (error) {
        if (error instanceof HistoryRangeError) throw new ApiError(410, "HISTORY_EXPIRED", error.message);
        throw error;
      }
      const body = { schemaVersion: COX_APP_API_SCHEMA_VERSION, deployment: await source.deployment(), data: result.data };
      return write(res, 200, body, result.complete && to === epoch.closesAt ? "public, max-age=86400, immutable" : "no-store");
    }
    if (path.length === 4 && a === "epochs" && c === "lots") {
      const wallet = url.searchParams.get("owner");
      if (wallet === null || !OWNER_PATTERN.test(wallet)) throw new ApiError(400, "INVALID_REQUEST", "owner is required");
      return send(res, await epochSource().lots(opensAt(b), wallet));
    }
    if (path.length === 3 && a === "quotes" && Object.hasOwn(QUOTES, b!)) {
      res.setHeader("allow", "POST");
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "method not allowed");
    }
    if (path.length === 3 && a === "transactions") {
      if (b === "submit" || BUILDERS.some((name) => name === b) || Object.hasOwn(EPOCH_BUILDERS, b!) || b === "prepare-position") {
        res.setHeader("allow", "POST");
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "method not allowed");
      }
      if (!submissions) throw new ApiError(409, "NOT_LIVE", "transactions are tracked only by a live deployment");
      const submission = await submissions.get(b!);
      if (!submission) throw new ApiError(404, "TRANSACTION_NOT_FOUND", "this API did not submit that transaction");
      return send(res, submission);
    }
    if (path.length === 4 && a === "wallets" && c === "portfolio") {
      if (!OWNER_PATTERN.test(b!)) throw new ApiError(400, "INVALID_REQUEST", "invalid owner");
      const portfolio = await source.portfolio(b!);
      if (!portfolio) throw new ApiError(404, "UNKNOWN_WALLET", "wallet has no positions or requests");
      return send(res, portfolio);
    }
    throw new ApiError(404, "NOT_FOUND", "not found");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      const errorBody = (code: CoxErrorCode, message: string) => ({ schemaVersion: COX_APP_API_SCHEMA_VERSION, error: { code, message } });
      if (error instanceof ApiError) return write(res, error.status, errorBody(error.code, error.message));
      if (error instanceof FaucetError) {
        if (error.retryAt !== null) res.setHeader("retry-after", String(Math.max(1, error.retryAt - now())));
        return write(res, error.status, errorBody(error.code, error.message));
      }
      if (error instanceof TransactionInputError) return write(res, 400, errorBody("INVALID_REQUEST", error.message));
      if (error instanceof StreamLimitError) {
        res.setHeader("retry-after", "10");
        return write(res, 429, errorBody("RATE_LIMITED", error.message));
      }
      if (error instanceof FeeChangedError) return write(res, 409, errorBody("FEE_CHANGED", error.message));
      if (error instanceof TradingClosedError) return write(res, 409, errorBody("TRADING_CLOSED", error.message));
      if (error instanceof NothingToDoError) return write(res, 409, errorBody("NOTHING_TO_DO", error.message));
      if (error instanceof TransactionRejectedError) return write(res, 422, errorBody("TRANSACTION_REJECTED", error.message));
      if (error instanceof URIError) return write(res, 400, errorBody("INVALID_REQUEST", "invalid path encoding"));
      options.onError?.(error);
      if (!res.headersSent) write(res, 500, errorBody("INTERNAL_ERROR", "internal error"));
    });
  });
  server.on("close", () => live.stop());
  return server;
}
