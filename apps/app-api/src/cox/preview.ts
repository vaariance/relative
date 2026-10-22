import { PREVIEW_SCHEMA, type Portfolio, type Preview, type PreviewPortfolio, type PreviewProjection, type PreviewRecord } from "@eox/app-api";

const STORAGE = "https://storage.googleapis.com/storage/v1";
const GCS_URL = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,61}[a-z0-9])\/((?:[A-Za-z0-9._-]+\/)*)$/;
const AMOUNT = /^(0|[1-9][0-9]*)$/;
const POSITIVE = /^[1-9][0-9]*$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SECONDS = /^[0-9]{10}$/;
const SCALES = { price: "100000000", reference: "1000000000000", collateral: "1000000" } as const;
const LOOKBACK_SECONDS = 300;

export interface PreviewIdentity {
  networks: readonly string[];
  program: string;
  pools: readonly string[];
  methodologyDigest: string;
  assets: readonly string[];
}

export interface PreviewStore {
  newest(after: number): Promise<number | null>;
  read(timestamp: number): Promise<string | null>;
}

export class PreviewInvalid extends Error {}

function fail(message: string): never {
  throw new PreviewInvalid(message);
}

function integer(value: unknown, name: string): number {
  const number = typeof value === "string" && AMOUNT.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) fail(`${name} is not a whole number`);
  return number;
}

