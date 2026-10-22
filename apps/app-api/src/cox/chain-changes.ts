const STORAGE = "https://storage.googleapis.com/storage/v1";
const GCS_URL = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,61}[a-z0-9])\/((?:[A-Za-z0-9._-]+\/)*)$/;
const NAME = /^([0-9]{20})-([0-9a-f]{64})\.json$/;
const DIGEST = /^[0-9a-f]{64}$/;
const REVISION = /^(0|[1-9][0-9]*)$/;
const LOOKBACK_MS = 120_000;
const HEARTBEAT_LIMIT_MS = 60_000;

export const CHAIN_NOTIFICATION_SCHEMA = "relative.chain-notification/v1";
export const CHAIN_CHANGE_SCHEMA = "relative.chain-change/v1";

export interface ChainChange {
  generation: string;
  revision: bigint;
  observedSlot: number;
  streamHealthy: boolean;
}

export interface ChainNotification {
  name: string;
  timestampMs: number;
  change: ChainChange;
}

export interface ChainChangeIdentity {
  networks: readonly string[];
  program: string;
  pools: readonly string[];
}

export interface ChainChangeStore {
  list(startOffset: string): Promise<string[]>;
  read(name: string): Promise<string>;
}

export class ChainChangeInvalid extends Error {}

function fail(message: string): never {
  throw new ChainChangeInvalid(message);
}

export const notificationName = (ms: number): string => String(ms).padStart(20, "0");

export function parseChainChange(value: unknown): ChainChange {
  const change = value as Record<string, unknown> | null;
  if (typeof change !== "object" || change === null || change.schema !== CHAIN_CHANGE_SCHEMA) fail("chainChange has an unknown schema");
  if (typeof change.generation !== "string" || !DIGEST.test(change.generation)) fail("chainChange generation is not 64 lowercase hex");
  if (typeof change.revision !== "string" || !REVISION.test(change.revision)) fail("chainChange revision is not an unsigned decimal");
  if (typeof change.observedSlot !== "number" || !Number.isSafeInteger(change.observedSlot) || change.observedSlot < 0) fail("chainChange observedSlot is not a slot");
  if (change.commitment !== "confirmed") fail("chainChange commitment is not confirmed");
  if (typeof change.streamHealthy !== "boolean") fail("chainChange streamHealthy is not a boolean");
  return { generation: change.generation, revision: BigInt(change.revision), observedSlot: change.observedSlot, streamHealthy: change.streamHealthy };
}

export function parseNotification(name: string, text: string, identity: ChainChangeIdentity): ChainNotification {
  const match = NAME.exec(name);
  if (!match) fail(`notification ${name} has an unexpected name`);
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    fail(`notification ${name} is not JSON`);
  }
  if (typeof value !== "object" || value === null || value.schema !== CHAIN_NOTIFICATION_SCHEMA) fail(`notification ${name} has an unknown schema`);
  if (typeof value.timestampMs !== "number" || !Number.isSafeInteger(value.timestampMs) || notificationName(value.timestampMs) !== match[1]) fail(`notification ${name} carries another time`);
  if (typeof value.network !== "string" || !identity.networks.includes(value.network) || value.program !== identity.program || typeof value.pool !== "string" || !identity.pools.includes(value.pool)) fail(`notification ${name} is for another network, program or pool`);
  return { name, timestampMs: value.timestampMs, change: parseChainChange(value.chainChange) };
}

