import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Program } from "@coral-xyz/anchor";
import { addresses, checkedPublication, decodeAccount } from "@cox/client";
import type { PublicKey } from "@solana/web3.js";
import type { ChainPublication } from "./chain.js";

const FINALIZED_SCHEMA = "cox.publication-archive/v1";
const CONFIRMED_SCHEMA = "cox.publication-archive/v2";
const ACCOUNT_BYTES = 8192;
const STORAGE = "https://storage.googleapis.com/storage/v1";
const GCS_URL = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,61}[a-z0-9])\/((?:[A-Za-z0-9._-]+\/)*)$/;

interface ArchiveRecord {
  schema: string;
  identity: { program: string; pool: string; genesisHash: string };
  address: string;
  sequence: string;
  batch: string;
  stateDigest: string;
  accountSha256: string;
  accountBase64: string;
  finalizedSlot?: number;
  observedSlot?: number;
  commitment?: string;
}

export interface ArchivedPublication {
  publication: ChainPublication;
  slot: number;
  finalized: boolean;
}

const slotValue = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function provenance(record: ArchiveRecord): { slot: number; finalized: boolean } | null {
  if (record.schema === FINALIZED_SCHEMA && slotValue(record.finalizedSlot) && record.observedSlot === undefined && record.commitment === undefined) {
    return { slot: record.finalizedSlot, finalized: true };
  }
  if (record.schema === CONFIRMED_SCHEMA && slotValue(record.observedSlot) && record.commitment === "confirmed" && record.finalizedSlot === undefined) {
    return { slot: record.observedSlot, finalized: false };
  }
  return null;
}

export class PublicationArchiveMissing extends Error {}

export interface ArchiveSource {
  fetch(sequence: bigint): Promise<string | null>;
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export function directorySource(directory: string): ArchiveSource {
  return {
    async fetch(sequence) {
      try {
        return await readFile(join(directory, `${sequence}.json`), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

export function gcsSource(url: string, accessToken: () => Promise<string>, request: typeof fetch = fetch): ArchiveSource {
  const match = GCS_URL.exec(url);
  if (!match) throw new Error("the archive must be a gs://bucket/prefix/ URL ending in a slash");
  const [, bucket, prefix] = match as unknown as [string, string, string];
  const base = `${STORAGE}/b/${encodeURIComponent(bucket)}/o`;
  const get = async (target: string): Promise<Response> => {
    const response = await request(target, { headers: { authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`archive storage returned HTTP ${response.status}`);
    return response;
  };
  return {
    async fetch(sequence) {
      const folder = `${prefix}${sequence}/`;
      const listing = (await (await get(`${base}?prefix=${encodeURIComponent(folder)}&fields=items(name)`)).json()) as { items?: { name: string }[] };
      const names = (listing.items ?? []).map((item) => item.name);
      if (names.length === 0) return null;
      if (names.length > 1) throw new Error(`archive holds ${names.length} records for publication ${sequence}`);
      const name = names[0]!;
      const digest = name.slice(folder.length).replace(/\.json$/, "");
      if (!/^[0-9a-f]{64}$/.test(digest) || name !== `${folder}${digest}.json`) throw new Error(`archive object for publication ${sequence} has an unexpected name`);
      const bytes = Buffer.from(await (await get(`${base}/${encodeURIComponent(name)}?alt=media`)).arrayBuffer());
      if (sha256(bytes) !== digest) throw new Error(`archive object for publication ${sequence} does not match its name`);
      return bytes.toString("utf8");
    },
  };
}

export class PublicationArchive {
  private readonly address: string;

  constructor(
    private readonly source: ArchiveSource,
    private readonly program: Program,
    private readonly pool: PublicKey,
    private readonly genesisHash: string,
  ) {
    this.address = addresses(program.programId).publication(pool).toBase58();
  }

  async read(sequence: bigint): Promise<ArchivedPublication> {
    const text = await this.source.fetch(sequence);
    if (text === null) throw new PublicationArchiveMissing(`publication ${sequence} is not in the archive`);
    const record = JSON.parse(text) as ArchiveRecord;
    const origin = provenance(record);
    if (!origin) throw new Error(`archived publication ${sequence} has an unknown schema or inconsistent commitment provenance`);
    if (record.identity?.program !== this.program.programId.toBase58() || record.identity.pool !== this.pool.toBase58() || record.identity.genesisHash !== this.genesisHash) {
      throw new Error(`archived publication ${sequence} belongs to another program, pool or network`);
    }
    if (record.address !== this.address || record.sequence !== sequence.toString()) {
      throw new Error(`archived publication ${sequence} has the wrong address or sequence`);
    }
    const bytes = Buffer.from(record.accountBase64, "base64");
    if (bytes.length !== ACCOUNT_BYTES || bytes.toString("base64") !== record.accountBase64 || sha256(bytes) !== record.accountSha256) {
      throw new Error(`archived publication ${sequence} fails its account hash`);
    }
    const account = decodeAccount(this.program, "publication", { data: bytes, owner: this.program.programId, executable: false, lamports: 0 });
    const publication = checkedPublication(this.program.programId, this.pool, account);
    if (publication.sequence.toString() !== record.sequence || publication.batch.toString() !== record.batch || Buffer.from(publication.stateDigest).toString("hex") !== record.stateDigest) {
      throw new Error(`archived publication ${sequence} does not match its record`);
    }
    return { publication, ...origin };
  }
}
