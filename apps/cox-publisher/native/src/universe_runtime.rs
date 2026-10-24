use crate::{
    activation,
    benchmark::{Anchor, Asset, History, Observation},
    executor::AssetMapping,
    journal::{self, FileHistory},
    origin, preparation,
    rpc::DEVNET_GENESIS,
};
use cox::UniverseVersion;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct View {
    pub digest: [u8; 32],
    pub crypto_class: u16,
    pub source_methodology: [u8; 32],
    pub anchor: Anchor,
    pub mapping: Vec<AssetMapping>,
    pub original_prices: Vec<u64>,
    pub original_benchmarks: Vec<i128>,
    pub original_timestamps: Vec<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "capture", deny_unknown_fields)]
pub enum Evidence {
    Genesis(origin::Captured),
    Inclusion(activation::Captured),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub schema: String,
    pub genesis_hash: String,
    pub canonical: Vec<u8>,
    pub previous_canonical: Option<Vec<u8>>,
    pub evidence: Evidence,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Manifest,
    Evidence,
    Lineage,
    Storage,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenesisRequest {
    pub schema: String,
    pub methodology: crate::methodology::Prepared,
    pub capture: origin::Captured,
    pub predecessor_sequence: u64,
    pub predecessor_state_digest: [u8; 32],
}

pub fn prepare_genesis(request: GenesisRequest) -> Result<Receipt, Error> {
    use anchor_lang::prelude::Pubkey;
    use cox::{Instrument, UniverseCapture};
    if request.schema != "relative.genesis-universe-request/v1"
        || request.predecessor_state_digest == [0; 32]
    {
        return Err(Error::Manifest);
    }
    crate::methodology::validate(&request.methodology).map_err(|_| Error::Manifest)?;
    origin::validate_capture(&request.capture).map_err(|_| Error::Evidence)?;
    let policy = &request.methodology.request;
    if request.capture.timestamp_us != policy.anchor.timestamp_us
        || request.capture.assets.len() != policy.anchor.assets.len()
        || request
            .capture
            .assets
            .iter()
            .zip(&policy.anchor.assets)
            .any(|(actual, expected)| {
                actual.id != expected.id
                    || actual.feed_id != expected.feed_id
                    || actual.price_e8 != expected.origin_price_e8
            })
    {
        return Err(Error::Evidence);
    }
    let pool: Pubkey = request
        .methodology
        .pool_admission
        .pool_address
        .parse()
        .map_err(|_| Error::Manifest)?;
    let operator: Pubkey = policy.operator.parse().map_err(|_| Error::Manifest)?;
    let source_methodology = hex::decode(&request.methodology.digest)
        .map_err(|_| Error::Manifest)?
        .try_into()
        .map_err(|_| Error::Manifest)?;
    let signed_payload_digest = hex::decode(&request.capture.signed_payload_sha256)
        .map_err(|_| Error::Evidence)?
        .try_into()
        .map_err(|_| Error::Evidence)?;
    let mut universe = UniverseVersion::draft(
        0,
        pool,
        operator,
        source_methodology,
        1,
        [0; 32],
        policy.anchor.assets.len() as u16,
        UniverseCapture {
            price_universe_digest: policy.anchor.universe_digest,
            timestamp: policy.anchor.timestamp_us / 1_000_000,
            benchmark: policy.anchor.benchmark,
            prices_e8: policy
                .anchor
                .assets
                .iter()
                .map(|asset| asset.origin_price_e8)
                .collect(),
            signed_payload_digest,
            trusted_storage_digest: trusted_storage_digest(&request.capture)?,
            predecessor_sequence: request.predecessor_sequence,
            predecessor_state_digest: request.predecessor_state_digest,
        },
    )
    .map_err(|_| Error::Manifest)?;
    universe.instruments = policy
        .anchor
        .assets
        .iter()
        .zip(&policy.mapping)
        .map(|(asset, mapping)| Instrument {
            stable_id: asset.id.to_ascii_lowercase(),
            symbol: asset.id.clone(),
            class_id: u16::from(mapping.basic_id),
            epoch_id: mapping.epoch_id,
            pyth_pro_feed_id: asset.feed_id,
            pyth_core_feed_id: mapping.epoch_feed_id,
            token_mint: None,
            original_price_e8: asset.origin_price_e8,
            original_benchmark: policy.anchor.benchmark,
            original_timestamp: policy.anchor.timestamp_us / 1_000_000,
        })
        .collect();
    universe
        .seal_initial(&request.methodology.seal_config.protocol_config())
        .map_err(|_| Error::Manifest)?;
    let receipt = Receipt {
        schema: "relative.runtime-universe-receipt/v1".into(),
        genesis_hash: DEVNET_GENESIS.into(),
        canonical: universe.canonical_bytes().map_err(|_| Error::Manifest)?,
        previous_canonical: None,
        evidence: Evidence::Genesis(request.capture),
    };
    receipt.validate_for_operator(&operator)?;
    Ok(receipt)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FreshGenesisRequest {
    pub schema: String,
    pub basic_program: String,
    pub basic_pool_id: u64,
    pub operator: String,
    pub policy_digest: [u8; 32],
    pub universe_digest: [u8; 32],
    pub mapping: Vec<AssetMapping>,
    pub capture: origin::Captured,
}

pub fn prepare_fresh_genesis(request: FreshGenesisRequest) -> Result<Receipt, Error> {
    use anchor_lang::prelude::Pubkey;
    use cox::{Instrument, UniverseCapture};
    if request.schema != "relative.fresh-genesis-universe-request/v1"
        || request.basic_pool_id < 2
        || request.policy_digest == [0; 32]
        || request.universe_digest == [0; 32]
        || !(30..=255).contains(&request.capture.assets.len())
        || request.mapping.len() != request.capture.assets.len()
    {
        return Err(Error::Manifest);
    }
    origin::validate_capture(&request.capture).map_err(|_| Error::Evidence)?;
    let program: Pubkey = request.basic_program.parse().map_err(|_| Error::Manifest)?;
    let operator: Pubkey = request.operator.parse().map_err(|_| Error::Manifest)?;
    if program == Pubkey::default() || operator == Pubkey::default() {
        return Err(Error::Manifest);
    }
    let pool =
        Pubkey::find_program_address(&[b"pool", &request.basic_pool_id.to_le_bytes()], &program).0;
    let signed_payload_digest = hex::decode(&request.capture.signed_payload_sha256)
        .map_err(|_| Error::Evidence)?
        .try_into()
        .map_err(|_| Error::Evidence)?;
    let timestamp = request.capture.timestamp_us / 1_000_000;
    let benchmark = 100 * cox_math::SCALE;
    let mut universe = UniverseVersion::draft(
        0,
        pool,
        operator,
        request.policy_digest,
        1,
        [0; 32],
        request.capture.assets.len() as u16,
        UniverseCapture {
            price_universe_digest: request.universe_digest,
            timestamp,
            benchmark,
            prices_e8: request
                .capture
                .assets
                .iter()
                .map(|asset| asset.price_e8)
                .collect(),
            signed_payload_digest,
            trusted_storage_digest: trusted_storage_digest(&request.capture)?,
            predecessor_sequence: 0,
            predecessor_state_digest: [0; 32],
        },
    )
    .map_err(|_| Error::Manifest)?;
    universe.schema_version = 2;
    universe.instruments = request
        .capture
        .assets
        .iter()
        .zip(request.mapping)
        .map(|(asset, mapping)| Instrument {
            stable_id: asset.id.to_ascii_lowercase(),
            symbol: asset.id.clone(),
            class_id: mapping.basic_id,
            epoch_id: mapping.epoch_id,
            pyth_pro_feed_id: asset.feed_id,
            pyth_core_feed_id: mapping.epoch_feed_id,
            token_mint: None,
            original_price_e8: asset.price_e8,
            original_benchmark: benchmark,
            original_timestamp: timestamp,
        })
        .collect();
    universe.seal_genesis().map_err(|_| Error::Manifest)?;
    let receipt = Receipt {
        schema: "relative.runtime-universe-receipt/v1".into(),
        genesis_hash: DEVNET_GENESIS.into(),
        canonical: universe.canonical_bytes().map_err(|_| Error::Manifest)?,
        previous_canonical: None,
        evidence: Evidence::Genesis(request.capture),
    };
    receipt.validate_for_operator(&operator)?;
    Ok(receipt)
}

pub fn prepare_fresh_genesis_file(input: &Path, output: &Path) -> Result<Receipt, Error> {
    let request = preparation::read_request(input).map_err(|_| Error::Manifest)?;
    let receipt = prepare_fresh_genesis(request)?;
    preparation::persist(output, &receipt).map_err(|_| Error::Storage)?;
    Ok(receipt)
}

pub fn initial_receipt(directory: &Path, canonical: &[u8]) -> Result<Receipt, Error> {
    let mut canonical = canonical.to_vec();
    for _ in 0..255 {
        let current = view(&canonical)?;
        let receipt: Receipt = journal::read(
            &directory
                .join("universes")
                .join(format!("{}.json", hex::encode(current.digest))),
        )
        .map_err(|_| Error::Storage)?
        .ok_or(Error::Storage)?;
        if receipt.canonical != canonical || receipt.validate()? != current {
            return Err(Error::Lineage);
        }
        match receipt.previous_canonical.as_ref() {
            None => return Ok(receipt),
            Some(previous) => canonical = previous.clone(),
        }
    }
    Err(Error::Lineage)
}

pub fn prepare_genesis_file(input: &Path, output: &Path) -> Result<Receipt, Error> {
    let request = preparation::read_request(input).map_err(|_| Error::Manifest)?;
    let receipt = prepare_genesis(request)?;
    preparation::persist(output, &receipt).map_err(|_| Error::Storage)?;
    Ok(receipt)
}

pub fn view(canonical: &[u8]) -> Result<View, Error> {
    let universe = UniverseVersion::from_canonical(canonical).map_err(|_| Error::Manifest)?;
    let assets = universe
        .instruments
        .iter()
        .zip(&universe.capture.prices_e8)
        .map(|(instrument, price)| Asset {
            id: instrument.symbol.clone(),
            feed_id: instrument.pyth_pro_feed_id,
            origin_price_e8: *price,
        })
        .collect();
    Ok(View {
        digest: universe.digest,
        crypto_class: universe.crypto_class(),
        source_methodology: universe.source_methodology,
        anchor: Anchor {
            universe_digest: universe.capture.price_universe_digest,
            timestamp_us: universe
                .capture
                .timestamp
                .checked_mul(1_000_000)
                .ok_or(Error::Manifest)?,
            benchmark: universe.capture.benchmark,
            assets,
        },
        mapping: universe
            .instruments
            .iter()
            .map(|instrument| AssetMapping {
                basic_id: instrument.class_id,
                epoch_id: instrument.epoch_id,
                epoch_feed_id: instrument.pyth_core_feed_id,
            })
            .collect(),
        original_prices: universe
            .instruments
            .iter()
            .map(|instrument| instrument.original_price_e8)
            .collect(),
        original_benchmarks: universe
            .instruments
            .iter()
            .map(|instrument| instrument.original_benchmark)
            .collect(),
        original_timestamps: universe
            .instruments
            .iter()
            .map(|instrument| instrument.original_timestamp)
            .collect(),
    })
}

pub fn trusted_storage_digest(capture: &origin::Captured) -> Result<[u8; 32], Error> {
    let bytes = serde_json::to_vec(&capture.verification).map_err(|_| Error::Evidence)?;
    Ok(Sha256::digest(bytes).into())
}

impl Receipt {
    pub fn validate(&self) -> Result<View, Error> {
        if self.schema != "relative.runtime-universe-receipt/v1"
            || self.genesis_hash != DEVNET_GENESIS
        {
            return Err(Error::Manifest);
        }
        let current =
            UniverseVersion::from_canonical(&self.canonical).map_err(|_| Error::Manifest)?;
        let result = view(&self.canonical)?;
        let capture = match &self.evidence {
            Evidence::Genesis(capture) => {
                origin::validate_capture(capture).map_err(|_| Error::Evidence)?;
                if current.version != 1
                    || self.previous_canonical.is_some()
                    || result.anchor.benchmark != 100 * cox_math::SCALE
                    || current.instruments.iter().any(|asset| {
                        asset.original_benchmark != result.anchor.benchmark
                            || asset.original_timestamp != current.capture.timestamp
                    })
                {
                    return Err(Error::Lineage);
                }
                capture
            }
            Evidence::Inclusion(capture) => {
                activation::validate_capture(capture).map_err(|_| Error::Evidence)?;
                let previous_bytes = self.previous_canonical.as_ref().ok_or(Error::Lineage)?;
                let previous =
                    UniverseVersion::from_canonical(previous_bytes).map_err(|_| Error::Lineage)?;
                let previous_view = view(previous_bytes)?;
                if current.version != previous.version.checked_add(1).ok_or(Error::Lineage)?
                    || current.predecessor_digest != previous.digest
                    || current.source_methodology != previous.source_methodology
                    || current.pool != previous.pool
                    || current.instruments.len() <= previous.instruments.len()
                    || !current.instruments.starts_with(&previous.instruments)
                    || previous_view.anchor != capture.request.previous_anchor
                    || result.anchor != capture.next_anchor
                    || current.capture.benchmark != capture.old_benchmark
                    || current
                        .instruments
                        .iter()
                        .enumerate()
                        .skip(previous.instruments.len())
                        .any(|(index, asset)| {
                            asset.original_price_e8 != current.capture.prices_e8[index]
                                || asset.original_benchmark != current.capture.benchmark
                                || asset.original_timestamp != current.capture.timestamp
                        })
                {
                    return Err(Error::Lineage);
                }
                &capture.captured
            }
        };
        let signed: [u8; 32] = hex::decode(&capture.signed_payload_sha256)
            .map_err(|_| Error::Evidence)?
            .try_into()
            .map_err(|_| Error::Evidence)?;
        if current.capture.timestamp.checked_mul(1_000_000) != Some(capture.timestamp_us)
            || current.capture.signed_payload_digest != signed
            || current.capture.trusted_storage_digest != trusted_storage_digest(capture)?
            || capture.assets.len() != result.anchor.assets.len()
            || capture
                .assets
                .iter()
                .zip(&result.anchor.assets)
                .any(|(price, asset)| {
                    price.id != asset.id
                        || price.feed_id != asset.feed_id
                        || price.price_e8 != asset.origin_price_e8
                })
            || current.instruments.iter().any(|asset| {
                asset.class_id == current.crypto_class()
                    || asset.original_timestamp > current.capture.timestamp
            })
        {
            return Err(Error::Evidence);
        }
        if matches!(self.evidence, Evidence::Genesis(_))
            && result.original_prices
                != result
                    .anchor
                    .assets
                    .iter()
                    .map(|asset| asset.origin_price_e8)
                    .collect::<Vec<_>>()
        {
            return Err(Error::Evidence);
        }
        Ok(result)
    }

    pub fn validate_for_operator(
        &self,
        expected_operator: &anchor_lang::prelude::Pubkey,
    ) -> Result<View, Error> {
        let view = self.validate()?;
        let current =
            UniverseVersion::from_canonical(&self.canonical).map_err(|_| Error::Manifest)?;
        if current.operator != *expected_operator {
            return Err(Error::Lineage);
        }
        Ok(view)
    }

    pub fn persist(&self, state_directory: &Path) -> Result<View, Error> {
        let active = self.validate()?;
        let directory = state_directory.join("universes");
        fs::create_dir_all(&directory).map_err(|_| Error::Storage)?;
        let path = directory.join(format!("{}.json", hex::encode(active.digest)));
        if let Some(prior) = journal::read::<Self>(&path).map_err(|_| Error::Storage)? {
            if prior != *self {
                return Err(Error::Storage);
            }
        } else {
            preparation::persist(&path, self).map_err(|_| Error::Storage)?;
        }
        Ok(active)
    }

    pub fn captured_observation(&self) -> Result<Observation, Error> {
        let active = self.validate()?;
        let capture = match &self.evidence {
            Evidence::Genesis(capture) => capture,
            Evidence::Inclusion(capture) => &capture.captured,
        };
        Ok(Observation {
            universe_digest: active.anchor.universe_digest,
            timestamp_us: active.anchor.timestamp_us,
            benchmark: active.anchor.benchmark,
            prices_e8: active
                .anchor
                .assets
                .iter()
                .map(|asset| asset.origin_price_e8)
                .collect(),
            signed_payload: hex::decode(&capture.raw_signed_payload_hex)
                .map_err(|_| Error::Evidence)?,
        })
    }
}

pub fn reconcile_committed(
    state_directory: &Path,
    canonical: &[u8],
    initial_anchor: &Anchor,
) -> Result<View, Error> {
    let expected = view(canonical)?;
    let receipt: Receipt = journal::read(
        &state_directory
            .join("universes")
            .join(format!("{}.json", hex::encode(expected.digest))),
    )
    .map_err(|_| Error::Storage)?
    .ok_or(Error::Storage)?;
    if receipt.canonical != canonical || receipt.validate()? != expected {
        return Err(Error::Evidence);
    }
    let previous_anchor = receipt
        .previous_canonical
        .as_ref()
        .map(|bytes| view(bytes).map(|previous| previous.anchor))
        .transpose()?
        .unwrap_or_else(|| initial_anchor.clone());
    if matches!(receipt.evidence, Evidence::Genesis(_)) && expected.anchor != *initial_anchor {
        return Err(Error::Lineage);
    }
    let mut history = FileHistory {
        directory: state_directory.join("prices"),
    };
    if let Some(active) = history.active_anchor().map_err(|_| Error::Storage)? {
        if active != expected.anchor && active != previous_anchor {
            return Err(Error::Lineage);
        }
    }
    history
        .activate(&expected.anchor)
        .map_err(|_| Error::Storage)?;
    let resumed = history
        .latest_staged(&expected.anchor)
        .map_err(|_| Error::Storage)?
        .unwrap_or(receipt.captured_observation()?);
    if history
        .latest()
        .map_err(|_| Error::Storage)?
        .is_none_or(|latest| {
            latest.universe_digest != expected.anchor.universe_digest
                || latest.timestamp_us < resumed.timestamp_us
        })
    {
        history.append(&resumed).map_err(|_| Error::Storage)?;
    }
    history
        .latest_for_anchor(&expected.anchor)
        .map_err(|_| Error::Storage)?;
    Ok(expected)
}
