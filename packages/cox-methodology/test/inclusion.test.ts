import test from "node:test";
import assert from "node:assert/strict";
import {
  activateUniverse, approveAsset, assetIdentityDigest, candidateAsset, freezeEpochUniverse,
  scheduleAsset, validateCandidate,
  type AssetDefinition, type InclusionPolicy, type ValidationEvidence,
} from "../src/inclusion.ts";

const authority = "2".repeat(32);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const policy: InclusionPolicy = { minimumNoticeSeconds: 100, validationMaxAgeSeconds: 100_000, maxAssets: 64 };
const definition = (i: number): AssetDefinition => ({
  stableAssetId: `asset-${i}`, tokenMint: "1".repeat(30) + alphabet[Math.floor(i / alphabet.length)]! + alphabet[i % alphabet.length]!,
  exposureGroup: `underlying-${i}`, feed: { kind: "pyth-pro", priceFeedId: 100 + i },
});
const evidence = (asset: AssetDefinition, overrides: Partial<ValidationEvidence> = {}): ValidationEvidence => ({
  assetDigest: assetIdentityDigest(asset), sourceAuthority: "audited-provider-facts",
  sourceFactDigest: "a".repeat(64), assessmentDigest: "b".repeat(64), checkedAt: 0, validUntil: 100_000,
  ...overrides,
});
const scheduled = (i: number, activatesAt = 14_400, asset = definition(i)) => {
  const validated = validateCandidate(candidateAsset(asset), evidence(asset), 0, policy);
  return scheduleAsset(approveAsset(validated, authority, 0, policy), activatesAt, 100, policy);
};

test("typed inclusion lifecycle retains audited fact references without treating hashes as proof", () => {
  const item = scheduled(0);
  assert.equal(item.status, "scheduled");
  assert.equal(item.evidence.sourceFactDigest, "a".repeat(64));
  assert.equal(item.evidence.assetDigest, assetIdentityDigest(definition(0)));
  const universe = activateUniverse(null, [item, scheduled(1)], 14_400, policy);
  assert.equal(universe.version, 1);
  assert.equal(universe.assets[0]!.status, "active");
  assert.equal(universe.methodology, "GEOMETRIC_EQUAL_WEIGHT_V1");
  assert.equal(universe.predecessorDigest, null);
});

test("identity binds stable asset, mint, feed product and exposure instead of ticker", () => {
  const asset = definition(0);
  for (const changed of [
    { ...asset, stableAssetId: "different" }, { ...asset, tokenMint: authority },
    { ...asset, exposureGroup: "other-underlying" },
    { ...asset, feed: { kind: "pyth-pro" as const, priceFeedId: 999 } },
    { ...asset, feed: { kind: "pyth-core" as const, priceFeedId: "c".repeat(64) } },
  ]) {
    assert.notEqual(assetIdentityDigest(asset), assetIdentityDigest(changed));
    assert.throws(() => validateCandidate(candidateAsset(changed), evidence(asset), 0, policy), /InvalidValidationEvidence/);
  }
  const reordered = { feed: asset.feed, exposureGroup: asset.exposureGroup, tokenMint: asset.tokenMint, stableAssetId: asset.stableAssetId };
  assert.equal(assetIdentityDigest(asset), assetIdentityDigest(reordered));
});

test("rejects duplicates across identifiers, mints, feeds and underlying exposure", () => {
  const first = definition(0);
  const second = definition(1);
  for (const duplicate of [
    { ...second, stableAssetId: first.stableAssetId }, { ...second, tokenMint: first.tokenMint },
    { ...second, feed: first.feed }, { ...second, exposureGroup: first.exposureGroup },
  ]) assert.throws(() => activateUniverse(null, [scheduled(0), scheduled(1, 14_400, duplicate)], 14_400, policy), /DuplicateAssetExposure/);
  const current = activateUniverse(null, [scheduled(0), scheduled(1)], 14_400, policy);
  assert.throws(() => activateUniverse(current, [scheduled(0, 14_500)], 14_500, policy), /DuplicateAssetExposure/);
});

test("validation expiry, source hashes and full identity are checked at every transition", () => {
  const asset = candidateAsset(definition(0));
  for (const invalid of [
    evidence(asset, { checkedAt: 1 }), evidence(asset, { validUntil: 0 }),
    evidence(asset, { assetDigest: "c".repeat(64) }), evidence(asset, { sourceFactDigest: "not-a-digest" }),
    evidence(asset, { sourceAuthority: " " }), evidence(asset, { checkedAt: 0.5 }),
  ]) assert.throws(() => validateCandidate(asset, invalid, 0, policy), /StaleValidation|InvalidValidationEvidence|InvalidTimestamp/);
  const validated = validateCandidate(asset, evidence(asset), 0, policy);
  assert.throws(() => validateCandidate(asset, evidence(asset, { validUntil: 200_000 }), 100_001, policy), /StaleValidation/);
  assert.throws(() => approveAsset(validated, authority, 100_000, policy), /StaleValidation/);
  const approved = approveAsset(validated, authority, 0, policy);
  assert.throws(() => scheduleAsset(approved, 100_000, 100, policy), /StaleValidation/);
  assert.throws(() => activateUniverse(null, [scheduled(0), scheduled(1)], 100_000, policy), /StaleValidation/);
});

