use crate::{
    activation,
    benchmark::{Anchor, Benchmark, History, Observation},
    chain::ChainState,
    feeds::PythConfig,
    inclusion_pipeline::{self, Commitment, Prepared, ScheduleEvidence},
    inclusion_rollout::{self, Cursor, Status},
    journal::{self, FileHistory},
    preview::PreviewCutoff,
    pyth,
    rpc::Rpc,
    scheduler::Work,
    worker,
};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use base64::{engine::general_purpose::STANDARD, Engine};
use relative_methodology::{inclusion::InclusionPolicy, transition::Preparation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_instruction::Instruction;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, watch};
pub const BOUNDARY_ID: &str = "basic:universe-boundary";
pub const ROLLOUT_ID: &str = "basic:universe-rollout";
pub const HANDOFF_ID: &str = "basic:universe-handoff";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Approved {
    pub schema: String,
    pub preparation: Preparation,
    pub policy: InclusionPolicy,
    pub previous_canonical: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_handoff: Option<crate::universe_runtime::HandoffConfirmation>,
    pub schedule: ScheduleEvidence,
    pub capture_request: activation::Request,
}
impl Approved {
    pub fn validate(&self) -> Result<(), worker::Error> {
        let previous = cox::UniverseVersion::from_canonical(&self.previous_canonical)
            .map_err(|_| worker::Error::Snapshot)?;
        crate::universe_runtime::validate_previous_anchor(&self.previous_canonical, self.previous_handoff.as_ref(), &self.capture_request.previous_anchor)
            .map_err(|_| worker::Error::Snapshot)?;
        inclusion_pipeline::validate_admission(&self.preparation, &self.policy).map_err(err)?;
        inclusion_pipeline::validate_execution_capacity(&self.preparation).map_err(err)?;
        self.capture_request.validate().map_err(err)?;
        let schedule = self
            .schedule
            .decode(&previous)
            .map_err(|_| worker::Error::Snapshot)?;
        if self.schema != "relative.inclusion-approved/v1"
            || self.preparation.activation_timestamp_us
                != self.capture_request.activation_timestamp_us
            || schedule.activation_timestamp.checked_mul(1_000_000)
                != Some(self.capture_request.activation_timestamp_us)
            || self.capture_request.fullnext_assets.len()
                != self.preparation.request.next_bindings.len()
        {
            return Err(worker::Error::Snapshot);
        }
        let mut instruments = previous.instruments.clone();
        let mut additions = self
            .preparation
            .request
            .next_bindings
            .iter()
            .filter(|binding| {
                !previous
                    .instruments
                    .iter()
                    .any(|instrument| instrument.stable_id == binding.stable_asset_id)
            })
            .collect::<Vec<_>>();
        additions.sort_by_key(|binding| binding.basic_class_id);
        for binding in additions {
            let asset = self
                .preparation
                .request
                .next
                .assets
                .iter()
                .find(|asset| asset.definition.stable_asset_id == binding.stable_asset_id)
                .ok_or(worker::Error::Snapshot)?;
            instruments.push(cox::Instrument {
                stable_id: binding.stable_asset_id.clone(),
                symbol: binding.runtime_asset_id.clone(),
                class_id: binding.basic_class_id,
                epoch_id: binding.epoch_asset_id,
                pyth_pro_feed_id: binding.pro_feed_id,
                pyth_core_feed_id: binding.epoch_feed_id,
                token_mint: asset
                    .definition
                    .token_mint
                    .as_ref()
                    .map(|value| value.parse().map_err(err))
                    .transpose()?,
                original_price_e8: 1,
                original_benchmark: 1,
                original_timestamp: schedule.activation_timestamp,
            });
        }
        if schedule.version
            != previous
                .version
                .checked_add(1)
                .ok_or(worker::Error::Snapshot)?
            || schedule.predecessor_digest != previous.digest
            || schedule.source_methodology != previous.source_methodology
            || usize::from(schedule.expected_instruments) != instruments.len()
            || cox::instrument_identities_digest_for_schema(previous.schema_version, &instruments)
                .map_err(err)?
                != schedule.identities_digest
            || self
                .capture_request
                .fullnext_assets
                .iter()
                .zip(&instruments)
                .any(|(asset, instrument)| {
                    asset.id != instrument.symbol || asset.feed_id != instrument.pyth_pro_feed_id
                })
            || self.capture_request.fullnext_assets.iter().any(|asset| {
                !self
                    .preparation
                    .request
                    .next_bindings
                    .iter()
                    .any(|binding| {
                        binding.runtime_asset_id == asset.id && binding.pro_feed_id == asset.feed_id
                    })
            })
        {
            return Err(worker::Error::Snapshot);
        }
        Ok(())
    }
    fn digest(&self) -> Result<[u8; 32], worker::Error> {
        Ok(Sha256::digest(serde_json::to_vec(self).map_err(|_| worker::Error::Storage)?).into())
    }
    fn boundary_ms(&self) -> u64 {
        self.capture_request.activation_timestamp_us / 1000
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum Phase {
    Waiting,
    Captured,
    Prepared,
    Complete,
    RescheduleRequired,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    schema: String,
    approved: Approved,
    digest: [u8; 32],
    captured: Option<activation::Captured>,
    prepared: Option<Prepared>,
    cursor: Option<Cursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    handoff_observation: Option<crate::origin::Captured>,
    phase: Phase,
    reason: Option<String>,
}
pub struct Controller {
    directory: PathBuf,
    stored: Option<Stored>,
    capturing: bool,
    approved_onchain: bool,
    dirty: bool,
}
pub type Shared = Arc<Mutex<Controller>>;
pub enum Action {
    Instructions(Vec<Instruction>),
    Waiting,
    Adopt,
}
fn err<T>(_: T) -> worker::Error {
    worker::Error::Snapshot
}
fn now_ms() -> Result<u64, worker::Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(err)?
        .as_millis()
        .try_into()
        .map_err(err)
}
fn ensure_journal_size(value: &Stored) -> Result<(), worker::Error> {
    if serde_json::to_vec(value)
        .map_err(|_| worker::Error::Storage)?
        .len() as u64
        > journal::MAX_JOURNAL_BYTES
    {
        return Err(worker::Error::Storage);
    }
    Ok(())
}
impl Controller {
    pub fn open(directory: &Path) -> Result<Shared, worker::Error> {
        let stored: Option<Stored> = journal::read(&directory.join("inclusion-execution.json"))
            .map_err(|_| worker::Error::Storage)?;
        if let Some(stored) = &stored {
            stored
                .approved
                .validate()
                .map_err(|_| worker::Error::Storage)?;
            if stored.schema != "relative.inclusion-execution/v1"
                || stored.digest != stored.approved.digest()?
            {
                return Err(worker::Error::Storage);
            }
            if let Some(prepared) = &stored.prepared {
                inclusion_pipeline::validate(prepared).map_err(|_| worker::Error::Storage)?;
            }
        }
        Ok(Arc::new(Mutex::new(Self {
            directory: directory.into(),
            stored,
            capturing: false,
            approved_onchain: false,
            dirty: false,
        })))
    }
    fn persist(&self) -> Result<(), worker::Error> {
        if let Some(stored) = &self.stored {
            ensure_journal_size(stored)?;
            journal::atomic_write(&self.directory.join("inclusion-execution.json"), stored)
                .map_err(|_| worker::Error::Storage)?;
        }
        Ok(())
    }
    pub fn refresh_file(&mut self) -> Result<bool, worker::Error> {
        let path = self.directory.join("inclusion-approved.json");
        let Ok(info) = std::fs::metadata(&path) else {
            return Ok(false);
        };
        if info.len() > journal::MAX_JOURNAL_BYTES {
            return Err(worker::Error::Snapshot);
        }
        let approved: Approved = journal::read(&path)
            .map_err(err)?
            .ok_or(worker::Error::Snapshot)?;
        let digest = approved.digest()?;
        if self
            .stored
            .as_ref()
            .is_some_and(|stored| stored.digest == digest)
        {
            return Ok(false);
        }
        if self.stored.as_ref().is_some_and(|stored| {
            !matches!(stored.phase, Phase::Complete | Phase::RescheduleRequired)
        }) {
            return Err(worker::Error::Snapshot);
        }
        approved.validate()?;
        let next = Stored {
            schema: "relative.inclusion-execution/v1".into(),
            approved,
            digest,
            captured: None,
            prepared: None,
            cursor: None,
            handoff_observation: None,
            phase: Phase::Waiting,
            reason: None,
        };
        ensure_journal_size(&next).map_err(|_| worker::Error::Snapshot)?;
        journal::atomic_write(&self.directory.join("inclusion-execution.json"), &next)
            .map_err(|_| worker::Error::Storage)?;
        self.stored = Some(next);
        self.capturing = false;
        self.approved_onchain = false;
        Ok(true)
    }
    fn active(&self) -> Option<&Stored> {
        self.stored
            .as_ref()
            .filter(|stored| !matches!(stored.phase, Phase::Complete | Phase::RescheduleRequired))
    }
    pub fn wake_ms(&self, now: u64) -> Option<u64> {
        self.active().and_then(|stored| {
            let previous =
                cox::UniverseVersion::from_canonical(&stored.approved.previous_canonical).ok()?;
            let expiry = stored
                .approved
                .schedule
                .decode(&previous)
                .ok()?
                .expires_at
                .saturating_add(1)
                .saturating_mul(1000);
            let capture_deadline = stored
                .captured
                .is_none()
                .then_some(stored.approved.boundary_ms().saturating_add(5_001));
            [
                Some(stored.approved.boundary_ms()),
                Some(expiry),
                capture_deadline,
            ]
            .into_iter()
            .flatten()
            .filter(|at| *at > now)
            .min()
        })
    }
    pub fn expire_if_due(&mut self, now: u64) -> Result<bool, worker::Error> {
        if self.active().is_some_and(|stored| {
            stored.captured.is_none() && now > stored.approved.boundary_ms().saturating_add(5_000)
        }) {
            self.reschedule("Exact next-universe capture missing")?;
            return Ok(true);
        }

        let expired = if let Some(stored) = self.active() {
            let previous =
                cox::UniverseVersion::from_canonical(&stored.approved.previous_canonical)
                    .map_err(err)?;
            now / 1000
                > stored
                    .approved
                    .schedule
                    .decode(&previous)
                    .map_err(err)?
                    .expires_at
        } else {
            false
        };
        if expired {
            self.reschedule("Approved schedule expired")?;
        }
        Ok(expired)
    }
    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }
    pub fn matches(work: &Work) -> bool {
        matches!(work,Work::Close{id,..} if id==BOUNDARY_ID)
            || matches!(work,Work::Maintenance{id,..} if id==ROLLOUT_ID)
            || matches!(work,Work::Entry{id,..} if id==HANDOFF_ID)
    }
    fn cutoff(&self, value: Option<&Approved>) -> Result<(), worker::Error> {
        let cutoff = value.map(|value| PreviewCutoff {
            schema: "relative.inclusion-preview-cutoff/v1".into(),
            price_digest: value.capture_request.previous_anchor.universe_digest,
            cutoff_timestamp: value.capture_request.activation_timestamp_us / 1_000_000,
        });
        journal::atomic_write(
            &self.directory.join("inclusion-preview-cutoff.json"),
            &cutoff,
        )
        .map_err(|_| worker::Error::Storage)
    }
    fn reschedule(&mut self, reason: &str) -> Result<(), worker::Error> {
        if let Some(stored) = self.stored.as_mut() {
            stored.phase = Phase::RescheduleRequired;
            stored.reason = Some(reason.into());
        }
        self.approved_onchain = false;
        self.dirty = true;
        self.cutoff(None)?;
        self.persist()
    }
    pub fn capture_stopped(&mut self) {
        self.capturing = false;
    }
    pub fn captured(&self) -> Option<activation::Captured> {
        self.active().and_then(|stored| stored.captured.clone())
    }
    pub fn reject_handoff(&mut self) -> Result<(), worker::Error> {
        self.reschedule("Prepared handoff transaction rejected; ordinary publication continues")
    }
    pub fn prepared_mode(&self) -> bool {
        self.active().is_some_and(|stored| cox::UniverseVersion::from_canonical(&stored.approved.previous_canonical)
            .ok().and_then(|previous| stored.approved.schedule.decode(&previous).ok()).is_some_and(|schedule| schedule.schema_version == 2))
    }
    fn complete(&mut self, digest: [u8; 32]) -> Result<(), worker::Error> {
        let stored = self.stored.as_mut().ok_or(worker::Error::Storage)?;
        if stored.digest != digest { return Err(worker::Error::Storage) }
        if stored.phase == Phase::Complete { return Ok(()) }
        stored.phase = Phase::Complete;
        self.cutoff(None)?;
        self.persist()
    }
    pub fn capture_request(&mut self, now: u64) -> Option<activation::Request> {
        if self.capturing || !self.approved_onchain {
            return None;
        }
        let stored = self.active()?;
        if now + 600_000 < stored.approved.boundary_ms() {
            return None;
        }
        let request = stored.approved.capture_request.clone();
        self.capturing = true;
        Some(request)
    }
    pub fn accept_capture(&mut self, capture: activation::Captured) -> Result<(), worker::Error> {
        activation::validate_capture(&capture).map_err(err)?;
        let stored = self.stored.as_mut().ok_or(worker::Error::Storage)?;
        if matches!(stored.phase, Phase::Complete | Phase::RescheduleRequired)
            || capture.request != stored.approved.capture_request
        {
            return Err(worker::Error::Snapshot);
        }
        if let Some(previous) = &stored.captured {
            return if previous == &capture {
                Ok(())
            } else {
                Err(worker::Error::Snapshot)
            };
        }
        stored.captured = Some(capture);
        stored.phase = Phase::Captured;
        self.dirty = true;
        self.persist()
    }
}
async fn account(
    rpc: &Rpc,
    key: Address,
    min_slot: u64,
) -> Result<(u64, Option<(Vec<u8>, usize)>), worker::Error> {
    let result=rpc.call("getAccountInfo",serde_json::json!([key.to_string(),{"commitment":"confirmed","encoding":"base64","minContextSlot":min_slot}])).await.map_err(err)?;
    let slot = result
        .pointer("/context/slot")
        .and_then(|value| value.as_u64())
        .ok_or(worker::Error::Chain)?;
    if slot < min_slot {
        return Err(worker::Error::StaleDraft);
    }
    let value = result.get("value").ok_or(worker::Error::Chain)?;
    if value.is_null() {
        return Ok((slot, None));
    }
    if value.get("owner").and_then(|value| value.as_str()) != Some(cox::ID.to_string().as_str())
        || value.get("executable").and_then(|value| value.as_bool()) != Some(false)
    {
        return Err(worker::Error::Snapshot);
    }
    let bytes = STANDARD
        .decode(
            value
                .pointer("/data/0")
                .and_then(|value| value.as_str())
                .ok_or(worker::Error::Chain)?,
        )
        .map_err(err)?;
    let length = bytes.len();
    Ok((slot, Some((bytes, length))))
}
pub async fn observe(
    shared: &Shared,
    rpc: &Rpc,
    state: &ChainState,
    now: u64,
) -> Result<Vec<Work>, worker::Error> {
    if shared.lock().map_err(err)?.expire_if_due(now)? {
        return Ok(vec![]);
    }
    let stored = { shared.lock().map_err(err)?.active().cloned() };
    let Some(stored) = stored else {
        return Ok(vec![]);
    };
    if stored.prepared.as_ref().is_some_and(|prepared| {
        crate::universe_runtime::view(&prepared.receipt.canonical)
            .is_ok_and(|view| view.digest == state.basic.methodology.digest)
    }) {
        let mut guard = shared.lock().map_err(err)?;
        if let Some(stored) = guard.stored.as_mut() {
            stored.phase = Phase::Complete;
        }
        guard.cutoff(None)?;
        guard.persist()?;
        return Ok(vec![]);
    }
    let previous =
        cox::UniverseVersion::from_canonical(&stored.approved.previous_canonical).map_err(err)?;
    if state.basic.methodology.digest != previous.digest {
        return Ok(vec![]);
    }
    let schedule_key = stored
        .approved
        .schedule
        .address
        .parse::<Address>()
        .map_err(err)?;
    let (slot, row) = account(rpc, schedule_key, state.slot).await?;
    let mut guard = shared.lock().map_err(err)?;
    if guard
        .active()
        .is_none_or(|current| current.digest != stored.digest)
    {
        return Err(worker::Error::Storage);
    }
    let Some((bytes, _)) = row else {
        guard.reschedule("Approved schedule missing")?;
        return Ok(vec![]);
    };
    let fresh = ScheduleEvidence {
        genesis_hash: crate::rpc::protocol_genesis(),
        program: cox::ID.to_string(),
        address: schedule_key.to_string(),
        owner: cox::ID.to_string(),
        slot,
        commitment: Commitment::Confirmed,
        account_data: bytes,
    };
    if fresh.account_data != stored.approved.schedule.account_data
        || fresh.decode(&previous).is_err()
    {
        guard.reschedule("Approved schedule changed or cancelled")?;
        return Ok(vec![]);
    }
    if now / 1000 > fresh.decode(&previous).map_err(err)?.expires_at {
        guard.reschedule("Approved schedule expired")?;
        return Ok(vec![]);
    }
    guard.approved_onchain = true;
    let approved_schedule = fresh.decode(&previous).map_err(err)?;
    if approved_schedule.schema_version == 2 {
        guard.cutoff(None)?;
        if stored.captured.is_none() {
            return Ok(vec![]);
        }
        if state.basic.batch.is_some() { return Ok(vec![]) }
        if stored.cursor.as_ref().is_some_and(|cursor| cursor.phase == inclusion_rollout::Phase::ReadyForHandoff) {
            return Ok(if state.basic.batch.is_none() { vec![Work::Entry { id: HANDOFF_ID.into(), pool: crate::scheduler::Pool::Basic, eligible_after_ms: stored.approved.boundary_ms() }] } else { vec![] });
        }
        return Ok(vec![Work::Maintenance { id: ROLLOUT_ID.into(), pool: crate::scheduler::Pool::Basic }]);
    }
    guard.cutoff(Some(&stored.approved))?;
    let boundary = stored.approved.boundary_ms();
    let committed = state
        .basic
        .pool
        .origin
        .checked_add(state.basic.pool.last_batch)
        .ok_or(worker::Error::Clock)?
        .saturating_mul(1000);
    if state.basic.pool.stage.is_none()
        && state.basic.pool.stage_batch > state.basic.pool.last_batch
        && state
            .basic
            .pool
            .origin
            .checked_add(state.basic.pool.stage_batch)
            .is_some_and(|timestamp| timestamp.saturating_mul(1000) >= boundary)
    {
        guard.reschedule("Exact boundary preparation was cancelled")?;
        return Ok(vec![]);
    }
    let accepted = state
        .basic
        .batch
        .as_ref()
        .is_some_and(|batch| batch.cutoff.saturating_mul(1000) == boundary);
    if now > boundary + 5_000 && committed < boundary && !accepted {
        guard.reschedule("Exact old-universe boundary publication missed")?;
        return Ok(vec![]);
    }
    if committed > boundary {
        guard.reschedule("Old universe already advanced beyond boundary")?;
        return Ok(vec![]);
    }
    if state.basic.batch.is_some() {
        return Ok(vec![]);
    }
    if committed < boundary {
        return Ok(vec![Work::Close {
            id: BOUNDARY_ID.into(),
            timestamp_ms: boundary,
        }]);
    }
    if guard
        .active()
        .and_then(|stored| stored.captured.as_ref())
        .is_none()
    {
        if now > boundary + 5_000 {
            guard.reschedule("Exact next-universe capture missing")?;
        }
        return Ok(vec![]);
    }
    Ok(vec![Work::Maintenance {
        id: ROLLOUT_ID.into(),
        pool: crate::scheduler::Pool::Basic,
    }])
}
pub fn filter_work(shared: &Shared, now: u64, work: &mut Vec<Work>) -> Result<(), worker::Error> {
    let guard = shared.lock().map_err(err)?;
    if let Some(stored) = guard.active() {
        let previous = cox::UniverseVersion::from_canonical(&stored.approved.previous_canonical).map_err(err)?;
        if stored.approved.schedule.decode(&previous).map_err(err)?.schema_version == 1 && now >= stored.approved.boundary_ms() {
            work.retain(|work| !matches!(work, Work::Entry { .. }) && !matches!(work,Work::Close{timestamp_ms,..} if *timestamp_ms>stored.approved.boundary_ms()));
        }
    }
    Ok(())
}
pub async fn plan(
    shared: &Shared,
    rpc: &Rpc,
    state: &ChainState,
    operator: Address,
    now: u64,
    epoch_stage: bool,
) -> Result<Action, worker::Error> {
    let stored = shared
        .lock()
        .map_err(err)?
        .active()
        .cloned()
        .ok_or(worker::Error::Chain)?;
    let mut prepared = stored.prepared.clone();
    if prepared.is_none() {
        let captured = stored.captured.clone().ok_or(worker::Error::Snapshot)?;
        prepared = match inclusion_pipeline::build_successor(inclusion_pipeline::Request {
            schema: "relative.inclusion-successor-request/v1".into(),
            preparation: stored.approved.preparation.clone(),
            policy: stored.approved.policy.clone(),
            previous_canonical: stored.approved.previous_canonical.clone(),
            previous_handoff: stored.approved.previous_handoff.clone(),
            schedule: stored.approved.schedule.clone(),
            captured,
            operator: operator.to_bytes(),
            predecessor_sequence: state.basic.pool.sequence,
            predecessor_state_digest: state.basic.pool.state_digest,
        }) {
            Ok(prepared) => Some(prepared),
            Err(_) => {
                shared
                    .lock()
                    .map_err(err)?
                    .reschedule("Deterministic successor preparation failed")?;
                return Ok(Action::Waiting);
            }
        };
    }
    let prepared = prepared.ok_or(worker::Error::Snapshot)?;
    let next = cox::UniverseVersion::from_canonical(&prepared.receipt.canonical).map_err(err)?;
    let schedule_key = stored
        .approved
        .schedule
        .address
        .parse::<Address>()
        .map_err(err)?;
    let min_slot = state.slot.max(
        stored
            .cursor
            .as_ref()
            .map_or(0, |cursor| cursor.observed_slot),
    );
    let (schedule_slot, schedule_row) = account(rpc, schedule_key, min_slot).await?;
    let (schedule_bytes, _) = schedule_row.ok_or(worker::Error::Snapshot)?;
    let schedule = ScheduleEvidence {
        genesis_hash: crate::rpc::protocol_genesis(),
        program: cox::ID.to_string(),
        address: schedule_key.to_string(),
        owner: cox::ID.to_string(),
        slot: schedule_slot,
        commitment: Commitment::Confirmed,
        account_data: schedule_bytes,
    };
    let next_key = Address::find_program_address(
        &[b"methodology", &next.digest],
        &state.basic.accounts.program,
    )
    .0;
    let (next_slot, next_row) = account(rpc, next_key, schedule_slot).await?;
    let next_methodology = next_row
        .as_ref()
        .map(|(bytes, length)| {
            cox::Methodology::try_deserialize(&mut bytes.as_slice())
                .map(|value| (value, *length))
                .map_err(err)
        })
        .transpose()?;
    let (slot, pool_row) = account(rpc, state.basic.accounts.pool, next_slot).await?;
    let (pool_bytes, allocated) = pool_row.ok_or(worker::Error::Chain)?;
    let fresh_pool = cox::Pool::try_deserialize(&mut pool_bytes.as_slice()).map_err(err)?;
    if fresh_pool.sequence != state.basic.pool.sequence
        || fresh_pool.state_digest != state.basic.pool.state_digest
        || fresh_pool.methodology != state.basic.pool.methodology
        || fresh_pool.stage != state.basic.pool.stage
    {
        return Err(worker::Error::StaleDraft);
    }
    let directory = shared.lock().map_err(err)?.directory.clone();
    let staged = schedule.decode(&cox::UniverseVersion::from_canonical(&stored.approved.previous_canonical).map_err(err)?).map_err(err)?.schema_version == 2;
    let receipt_directory = directory.join("universes");
    let receipt_directory = if staged { receipt_directory.join("prepared") } else { receipt_directory };
    let receipt_path = receipt_directory
        .join(format!("{}.json", hex::encode(next.digest)));
    let receipt_persisted = journal::read::<crate::universe_runtime::Receipt>(&receipt_path)
        .map_err(|_| worker::Error::Storage)?
        .as_ref()
        == Some(&prepared.receipt);
    let next_registry_version =
        if state.basic.pool.asset_registry != anchor_lang::prelude::Pubkey::default() {
            let key = anchor_lang::prelude::Pubkey::find_program_address(
                &[
                    b"asset-version",
                    state.basic.pool.asset_registry.as_ref(),
                    &next.digest,
                ],
                &cox::ID,
            )
            .0;
            let (_, row) = account(rpc, Address::new_from_array(key.to_bytes()), slot).await?;
            row.map(|(bytes, _)| {
                cox::AssetRegistryVersion::try_deserialize(&mut bytes.as_slice()).map_err(err)
            })
            .transpose()?
        } else {
            None
        };
    let result = inclusion_rollout::plan(
        &prepared,
        &state.basic.accounts,
        operator,
        inclusion_rollout::Confirmed {
            genesis_hash: &crate::rpc::protocol_genesis(),
            commitment: Commitment::Confirmed,
            slot,
            now_ms: now,
            max_publication_age_ms: 5_000,
            registry: &state.basic.registry,
            pool: &state.basic.pool,
            pool_bytes: allocated,
            batch: state.basic.batch.as_ref(),
            schedule: &schedule,
            next_methodology: next_methodology
                .as_ref()
                .map(|(value, space)| (value, *space)),
            epoch_stage_present: epoch_stage,
            receipt_persisted,
            next_registry_version: next_registry_version.as_ref(),
        },
        stored.cursor.as_ref(),
    );
    let result = match result {
        Ok(result) => result,
        Err(_) => {
            shared
                .lock()
                .map_err(err)?
                .reschedule("Deterministic inclusion rollout validation failed")?;
            return Ok(Action::Waiting);
        }
    };
    if matches!(result.status, Status::ReadyForHandoff) {
        let required = cox::dynamic_batch_space(next.instruments.len() + 1);
        let sizes = state.basic.staging_bytes.ok_or(worker::Error::Storage)?;
        for (target, allocated) in [state.basic.accounts.batch, state.basic.accounts.publication].into_iter().zip(sizes) {
            if allocated < required {
                if state.basic.pool.stage.is_some() { return Ok(Action::Waiting) }
                return Ok(Action::Instructions(vec![state.basic.accounts.grow_staging(operator, target, (required - allocated).min(cox::DYNAMIC_MAX_GROWTH) as u32).map_err(err)?]));
            }
        }
    }
    {
        let mut guard = shared.lock().map_err(err)?;
        let current = guard.stored.as_mut().ok_or(worker::Error::Storage)?;
        if current.digest != stored.digest {
            return Err(worker::Error::Storage);
        }
        current.prepared = Some(prepared.clone());
        current.cursor = Some(result.cursor.clone());
        current.phase = Phase::Prepared;
        guard.persist()?;
    }
    match result.status {
        Status::Transaction => Ok(Action::Instructions(result.instructions)),
        Status::PersistReceipt => {
            let persist = if staged { journal::atomic_write(&receipt_path, &prepared.receipt).map_err(|_| crate::universe_runtime::Error::Storage) } else { prepared.receipt.persist(&directory).map(|_| ()) };
            persist
                .map_err(|error| match error {
                    crate::universe_runtime::Error::Storage => worker::Error::Storage,
                    _ => worker::Error::Snapshot,
                })?;
            Ok(Action::Waiting)
        }
        Status::Complete => Ok(Action::Adopt),
        Status::RescheduleRequired(reason) => {
            shared
                .lock()
                .map_err(err)?
                .reschedule(&format!("{reason:?}"))?;
            Ok(Action::Waiting)
        }
        Status::Waiting => Ok(Action::Waiting),
        Status::ReadyForHandoff => Ok(Action::Waiting),
    }
}
struct StagedHistory {
    history: FileHistory,
    anchor: Anchor,
    controller: Shared,
}
impl History for StagedHistory {
    fn append(&mut self, value: &Observation) -> Result<(), crate::benchmark::Error> {
        let guard = self.controller.lock().map_err(|_| crate::benchmark::Error::Persistence)?;
        if guard.active().is_none() { return Err(crate::benchmark::Error::TimeRegression) }
        self.history.stage_observation(&self.anchor, value)
    }
}
pub async fn capture(
    shared: Shared,
    request: activation::Request,
    token: String,
    archive: crate::runtime::SnapshotArchive,
    mut stop: watch::Receiver<bool>,
) -> Result<(), worker::Error> {
    let requested_at = now_ms()?.checked_mul(1000).ok_or(worker::Error::Clock)?;
    let prior = {
        shared
            .lock()
            .map_err(err)?
            .active()
            .and_then(|stored| stored.captured.clone())
    };
    if prior.is_none() {
        request.validate_schedule(requested_at).map_err(err)?;
    }
    let (send, mut receive) = mpsc::channel(16);
    let (halt, halted) = watch::channel(false);
    let task = tokio::spawn(crate::runtime::pyth_task(
        PythConfig {
            token,
            feed_ids: request
                .fullnext_assets
                .iter()
                .map(|asset| asset.feed_id)
                .collect(),
            subscription_id: 13,
        },
        send,
        halted,
    ));
    let directory = shared.lock().map_err(err)?.directory.clone();
    let mut next = if let Some(captured) = prior {
        let history = FileHistory {
            directory: directory.join("prices"),
        };
        let resumed = history
            .latest_staged(&captured.next_anchor)
            .map_err(|_| worker::Error::Storage)?;
        Some(
            Benchmark::new(
                captured.next_anchor.clone(),
                StagedHistory {
                    history,
                    anchor: captured.next_anchor,
                    controller: shared.clone(),
                },
                resumed,
            )
            .map_err(err)?,
        )
    } else {
        None
    };
    let mut timeout = tokio::time::interval(Duration::from_secs(1));
    let result=async{loop{tokio::select!{
        changed=stop.changed()=>{changed.map_err(err)?;if *stop.borrow(){return Ok(());}},
        _=timeout.tick()=>{if next.is_none() && now_ms()?>request.activation_timestamp_us/1000+5_000{return Err(worker::Error::Snapshot);}if shared.lock().map_err(err)?.active().is_none(){return Ok(());}},
        bytes=receive.recv()=>{let bytes=bytes.ok_or(worker::Error::Snapshot)?;let now=now_ms()?;let signers=archive.trusted_keys()?;
            if next.is_none(){match activation::capture_update(&request,requested_at,&bytes,&signers,now/1000){Ok(Some(captured))=>{shared.lock().map_err(err)?.accept_capture(captured.clone())?;let history=FileHistory{directory:directory.join("prices")};next=Some(Benchmark::new(captured.next_anchor.clone(),StagedHistory{history,anchor:captured.next_anchor,controller:shared.clone()},None).map_err(err)?);},Ok(None)=>continue,Err(activation::Error::Verification)=>continue,Err(_)=>return Err(worker::Error::Snapshot)}}
            if let Some(benchmark)=next.as_mut(){let batch=match pyth::verify_payload(&bytes,&signers,now/1000,request.max_feed_age_ms*1000){Ok(batch)=>batch,Err(_)=>continue};if batch.timestamp_us<request.activation_timestamp_us{continue;}match benchmark.observe(&batch,|_|Ok(())){Ok(_)|Err(crate::benchmark::Error::TimeRegression)=>{},Err(_)=>return Err(worker::Error::Storage)}}
        }
    }}}.await;
    let _ = halt.send(true);
    task.abort();
    let _ = task.await;
    if result.is_err()
        && shared
            .lock()
            .map_err(err)?
            .active()
            .is_some_and(|stored| stored.captured.is_none())
    {
        shared
            .lock()
            .map_err(err)?
            .reschedule("Exact inclusion capture unavailable")?;
    }
    result
}

