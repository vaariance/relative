import { createHash } from "node:crypto";

export const MAX_UNIVERSE_ASSETS = 256;
const EPOCH_SECONDS = 14_400;
export type FeedIdentity =
  | Readonly<{ kind: "pyth-pro"; priceFeedId: number }>
  | Readonly<{ kind: "pyth-core"; priceFeedId: string }>;
export interface AssetDefinition {
  readonly stableAssetId: string;
  readonly tokenMint: string;
  readonly exposureGroup: string;
  readonly feed: FeedIdentity;
}
export interface ValidationEvidence {
  readonly assetDigest: string;
  readonly sourceAuthority: string;
  readonly sourceFactDigest: string;
  readonly assessmentDigest: string;
  readonly checkedAt: number;
  readonly validUntil: number;
}
export type CandidateAsset = AssetDefinition & Readonly<{ status: "candidate" }>;
export type ValidatedAsset = AssetDefinition & Readonly<{ status: "validated"; evidence: ValidationEvidence }>;
export type ApprovedAsset = Omit<ValidatedAsset, "status"> & Readonly<{
  status: "approved"; approvedBy: string; approvedAt: number;
}>;
export type ScheduledAsset = Omit<ApprovedAsset, "status"> & Readonly<{
  status: "scheduled"; scheduledAt: number; activatesAt: number;
}>;
export type ActiveAsset = Omit<ScheduledAsset, "status"> & Readonly<{
  status: "active"; activatedAt: number;
}>;
export interface InclusionPolicy {
  readonly minimumNoticeSeconds: number;
  readonly validationMaxAgeSeconds: number;
  readonly maxAssets: number;
}
export interface UniverseSnapshot {
  readonly version: number;
  readonly effectiveAt: number;
  readonly predecessorDigest: string | null;
  readonly methodology: "GEOMETRIC_EQUAL_WEIGHT_V1";
  readonly assets: readonly ActiveAsset[];
  readonly canonical: string;
  readonly digest: string;
}
export interface FrozenEpochUniverse {
  readonly opensAt: number;
  readonly closesAt: number;
  readonly universe: UniverseSnapshot;
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const validDigest = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("InvalidTimestamp");
}
function checkPolicy(policy: InclusionPolicy): void {
  if (!Number.isSafeInteger(policy.minimumNoticeSeconds) || policy.minimumNoticeSeconds < 0
    || !Number.isSafeInteger(policy.validationMaxAgeSeconds) || policy.validationMaxAgeSeconds <= 0
    || !Number.isSafeInteger(policy.maxAssets) || policy.maxAssets < 2 || policy.maxAssets > MAX_UNIVERSE_ASSETS) {
    throw new Error("InvalidInclusionPolicy");
  }
}
function definition(asset: AssetDefinition): AssetDefinition {
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(asset.stableAssetId)
    || !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(asset.exposureGroup)
    || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset.tokenMint)) throw new Error("InvalidAssetIdentity");
  if (asset.feed.kind === "pyth-pro") {
    if (!Number.isSafeInteger(asset.feed.priceFeedId) || asset.feed.priceFeedId <= 0) throw new Error("InvalidFeedIdentity");
  } else if (asset.feed.kind !== "pyth-core" || !validDigest(asset.feed.priceFeedId)) {
    throw new Error("InvalidFeedIdentity");
  }
  return Object.freeze({ stableAssetId: asset.stableAssetId, tokenMint: asset.tokenMint,
    exposureGroup: asset.exposureGroup, feed: Object.freeze({ ...asset.feed }) });
}
const feedTuple = (feed: FeedIdentity): readonly [string, string | number] => [feed.kind, feed.priceFeedId];
export function assetIdentityDigest(asset: AssetDefinition): string {
  const checked = definition(asset);
  return hash(JSON.stringify(["RELATIVE/ASSET/V1", checked.stableAssetId, checked.tokenMint,
    checked.exposureGroup, feedTuple(checked.feed)]));
}
function evidenceAt(asset: AssetDefinition, evidence: ValidationEvidence, at: number, policy: InclusionPolicy): ValidationEvidence {
  timestamp(at);
  timestamp(evidence.checkedAt);
  timestamp(evidence.validUntil);
  checkPolicy(policy);
  if (evidence.assetDigest !== assetIdentityDigest(asset) || !validDigest(evidence.sourceFactDigest)
    || !validDigest(evidence.assessmentDigest) || evidence.sourceAuthority.trim().length === 0) throw new Error("InvalidValidationEvidence");
  if (evidence.checkedAt > at || evidence.validUntil <= at
    || at - evidence.checkedAt > policy.validationMaxAgeSeconds) throw new Error("StaleValidation");
  return Object.freeze({ ...evidence });
}
export function candidateAsset(asset: AssetDefinition): CandidateAsset {
  return Object.freeze({ ...definition(asset), status: "candidate" });
}
export function validateCandidate(asset: CandidateAsset, evidence: ValidationEvidence, at: number, policy: InclusionPolicy): ValidatedAsset {
  if (asset.status !== "candidate") throw new Error("InvalidInclusionTransition");
  return Object.freeze({ ...definition(asset), status: "validated", evidence: evidenceAt(asset, evidence, at, policy) });
}
export function approveAsset(asset: ValidatedAsset, approvedBy: string, at: number, policy: InclusionPolicy): ApprovedAsset {
  if (asset.status !== "validated" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(approvedBy)) throw new Error("InvalidApproval");
  return Object.freeze({ ...definition(asset), status: "approved", evidence: evidenceAt(asset, asset.evidence, at, policy), approvedBy, approvedAt: at });
}
export function scheduleAsset(asset: ApprovedAsset, activatesAt: number, at: number, policy: InclusionPolicy): ScheduledAsset {
  timestamp(at);
  timestamp(activatesAt);
  checkPolicy(policy);
  if (asset.status !== "approved" || at < asset.approvedAt || activatesAt <= at
    || activatesAt - at < policy.minimumNoticeSeconds) throw new Error("InvalidActivationSchedule");
  const evidence = evidenceAt(asset, asset.evidence, at, policy);
  evidenceAt(asset, evidence, activatesAt, policy);
  return Object.freeze({ ...definition(asset), status: "scheduled", evidence,
    approvedBy: asset.approvedBy, approvedAt: asset.approvedAt, scheduledAt: at, activatesAt });
}
function activeCopy(asset: ActiveAsset): ActiveAsset {
  return Object.freeze({ ...asset, ...definition(asset), evidence: Object.freeze({ ...asset.evidence }) });
}
function snapshot(version: number, effectiveAt: number, predecessorDigest: string | null, assets: readonly ActiveAsset[]): UniverseSnapshot {
  const ordered = Object.freeze([...assets].sort((a, b) => a.stableAssetId < b.stableAssetId ? -1 : a.stableAssetId > b.stableAssetId ? 1 : 0).map(activeCopy));
  const canonical = JSON.stringify(["RELATIVE/UNIVERSE/V1", version, effectiveAt, predecessorDigest,
    "GEOMETRIC_EQUAL_WEIGHT_V1", ordered.map(asset => [asset.stableAssetId, asset.tokenMint,
      asset.exposureGroup, feedTuple(asset.feed), "1", String(ordered.length), asset.evidence.assetDigest,
      asset.evidence.sourceAuthority, asset.evidence.sourceFactDigest, asset.evidence.assessmentDigest,
      asset.evidence.checkedAt, asset.evidence.validUntil, asset.approvedBy, asset.approvedAt,
      asset.scheduledAt, asset.activatesAt, asset.activatedAt])]);
  return Object.freeze({ version, effectiveAt, predecessorDigest, methodology: "GEOMETRIC_EQUAL_WEIGHT_V1",
    assets: ordered, canonical, digest: hash(canonical) });
}
function assertSnapshot(value: UniverseSnapshot): void {
  timestamp(value.effectiveAt);
  if (!Number.isSafeInteger(value.version) || value.version <= 0 || value.assets.length < 2
    || value.assets.length > MAX_UNIVERSE_ASSETS || value.methodology !== "GEOMETRIC_EQUAL_WEIGHT_V1"
    || (value.predecessorDigest !== null && !validDigest(value.predecessorDigest))) throw new Error("InvalidUniverse");
  const expected = snapshot(value.version, value.effectiveAt, value.predecessorDigest, value.assets);
  if (expected.digest !== value.digest || expected.canonical !== value.canonical) throw new Error("InvalidUniverseDigest");
  uniqueAssets(value.assets);
}
function uniqueAssets(assets: readonly AssetDefinition[]): void {
  for (const values of [assets.map(asset => asset.stableAssetId), assets.map(asset => asset.tokenMint),
    assets.map(asset => asset.exposureGroup), assets.map(asset => JSON.stringify(feedTuple(asset.feed)))]) {
    if (new Set(values).size !== assets.length) throw new Error("DuplicateAssetExposure");
  }
}
export function activateUniverse(previous: UniverseSnapshot | null, additions: readonly ScheduledAsset[], at: number, policy: InclusionPolicy): UniverseSnapshot {
  timestamp(at);
  checkPolicy(policy);
  if (previous) {
    assertSnapshot(previous);
    if (at <= previous.effectiveAt) throw new Error("NonMonotonicActivation");
  }
  if (additions.length === 0) throw new Error("EmptyActivation");
  const active = additions.map(asset => {
    timestamp(asset.approvedAt);
    timestamp(asset.scheduledAt);
    timestamp(asset.activatesAt);
    if (asset.status !== "scheduled" || asset.activatesAt > at || asset.scheduledAt >= asset.activatesAt
      || asset.approvedAt > asset.scheduledAt
      || asset.activatesAt - asset.scheduledAt < policy.minimumNoticeSeconds) throw new Error("PrematureActivation");
    return Object.freeze({ ...asset, ...definition(asset), status: "active" as const,
      evidence: evidenceAt(asset, asset.evidence, at, policy), activatedAt: at });
  });
  const assets = [...(previous?.assets ?? []), ...active];
  if (assets.length < 2 || assets.length > policy.maxAssets) throw new Error("UniverseCapacityExceeded");
  uniqueAssets(assets);
  return snapshot((previous?.version ?? 0) + 1, at, previous?.digest ?? null, assets);
}
export function freezeEpochUniverse(history: readonly UniverseSnapshot[], opensAt: number): FrozenEpochUniverse {
  timestamp(opensAt);
  timestamp(opensAt + EPOCH_SECONDS);
  if (opensAt % EPOCH_SECONDS !== 0) throw new Error("InvalidEpochBoundary");
  let previous: UniverseSnapshot | undefined;
  let eligible: UniverseSnapshot | undefined;
  for (const current of history) {
    assertSnapshot(current);
    if (previous && (current.version !== previous.version + 1 || current.predecessorDigest !== previous.digest
      || current.effectiveAt <= previous.effectiveAt)) throw new Error("InvalidUniverseHistory");
    if (current.effectiveAt <= opensAt) eligible = current;
    previous = current;
  }
  if (!eligible) throw new Error("NoEligibleUniverse");
  const immutable = snapshot(eligible.version, eligible.effectiveAt, eligible.predecessorDigest, eligible.assets);
  return Object.freeze({ opensAt, closesAt: opensAt + EPOCH_SECONDS, universe: immutable });
}
