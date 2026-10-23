import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { build } from "esbuild";
import { decodeDynamicManifest, dynamicManifestBytes, dynamicClassForAsset, dynamicAssetForClass, dynamicPositionSpace, dynamicInstrumentIdentitiesDigest, type DynamicManifest } from "../src/dynamic.ts";
import { sha256 } from "../src/wire.ts";
const bytes = (value: number) => Buffer.alloc(32, value);
export function manifest(count = 30): DynamicManifest {
  return { schemaVersion: 1, pool: new PublicKey(bytes(1)), operator: new PublicKey(bytes(2)), sourceMethodology: bytes(3), version: 1n,
    predecessorDigest: bytes(0), expectedInstruments: count,
    capture: { priceUniverseDigest: bytes(4), timestamp: 1000n, benchmark: 100000000000000n, pricesE8: Array(count).fill(100n),
      signedPayloadDigest: bytes(5), trustedStorageDigest: bytes(6), predecessorSequence: 0n, predecessorStateDigest: bytes(7) },
    instruments: Array.from({ length: count }, (_, index) => ({ stableId: `asset${index}`, symbol: `ASSET${index}`, classId: dynamicClassForAsset(index), epochId: index,
      pythProFeedId: index + 1, pythCoreFeedId: bytes(index + 1), tokenMint: null, originalPriceE8: 100n, originalBenchmark: 100000000000000n, originalTimestamp: 1000n })) };
}
test("dynamic canonical bytes match the independent Rust universe fixture", () => {
  const canonical = dynamicManifestBytes(manifest());
  assert.equal(canonical.length, 3415);
  assert.equal(sha256(canonical).toString("hex"), "37a30d54c5868a4f35be9bfa1bc9781f00a5b4d09808b51091d3050186d57e41");
  assert.deepEqual(dynamicManifestBytes(decodeDynamicManifest(canonical, sha256(canonical))), canonical);
  assert.throws(() => decodeDynamicManifest(canonical, bytes(8)), /InvalidDynamicManifest/);
  assert.throws(() => decodeDynamicManifest(Buffer.concat([canonical, Buffer.from([0])])), /InvalidDynamicManifest/);
  assert.throws(() => decodeDynamicManifest(canonical.subarray(0, -1)), /InvalidDynamicManifest/);
});
test("dynamic class mapping reserves CRYPTO thirty across appended assets and full capacity", () => {
  assert.equal(dynamicClassForAsset(29), 29); assert.equal(dynamicClassForAsset(30), 31); assert.equal(dynamicClassForAsset(254), 255);
  assert.equal(dynamicAssetForClass(30, 255), null); assert.equal(dynamicAssetForClass(31, 255), 30); assert.equal(dynamicAssetForClass(255, 255), 254);
  assert.throws(() => dynamicClassForAsset(255), /InvalidDynamicManifest/);
  assert.throws(() => dynamicAssetForClass(256, 255), /InvalidDynamicManifest/);
  const full = manifest(255);
  full.instruments[254]!.pythCoreFeedId = bytes(42); full.instruments[254]!.pythCoreFeedId[0] = 0;
  const canonical = dynamicManifestBytes(full);
  assert.equal(decodeDynamicManifest(canonical).instruments.length, 255);
  assert.equal(dynamicPositionSpace(31), 4096); assert.equal(dynamicPositionSpace(256), 24576);
});
test("dynamic manifests reject forged mappings, duplicate feeds, invalid option mints and missing provenance", () => {
  for (let change = 0; change < 8; change++) {
    const value = manifest();
    switch (change) {
      case 0: value.instruments[0]!.classId = 30; break;
      case 1: value.instruments[1]!.pythProFeedId = value.instruments[0]!.pythProFeedId; break;
      case 2: value.instruments[1]!.pythCoreFeedId = value.instruments[0]!.pythCoreFeedId; break;
      case 3: value.instruments[1]!.epochId = 0; break;
      case 4: value.instruments[0]!.tokenMint = PublicKey.default; break;
      case 5: value.capture.trustedStorageDigest = bytes(0); break;
      case 6: value.capture.pricesE8 = [1n]; break;
      default: value.instruments[0]!.originalPriceE8 = 0n;
    }
    assert.throws(() => dynamicManifestBytes(value), /InvalidDynamicManifest/);
  }
  const minted = manifest(); minted.instruments[0]!.tokenMint = new PublicKey(bytes(9));
  assert.equal(decodeDynamicManifest(dynamicManifestBytes(minted)).instruments[0]!.tokenMint?.toBase58(), minted.instruments[0]!.tokenMint.toBase58());
  minted.instruments[1]!.tokenMint = minted.instruments[0]!.tokenMint;
  assert.throws(() => dynamicManifestBytes(minted), /InvalidDynamicManifest/);
});
test("dynamic browser export excludes server runtimes and credentials", async () => {
  const result = await build({ entryPoints: [new URL("../src/dynamic.ts", import.meta.url).pathname], bundle: true, platform: "browser", format: "esm", write: false });
  const output = result.outputFiles[0]!.text;
  for (const forbidden of ["PYTH_API_KEY", "ALCHEMY_API_KEY", "createSigningClient", "node:fs", "node:crypto"]) assert.ok(!output.includes(forbidden));
});

test("operator approval identity excludes capture-derived origins and binds every admitted feed", () => {
  const value = manifest(31); const before = dynamicInstrumentIdentitiesDigest(value.instruments);
  value.instruments[30]!.originalPriceE8 += 1n;
  value.instruments[30]!.originalBenchmark += 1n;
  value.instruments[30]!.originalTimestamp += 1n;
  assert.deepEqual(dynamicInstrumentIdentitiesDigest(value.instruments), before);
  value.instruments[30]!.pythProFeedId += 1;
  assert.notDeepEqual(dynamicInstrumentIdentitiesDigest(value.instruments), before);
});