export function gcsChainChangeStore(url: string, accessToken: () => Promise<string>, request: typeof fetch = fetch): ChainChangeStore & { prefix: string } {
  const match = GCS_URL.exec(url);
  if (!match) throw new Error("the chain change location must be a gs://bucket/prefix/ URL ending in a slash");
  const [, bucket, prefix] = match as unknown as [string, string, string];
  const base = `${STORAGE}/b/${encodeURIComponent(bucket)}/o`;
  const get = async (target: string): Promise<Response> => {
    const response = await request(target, { headers: { authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`chain change storage returned HTTP ${response.status}`);
    return response;
  };
  return {
    prefix,
    async list(startOffset) {
      const names: string[] = [];
      let token: string | undefined;
      do {
        const query = new URLSearchParams({ prefix, startOffset: `${prefix}${startOffset}`, fields: "items(name),nextPageToken", maxResults: "1000" });
        if (token) query.set("pageToken", token);
        const listing = (await (await get(`${base}?${query}`)).json()) as { items?: { name: string }[]; nextPageToken?: string };
        for (const item of listing.items ?? []) names.push(item.name.slice(prefix.length));
        token = listing.nextPageToken;
      } while (token);
      return names.filter((name) => NAME.test(name)).sort();
    },
    async read(name) {
      return (await get(`${base}/${encodeURIComponent(`${prefix}${name}`)}?alt=media`)).text();
    },
  };
}

export interface ChainChangeFeedOptions {
  store: ChainChangeStore;
  identity: ChainChangeIdentity;
  nowMs: () => number;
  pollMs?: number;
  onError?: (error: unknown) => void;
}

export interface ChainFeedState {
  healthy: boolean;
  revision: string | null;
  observedAt: number | null;
}

export class ChainChangeFeed {
  private cursor: string | null = null;
  private generation: string | null = null;
  private revision: bigint | null = null;
  private lastMs: number | null = null;
  private streamHealthy = false;
  private listingFailed = false;
  private wasHealthy = false;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly listeners = new Set<(observedSlot: number | null) => void>();

  constructor(private readonly options: ChainChangeFeedOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 1_000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onChange(listener: (observedSlot: number | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  state(nowMs = this.options.nowMs()): ChainFeedState {
    return {
      healthy: this.healthy(nowMs),
      revision: this.revision === null ? null : this.revision.toString(),
      observedAt: this.lastMs === null ? null : Math.floor(this.lastMs / 1000),
    };
  }

  private healthy(nowMs: number): boolean {
    return !this.listingFailed && this.streamHealthy && this.lastMs !== null && nowMs - this.lastMs <= HEARTBEAT_LIMIT_MS;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const nowMs = this.options.nowMs();
    let catchUp = this.cursor === null;
    let changed = false;
    let observedSlot: number | null = null;
    try {
      const after = this.cursor ?? notificationName(nowMs - LOOKBACK_MS);
      const names = (await this.options.store.list(after)).filter((name) => this.cursor === null || name > this.cursor);
      this.listingFailed = false;
      for (const name of names) {
        const text = await this.options.store.read(name);
        this.cursor = name;
        let notification: ChainNotification;
        try {
          notification = parseNotification(name, text, this.options.identity);
        } catch (error) {
          if (!(error instanceof ChainChangeInvalid)) throw error;
          this.options.onError?.(error);
          continue;
        }
        const { change } = notification;
        this.lastMs = Math.max(this.lastMs ?? 0, notification.timestampMs);
        this.streamHealthy = change.streamHealthy;
        if (this.generation !== change.generation) {
          catchUp ||= this.generation !== null;
          this.generation = change.generation;
          this.revision = change.revision;
          changed = true;
        } else if (this.revision === null || change.revision > this.revision) {
          catchUp ||= this.revision !== null && change.revision > this.revision + 1n;
          this.revision = change.revision;
          changed = true;
        } else continue;
        observedSlot = Math.max(observedSlot ?? 0, change.observedSlot);
      }
    } catch (error) {
      this.listingFailed = true;
      this.options.onError?.(error);
    } finally {
      this.running = false;
    }
    const healthy = this.healthy(this.options.nowMs());
    if (healthy && !this.wasHealthy) catchUp = true;
    this.wasHealthy = healthy;
    if (catchUp || changed) for (const listener of this.listeners) listener(observedSlot);
  }
}
