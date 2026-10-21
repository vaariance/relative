use crate::preparation;
use anchor_lang::{prelude::Pubkey, AnchorSerialize};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::Path};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Asset {
    pub id: String,
    pub feed_id: u32,
    pub origin_price_e8: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Anchor {
    pub universe_digest: [u8; 32],
    pub timestamp_us: u64,
    pub benchmark: i128,
    pub assets: Vec<Asset>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mapping {
    pub basic_id: u8,
    pub epoch_id: u16,
    pub epoch_feed_id: [u8; 32],
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema: String,
    pub version: String,
    pub basic_program: String,
    pub basic_pool_id: u64,
    pub operator: String,
    pub anchor: Anchor,
    pub mapping: Vec<Mapping>,
    pub feed_check_digest: [u8; 32],
    pub max_price_age_ms: u64,
    pub max_feed_age_ms: u64,
    pub trading_opens_at: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SealConfig {
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
impl SealConfig {
    pub fn protocol_config(&self) -> cox::AdaptiveManifestConfig {
        cox::AdaptiveManifestConfig {
            version: self.version.clone(),
            roster: self.roster.clone(),
            pyth_feed_ids: self.pyth_feed_ids.clone(),
            origin: self.origin,
            origin_prices: self.origin_prices.clone(),
            universe_digest: self.universe_digest,
            feed_check_digest: self.feed_check_digest,
            max_price_age_ms: self.max_price_age_ms,
            max_feed_age_ms: self.max_feed_age_ms,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PoolAdmission {
    pub pool_id: u64,
    pub pool_address: String,
    pub methodology: String,
    pub trading_opens_at: u64,
    pub instruction_args_hex: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prepared {
    pub schema: String,
    pub activated: bool,
    pub request: Request,
    pub seal_config: SealConfig,
    pub canonical_hex: String,
    pub digest: String,
    pub methodology_address: String,
    pub canonical_length: u32,
    pub seal_instruction_args_hex: String,
    pub pool_admission: PoolAdmission,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    InvalidRequest,
    InvalidManifest,
    InvalidCommitment,
    Storage,
}
fn public_key(value: &str) -> Result<Pubkey, Error> {
    let key: Pubkey = value.parse().map_err(|_| Error::InvalidRequest)?;
    if key == Pubkey::default() || key.to_string() != value {
        return Err(Error::InvalidRequest);
    }
    Ok(key)
}
pub fn prepare(request: Request) -> Result<Prepared, Error> {
    let program = public_key(&request.basic_program)?;
    let operator = public_key(&request.operator)?;
    if request.schema != "relative.methodology-request/v1"
        || request.basic_pool_id < 2
        || request.anchor.benchmark != 100 * cox_math::SCALE
        || request.anchor.timestamp_us == 0
        || request.anchor.timestamp_us % 1_000_000 != 0
        || request.trading_opens_at % cox_epoch::EPOCH_SECONDS != 0
        || request.trading_opens_at < request.anchor.timestamp_us / 1_000_000
        || request.anchor.assets.len() != request.mapping.len()
    {
        return Err(Error::InvalidRequest);
    }
    let mut epoch_ids = BTreeSet::new();
    let mut epoch_feeds = BTreeSet::new();
    for (asset, mapping) in request.anchor.assets.iter().zip(&request.mapping) {
        if cox::IDS.get(usize::from(mapping.basic_id)).copied() != Some(asset.id.as_str())
            || mapping.epoch_id >= 256
            || mapping.epoch_feed_id == [0; 32]
            || !epoch_ids.insert(mapping.epoch_id)
            || !epoch_feeds.insert(mapping.epoch_feed_id)
        {
            return Err(Error::InvalidRequest);
        }
    }
    let config = SealConfig {
        version: request.version.clone(),
        roster: request.mapping.iter().map(|m| m.basic_id).collect(),
        pyth_feed_ids: request.anchor.assets.iter().map(|a| a.feed_id).collect(),
        origin: request.anchor.timestamp_us / 1_000_000,
        origin_prices: request
            .anchor
            .assets
            .iter()
            .map(|a| a.origin_price_e8)
            .collect(),
        universe_digest: request.anchor.universe_digest,
        feed_check_digest: request.feed_check_digest,
        max_price_age_ms: request.max_price_age_ms,
        max_feed_age_ms: request.max_feed_age_ms,
    };
    let protocol = config.protocol_config();
    let canonical = cox::canonical_adaptive_manifest(&protocol, operator)
        .map_err(|_| Error::InvalidManifest)?;
    let digest = cox_math::artifact_digest(&canonical);
    let methodology = Pubkey::find_program_address(&[b"methodology", &digest], &program).0;
    let pool =
        Pubkey::find_program_address(&[b"pool", &request.basic_pool_id.to_le_bytes()], &program).0;
    let seal_instruction_args_hex =
        hex::encode(protocol.try_to_vec().map_err(|_| Error::InvalidManifest)?);
    let mut init_args = request.basic_pool_id.to_le_bytes().to_vec();
    init_args.extend_from_slice(&request.trading_opens_at.to_le_bytes());
    let admission = PoolAdmission {
        pool_id: request.basic_pool_id,
        pool_address: pool.to_string(),
        methodology: methodology.to_string(),
        trading_opens_at: request.trading_opens_at,
        instruction_args_hex: hex::encode(init_args),
    };
    Ok(Prepared {
        schema: "relative.methodology-preparation/v1".into(),
        activated: false,
        request,
        seal_config: config,
        canonical_hex: hex::encode(&canonical),
        digest: hex::encode(digest),
        methodology_address: methodology.to_string(),
        canonical_length: canonical
            .len()
            .try_into()
            .map_err(|_| Error::InvalidManifest)?,
        seal_instruction_args_hex,
        pool_admission: admission,
    })
}
pub fn validate(value: &Prepared) -> Result<(), Error> {
    if prepare(value.request.clone())? != *value {
        return Err(Error::InvalidCommitment);
    }
    Ok(())
}
pub fn prepare_file(input: &Path, output: &Path) -> Result<Prepared, Error> {
    let request = preparation::read_request(input).map_err(|_| Error::InvalidRequest)?;
    let artifact = prepare(request)?;
    preparation::persist(output, &artifact).map_err(|_| Error::Storage)?;
    Ok(artifact)
}
