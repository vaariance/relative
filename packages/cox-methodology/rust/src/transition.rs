use crate::inclusion::{assert_snapshot, FeedIdentity, UniverseSnapshot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OriginalReference {
    pub timestamp_us: u64,
    pub price_e8: u64,
    pub benchmark: i128,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub stable_asset_id: String,
    pub runtime_asset_id: String,
    pub pro_feed_id: u32,
    pub basic_class_id: u16,
    pub epoch_asset_id: u16,
    pub epoch_feed_id: [u8; 32],
    pub original_reference: Option<OriginalReference>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema: String,
    pub previous: UniverseSnapshot,
    pub next: UniverseSnapshot,
    pub previous_bindings: Vec<Binding>,
    pub next_bindings: Vec<Binding>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Blocker {
    BasicDynamicRoster,
    EpochSnapshotStaging,
    VerifiedActivationPriceCapture,
    RuntimeTransitionIntegration,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preparation {
    pub schema: String,
    pub request: Request,
    pub activation_timestamp_us: u64,
    pub required_pro_feed_ids: Vec<u32>,
    pub reference_capture_required: Vec<String>,
    pub blockers: Vec<Blocker>,
    pub digest: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidUniverse,
    InvalidLineage,
    InvalidBinding,
    ReferenceChanged,
    InvalidCommitment,
}
fn bindings(
    universe: &UniverseSnapshot,
    values: &[Binding],
    previous: bool,
    crypto_class: u16,
) -> Result<(), Error> {
    if values.len() != universe.assets.len() {
        return Err(Error::InvalidBinding);
    }
    let mut stable = BTreeSet::new();
    let mut runtime = BTreeSet::new();
    let mut basic = BTreeSet::new();
    let mut epoch = BTreeSet::new();
    let mut feeds = BTreeSet::new();
    for (asset, binding) in universe.assets.iter().zip(values) {
        if binding.stable_asset_id != asset.definition.stable_asset_id
            || binding.runtime_asset_id.is_empty()
            || binding.runtime_asset_id.len() > 64
            || !binding
                .runtime_asset_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            || asset.definition.feed
                != (FeedIdentity::Pro {
                    price_feed_id: u64::from(binding.pro_feed_id),
                })
            || binding.pro_feed_id == 0
            || binding.basic_class_id >= 256
            || binding.basic_class_id == crypto_class
            || binding.epoch_asset_id >= 256
            || binding.epoch_feed_id == [0; 32]
            || !stable.insert(&binding.stable_asset_id)
            || !runtime.insert(&binding.runtime_asset_id)
            || !basic.insert(binding.basic_class_id)
            || !epoch.insert(binding.epoch_asset_id)
            || !feeds.insert(binding.epoch_feed_id)
        {
            return Err(Error::InvalidBinding);
        }
        match &binding.original_reference {
            Some(reference)
                if reference.timestamp_us > 0
                    && reference.timestamp_us
                        <= universe
                            .effective_at
                            .checked_mul(1_000_000)
                            .ok_or(Error::InvalidUniverse)?
                    && reference.price_e8 > 0
                    && reference.benchmark > 0 => {}
            None if !previous => {}
            _ => return Err(Error::InvalidBinding),
        }
    }
    Ok(())
}
pub fn prepare(request: Request) -> Result<Preparation, Error> {
    let crypto_class = match request.schema.as_str() {
        "relative.inclusion-request/v1" => 30,
        "relative.inclusion-request/v2" => 0,
        _ => return Err(Error::InvalidBinding),
    };
    assert_snapshot(&request.previous).map_err(|_| Error::InvalidUniverse)?;
    assert_snapshot(&request.next).map_err(|_| Error::InvalidUniverse)?;
    if request.next.predecessor_digest.as_ref() != Some(&request.previous.digest)
        || request.previous.version.checked_add(1) != Some(request.next.version)
        || request.next.effective_at <= request.previous.effective_at
        || request.next.assets.len() <= request.previous.assets.len()
    {
        return Err(Error::InvalidLineage);
    }
    bindings(
        &request.previous,
        &request.previous_bindings,
        true,
        crypto_class,
    )?;
    bindings(&request.next, &request.next_bindings, false, crypto_class)?;
    for (asset, binding) in request
        .previous
        .assets
        .iter()
        .zip(&request.previous_bindings)
    {
        if !request.next.assets.contains(asset) {
            return Err(Error::InvalidLineage);
        }
        if !request.next_bindings.contains(binding) {
            return Err(Error::ReferenceChanged);
        }
    }
    let additions = request
        .next_bindings
        .iter()
        .filter(|binding| {
            !request
                .previous_bindings
                .iter()
                .any(|old| old.stable_asset_id == binding.stable_asset_id)
        })
        .collect::<Vec<_>>();
    if additions
        .iter()
        .any(|binding| binding.original_reference.is_some())
    {
        return Err(Error::ReferenceChanged);
    }
    let reference_capture_required = additions
        .iter()
        .map(|binding| binding.stable_asset_id.clone())
        .collect();
    let required_pro_feed_ids = request
        .next_bindings
        .iter()
        .map(|binding| binding.pro_feed_id)
        .collect();
    let activation_timestamp_us = request
        .next
        .effective_at
        .checked_mul(1_000_000)
        .ok_or(Error::InvalidUniverse)?;
    let mut result = Preparation {
        schema: "relative.inclusion-preparation/v1".into(),
        request,
        activation_timestamp_us,
        required_pro_feed_ids,
        reference_capture_required,
        blockers: vec![
            Blocker::BasicDynamicRoster,
            Blocker::EpochSnapshotStaging,
            Blocker::VerifiedActivationPriceCapture,
            Blocker::RuntimeTransitionIntegration,
        ],
        digest: String::new(),
    };
    result.digest = commitment(&result)?;
    Ok(result)
}
fn commitment(value: &Preparation) -> Result<String, Error> {
    let bytes = serde_json::to_vec(&(
        "RELATIVE/INCLUSION-PREPARATION/V1",
        &value.schema,
        &value.request,
        value.activation_timestamp_us,
        &value.required_pro_feed_ids,
        &value.reference_capture_required,
        &value.blockers,
    ))
    .map_err(|_| Error::InvalidCommitment)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}
pub fn validate(value: &Preparation) -> Result<(), Error> {
    let expected = prepare(value.request.clone())?;
    if expected != *value {
        return Err(Error::InvalidCommitment);
    }
    Ok(())
}
