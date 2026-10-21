use crate::{CoxError, Methodology, IDS, MANIFEST_LIMIT};
use anchor_lang::prelude::*;

pub const ADAPTIVE_MANIFEST_DOMAIN: &str = "COX/METHODOLOGY/ADAPTIVE/V1";
pub const ADAPTIVE_POLICY: &str = concat!(
    "solana-devnet;USD-e8;benchmark-origin=100e12;",
    "COX/GEOMETRIC/LOG2-Q18/V1;equal-weight;constant-anchor-between-universe-transitions;",
    "pyth-pro-lazer-numeric-feed-id;offchain-ed25519-strict;",
    "pyth-storage=3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL;",
    "pyth-program=pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt;",
    "signed-full-roster;positive-price-and-confidence;no-exchange-fallback;",
    "offchain-continuous-calculation;onchain-registry-operator-attestation;no-onchain-pyth-or-formula-proof;",
    "publication-grid-seconds=1;pending-attempt-cadence-ms=1000;idle-may-be-silent;",
    "normal-acceptance-deadline-seconds=5;historical-empty-bootstrap-before-admission;",
    "separate-pool-admission-time;future-publication-entry;no-fill-deadline;",
    "integer-checked;price-round-half-away;geometric-log2-exp2-q18-v1;",
    "reference-scale=1000000000000;FLOOR_USER;FLOOR_AGGREGATE_CLASS;POOL_RESIDUAL_NO_DISTRIBUTION;",
    "COX/ACCOUNTING/V1;COX/BATCH/ASYNC/V1;COX/STATE/ADAPTIVE/V1;",
    "current-basic-roster-fixed-2-to-30;universe-digest-is-commitment-not-dynamic-inclusion"
);

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct AdaptiveManifestConfig {
    pub version: String,
    pub roster: Vec<u8>,
    pub pyth_feed_ids: Vec<u32>,
    pub origin: u64,
    pub origin_prices: Vec<u64>,
    pub universe_digest: [u8; 32],
    pub feed_check_digest: [u8; 32],
    pub max_price_age_ms: u64,
    pub max_feed_age_ms: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct AdaptiveManifest {
    pub domain: String,
    pub config: AdaptiveManifestConfig,
    pub initial_operator: Pubkey,
    pub policy: String,
}

pub fn canonical_adaptive_manifest(
    config: &AdaptiveManifestConfig,
    runtime: Pubkey,
) -> Result<Vec<u8>> {
    require!(
        !config.version.is_empty()
            && config.version.len() <= 64
            && config
                .version
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'.' | b'_' | b'-')),
        CoxError::InvalidManifest
    );
    let count = config.roster.len();
    require!(
        (2..=30).contains(&count)
            && config.roster.iter().all(|id| usize::from(*id) < IDS.len())
            && config.roster.windows(2).all(|pair| pair[0] < pair[1]),
        CoxError::InvalidRoster
    );
    require!(
        config.pyth_feed_ids.len() == count
            && config.origin_prices.len() == count
            && config.pyth_feed_ids.iter().all(|id| *id != 0)
            && config
                .pyth_feed_ids
                .iter()
                .enumerate()
                .all(|(index, id)| !config.pyth_feed_ids[..index].contains(id))
            && config.origin_prices.iter().all(|price| *price > 0),
        CoxError::InvalidManifest
    );
    require!(
        config.origin > 0
            && config.universe_digest != [0; 32]
            && config.feed_check_digest != [0; 32]
            && runtime != Pubkey::default()
            && (1..=5_000).contains(&config.max_price_age_ms)
            && (1..=60_000).contains(&config.max_feed_age_ms),
        CoxError::InvalidManifest
    );
    let bytes = AdaptiveManifest {
        domain: ADAPTIVE_MANIFEST_DOMAIN.into(),
        config: config.clone(),
        initial_operator: runtime,
        policy: ADAPTIVE_POLICY.into(),
    }
    .try_to_vec()?;
    require!(bytes.len() <= MANIFEST_LIMIT, CoxError::InvalidManifest);
    Ok(bytes)
}

pub fn read_adaptive_manifest(methodology: &Methodology) -> Result<AdaptiveManifest> {
    require!(
        methodology.schema_version == 2 && methodology.sealed && !methodology.bybit,
        CoxError::InvalidManifest
    );
    let manifest = AdaptiveManifest::try_from_slice(&methodology.canonical)
        .map_err(|_| error!(CoxError::InvalidManifest))?;
    require!(
        manifest.domain == ADAPTIVE_MANIFEST_DOMAIN
            && manifest.policy == ADAPTIVE_POLICY
            && methodology.origin == manifest.config.origin
            && methodology.roster == manifest.config.roster
            && methodology.expected_length as usize == methodology.canonical.len()
            && canonical_adaptive_manifest(&manifest.config, manifest.initial_operator)?
                == methodology.canonical
            && cox_math::artifact_digest(&methodology.canonical) == methodology.digest,
        CoxError::InvalidManifest
    );
    Ok(manifest)
}
