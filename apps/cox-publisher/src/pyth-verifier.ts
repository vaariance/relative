import { createHash, createPublicKey, verify } from "node:crypto";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { PythBatch } from "./pyth-cache.ts";

export const PYTH_PRO_PROGRAM = new PublicKey("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
export const PYTH_PRO_STORAGE = new PublicKey("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
const STORAGE_DISCRIMINATOR = createHash("sha256").update("account:Storage").digest().subarray(0, 8);
const ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface PythTrustedSigner { readonly publicKey: PublicKey; readonly expiresAtSeconds: bigint }
export interface PythVerifierOptions {
  readonly trustedSigners: () => Promise<readonly PythTrustedSigner[]>;
  readonly nowSeconds: () => bigint;
  readonly maxFeedAgeUs: bigint;
}

export async function readPythTrustedSigners(connection: Pick<Connection, "getAccountInfo">): Promise<readonly PythTrustedSigner[]> {
  const account = await connection.getAccountInfo(PYTH_PRO_STORAGE, "confirmed");
  if (!account || !account.owner.equals(PYTH_PRO_PROGRAM) || account.executable
      || account.data.length < 8 + 373 || !account.data.subarray(0, 8).equals(STORAGE_DISCRIMINATOR)) {
    throw new Error("InvalidPythSignerStorage");
  }
  const count = account.data.readUInt8(80);
  if (count < 1 || count > 5) throw new Error("InvalidPythSignerStorage");
  const signers: PythTrustedSigner[] = [];
  for (let i = 0; i < count; i++) {
    const offset = 81 + i * 40;
    const publicKey = new PublicKey(account.data.subarray(offset, offset + 32));
    if (publicKey.equals(PublicKey.default) || signers.some(signer => signer.publicKey.equals(publicKey))) throw new Error("InvalidPythSignerStorage");
    signers.push({ publicKey, expiresAtSeconds: account.data.readBigInt64LE(offset + 32) });
  }
  return signers;
}

class Reader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}
  take(size: number): Buffer {
    if (this.offset + size > this.data.length) throw new Error("TruncatedPythPayload");
    const value = this.data.subarray(this.offset, this.offset + size); this.offset += size; return value;
  }
  u8(): number { return this.take(1).readUInt8(); }
  u16(): number { return this.take(2).readUInt16LE(); }
  u32(): number { return this.take(4).readUInt32LE(); }
  u64(): bigint { return this.take(8).readBigUInt64LE(); }
  i64(): bigint { return this.take(8).readBigInt64LE(); }
  i16(): number { return this.take(2).readInt16LE(); }
  done(): void { if (this.offset !== this.data.length) throw new Error("TrailingPythPayload"); }
}

export function createPythBatchVerifier(options: PythVerifierOptions): (batch: PythBatch) => Promise<void> {
  if (options.maxFeedAgeUs < 0n) throw new Error("InvalidPythVerifierConfiguration");
  return async batch => {
    const envelope = new Reader(Buffer.from(batch.signedSolana));
    if (envelope.u32() !== 2182742457) throw new Error("InvalidPythSolanaEnvelope");
    const signature = envelope.take(64);
    const publicKeyBytes = envelope.take(32);
    const publicKey = new PublicKey(publicKeyBytes);
    const payload = envelope.take(envelope.u16());
    envelope.done();
    const now = options.nowSeconds();
    if (now < 0n || !(await options.trustedSigners()).some(signer => signer.publicKey.equals(publicKey) && signer.expiresAtSeconds > now)) {
      throw new Error("UntrustedPythSigner");
    }
    const key = createPublicKey({ key: Buffer.concat([ED25519_PREFIX, publicKeyBytes]), format: "der", type: "spki" });
    if (!verify(null, payload, key, signature)) throw new Error("InvalidPythSignature");
    const data = new Reader(payload);
    if (data.u32() !== 2479346549 || data.u64() !== batch.timestampUs || data.u8() !== 4) throw new Error("PythPayloadBindingMismatch");
    const count = data.u8();
    if (count === 0 || count !== batch.prices.length) throw new Error("PythFeedBindingMismatch");
    const seen = new Set<string>();
    for (let i = 0; i < count; i++) {
      const feedId = String(data.u32());
      const properties = data.u8();
      if (seen.has(feedId) || properties !== 4) throw new Error("InvalidPythProperties");
      seen.add(feedId);
      const fields = new Set<number>();
      let price: bigint | undefined, exponent: number | undefined, confidence: bigint | undefined, timestamp: bigint | undefined;
      for (let j = 0; j < properties; j++) {
        const kind = data.u8();
        if (fields.has(kind)) throw new Error("InvalidPythProperties");
        fields.add(kind);
        switch (kind) {
          case 0: price = data.i64(); break;
          case 4: exponent = data.i16(); break;
          case 5: confidence = data.i64(); break;
          case 12:
            if (data.u8() !== 1) throw new Error("MissingPythFeedTimestamp");
            timestamp = data.u64(); break;
          default: throw new Error("UnsupportedPythProperty");
        }
      }
      const parsed = batch.prices.find(item => item.feedId === feedId);
      if (!parsed || price === undefined || price <= 0n || confidence === undefined || confidence <= 0n
          || parsed.price !== price || parsed.exponent !== exponent || parsed.confidence !== confidence) throw new Error("PythFeedBindingMismatch");
      if (timestamp === undefined || timestamp > batch.timestampUs || batch.timestampUs - timestamp > options.maxFeedAgeUs) throw new Error("StaleSignedPythFeed");
    }
    data.done();
  };
}
