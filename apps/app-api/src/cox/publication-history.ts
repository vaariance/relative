import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Publication } from "@eox/app-api";

const TAIL_SCHEMA = "cox.app-api.publications/v1";
const SEGMENT_SCHEMA = "cox.app-api.history-segment/v1";
const STORAGE = "https://storage.googleapis.com/storage/v1";
const UPLOAD = "https://storage.googleapis.com/upload/storage/v1";
const GCS_URL = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,61}[a-z0-9])\/((?:[A-Za-z0-9._-]+\/)*)$/;
const SEGMENT_NAME = /^seg-([0-9]{12})-([0-9]{12})-(x|[0-9]{1,16})-([0-9]{1,16})\.json$/;

export interface SegmentStore {
  list(): Promise<string[]>;
  read(name: string): Promise<string | null>;
  create(name: string, text: string): Promise<"created" | "exists">;
}

interface Identity {
  program: string;
  pool: string;
}

interface SegmentName {
  name: string;
  start: number;
  end: number;
  firstPredecessorBatch: number | null;
  lastBatch: number;
}

interface SegmentFile extends Identity {
  schema: typeof SEGMENT_SCHEMA;
  start: number;
  end: number;
  publications: Publication[];
}

export interface PublicationHistoryOptions {
  path: string;
  store: SegmentStore;
  identity: Identity;
  firstSequence?: number;
  segmentSize?: number;
  cacheSegments?: number;
}

const pad = (value: number): string => String(value).padStart(12, "0");

function segmentName(publications: readonly Publication[]): string {
  const first = publications[0]!.identity;
  const last = publications.at(-1)!.identity;
  return `seg-${pad(first.sequence)}-${pad(last.sequence)}-${first.predecessorBatch ?? "x"}-${last.batch}.json`;
}

function parseName(name: string): SegmentName | null {
  const match = SEGMENT_NAME.exec(name);
  if (!match) return null;
  const [, start, end, predecessor, last] = match as unknown as [string, string, string, string, string];
  return { name, start: Number(start), end: Number(end), firstPredecessorBatch: predecessor === "x" ? null : Number(predecessor), lastBatch: Number(last) };
}

function follows(publication: Publication, previous: { sequence: number; batch: number } | null, first: number): void {
  const { sequence, predecessorBatch } = publication.identity;
  const expected = previous ? previous.sequence + 1 : first;
  if (sequence !== expected) throw new Error(`publication ${sequence} is out of order; expected ${expected}`);
  if ((previous?.batch ?? null) !== predecessorBatch) throw new Error(`publication ${sequence} does not follow batch ${previous?.batch ?? "none"}`);
}

