use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const MAX_UNIVERSE_ASSETS: usize = 255;
pub const MAX_SOURCE_AUTHORITY_BYTES: usize = 256;
pub const EPOCH_SECONDS: u64 = 14_400;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const METHODOLOGY: &str = "GEOMETRIC_EQUAL_WEIGHT_V1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum FeedIdentity {
    #[serde(rename = "pyth-pro")]
    Pro {
        #[serde(rename = "priceFeedId")]
        price_feed_id: u64,
    },
    #[serde(rename = "pyth-core")]
    Core {
        #[serde(rename = "priceFeedId")]
        price_feed_id: String,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetDefinition {
    pub stable_asset_id: String,
    pub token_mint: Option<String>,
    pub exposure_group: String,
    pub feed: FeedIdentity,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationEvidence {
    pub asset_digest: String,
    pub source_authority: String,
    pub source_fact_digest: String,
    pub assessment_digest: String,
    pub checked_at: u64,
    pub valid_until: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CandidateAsset {
    definition: AssetDefinition,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedAsset {
    definition: AssetDefinition,
    evidence: ValidationEvidence,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovedAsset {
    validated: ValidatedAsset,
    approved_by: String,
    approved_at: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduledAsset {
    approved: ApprovedAsset,
    scheduled_at: u64,
    activates_at: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveAsset {
    #[serde(flatten)]
    pub definition: AssetDefinition,
    pub evidence: ValidationEvidence,
    pub approved_by: String,
    pub approved_at: u64,
    pub scheduled_at: u64,
    pub activates_at: u64,
    pub activated_at: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InclusionPolicy {
    pub minimum_notice_seconds: u64,
    pub validation_max_age_seconds: u64,
    pub max_assets: usize,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UniverseSnapshot {
    pub version: u64,
    pub effective_at: u64,
    pub predecessor_digest: Option<String>,
    pub methodology: String,
    pub assets: Vec<ActiveAsset>,
    pub canonical: String,
    pub digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrozenEpochUniverse {
    pub opens_at: u64,
    pub closes_at: u64,
    pub universe: UniverseSnapshot,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidTimestamp,
    InvalidInclusionPolicy,
    InvalidAssetIdentity,
    InvalidFeedIdentity,
    InvalidValidationEvidence,
    StaleValidation,
    InvalidApproval,
    InvalidActivationSchedule,
    InvalidUniverse,
    InvalidUniverseDigest,
    DuplicateAssetExposure,
    NonMonotonicActivation,
    EmptyActivation,
    PrematureActivation,
    UniverseCapacityExceeded,
    InvalidEpochBoundary,
    InvalidUniverseHistory,
    NoEligibleUniverse,
}

fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn timestamp(value: u64) -> Result<(), Error> {
    if value > MAX_SAFE_INTEGER {
        return Err(Error::InvalidTimestamp);
    }
    Ok(())
}
fn policy_checked(policy: &InclusionPolicy) -> Result<(), Error> {
    if policy.minimum_notice_seconds > MAX_SAFE_INTEGER
        || policy.validation_max_age_seconds == 0
        || policy.validation_max_age_seconds > MAX_SAFE_INTEGER
        || !(2..=MAX_UNIVERSE_ASSETS).contains(&policy.max_assets)
    {
        return Err(Error::InvalidInclusionPolicy);
    }
    Ok(())
}
fn identifier(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && (value.as_bytes()[0].is_ascii_lowercase() || value.as_bytes()[0].is_ascii_digit())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._:-".contains(&b))
}
fn base58_identity(value: &str) -> bool {
    (32..=44).contains(&value.len())
        && value
            .bytes()
            .all(|b| b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&b))
}
fn definition_checked(asset: &AssetDefinition) -> Result<(), Error> {
    if !identifier(&asset.stable_asset_id)
        || !identifier(&asset.exposure_group)
        || asset
            .token_mint
            .as_ref()
            .is_some_and(|mint| !base58_identity(mint))
    {
        return Err(Error::InvalidAssetIdentity);
    }
    match &asset.feed {
        FeedIdentity::Pro { price_feed_id }
            if *price_feed_id > 0 && *price_feed_id <= MAX_SAFE_INTEGER =>
        {
            Ok(())
        }
        FeedIdentity::Core { price_feed_id } if valid_digest(price_feed_id) => Ok(()),
        _ => Err(Error::InvalidFeedIdentity),
    }
}
fn feed_tuple(feed: &FeedIdentity) -> Value {
    match feed {
        FeedIdentity::Pro { price_feed_id } => json!(["pyth-pro", price_feed_id]),
        FeedIdentity::Core { price_feed_id } => json!(["pyth-core", price_feed_id]),
    }
}
pub fn asset_identity_digest(asset: &AssetDefinition) -> Result<String, Error> {
    definition_checked(asset)?;
    Ok(hash(
        &json!([
            if asset.token_mint.is_some() {
                "RELATIVE/ASSET/V1"
            } else {
                "RELATIVE/ASSET/V2"
            },
            asset.stable_asset_id,
            asset.token_mint,
            asset.exposure_group,
            feed_tuple(&asset.feed)
        ])
        .to_string(),
    ))
}
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn evidence_at(
    asset: &AssetDefinition,
    evidence: &ValidationEvidence,
    at: u64,
    policy: &InclusionPolicy,
) -> Result<(), Error> {
    timestamp(at)?;
    timestamp(evidence.checked_at)?;
    timestamp(evidence.valid_until)?;
    policy_checked(policy)?;
    if evidence.asset_digest != asset_identity_digest(asset)?
        || !valid_digest(&evidence.source_fact_digest)
        || !valid_digest(&evidence.assessment_digest)
        || evidence.source_authority.len() > MAX_SOURCE_AUTHORITY_BYTES
        || evidence
            .source_authority
            .trim_matches(js_whitespace)
            .is_empty()
    {
        return Err(Error::InvalidValidationEvidence);
    }
    if evidence.checked_at > at
        || evidence.valid_until <= at
        || at - evidence.checked_at > policy.validation_max_age_seconds
    {
        return Err(Error::StaleValidation);
    }
    Ok(())
}
pub fn candidate_asset(definition: AssetDefinition) -> Result<CandidateAsset, Error> {
    definition_checked(&definition)?;
    Ok(CandidateAsset { definition })
}
pub fn validate_candidate(
    asset: CandidateAsset,
    evidence: ValidationEvidence,
    at: u64,
    policy: &InclusionPolicy,
) -> Result<ValidatedAsset, Error> {
    evidence_at(&asset.definition, &evidence, at, policy)?;
    Ok(ValidatedAsset {
        definition: asset.definition,
        evidence,
    })
}
pub fn approve_asset(
    asset: ValidatedAsset,
    approved_by: String,
    at: u64,
    policy: &InclusionPolicy,
) -> Result<ApprovedAsset, Error> {
    if !base58_identity(&approved_by) {
        return Err(Error::InvalidApproval);
    }
    evidence_at(&asset.definition, &asset.evidence, at, policy)?;
    Ok(ApprovedAsset {
        validated: asset,
        approved_by,
        approved_at: at,
    })
}
pub fn schedule_asset(
    asset: ApprovedAsset,
    activates_at: u64,
    at: u64,
    policy: &InclusionPolicy,
) -> Result<ScheduledAsset, Error> {
    timestamp(at)?;
    timestamp(activates_at)?;
    policy_checked(policy)?;
    if at < asset.approved_at
        || activates_at <= at
        || activates_at - at < policy.minimum_notice_seconds
    {
        return Err(Error::InvalidActivationSchedule);
    }
    evidence_at(
        &asset.validated.definition,
        &asset.validated.evidence,
        at,
        policy,
    )?;
    evidence_at(
        &asset.validated.definition,
        &asset.validated.evidence,
        activates_at,
        policy,
    )?;
    Ok(ScheduledAsset {
        approved: asset,
        scheduled_at: at,
        activates_at,
    })
}
fn unique_assets(assets: &[ActiveAsset]) -> Result<(), Error> {
    let (mut ids, mut mints, mut groups, mut feeds) = (
        BTreeSet::new(),
        BTreeSet::new(),
        BTreeSet::new(),
        BTreeSet::new(),
    );
    for asset in assets {
        let def = &asset.definition;
        if !ids.insert(&def.stable_asset_id)
            || def
                .token_mint
                .as_ref()
                .is_some_and(|mint| !mints.insert(mint))
            || !groups.insert(&def.exposure_group)
            || !feeds.insert(feed_tuple(&def.feed).to_string())
        {
            return Err(Error::DuplicateAssetExposure);
        }
    }
    Ok(())
}
fn snapshot(
    version: u64,
    effective_at: u64,
    predecessor_digest: Option<String>,
    assets: &[ActiveAsset],
) -> Result<UniverseSnapshot, Error> {
    let mut assets = assets.to_vec();
    assets.sort_by(|a, b| {
        a.definition
            .stable_asset_id
            .cmp(&b.definition.stable_asset_id)
    });
    let mut tuples = Vec::with_capacity(assets.len());
    for asset in &assets {
        definition_checked(&asset.definition)?;
        let def = &asset.definition;
        let ev = &asset.evidence;
        tuples.push(json!([
            def.stable_asset_id,
            def.token_mint,
            def.exposure_group,
            feed_tuple(&def.feed),
            "1",
            assets.len().to_string(),
            ev.asset_digest,
            ev.source_authority,
            ev.source_fact_digest,
            ev.assessment_digest,
            ev.checked_at,
            ev.valid_until,
            asset.approved_by,
            asset.approved_at,
            asset.scheduled_at,
            asset.activates_at,
            asset.activated_at
        ]));
    }
    let canonical = json!([
        if assets
            .iter()
            .all(|asset| asset.definition.token_mint.is_some())
        {
            "RELATIVE/UNIVERSE/V1"
        } else {
            "RELATIVE/UNIVERSE/V2"
        },
        version,
        effective_at,
        predecessor_digest,
        METHODOLOGY,
        tuples
    ])
    .to_string();
    let digest = hash(&canonical);
    Ok(UniverseSnapshot {
        version,
        effective_at,
        predecessor_digest,
        methodology: METHODOLOGY.into(),
        assets,
        canonical,
        digest,
    })
}
pub fn assert_snapshot(value: &UniverseSnapshot) -> Result<(), Error> {
    timestamp(value.effective_at)?;
    if value.version == 0
        || value.version > MAX_SAFE_INTEGER
        || !(2..=MAX_UNIVERSE_ASSETS).contains(&value.assets.len())
        || value.methodology != METHODOLOGY
        || value
            .predecessor_digest
            .as_ref()
            .is_some_and(|d| !valid_digest(d))
    {
        return Err(Error::InvalidUniverse);
    }
    let expected = snapshot(
        value.version,
        value.effective_at,
        value.predecessor_digest.clone(),
        &value.assets,
    )?;
    if expected.digest != value.digest || expected.canonical != value.canonical {
        return Err(Error::InvalidUniverseDigest);
    }
    unique_assets(&value.assets)
}
pub fn activate_universe(
    previous: Option<&UniverseSnapshot>,
    additions: &[ScheduledAsset],
    at: u64,
    policy: &InclusionPolicy,
) -> Result<UniverseSnapshot, Error> {
    timestamp(at)?;
    policy_checked(policy)?;
    if let Some(previous) = previous {
        assert_snapshot(previous)?;
        if at <= previous.effective_at {
            return Err(Error::NonMonotonicActivation);
        }
    }
    if additions.is_empty() {
        return Err(Error::EmptyActivation);
    }
    let mut assets = previous.map_or_else(Vec::new, |previous| previous.assets.clone());
    for asset in additions {
        let approved = &asset.approved;
        let validated = &approved.validated;
        timestamp(approved.approved_at)?;
        timestamp(asset.scheduled_at)?;
        timestamp(asset.activates_at)?;
        if asset.activates_at != at
            || asset.scheduled_at >= asset.activates_at
            || approved.approved_at > asset.scheduled_at
            || asset.activates_at - asset.scheduled_at < policy.minimum_notice_seconds
        {
            return Err(Error::PrematureActivation);
        }
        definition_checked(&validated.definition)?;
        evidence_at(&validated.definition, &validated.evidence, at, policy)?;
        assets.push(ActiveAsset {
            definition: validated.definition.clone(),
            evidence: validated.evidence.clone(),
            approved_by: approved.approved_by.clone(),
            approved_at: approved.approved_at,
            scheduled_at: asset.scheduled_at,
            activates_at: asset.activates_at,
            activated_at: at,
        });
    }
    if assets.len() < 2 || assets.len() > policy.max_assets {
        return Err(Error::UniverseCapacityExceeded);
    }
    unique_assets(&assets)?;
    snapshot(
        previous.map_or(1, |previous| previous.version + 1),
        at,
        previous.map(|previous| previous.digest.clone()),
        &assets,
    )
}
pub fn freeze_epoch_universe(
    history: &[UniverseSnapshot],
    opens_at: u64,
) -> Result<FrozenEpochUniverse, Error> {
    timestamp(opens_at)?;
    let closes_at = opens_at
        .checked_add(EPOCH_SECONDS)
        .ok_or(Error::InvalidTimestamp)?;
    timestamp(closes_at)?;
    if opens_at % EPOCH_SECONDS != 0 {
        return Err(Error::InvalidEpochBoundary);
    }
    let mut previous: Option<&UniverseSnapshot> = None;
    let mut eligible = None;
    for current in history {
        assert_snapshot(current)?;
        if previous.is_some_and(|previous| {
            current.version != previous.version + 1
                || current.predecessor_digest.as_ref() != Some(&previous.digest)
                || current.effective_at <= previous.effective_at
        }) {
            return Err(Error::InvalidUniverseHistory);
        }
        if current.effective_at <= opens_at {
            eligible = Some(current);
        }
        previous = Some(current);
    }
    let eligible = eligible.ok_or(Error::NoEligibleUniverse)?;
    Ok(FrozenEpochUniverse {
        opens_at,
        closes_at,
        universe: snapshot(
            eligible.version,
            eligible.effective_at,
            eligible.predecessor_digest.clone(),
            &eligible.assets,
        )?,
    })
}
