import type { IncomingMessage, ServerResponse } from "node:http";
import type { CoxPublicationEvent, CoxStatus, Portfolio, Publication, WalletPortfolioEvent } from "@eox/app-api";
import type { PreviewFeed } from "./preview.js";
import { replay } from "./replay.js";
import type { CoxSource } from "./source.js";

const HEARTBEAT_MS = 15_000;
const RETRY_MS = 3_000;

export interface CoxLiveStreamOptions {
  source: CoxSource;
  preview?: PreviewFeed | null;
  now: () => number;
  statusMs?: number;
  portfolioMs?: number;
  maxConnections?: number;
  maxPerClient?: number;
  maxWallets?: number;
  onError?: (error: unknown) => void;
}

export class StreamLimitError extends Error {}

interface Connection {
  client: string;
  wallet: string | null;
  last: number | null;
  pending: Publication[] | null;
  send(event: string, data: unknown, id?: number): void;
}

interface WalletWatch {
  connections: Set<Connection>;
  current: string | undefined;
  refreshing: Promise<void> | null;
  again: boolean;
}

const statusSignature = (status: CoxStatus): string => {
  const { asOf: _asOf, ageSeconds: _age, currentBatch: _batch, ...rest } = status;
  return JSON.stringify(rest);
};

export class CoxLiveStream {
  private readonly connections = new Set<Connection>();
  private readonly perClient = new Map<string, number>();
  private readonly wallets = new Map<string, WalletWatch>();
  private status: CoxStatus | null = null;
  private signature: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe: (() => void) | null = null;
  private unsubscribePreview: (() => void) | null = null;

  constructor(private readonly options: CoxLiveStreamOptions) {}

  async open(req: IncomingMessage, res: ServerResponse, client: string, wallet: string | null, from: number | null): Promise<void> {
    const maxConnections = this.options.maxConnections ?? 500;
    const maxPerClient = this.options.maxPerClient ?? 8;
    const maxWallets = this.options.maxWallets ?? 200;
    if (this.connections.size >= maxConnections) throw new StreamLimitError("the stream is at capacity; reconnect shortly");
    if ((this.perClient.get(client) ?? 0) >= maxPerClient) throw new StreamLimitError("too many open streams from this client");
    if (wallet !== null && !this.wallets.has(wallet) && this.wallets.size >= maxWallets) throw new StreamLimitError("too many wallets are being watched; reconnect shortly");

    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff", "x-accel-buffering": "no" });
    res.write(`retry: ${RETRY_MS}\n\n`);
    const connection: Connection = {
      client,
      wallet,
      last: from,
      pending: [],
      send: (event, data, id) => {
        res.write(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
    };
    this.attach(connection);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      this.detach(connection);
    });

    const now = this.options.now();
    const status = this.status ?? (await this.options.source.status(now));
    if (!this.status) this.remember(status);
    connection.send("status", status);
    const history = from === null ? [(await this.options.source.latest(now))].filter((p): p is Publication => p !== null) : await replay(this.options.source, now, from);
    const live = connection.pending ?? [];
    connection.pending = null;
    for (const publication of [...history, ...live]) this.publication(connection, publication);
    const preview = this.options.preview?.latest(this.options.now());
    if (preview) connection.send("preview", preview);
    if (wallet !== null) {
      const watch = this.wallets.get(wallet)!;
      if (watch.current !== undefined) connection.send("portfolio", JSON.parse(watch.current) as WalletPortfolioEvent);
      else void this.refresh(wallet);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribePreview?.();
    this.unsubscribePreview = null;
  }

  get size(): number {
    return this.connections.size;
  }

  private attach(connection: Connection): void {
    this.connections.add(connection);
    this.perClient.set(connection.client, (this.perClient.get(connection.client) ?? 0) + 1);
    if (connection.wallet !== null) {
      const watch = this.wallets.get(connection.wallet) ?? { connections: new Set(), current: undefined, refreshing: null, again: false };
      watch.connections.add(connection);
      this.wallets.set(connection.wallet, watch);
    }
    if (this.connections.size === 1) this.start();
  }

  private detach(connection: Connection): void {
    if (!this.connections.delete(connection)) return;
    const count = (this.perClient.get(connection.client) ?? 1) - 1;
    if (count <= 0) this.perClient.delete(connection.client);
    else this.perClient.set(connection.client, count);
    if (connection.wallet !== null) {
      const watch = this.wallets.get(connection.wallet);
      watch?.connections.delete(connection);
      if (watch && watch.connections.size === 0) this.wallets.delete(connection.wallet);
    }
    if (this.connections.size === 0) {
      this.stop();
      this.status = null;
      this.signature = null;
    }
  }

  private start(): void {
    this.unsubscribe = this.options.source.onPublication((publication) => {
      for (const connection of this.connections) this.publication(connection, publication);
      void this.checkStatus();
      for (const wallet of this.wallets.keys()) void this.refresh(wallet);
    });
    this.unsubscribePreview =
      this.options.preview?.onPreview((preview) => {
        for (const connection of this.connections) if (!connection.pending) connection.send("preview", preview);
      }) ?? null;
    const statusTimer = setInterval(() => void this.checkStatus(), this.options.statusMs ?? 5_000);
    const portfolioTimer = setInterval(() => {
      for (const wallet of this.wallets.keys()) void this.refresh(wallet);
    }, this.options.portfolioMs ?? 15_000);
    statusTimer.unref();
    portfolioTimer.unref();
    this.timers = [statusTimer, portfolioTimer];
  }

  private publication(connection: Connection, publication: Publication): void {
    if (connection.pending) {
      connection.pending.push(publication);
      return;
    }
    const sequence = publication.identity.sequence;
    if (connection.last !== null && sequence <= connection.last) return;
    connection.last = sequence;
    const event: CoxPublicationEvent = { sequence, publication };
    connection.send("publication", event, sequence);
  }

  private remember(status: CoxStatus): boolean {
    const signature = statusSignature(status);
    const changed = signature !== this.signature;
    this.status = status;
    this.signature = signature;
    return changed;
  }

  private async checkStatus(): Promise<void> {
    try {
      const status = await this.options.source.status(this.options.now());
      if (this.remember(status)) for (const connection of this.connections) connection.send("status", status);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private refresh(wallet: string): Promise<void> {
    const watch = this.wallets.get(wallet);
    if (!watch) return Promise.resolve();
    if (watch.refreshing) {
      watch.again = true;
      return watch.refreshing;
    }
    watch.refreshing = (async () => {
      do {
        watch.again = false;
        try {
          const portfolio: Portfolio | null = await this.options.source.portfolio(wallet);
          const event: WalletPortfolioEvent = { owner: wallet, portfolio };
          const text = JSON.stringify(event);
          if (text !== watch.current) {
            watch.current = text;
            for (const connection of watch.connections) connection.send("portfolio", event);
          }
        } catch (error) {
          this.options.onError?.(error);
        }
      } while (watch.again && this.wallets.get(wallet) === watch);
      watch.refreshing = null;
    })();
    return watch.refreshing;
  }
}