export function directorySegments(directory: string): SegmentStore {
  mkdirSync(directory, { recursive: true });
  return {
    async list() {
      return (await readdir(directory)).filter((name) => SEGMENT_NAME.test(name));
    },
    async read(name) {
      try {
        return await readFile(join(directory, name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async create(name, text) {
      const temporary = join(directory, `.${name}.${process.pid}.tmp`);
      writeFileSync(temporary, text);
      try {
        linkSync(temporary, join(directory, name));
        return "created";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
        throw error;
      } finally {
        unlinkSync(temporary);
      }
    },
  };
}

export function gcsSegments(url: string, accessToken: () => Promise<string>, request: typeof fetch = fetch): SegmentStore {
  const match = GCS_URL.exec(url);
  if (!match) throw new Error("the history store must be a gs://bucket/prefix/ URL ending in a slash");
  const [, bucket, prefix] = match as unknown as [string, string, string];
  const objects = `${STORAGE}/b/${encodeURIComponent(bucket)}/o`;
  const call = async (target: string, init: RequestInit = {}): Promise<Response> =>
    request(target, { ...init, headers: { ...init.headers, authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(30_000) });
  return {
    async list() {
      const names: string[] = [];
      let page: string | undefined;
      do {
        const response = await call(`${objects}?prefix=${encodeURIComponent(prefix)}&fields=items(name),nextPageToken${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
        if (!response.ok) throw new Error(`history storage returned HTTP ${response.status}`);
        const body = (await response.json()) as { items?: { name: string }[]; nextPageToken?: string };
        for (const item of body.items ?? []) {
          const name = item.name.slice(prefix.length);
          if (SEGMENT_NAME.test(name)) names.push(name);
        }
        page = body.nextPageToken;
      } while (page);
      return names;
    },
    async read(name) {
      const response = await call(`${objects}/${encodeURIComponent(`${prefix}${name}`)}?alt=media`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`history storage returned HTTP ${response.status}`);
      return response.text();
    },
    async create(name, text) {
      const response = await call(`${UPLOAD}/b/${encodeURIComponent(bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(`${prefix}${name}`)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      });
      if (response.status === 412) return "exists";
      if (!response.ok) throw new Error(`history storage returned HTTP ${response.status}`);
      return "created";
    },
  };
}

export class PublicationHistory {
  private readonly segmentSize: number;
  private readonly cacheSegments: number;
  private readonly first: number;
  private readonly segments: SegmentName[] = [];
  private readonly cache = new Map<number, Publication[]>();
  private tail: Publication[] = [];
  private last: Publication | null = null;

  private constructor(private readonly options: PublicationHistoryOptions) {
    this.segmentSize = options.segmentSize ?? 360;
    this.cacheSegments = options.cacheSegments ?? 8;
    this.first = options.firstSequence ?? 0;
    if (!Number.isSafeInteger(this.first) || this.first < 0) throw new Error("firstSequence must be a non-negative integer");
    if (!Number.isSafeInteger(this.segmentSize) || this.segmentSize < 1) throw new Error("segmentSize must be a positive integer");
  }

  static async open(options: PublicationHistoryOptions): Promise<PublicationHistory> {
    const history = new PublicationHistory(options);
    await history.load();
    return history;
  }

  get nextSequence(): number {
    return this.last ? this.last.identity.sequence + 1 : this.first;
  }

  latest(): Publication | null {
    return this.last;
  }

  async get(sequence: number): Promise<Publication | null> {
    if (!Number.isSafeInteger(sequence) || sequence < this.first || sequence >= this.nextSequence) return null;
    const tailStart = this.tailStart;
    if (sequence >= tailStart) return this.tail[sequence - tailStart] ?? null;
    const segment = await this.segment(Math.floor((sequence - this.first) / this.segmentSize));
    return segment[(sequence - this.first) % this.segmentSize] ?? null;
  }

  async page(after: number | null, limit: number): Promise<Publication[]> {
    const out: Publication[] = [];
    let sequence = after === null ? this.first : Math.max(after + 1, this.first);
    while (out.length < limit && sequence < this.nextSequence) {
      const tailStart = this.tailStart;
      if (sequence >= tailStart) {
        out.push(...this.tail.slice(sequence - tailStart, sequence - tailStart + limit - out.length));
        break;
      }
      const index = Math.floor((sequence - this.first) / this.segmentSize);
      const segment = await this.segment(index);
      const from = sequence - this.first - index * this.segmentSize;
      const taken = segment.slice(from, from + limit - out.length);
      out.push(...taken);
      sequence += taken.length;
    }
    return out;
  }

  async append(publication: Publication): Promise<void> {
    follows(publication, this.last ? { sequence: this.last.identity.sequence, batch: this.last.identity.batch } : null, this.first);
    this.tail.push(publication);
    this.last = publication;
    this.appendLine(`${JSON.stringify(publication)}\n`);
    if (this.tail.length >= this.segmentSize) await this.seal();
  }

  private get tailStart(): number {
    return this.first + this.segments.length * this.segmentSize;
  }

  private async load(): Promise<void> {
    const listed = (await this.options.store.list()).map(parseName).filter((s): s is SegmentName => s !== null).sort((a, b) => a.start - b.start);
    let previous: SegmentName | null = null;
    for (const segment of listed) {
      if (segment.start !== this.tailStart || segment.end !== segment.start + this.segmentSize - 1) break;
      if ((previous?.lastBatch ?? null) !== segment.firstPredecessorBatch) throw new Error(`history segment ${segment.name} does not follow ${previous?.name ?? "the origin"}`);
      this.segments.push(segment);
      previous = segment;
    }
    const kept: Publication[] = [];
    if (existsSync(this.options.path)) {
      const text = readFileSync(this.options.path, "utf8");
      const lines = text.split("\n");
      if (!text.endsWith("\n")) lines.pop();
      const [first, ...rest] = lines.filter((line) => line.length > 0);
      const header = first === undefined ? null : (JSON.parse(first) as { schema?: string; program?: string; pool?: string });
      if (!header || header.schema !== TAIL_SCHEMA || header.program !== this.options.identity.program || header.pool !== this.options.identity.pool) {
        throw new Error(`publication log ${this.options.path} belongs to another program or pool`);
      }
      const start = this.tailStart;
      let expected = start;
      for (const line of rest) {
        const publication = JSON.parse(line) as Publication;
        if (publication.identity.sequence < start) continue;
        if (publication.identity.sequence !== expected) break;
        kept.push(publication);
        expected += 1;
      }
    }
    if (this.segments.length > 0) {
      const lastSegment = await this.segment(this.segments.length - 1);
      this.last = lastSegment.at(-1)!;
    }
    this.tail = [];
    for (const publication of kept) {
      follows(publication, this.last ? { sequence: this.last.identity.sequence, batch: this.last.identity.batch } : null, this.first);
      this.tail.push(publication);
      this.last = publication;
    }
    while (this.tail.length >= this.segmentSize) await this.seal(false);
    this.rewriteTail();
  }

  private async seal(rewrite = true): Promise<void> {
    const block = this.tail.slice(0, this.segmentSize);
    const name = segmentName(block);
    const parsed = parseName(name)!;
    const file: SegmentFile = { schema: SEGMENT_SCHEMA, ...this.options.identity, start: parsed.start, end: parsed.end, publications: block };
    const created = await this.options.store.create(name, JSON.stringify(file));
    this.segments.push(parsed);
    this.tail = this.tail.slice(this.segmentSize);
    if (created === "created") this.remember(this.segments.length - 1, block);
    if (rewrite) this.rewriteTail();
  }

  private async segment(index: number): Promise<Publication[]> {
    const cached = this.cache.get(index);
    if (cached) {
      this.cache.delete(index);
      this.cache.set(index, cached);
      return cached;
    }
    const meta = this.segments[index];
    if (!meta) throw new Error(`history segment ${index} is not available`);
    const text = await this.options.store.read(meta.name);
    if (text === null) throw new Error(`history segment ${meta.name} is missing`);
    const file = JSON.parse(text) as SegmentFile;
    if (file.schema !== SEGMENT_SCHEMA || file.program !== this.options.identity.program || file.pool !== this.options.identity.pool) {
      throw new Error(`history segment ${meta.name} belongs to another program or pool`);
    }
    if (file.start !== meta.start || file.end !== meta.end || !Array.isArray(file.publications) || file.publications.length !== meta.end - meta.start + 1) {
      throw new Error(`history segment ${meta.name} does not match its name`);
    }
    file.publications.forEach((publication, i) => {
      const previous = i === 0 ? null : file.publications[i - 1]!.identity;
      if (publication.identity.sequence !== meta.start + i) throw new Error(`history segment ${meta.name} is not contiguous`);
      const expected = i === 0 ? meta.firstPredecessorBatch : previous!.batch;
      if (publication.identity.predecessorBatch !== expected) throw new Error(`history segment ${meta.name} breaks the batch chain`);
    });
    if (file.publications.at(-1)!.identity.batch !== meta.lastBatch) throw new Error(`history segment ${meta.name} does not match its name`);
    this.remember(index, file.publications);
    return file.publications;
  }

  private remember(index: number, publications: Publication[]): void {
    this.cache.set(index, publications);
    while (this.cache.size > this.cacheSegments) this.cache.delete(this.cache.keys().next().value!);
  }

  private header(): string {
    return `${JSON.stringify({ schema: TAIL_SCHEMA, ...this.options.identity })}\n`;
  }

  private rewriteTail(): void {
    mkdirSync(dirname(this.options.path), { recursive: true });
    const temporary = `${this.options.path}.tmp`;
    const fd = openSync(temporary, "w");
    try {
      writeSync(fd, this.header() + this.tail.map((p) => `${JSON.stringify(p)}\n`).join(""));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.options.path);
  }

  private appendLine(text: string): void {
    const fd = openSync(this.options.path, "a");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
