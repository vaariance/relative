use crate::{
    inclusion_pipeline::{self, Commitment, Prepared, ScheduleEvidence},
    transactions::BasicAccounts,
};
use anchor_lang::{prelude::Pubkey, AccountSerialize, InstructionData, ToAccountMetas};
use cox::{Batch, Methodology, Pool, Registry, UniverseVersion};
use serde::{Deserialize, Serialize};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    pub schema: String,
    pub successor_digest: [u8; 32],
    pub observed_slot: u64,
    pub phase: Phase,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase {
    WaitingBoundaryPublication,
    WaitingAcceptedBasicBatch,
    WaitingEpochStage,
    Register,
    GrowMethodology,
    Upload,
    Seal,
    GrowPool,
    PersistReceipt,
    RegisterRegistryVersion,
    Activate,
    Complete,
    RescheduleRequired,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RescheduleReason {
    ExpiredSchedule,
    BoundaryWindowMissed,
    BoundaryAlreadyPassed,
    BoundaryDoesNotMatchCapture,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Status {
    Waiting,
    Transaction,
    PersistReceipt,
    Complete,
    RescheduleRequired(RescheduleReason),
}
#[derive(Clone, Debug)]
pub struct Plan {
    pub status: Status,
    pub cursor: Cursor,
    pub instructions: Vec<Instruction>,
}
pub struct Confirmed<'a> {
    pub genesis_hash: &'a str,
    pub commitment: Commitment,
    pub slot: u64,
    pub now_ms: u64,
    pub max_publication_age_ms: u64,
    pub registry: &'a Registry,
    pub pool: &'a Pool,
    pub pool_bytes: usize,
    pub batch: Option<&'a Batch>,
    pub schedule: &'a ScheduleEvidence,
    pub next_methodology: Option<(&'a Methodology, usize)>,
    pub epoch_stage_present: bool,
    pub receipt_persisted: bool,
    pub next_registry_version: Option<&'a cox::AssetRegistryVersion>,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Prepared,
    State,
    Authority,
    Schedule,
    Cursor,
    Conflict,
    Capacity,
}
fn pubkey(value: Address) -> Pubkey {
    Pubkey::new_from_array(value.to_bytes())
}
fn address(value: Pubkey) -> Address {
    Address::new_from_array(value.to_bytes())
}
fn instruction(
    program: Address,
    data: Vec<u8>,
    accounts: Vec<anchor_lang::solana_program::instruction::AccountMeta>,
) -> Instruction {
    Instruction {
        program_id: program,
        data,
        accounts: accounts
            .into_iter()
            .map(|meta| AccountMeta {
                pubkey: address(meta.pubkey),
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            })
            .collect(),
    }
}
pub fn plan(
    prepared: &Prepared,
    accounts: &BasicAccounts,
    operator: Address,
    state: Confirmed<'_>,
    prior: Option<&Cursor>,
) -> Result<Plan, Error> {
    inclusion_pipeline::validate(prepared).map_err(|_| Error::Prepared)?;
    let next = UniverseVersion::from_canonical(&prepared.receipt.canonical)
        .map_err(|_| Error::Prepared)?;
    let previous = UniverseVersion::from_canonical(&prepared.request.previous_canonical)
        .map_err(|_| Error::Prepared)?;
    let next_key = Pubkey::find_program_address(&[b"methodology", &next.digest], &cox::ID).0;
    let previous_key =
        Pubkey::find_program_address(&[b"methodology", &previous.digest], &cox::ID).0;
    if state.genesis_hash != crate::rpc::protocol_genesis()
        || state.slot == 0
        || state.max_publication_age_ms == 0
        || state.max_publication_age_ms > 5000
        || pubkey(accounts.program) != cox::ID
        || pubkey(accounts.pool) != previous.pool
        || state.pool.schema_version != 5
        || !state.pool.initialized
        || state.pool.registry != pubkey(accounts.registry)
        || state.pool.vault != pubkey(accounts.vault)
        || Pubkey::find_program_address(&[b"registry"], &cox::ID).0 != pubkey(accounts.registry)
        || Pubkey::find_program_address(&[b"pool", &state.pool.pool_id.to_le_bytes()], &cox::ID).0
            != previous.pool
    {
        return Err(Error::State);
    }
    if state.registry.runtime != pubkey(operator) {
        return Err(Error::Authority);
    }
    if let Some(prior) = prior {
        if prior.schema != "relative.inclusion-rollout-cursor/v1"
            || prior.successor_digest != next.digest
            || prior.observed_slot > state.slot
        {
            return Err(Error::Cursor);
        }
    }
    let emit = |phase: Phase, status: Status, instructions: Vec<Instruction>| Plan {
        status,
        cursor: Cursor {
            schema: "relative.inclusion-rollout-cursor/v1".into(),
            successor_digest: next.digest,
            observed_slot: state.slot,
            phase,
        },
        instructions,
    };
    let wait = |phase| emit(phase, Status::Waiting, vec![]);
    let reschedule = |reason| {
        emit(
            Phase::RescheduleRequired,
            Status::RescheduleRequired(reason),
            vec![],
        )
    };
    if state.pool.methodology == next_key {
        if state.pool.classes.len() != next.instruments.len() + 1 {
            return Err(Error::State);
        }
        return Ok(emit(Phase::Complete, Status::Complete, vec![]));
    }
    if next.operator != pubkey(operator) {
        return Err(Error::Authority);
    }
    if state.pool.methodology != previous_key || pubkey(accounts.methodology) != previous_key {
        return Err(Error::Conflict);
    }
    if state.pool.classes.len() != previous.instruments.len() + 1
        || state.pool.origin_prices.len() != previous.instruments.len()
        || state.pool.last_prices.len() != previous.instruments.len()
        || state.pool.references.len() != state.pool.classes.len()
        || !state.pool.origin_prices.iter().copied().eq(previous
            .instruments
            .iter()
            .map(|instrument| instrument.original_price_e8))
    {
        return Err(Error::State);
    }
    if state.pool.stage.is_some()
        && state.batch.is_none_or(|batch| {
            batch.pool != previous.pool
                || state.pool.stage != Some(pubkey(accounts.batch))
                || batch.predecessor_sequence != state.pool.sequence
                || batch.predecessor_digest != state.pool.state_digest
        })
    {
        return Err(Error::State);
    }
    if state.schedule.account_data != prepared.request.schedule.account_data
        || state.schedule.address != prepared.request.schedule.address
        || state.schedule.slot < prepared.request.schedule.slot
        || state.slot < state.schedule.slot
    {
        return Err(Error::Schedule);
    }
    let schedule = state
        .schedule
        .decode(&previous)
        .map_err(|_| Error::Schedule)?;
    schedule
        .validate_successor(&previous, &next)
        .map_err(|_| Error::Schedule)?;
    if state.now_ms / 1000 > schedule.expires_at {
        return Ok(reschedule(RescheduleReason::ExpiredSchedule));
    }
    let boundary = next.capture.timestamp;
    let pool_timestamp = state
        .pool
        .origin
        .checked_add(state.pool.last_batch)
        .ok_or(Error::State)?;
    if pool_timestamp > boundary {
        return Ok(reschedule(RescheduleReason::BoundaryAlreadyPassed));
    }
    let accepted_boundary = state.pool.stage.is_some()
        && state.batch.is_some_and(|batch| {
            batch.cutoff == boundary
                && batch.pool == previous.pool
                && state.pool.stage == Some(pubkey(accounts.batch))
        });
    if pool_timestamp < boundary
        && !accepted_boundary
        && state.now_ms
            > boundary
                .checked_mul(1000)
                .and_then(|value| value.checked_add(state.max_publication_age_ms))
                .ok_or(Error::State)?
    {
        return Ok(reschedule(RescheduleReason::BoundaryWindowMissed));
    }
    if state.pool.stage.is_some() {
        return Ok(wait(Phase::WaitingAcceptedBasicBatch));
    }
    if pool_timestamp < boundary || state.now_ms / 1000 < boundary {
        return Ok(wait(Phase::WaitingBoundaryPublication));
    }
    if state.pool.sequence != next.capture.predecessor_sequence
        || state.pool.state_digest != next.capture.predecessor_state_digest
        || state.pool.benchmark != next.capture.benchmark
        || next.capture.prices_e8.get(..state.pool.last_prices.len())
            != Some(state.pool.last_prices.as_slice())
    {
        return Ok(reschedule(RescheduleReason::BoundaryDoesNotMatchCapture));
    }
    if state.epoch_stage_present {
        return Ok(wait(Phase::WaitingEpochStage));
    }
    let runtime = pubkey(operator);
    let registry = pubkey(accounts.registry);
    let pool = pubkey(accounts.pool);
    let schedule_key = state
        .schedule
        .address
        .parse()
        .map_err(|_| Error::Schedule)?;
    let transact = |phase, data, metas| {
        emit(
            phase,
            Status::Transaction,
            vec![instruction(accounts.program, data, metas)],
        )
    };
    let manage = || {
        cox::accounts::ManageScheduledMethodology {
            runtime,
            registry,
            pool,
            methodology: previous_key,
            schedule: schedule_key,
            next_methodology: next_key,
        }
        .to_account_metas(None)
    };
    let grow = |phase, target, additional_bytes| {
        transact(
            phase,
            cox::instruction::GrowDynamicAccount { additional_bytes }.data(),
            cox::accounts::GrowDynamicAccount {
                payer: runtime,
                registry,
                pool,
                target,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        )
    };
    let Some((methodology, allocated)) = state.next_methodology else {
        return Ok(transact(
            Phase::Register,
            cox::instruction::RegisterScheduledMethodology {
                digest: next.digest,
                length: prepared
                    .receipt
                    .canonical
                    .len()
                    .try_into()
                    .map_err(|_| Error::Capacity)?,
            }
            .data(),
            cox::accounts::RegisterScheduledMethodology {
                runtime,
                registry,
                pool,
                methodology: previous_key,
                schedule: schedule_key,
                next_methodology: next_key,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
        ));
    };
    if methodology.schema_version != 3
        || methodology.digest != next.digest
        || methodology.expected_length as usize != prepared.receipt.canonical.len()
        || !prepared
            .receipt
            .canonical
            .starts_with(&methodology.canonical)
        || allocated > cox::DYNAMIC_MAX_ACCOUNT_BYTES
    {
        return Err(Error::Conflict);
    }
    if methodology.sealed && methodology.canonical.len() != prepared.receipt.canonical.len() {
        return Err(Error::Conflict);
    }
    let mut encoded_methodology = Vec::new();
    methodology
        .try_serialize(&mut encoded_methodology)
        .map_err(|_| Error::Conflict)?;
    if encoded_methodology.len() > allocated {
        return Err(Error::Conflict);
    }
    let required = prepared
        .receipt
        .canonical
        .len()
        .checked_add(512)
        .ok_or(Error::Capacity)?;
    if required > cox::DYNAMIC_MAX_ACCOUNT_BYTES {
        return Err(Error::Capacity);
    }
    if allocated < required && !methodology.sealed {
        return Ok(grow(
            Phase::GrowMethodology,
            next_key,
            (required - allocated).min(cox::DYNAMIC_MAX_GROWTH) as u32,
        ));
    }
    if methodology.canonical.len() < prepared.receipt.canonical.len() {
        if methodology.sealed {
            return Err(Error::Conflict);
        }
        let offset = methodology.canonical.len();
        return Ok(transact(
            Phase::Upload,
            cox::instruction::UploadScheduledMethodology {
                offset: offset.try_into().map_err(|_| Error::Capacity)?,
                bytes: prepared.receipt.canonical
                    [offset..(offset + 700).min(prepared.receipt.canonical.len())]
                    .to_vec(),
            }
            .data(),
            manage(),
        ));
    }
    if !methodology.sealed {
        return Ok(transact(
            Phase::Seal,
            cox::instruction::SealScheduledMethodology {}.data(),
            manage(),
        ));
    }
    let mut serialized = Vec::new();
    state
        .pool
        .try_serialize(&mut serialized)
        .map_err(|_| Error::State)?;
    if serialized.len() > state.pool_bytes {
        return Err(Error::State);
    }
    let additional = next
        .instruments
        .len()
        .checked_sub(previous.instruments.len())
        .ok_or(Error::Capacity)?;
    let required_pool = serialized
        .len()
        .checked_add(additional.checked_mul(56).ok_or(Error::Capacity)?)
        .ok_or(Error::Capacity)?;
    if required_pool > 32768 || state.pool_bytes > 32768 {
        return Err(Error::Capacity);
    }
    if state.pool_bytes < required_pool {
        return Ok(grow(
            Phase::GrowPool,
            pool,
            (required_pool - state.pool_bytes).min(cox::DYNAMIC_MAX_GROWTH) as u32,
        ));
    }
    if !state.receipt_persisted {
        return Ok(emit(Phase::PersistReceipt, Status::PersistReceipt, vec![]));
    }
    let registry_key = state.pool.asset_registry;
    let next_version = Pubkey::find_program_address(
        &[b"asset-version", registry_key.as_ref(), &next.digest],
        &cox::ID,
    )
    .0;
    let previous_version = Pubkey::find_program_address(
        &[b"asset-version", registry_key.as_ref(), &previous.digest],
        &cox::ID,
    )
    .0;
    if registry_key != Pubkey::default() {
        if let Some(version) = state.next_registry_version {
            if version.registry != registry_key
                || version.generation != state.pool.generation
                || version.methodology != next_key
                || version.digest != next.digest
                || version.predecessor != previous.digest
                || version.effective_from != next.capture.timestamp
                || version.sealed
            {
                return Err(Error::Conflict);
            }
        } else {
            return Ok(transact(
                Phase::RegisterRegistryVersion,
                cox::instruction::RegisterAssetRegistryVersion {}.data(),
                cox::accounts::RegisterAssetRegistryVersion {
                    payer: runtime,
                    registry,
                    pool,
                    asset_registry: registry_key,
                    methodology: next_key,
                    version: next_version,
                    system_program: anchor_lang::system_program::ID,
                }
                .to_account_metas(None),
            ));
        }
    }
    Ok(transact(
        Phase::Activate,
        cox::instruction::ActivateUniverse {}.data(),
        cox::accounts::ActivateUniverse {
            runtime,
            registry,
            pool,
            methodology: previous_key,
            next_methodology: next_key,
            vault: pubkey(accounts.vault),
            schedule: schedule_key,
            test_vault: accounts.test_vault.map(pubkey),
            asset_registry: (registry_key != Pubkey::default()).then_some(registry_key),
            next_registry_version: (registry_key != Pubkey::default()).then_some(next_version),
            previous_registry_version: (registry_key != Pubkey::default())
                .then_some(previous_version),
        }
        .to_account_metas(None),
    ))
}