function amount(value: unknown, name: string, pattern = AMOUNT): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${name} is not a decimal integer string`);
  return value;
}

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(`${name} is not a SHA-256 digest`);
  return value;
}

function projection(value: unknown, classes: number): PreviewProjection | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === undefined) fail("basicProjection is malformed");
  const p = value as Record<string, unknown>;
  integer(p.sequence, "basicProjection.sequence");
  digest(p.stateDigest, "basicProjection.stateDigest");
  integer(p.publicationTimestamp, "basicProjection.publicationTimestamp");
  amount(p.addedResidual, "basicProjection.addedResidual");
  if (!Array.isArray(p.classes) || p.classes.length !== classes) fail(`basicProjection must list ${classes} classes`);
  p.classes.forEach((row: Record<string, unknown>, i) => {
    if (integer(row?.classId, "basicProjection class") !== i) fail(`basicProjection class ${i} is out of order`);
    amount(row.backing, `basicProjection class ${i} backing`);
    amount(row.units, `basicProjection class ${i} units`);
  });
  return value as PreviewProjection;
}

export function parsePreview(text: string, timestamp: number, identity: PreviewIdentity): PreviewRecord {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    fail(`preview ${timestamp} is not JSON`);
  }
  if (typeof value !== "object" || value === null) fail(`preview ${timestamp} is not an object`);
  if (value.schema !== PREVIEW_SCHEMA || value.status !== "estimate") fail(`preview ${timestamp} has schema ${String(value.schema)} and status ${String(value.status)}`);
  if (integer(value.timestamp, "timestamp") !== timestamp) fail(`preview ${timestamp} carries timestamp ${String(value.timestamp)}`);
  if (typeof value.network !== "string" || !identity.networks.includes(value.network)) fail(`preview ${timestamp} is for another network`);
  if (value.program !== identity.program || typeof value.pool !== "string" || !identity.pools.includes(value.pool)) fail(`preview ${timestamp} is for another program or pool`);
  if (digest(value.methodologyDigest, "methodologyDigest") !== identity.methodologyDigest) fail(`preview ${timestamp} is for another methodology`);
  digest(value.universeDigest, "universeDigest");
  amount(value.benchmark, "benchmark", POSITIVE);
  const scales = value.scales as Record<string, unknown> | undefined;
  for (const [name, expected] of Object.entries(SCALES)) if (String(scales?.[name]) !== expected) fail(`preview ${timestamp} uses ${name} scale ${String(scales?.[name])}`);
  const n = identity.assets.length;
  if (!Array.isArray(value.assets) || value.assets.length !== n) fail(`preview ${timestamp} must list ${n} assets`);
  value.assets.forEach((row: Record<string, unknown>, i) => {
    if (integer(row?.classId, "asset classId") !== i || row.assetId !== identity.assets[i]) fail(`preview ${timestamp} asset ${i} is not ${identity.assets[i]}`);
    amount(row.priceE8, `${identity.assets[i]} priceE8`, POSITIVE);
    amount(row.reference, `${identity.assets[i]} reference`, POSITIVE);
  });
  if (integer(value.cryptoClass, "cryptoClass") !== n) fail(`preview ${timestamp} puts CRYPTO at class ${String(value.cryptoClass)}`);
  if (value.cryptoReference !== (100n * BigInt(SCALES.reference)).toString()) fail(`preview ${timestamp} has CRYPTO reference ${String(value.cryptoReference)}`);
  projection(value.basicProjection, n + 1);
  return value as unknown as PreviewRecord;
}

export function gcsPreviewStore(url: string, accessToken: () => Promise<string>, request: typeof fetch = fetch): PreviewStore {
  const match = GCS_URL.exec(url);
  if (!match) throw new Error("the preview location must be a gs://bucket/prefix/ URL ending in a slash");
  const [, bucket, prefix] = match as unknown as [string, string, string];
  const base = `${STORAGE}/b/${encodeURIComponent(bucket)}/o`;
  const get = async (target: string): Promise<Response> => {
    const response = await request(target, { headers: { authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok && response.status !== 404) throw new Error(`preview storage returned HTTP ${response.status}`);
    return response;
  };
  return {
    async newest(after) {
      let newest: number | null = null;
      let token: string | undefined;
      do {
        const query = new URLSearchParams({ prefix, startOffset: `${prefix}${after + 1}.json`, fields: "items(name),nextPageToken", maxResults: "1000" });
        if (token) query.set("pageToken", token);
        const response = await get(`${base}?${query}`);
        if (response.status === 404) throw new Error("preview bucket not found");
        const listing = (await response.json()) as { items?: { name: string }[]; nextPageToken?: string };
        for (const { name } of listing.items ?? []) {
          const stem = name.slice(prefix.length).replace(/\.json$/, "");
          if (name !== `${prefix}${stem}.json` || !SECONDS.test(stem)) continue;
          const seconds = Number(stem);
          if (seconds > after && (newest === null || seconds > newest)) newest = seconds;
        }
        token = listing.nextPageToken;
      } while (token);
      return newest;
    },
    async read(timestamp) {
      const response = await get(`${base}/${encodeURIComponent(`${prefix}${timestamp}.json`)}?alt=media`);
      if (response.status === 404) return null;
      return response.text();
    },
  };
}

export interface PreviewFeedOptions {
  store: PreviewStore;
  identity: PreviewIdentity;
  now: () => number;
  pollMs?: number;
  staleSeconds?: number;
  onError?: (error: unknown) => void;
}

export class PreviewFeed {
  private record: PreviewRecord | null = null;
  private cursor: number | null = null;
  private stale: boolean | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly listeners = new Set<(preview: Preview) => void>();

  constructor(private readonly options: PreviewFeedOptions) {}

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

  latest(now = this.options.now()): Preview | null {
    if (!this.record) return null;
    const ageSeconds = Math.max(0, now - this.record.timestamp);
    return { record: this.record, ageSeconds, stale: ageSeconds > (this.options.staleSeconds ?? 10) };
  }

  onPreview(listener: (preview: Preview) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.options.now();
      const after = this.cursor ?? now - LOOKBACK_SECONDS;
      const newest = await this.options.store.newest(after);
      if (newest !== null) {
        this.cursor = newest;
        const text = await this.options.store.read(newest);
        if (text !== null) {
          this.record = parsePreview(text, newest, this.options.identity);
          this.stale = null;
        }
      }
      const preview = this.latest(now);
      if (preview && preview.stale !== this.stale) {
        this.stale = preview.stale;
        for (const listener of this.listeners) listener(preview);
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.running = false;
    }
  }
}

export function previewPortfolio(preview: Preview, portfolio: Portfolio, latestSequence: number | null, classes: readonly string[]): PreviewPortfolio {
  const basis = preview.record.basicProjection;
  const unavailable = basis === null ? "no-projection" : basis.sequence !== latestSequence ? "basis-mismatch" : null;
  let total = 0n;
  const positions = portfolio.positions.map((position) => {
    let estimatedValue: string | null = null;
    if (basis && unavailable === null) {
      const index = classes.indexOf(position.classId);
      const row = basis.classes[index];
      if (!row) throw new Error(`preview projection has no class ${position.classId}`);
      const units = BigInt(row.units);
      const value = units === 0n ? 0n : (BigInt(position.units) * BigInt(row.backing)) / units;
      total += value;
      estimatedValue = value.toString();
    }
    return { classId: position.classId, units: position.units, locked: position.locked, estimatedValue };
  });
  return {
    owner: portfolio.owner,
    timestamp: preview.record.timestamp,
    stale: preview.stale,
    basisSequence: basis?.sequence ?? null,
    unavailable,
    positions,
    estimatedValue: unavailable === null ? total.toString() : null,
  };
}
