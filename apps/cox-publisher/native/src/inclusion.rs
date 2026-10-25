use crate::{
    activation, preparation,
    rpc::DEVNET_GENESIS,
    universe_runtime::{self, Evidence, Receipt},
};
use anchor_lang::{prelude::Pubkey, AccountDeserialize};
use cox::{Instrument, UniverseCapture, UniverseSchedule, UniverseVersion};
use relative_methodology::{
    inclusion::{self as admission, AssetDefinition, InclusionPolicy, UniverseSnapshot},
    transition::{self, Binding, Preparation},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Commitment {
    Confirmed,
    Finalized,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleEvidence {
    pub genesis_hash: String,
    pub program: String,
    pub address: String,
    pub owner: String,
    pub slot: u64,
    pub commitment: Commitment,
    pub account_data: Vec<u8>,
}
impl ScheduleEvidence {
    pub fn decode(&self, previous: &UniverseVersion) -> Result<UniverseSchedule, Error> {
        let program: Pubkey = self.program.parse().map_err(|_| Error::Schedule)?;
        let owner: Pubkey = self.owner.parse().map_err(|_| Error::Schedule)?;
        let address: Pubkey = self.address.parse().map_err(|_| Error::Schedule)?;
        if self.genesis_hash != crate::rpc::protocol_genesis()
            || program != cox::ID
            || owner != program
            || self.slot == 0
            || self.account_data.len() > 1024
        {
            return Err(Error::Schedule);
        }
        let schedule = UniverseSchedule::try_deserialize(&mut self.account_data.as_slice())
            .map_err(|_| Error::Schedule)?;
        let (expected, bump) = Pubkey::find_program_address(
            &[
                b"universe-schedule",
                previous.pool.as_ref(),
                &schedule.version.to_le_bytes(),
            ],
            &program,
        );
        if address != expected || bump != schedule.bump {
            return Err(Error::Schedule);
        }
        schedule
            .eligible(previous.pool, schedule.activation_timestamp)
            .map_err(|_| Error::Schedule)?;
        Ok(schedule)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema: String,
    pub preparation: Preparation,
    pub policy: InclusionPolicy,
    pub operator: [u8; 32],
    pub previous_canonical: Vec<u8>,
    pub schedule: ScheduleEvidence,
    pub captured: activation::Captured,
    pub predecessor_sequence: u64,
    pub predecessor_state_digest: [u8; 32],
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Prepared,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prepared {
    pub schema: String,
    pub status: Status,
    pub request: Request,
    pub receipt: Receipt,
    pub digest: String,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Admission,
    Binding,
    Schedule,
    Capture,
    Universe,
    Commitment,
    Storage,
}

fn definition<'a>(
    universe: &'a UniverseSnapshot,
    binding: &Binding,
) -> Result<&'a AssetDefinition, Error> {
    universe
        .assets
        .iter()
        .find(|asset| asset.definition.stable_asset_id == binding.stable_asset_id)
        .map(|asset| &asset.definition)
        .ok_or(Error::Binding)
}
fn mint(asset: &AssetDefinition) -> Result<Option<Pubkey>, Error> {
    asset
        .token_mint
        .as_ref()
        .map(|value| value.parse().map_err(|_| Error::Binding))
        .transpose()
}
fn instrument_matches(
    asset: &AssetDefinition,
    binding: &Binding,
    instrument: &Instrument,
) -> Result<(), Error> {
    let reference = binding.original_reference.as_ref().ok_or(Error::Binding)?;
    if instrument.stable_id != binding.stable_asset_id
        || instrument.symbol != binding.runtime_asset_id
        || instrument.pyth_pro_feed_id != binding.pro_feed_id
        || instrument.pyth_core_feed_id != binding.epoch_feed_id
        || instrument.class_id != binding.basic_class_id
        || instrument.epoch_id != binding.epoch_asset_id
        || instrument.token_mint != mint(asset)?
        || instrument.original_price_e8 != reference.price_e8
        || instrument.original_benchmark != reference.benchmark
        || instrument.original_timestamp.checked_mul(1_000_000) != Some(reference.timestamp_us)
    {
        return Err(Error::Binding);
    }
    Ok(())
}
pub fn validate_admission(
    preparation: &Preparation,
    policy: &InclusionPolicy,
) -> Result<(), Error> {
    transition::validate(preparation).map_err(|_| Error::Admission)?;
    let transition = &preparation.request;
    let previous_ids = transition
        .previous
        .assets
        .iter()
        .map(|asset| asset.definition.stable_asset_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let mut scheduled = Vec::new();
    for asset in transition
        .next
        .assets
        .iter()
        .filter(|asset| !previous_ids.contains(asset.definition.stable_asset_id.as_str()))
    {
        let candidate =
            admission::candidate_asset(asset.definition.clone()).map_err(|_| Error::Admission)?;
        let validated = admission::validate_candidate(
            candidate,
            asset.evidence.clone(),
            asset.evidence.checked_at,
            policy,
        )
        .map_err(|_| Error::Admission)?;
        let approved = admission::approve_asset(
            validated,
            asset.approved_by.clone(),
            asset.approved_at,
            policy,
        )
        .map_err(|_| Error::Admission)?;
        scheduled.push(
            admission::schedule_asset(approved, asset.activates_at, asset.scheduled_at, policy)
                .map_err(|_| Error::Admission)?,
        );
    }
    if admission::activate_universe(
        Some(&transition.previous),
        &scheduled,
        transition.next.effective_at,
        policy,
    )
    .map_err(|_| Error::Admission)?
        != transition.next
    {
        return Err(Error::Admission);
    }
    Ok(())
}
pub fn build_successor(request: Request) -> Result<Prepared, Error> {
    if request.schema != "relative.inclusion-successor-request/v1" {
        return Err(Error::Admission);
    }
    validate_admission(&request.preparation, &request.policy)?;
    activation::validate_capture(&request.captured).map_err(|_| Error::Capture)?;
    let previous = UniverseVersion::from_canonical(&request.previous_canonical)
        .map_err(|_| Error::Universe)?;
    let previous_view =
        universe_runtime::view(&request.previous_canonical).map_err(|_| Error::Universe)?;
    let transition = &request.preparation.request;
    if !matches!(
        (previous.schema_version, transition.schema.as_str()),
        (1, "relative.inclusion-request/v1") | (2, "relative.inclusion-request/v2")
    ) || transition.previous_bindings.len() != previous.instruments.len()
        || request.captured.request.previous_anchor != previous_view.anchor
        || request.preparation.activation_timestamp_us != request.captured.captured.timestamp_us
        || transition.previous.version != previous.version
        || transition.next.version != previous.version.checked_add(1).ok_or(Error::Universe)?
    {
        return Err(Error::Binding);
    }
    let prior_bindings = transition
        .previous_bindings
        .iter()
        .map(|value| (value.stable_asset_id.as_str(), value))
        .collect::<BTreeMap<_, _>>();
    for instrument in &previous.instruments {
        let binding = prior_bindings
            .get(instrument.stable_id.as_str())
            .ok_or(Error::Binding)?;
        instrument_matches(
            definition(&transition.previous, binding)?,
            binding,
            instrument,
        )?;
    }
    let schedule = request.schedule.decode(&previous)?;
    let capture = &request.captured.captured;
    let timestamp = capture.timestamp_us / 1_000_000;
    let mut instruments = previous.instruments.clone();
    let mut additions = transition
        .next_bindings
        .iter()
        .filter(|binding| !prior_bindings.contains_key(binding.stable_asset_id.as_str()))
        .collect::<Vec<_>>();
    additions.sort_by_key(|binding| binding.basic_class_id);
    for binding in additions {
        let asset = definition(&transition.next, binding)?;
        let price = capture
            .assets
            .get(instruments.len())
            .ok_or(Error::Capture)?;
        if price.id != binding.runtime_asset_id || price.feed_id != binding.pro_feed_id {
            return Err(Error::Binding);
        }
        instruments.push(Instrument {
            stable_id: binding.stable_asset_id.clone(),
            symbol: binding.runtime_asset_id.clone(),
            class_id: binding.basic_class_id,
            epoch_id: binding.epoch_asset_id,
            pyth_pro_feed_id: binding.pro_feed_id,
            pyth_core_feed_id: binding.epoch_feed_id,
            token_mint: mint(asset)?,
            original_price_e8: price.price_e8,
            original_benchmark: request.captured.old_benchmark,
            original_timestamp: timestamp,
        });
    }
    let mut next = UniverseVersion::draft(
        0,
        previous.pool,
        Pubkey::new_from_array(request.operator),
        previous.source_methodology,
        schedule.version,
        previous.digest,
        instruments.len().try_into().map_err(|_| Error::Universe)?,
        UniverseCapture {
            price_universe_digest: request.captured.next_anchor.universe_digest,
            timestamp,
            benchmark: request.captured.old_benchmark,
            prices_e8: capture.assets.iter().map(|asset| asset.price_e8).collect(),
            signed_payload_digest: hex::decode(&capture.signed_payload_sha256)
                .map_err(|_| Error::Capture)?
                .try_into()
                .map_err(|_| Error::Capture)?,
            trusted_storage_digest: universe_runtime::trusted_storage_digest(capture)
                .map_err(|_| Error::Capture)?,
            predecessor_sequence: request.predecessor_sequence,
            predecessor_state_digest: request.predecessor_state_digest,
        },
    )
    .map_err(|_| Error::Universe)?;
    next.schema_version = previous.schema_version;
    next.instruments = instruments;
    schedule
        .validate_successor(&previous, &next)
        .map_err(|_| Error::Schedule)?;
    next.seal_successor(&previous, request.captured.old_benchmark)
        .map_err(|_| Error::Universe)?;
    let receipt = Receipt {
        schema: "relative.runtime-universe-receipt/v1".into(),
        genesis_hash: DEVNET_GENESIS.into(),
        canonical: next.canonical_bytes().map_err(|_| Error::Universe)?,
        previous_canonical: Some(request.previous_canonical.clone()),
        evidence: Evidence::Inclusion(request.captured.clone()),
    };
    receipt
        .validate_for_operator(&Pubkey::new_from_array(request.operator))
        .map_err(|_| Error::Universe)?;
    let mut result = Prepared {
        schema: "relative.inclusion-successor/v1".into(),
        status: Status::Prepared,
        request,
        receipt,
        digest: String::new(),
    };
    result.digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&result).map_err(|_| Error::Commitment)?,
    ));
    Ok(result)
}
pub fn validate(value: &Prepared) -> Result<(), Error> {
    if build_successor(value.request.clone())? != *value {
        return Err(Error::Commitment);
    }
    Ok(())
}
pub fn persist(output: &Path, value: &Prepared) -> Result<(), Error> {
    validate(value)?;
    preparation::persist(output, value).map_err(|_| Error::Storage)
}
pub fn prepare_file(input: &Path, output: &Path) -> Result<Prepared, Error> {
    let request = preparation::read_request(input).map_err(|_| Error::Admission)?;
    let value = build_successor(request)?;
    persist(output, &value)?;
    Ok(value)
}