fn key(value: Address) -> anchor_lang::prelude::Pubkey {
    anchor_lang::prelude::Pubkey::new_from_array(value.to_bytes())
}
fn handoff_instruction(data: Vec<u8>, accounts: Vec<anchor_lang::solana_program::instruction::AccountMeta>) -> Instruction {
    Instruction {
        program_id: Address::new_from_array(cox::ID.to_bytes()), data,
        accounts: accounts.into_iter().map(|meta| solana_instruction::AccountMeta {
            pubkey: Address::new_from_array(meta.pubkey.to_bytes()), is_signer: meta.is_signer, is_writable: meta.is_writable,
        }).collect(),
    }
}
fn prepared_handoff(shared: &Shared) -> Result<Option<Stored>, worker::Error> {
    let guard = shared.lock().map_err(err)?;
    let Some(stored) = guard.active() else { return Ok(None) };
    let previous = cox::UniverseVersion::from_canonical(&stored.approved.previous_canonical).map_err(err)?;
    if stored.approved.schedule.decode(&previous).map_err(err)?.schema_version != 2
        || !stored.cursor.as_ref().is_some_and(|cursor| cursor.phase == inclusion_rollout::Phase::ReadyForHandoff)
    { return Ok(None) }
    Ok(Some(stored.clone()))
}
pub fn attach_handoff_begin(
    shared: &Shared, state: &ChainState, operator: Address, observation: &Observation,
    archive: &crate::runtime::SnapshotArchive, now: u64, instructions: &mut Vec<Instruction>,
) -> Result<(), worker::Error> {
    let Some(stored) = prepared_handoff(shared)? else { return Ok(()) };
    let Some(begin) = instructions.iter().position(|instruction| instruction.program_id == state.basic.accounts.program
        && instruction.data.get(..8) == Some(&Sha256::digest(b"global:begin_dynamic_publication")[..8])) else { return Ok(()) };
    let prepared = stored.prepared.as_ref().ok_or(worker::Error::Storage)?;
    let next = cox::UniverseVersion::from_canonical(&prepared.receipt.canonical).map_err(err)?;
    let directory = shared.lock().map_err(err)?.directory.clone();
    let captured = stored.captured.as_ref().ok_or(worker::Error::Storage)?;
    let history = FileHistory { directory: directory.join("prices") };
    let Some(full) = history.exact(&captured.next_anchor.universe_digest, observation.timestamp_us).map_err(|_| worker::Error::Storage)? else { return Ok(()) };
    let capture = crate::origin::verify_capture(crate::origin::Request {
        schema: "relative.origin-request/v1".into(), assets: next.instruments.iter().map(|instrument| crate::origin::Asset {
            id: instrument.symbol.clone(), feed_id: instrument.pyth_pro_feed_id,
        }).collect(), max_feed_age_ms: stored.approved.capture_request.max_feed_age_ms,
    }, &full.signed_payload, &archive.trusted_keys()?, now / 1000).map_err(err)?;
    if capture.timestamp_us != observation.timestamp_us || capture.assets.len() != next.instruments.len()
        || !capture.assets.iter().take(observation.prices_e8.len()).map(|asset| asset.price_e8).eq(observation.prices_e8.iter().copied())
    { return Ok(()) }
    let next_methodology = anchor_lang::prelude::Pubkey::find_program_address(&[b"methodology", &next.digest], &cox::ID).0;
    let handoff = anchor_lang::prelude::Pubkey::find_program_address(&[b"universe-handoff", next.pool.as_ref(), &next.digest], &cox::ID).0;
    let schedule = stored.approved.schedule.address.parse().map_err(err)?;
    let instruction = handoff_instruction(cox::instruction::BeginUniverseHandoff {}.data(), cox::accounts::BeginUniverseHandoff {
        runtime: key(operator), registry: key(state.basic.accounts.registry), pool: next.pool, batch: key(state.basic.accounts.batch),
        methodology: key(state.basic.accounts.methodology), next_methodology, schedule, handoff,
        system_program: anchor_lang::system_program::ID,
    }.to_account_metas(None));
    {
        let mut guard = shared.lock().map_err(err)?;
        let current = guard.stored.as_mut().ok_or(worker::Error::Storage)?;
        if current.digest != stored.digest { return Err(worker::Error::StaleDraft) }
        current.handoff_observation = Some(capture);
        guard.persist()?;
    }
    instructions.insert(begin + 1, instruction);
    Ok(())
}
pub async fn handoff_maintenance(
    shared: &Shared, rpc: &Rpc, state: &ChainState, operator: Address,
) -> Result<Option<Vec<Instruction>>, worker::Error> {
    let Some(stored) = prepared_handoff(shared)? else { return Ok(None) };
    let Some(batch) = state.basic.batch.as_ref() else { return Ok(None) };
    let prepared = stored.prepared.as_ref().ok_or(worker::Error::Storage)?;
    let next = cox::UniverseVersion::from_canonical(&prepared.receipt.canonical).map_err(err)?;
    let next_methodology = anchor_lang::prelude::Pubkey::find_program_address(&[b"methodology", &next.digest], &cox::ID).0;
    let (handoff, _) = Address::find_program_address(&[b"universe-handoff", next.pool.as_ref(), &next.digest], &state.basic.accounts.program);
    let (_, row) = account(rpc, handoff, state.slot).await?;
    let Some((bytes, _)) = row else { return Ok(None) };
    let saved = cox::UniverseHandoff::try_deserialize(&mut bytes.as_slice()).map_err(err)?;
    if saved.effective_from != 0 || saved.sequence != batch.sequence || saved.snapshot_digest != batch.snapshot_digest
        || saved.timestamp != batch.cutoff || saved.predecessor_sequence != batch.predecessor_sequence
        || saved.predecessor_state_digest != batch.predecessor_digest
    { return Ok(None) }
    let capture = stored.handoff_observation.as_ref().ok_or(worker::Error::Storage)?;
    if capture.timestamp_us / 1_000_000 != batch.cutoff { return Ok(None) }
    let old = state.basic.pool.origin_prices.len();
    let additional = &capture.assets.get(old..).ok_or(worker::Error::Storage)?;
    if saved.prices_e8.len() > additional.len() || saved.prices_e8.iter().zip(additional.iter()).any(|(price, asset)| *price != asset.price_e8) {
        return Err(worker::Error::Storage)
    }
    if saved.prices_e8.len() == additional.len() { return Ok(None) }
    let offset = saved.prices_e8.len();
    let prices = additional[offset..].iter().take(16).map(|asset| asset.price_e8).collect();
    Ok(Some(vec![handoff_instruction(cox::instruction::AppendUniverseHandoffPrices { offset: offset.try_into().map_err(err)?, prices }.data(), cox::accounts::AppendUniverseHandoffPrices {
        runtime: key(operator), registry: key(state.basic.accounts.registry), pool: next.pool, batch: key(state.basic.accounts.batch),
        methodology: key(state.basic.accounts.methodology), next_methodology, handoff: key(handoff),
    }.to_account_metas(None))]))
}
pub async fn attach_handoff_commit(
    shared: &Shared, rpc: &Rpc, state: &ChainState, operator: Address, now: u64, instructions: &mut Vec<Instruction>,
) -> Result<(), worker::Error> {
    if now / 1000 % cox_epoch::EPOCH_SECONDS == 0 { return Ok(()) }
    let Some(finalize) = instructions.iter().position(|instruction| instruction.program_id == state.basic.accounts.program
        && instruction.data.get(..8) == Some(&Sha256::digest(b"global:finalize")[..8])) else { return Ok(()) };
    let Some(stored) = prepared_handoff(shared)? else { return Ok(()) };
    let Some(batch) = state.basic.batch.as_ref() else { return Ok(()) };
    let prepared = stored.prepared.as_ref().ok_or(worker::Error::Storage)?;
    let next = cox::UniverseVersion::from_canonical(&prepared.receipt.canonical).map_err(err)?;
    let next_methodology = anchor_lang::prelude::Pubkey::find_program_address(&[b"methodology", &next.digest], &cox::ID).0;
    let (handoff, _) = Address::find_program_address(&[b"universe-handoff", next.pool.as_ref(), &next.digest], &state.basic.accounts.program);
    let (_, row) = account(rpc, handoff, state.slot).await?;
    let Some((bytes, _)) = row else { return Ok(()) };
    let h = cox::UniverseHandoff::try_deserialize(&mut bytes.as_slice()).map_err(err)?;
    if h.effective_from != 0 || h.sequence != batch.sequence || h.snapshot_digest != batch.snapshot_digest
        || h.timestamp != batch.cutoff || h.prices_e8.len() != next.instruments.len() - state.basic.pool.origin_prices.len()
    { return Ok(()) }
    let asset_registry = state.basic.pool.asset_registry;
    let version = |digest: &[u8; 32]| anchor_lang::prelude::Pubkey::find_program_address(&[b"asset-version", asset_registry.as_ref(), digest], &cox::ID).0;
    let instruction = handoff_instruction(cox::instruction::ActivatePreparedUniverse {}.data(), cox::accounts::ActivatePreparedUniverse {
        runtime: key(operator), registry: key(state.basic.accounts.registry), pool: next.pool, batch: key(state.basic.accounts.batch),
        methodology: key(state.basic.accounts.methodology), next_methodology, schedule: stored.approved.schedule.address.parse().map_err(err)?,
        handoff: key(handoff), vault: key(state.basic.accounts.vault), instructions: anchor_lang::solana_program::sysvar::instructions::ID,
        test_vault: state.basic.accounts.test_vault.map(key), asset_registry: Some(asset_registry),
        next_registry_version: Some(version(&next.digest)), previous_registry_version: Some(version(&next.predecessor_digest)),
    }.to_account_metas(None));
    instructions.insert(finalize + 1, instruction);
    Ok(())
}
pub async fn recover_handoff_commit(shared: &Shared, rpc: &Rpc, state: &ChainState) -> Result<(), worker::Error> {
    let stored = shared.lock().map_err(err)?.stored.clone();
    let Some(stored) = stored else { return Ok(()) };
    let Some(prepared) = &stored.prepared else { return Ok(()) };
    let previous = cox::UniverseVersion::from_canonical(&stored.approved.previous_canonical).map_err(err)?;
    if stored.approved.schedule.decode(&previous).map_err(err)?.schema_version != 2 { return Ok(()) }
    let next = cox::UniverseVersion::from_canonical(&prepared.receipt.canonical).map_err(err)?;
    if state.basic.methodology.digest != next.digest { return Ok(()) }
    let directory = shared.lock().map_err(err)?.directory.clone();
    let path = directory.join("universes").join(format!("{}.json", hex::encode(next.digest)));
    if let Some(receipt) = journal::read::<crate::universe_runtime::Receipt>(&path).map_err(|_| worker::Error::Storage)? {
        if receipt.canonical != prepared.receipt.canonical || !matches!(receipt.evidence, crate::universe_runtime::Evidence::Handoff { .. }) { return Err(worker::Error::Storage) }
        receipt.validate().map_err(err)?;
        return shared.lock().map_err(err)?.complete(stored.digest)
    }
    let (handoff, _) = Address::find_program_address(&[b"universe-handoff", next.pool.as_ref(), &next.digest], &state.basic.accounts.program);
    let (slot, row) = account(rpc, handoff, state.slot).await?;
    let (account_data, _) = row.ok_or(worker::Error::Storage)?;
    let confirmation = crate::universe_runtime::HandoffConfirmation {
        genesis_hash: crate::rpc::protocol_genesis(), program: cox::ID.to_string(), address: handoff.to_string(), owner: cox::ID.to_string(),
        slot, commitment: Commitment::Confirmed, account_data, capture: stored.handoff_observation.clone().ok_or(worker::Error::Storage)?,
    };
    let receipt = crate::universe_runtime::Receipt {
        schema: prepared.receipt.schema.clone(), genesis_hash: prepared.receipt.genesis_hash.clone(), canonical: prepared.receipt.canonical.clone(),
        previous_canonical: prepared.receipt.previous_canonical.clone(), evidence: crate::universe_runtime::Evidence::Handoff {
            admission: stored.captured.clone().ok_or(worker::Error::Storage)?, handoff: confirmation, predecessor_handoff: stored.approved.previous_handoff.clone(),
        },
    };
    receipt.validate().map_err(err)?;
    receipt.persist(&directory).map_err(|_| worker::Error::Storage)?;
    let mut guard = shared.lock().map_err(err)?;
    guard.complete(stored.digest)
}