test("activation enforces notice, monotonic time and safe integral UTC seconds", () => {
  const asset = definition(0);
  const approved = approveAsset(validateCandidate(candidateAsset(asset), evidence(asset), 0, policy), authority, 0, policy);
  for (const at of [0, 99, 100.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => scheduleAsset(approved, at, 0, policy), /InvalidActivationSchedule|InvalidTimestamp|StaleValidation/);
  }
  assert.throws(() => activateUniverse(null, [scheduled(0), scheduled(1)], 14_399, policy), /PrematureActivation/);
  assert.throws(() => activateUniverse(null, [scheduled(0), { ...scheduled(1), scheduledAt: 14_399 }], 14_400, policy), /PrematureActivation/);
  const universe = activateUniverse(null, [scheduled(0), scheduled(1)], 14_400, policy);
  assert.throws(() => activateUniverse(universe, [scheduled(2)], 14_400, policy), /NonMonotonicActivation/);
  assert.throws(() => activateUniverse(universe, [], 14_500, policy), /EmptyActivation/);
});

test("roster hashing is canonical and includes equal weights plus complete feed mappings", () => {
  const a = activateUniverse(null, [scheduled(1), scheduled(0)], 14_400, policy);
  const b = activateUniverse(null, [scheduled(0), scheduled(1)], 14_400, policy);
  assert.equal(a.digest, b.digest);
  const tuple = JSON.parse(a.canonical);
  assert.deepEqual(tuple[5][0].slice(0, 6), ["asset-0", definition(0).tokenMint, "underlying-0", ["pyth-pro", 100], "1", "2"]);
  const changed = activateUniverse(null, [scheduled(0), scheduled(1, 14_400, { ...definition(1), feed: { kind: "pyth-pro", priceFeedId: 999 } })], 14_400, policy);
  assert.notEqual(a.digest, changed.digest);
  const next = activateUniverse(a, [scheduled(2, 14_500)], 14_500, policy);
  assert.equal(next.version, 2);
  assert.equal(next.predecessorDigest, a.digest);
  assert.equal(JSON.parse(next.canonical)[5][0][5], "3");
});

test("new inclusions never change an already frozen epoch universe", () => {
  const first = activateUniverse(null, [scheduled(0), scheduled(1)], 14_400, policy);
  const frozen = freezeEpochUniverse([first], 14_400);
  const second = activateUniverse(first, [scheduled(2, 14_401)], 14_401, policy);
  assert.equal(frozen.universe.assets.length, 2);
  assert.equal(freezeEpochUniverse([first, second], 14_400).universe.digest, first.digest);
  assert.equal(freezeEpochUniverse([first, second], 28_800).universe.digest, second.digest);
  assert.throws(() => freezeEpochUniverse([first], 0), /NoEligibleUniverse/);
  assert.throws(() => freezeEpochUniverse([first], 14_401), /InvalidEpochBoundary/);
  assert.throws(() => freezeEpochUniverse([second, first], 28_800), /InvalidUniverseHistory/);
  assert.throws(() => freezeEpochUniverse([{ ...first, digest: "c".repeat(64) }], 14_400), /InvalidUniverseDigest/);
  assert.throws(() => { (frozen.universe.assets as unknown as unknown[]).push(definition(3)); }, TypeError);
  assert.throws(() => { Object.assign(frozen.universe.assets[0]!.feed, { priceFeedId: 999 }); }, TypeError);
});

test("benchmark universes may exceed thirty while the configurable cap is enforced", () => {
  const additions = Array.from({ length: 32 }, (_, i) => scheduled(i));
  assert.equal(activateUniverse(null, additions, 14_400, policy).assets.length, 32);
  assert.throws(() => activateUniverse(null, additions, 14_400, { ...policy, maxAssets: 31 }), /UniverseCapacityExceeded/);
  assert.throws(() => activateUniverse(null, additions, 14_400, { ...policy, maxAssets: 257 }), /InvalidInclusionPolicy/);
});

test("candidate definitions are immutable copies and invalid feed namespaces fail explicitly", () => {
  const raw = { ...definition(0), feed: { kind: "pyth-pro" as const, priceFeedId: 100 } };
  const candidate = candidateAsset(raw);
  raw.feed.priceFeedId = 200;
  assert.equal(candidate.feed.priceFeedId, 100);
  for (const feed of [
    { kind: "pyth-pro" as const, priceFeedId: 1.5 }, { kind: "pyth-pro" as const, priceFeedId: 0 },
    { kind: "pyth-core" as const, priceFeedId: "0x" + "a".repeat(64) },
  ]) assert.throws(() => candidateAsset({ ...definition(0), feed }), /InvalidFeedIdentity/);
});
