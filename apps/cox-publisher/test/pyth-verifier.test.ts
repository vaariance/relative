import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { createPythBatchVerifier, readPythTrustedSigners, PYTH_PRO_PROGRAM, PYTH_PRO_STORAGE } from "../src/pyth-verifier.ts";
import type { PythBatch } from "../src/pyth-cache.ts";

const keys = generateKeyPairSync("ed25519");
const publicKey = new PublicKey(keys.publicKey.export({type:"spki",format:"der"}).subarray(-32));
function fixture(options: { timestamp?: bigint; channel?: number; stale?: boolean; property?: number; duplicate?: boolean } = {}): PythBatch {
  const timestamp = options.timestamp ?? 5_000_000n;
  const payload = Buffer.alloc(50);
  payload.writeUInt32LE(2479346549, 0); payload.writeBigUInt64LE(timestamp, 4);
  payload[12] = options.channel ?? 4; payload[13] = 1;
  payload.writeUInt32LE(1, 14); payload[18] = 4;
  payload[19] = 0; payload.writeBigInt64LE(1000n, 20);
  payload[28] = options.duplicate ? 0 : 4; payload.writeInt16LE(-8, 29);
  payload[31] = options.property ?? 5; payload.writeBigInt64LE(2n, 32);
  payload[40] = 12; payload[41] = 1; payload.writeBigUInt64LE(options.stale ? 1n : timestamp, 42);
  const envelope = Buffer.alloc(102);
  envelope.writeUInt32LE(2182742457,0); sign(null,payload,keys.privateKey).copy(envelope,4);
  publicKey.toBuffer().copy(envelope,68); envelope.writeUInt16LE(payload.length,100);
  return { timestampUs:timestamp, prices:[{feedId:"1",price:1000n,exponent:-8,confidence:2n}], signedSolana:Buffer.concat([envelope,payload]) };
}
const verifier = (expiresAtSeconds = 100n) => createPythBatchVerifier({ trustedSigners: async()=>[{publicKey,expiresAtSeconds}], nowSeconds:()=>10n,maxFeedAgeUs:1_000_000n });

test("verifies Ed25519 and binds every parsed field to the signed one-second payload",async()=>{
  await verifier()(fixture());
  for (const changed of [{feedId:"2"},{price:999n},{exponent:-7},{confidence:1n}]) {
    const batch=fixture(); await assert.rejects(verifier()({...batch,prices:[{...batch.prices[0]!,...changed}]}),/BindingMismatch/);
  }
  const batch=fixture(); await assert.rejects(verifier()({...batch,timestampUs:5_000_001n}),/BindingMismatch/);
});
test("rejects tampering, expired or unknown signers and noncanonical envelopes",async()=>{
  const batch=fixture(); batch.signedSolana[130]! ^= 1;
  await assert.rejects(verifier()(batch),/InvalidPythSignature/);
  await assert.rejects(verifier(10n)(fixture()),/UntrustedPythSigner/);
  await assert.rejects(createPythBatchVerifier({trustedSigners:async()=>[],nowSeconds:()=>10n,maxFeedAgeUs:1n})(fixture()),/UntrustedPythSigner/);
  await assert.rejects(verifier()({...fixture(),signedSolana:Buffer.alloc(10)}),/Pyth/);
  await assert.rejects(verifier()({...fixture(),signedSolana:Buffer.concat([fixture().signedSolana,Buffer.alloc(1)])}),/TrailingPythPayload/);
});
test("signed stale timestamps, channels, duplicate and unsupported properties fail closed",async()=>{
  await assert.rejects(verifier()(fixture({stale:true})),/StaleSignedPythFeed/);
  await assert.rejects(verifier()(fixture({channel:1})),/BindingMismatch/);
  await assert.rejects(verifier()(fixture({duplicate:true})),/InvalidPythProperties/);
  await assert.rejects(verifier()(fixture({property:6})),/UnsupportedPythProperty/);
});
test("reads signers only from the pinned Pyth-owned storage account",async()=>{
  const data=Buffer.alloc(381); createHash("sha256").update("account:Storage").digest().copy(data,0,0,8);
  data[80]=1;publicKey.toBuffer().copy(data,81);data.writeBigInt64LE(100n,113);
  const account={data,owner:PYTH_PRO_PROGRAM,executable:false,lamports:1,rentEpoch:0};
  const read=async()=>readPythTrustedSigners({async getAccountInfo(key,commitment){assert.ok(key.equals(PYTH_PRO_STORAGE));assert.equal(commitment,"confirmed");return account;}});
  assert.deepEqual(await read(),[{publicKey,expiresAtSeconds:100n}]);
  account.owner=PublicKey.default;await assert.rejects(read(),/InvalidPythSignerStorage/);
  account.owner=PYTH_PRO_PROGRAM;data[80]=6;await assert.rejects(read(),/InvalidPythSignerStorage/);
});
