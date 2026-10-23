#[path = "support/inclusion.rs"]
mod support;
use anchor_lang::{AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator};
use cox::{Batch, Methodology, Pool, Registry, UniverseVersion};
use relative_publisher::{
    inclusion_pipeline::{self, Commitment, Prepared},
    inclusion_rollout::{self, Confirmed, Error, Phase, RescheduleReason, Status},
    rpc::DEVNET_GENESIS,
    transactions::BasicAccounts,
};
use solana_address::Address;
fn zero<T: AccountDeserialize + Discriminator>() -> T {
    let mut bytes = T::DISCRIMINATOR.to_vec();
    bytes.resize(65_536, 0);
    T::try_deserialize(&mut bytes.as_slice()).unwrap()
}
struct Fixture {
    prepared: Prepared,
    accounts: BasicAccounts,
    registry: Registry,
    pool: Pool,
    slot: u64,
    now_ms: u64,
    methodology: Option<Methodology>,
    allocation: usize,
    pool_bytes: usize,
    epoch_stage: bool,
    persisted: bool,
    batch: Option<Batch>,
}
impl Fixture {
    fn new(count: usize) -> Self {
        let prepared =
            inclusion_pipeline::build_successor(support::request_with_count(count)).unwrap();
        let previous =
            UniverseVersion::from_canonical(&prepared.request.previous_canonical).unwrap();
        let next = UniverseVersion::from_canonical(&prepared.receipt.canonical).unwrap();
        let accounts = BasicAccounts::derive(
            Address::new_from_array(cox::ID.to_bytes()),
            2,
            previous.digest,
        );
        let mut registry: Registry = zero();
        registry.runtime = previous.operator;
        let mut pool: Pool = zero();
        pool.schema_version = 5;
        pool.pool_id = 2;
        pool.registry = anchor_lang::prelude::Pubkey::new_from_array(accounts.registry.to_bytes());
        pool.vault = anchor_lang::prelude::Pubkey::new_from_array(accounts.vault.to_bytes());
        pool.methodology =
            anchor_lang::prelude::Pubkey::new_from_array(accounts.methodology.to_bytes());
        pool.initialized = true;
        pool.origin = 1;
        pool.last_batch = 2;
        pool.sequence = next.capture.predecessor_sequence;
        pool.state_digest = next.capture.predecessor_state_digest;
        pool.benchmark = next.capture.benchmark;
        pool.origin_prices = vec![100; 30];
        pool.last_prices = vec![200; 30];
        pool.references = vec![100 * cox_math::SCALE; 31];
        pool.classes = vec![cox::Class::default(); 31];
        Self {
            prepared,
            accounts,
            registry,
            pool,
            slot: 100,
            now_ms: 3000,
            methodology: None,
            allocation: 8192,
            pool_bytes: 8192,
            epoch_stage: false,
            persisted: false,
            batch: None,
        }
    }
    fn plan(
        &self,
        cursor: Option<&inclusion_rollout::Cursor>,
    ) -> Result<inclusion_rollout::Plan, Error> {
        inclusion_rollout::plan(
            &self.prepared,
            &self.accounts,
            Address::new_from_array(self.registry.runtime.to_bytes()),
            Confirmed {
                genesis_hash: DEVNET_GENESIS,
                commitment: Commitment::Confirmed,
                slot: self.slot,
                now_ms: self.now_ms,
                max_publication_age_ms: 5000,
                registry: &self.registry,
                pool: &self.pool,
                pool_bytes: self.pool_bytes,
                batch: self.batch.as_ref(),
                schedule: &self.prepared.request.schedule,
                next_methodology: self
                    .methodology
                    .as_ref()
                    .map(|value| (value, self.allocation)),
                epoch_stage_present: self.epoch_stage,
                receipt_persisted: self.persisted,
            },
            cursor,
        )
    }
    fn registered(&mut self, complete: bool, sealed: bool) {
        let next = UniverseVersion::from_canonical(&self.prepared.receipt.canonical).unwrap();
        let mut value: Methodology = zero();
        value.schema_version = 3;
        value.digest = next.digest;
        value.expected_length = self.prepared.receipt.canonical.len() as u32;
        if complete {
            value.canonical = self.prepared.receipt.canonical.clone();
        }
        value.sealed = sealed;
        if sealed {
            value.origin = self.pool.origin;
            value.roster = (0..next.instruments.len())
                .map(|index| index as u8)
                .collect();
        }
        self.methodology = Some(value);
    }
}
#[test]
fn phases_follow_confirmed_offsets_and_repeat_safely_until_each_transaction_lands() {
    let mut f = Fixture::new(31);
    let register = f.plan(None).unwrap();
    assert_eq!(register.cursor.phase, Phase::Register);
    assert_eq!(
        register.instructions,
        f.plan(Some(&register.cursor)).unwrap().instructions
    );
    assert_eq!(
        &register.instructions[0].data[..8],
        cox::instruction::RegisterScheduledMethodology::DISCRIMINATOR
    );
    f.registered(false, false);
    let upload = f.plan(Some(&register.cursor)).unwrap();
    assert_eq!(upload.cursor.phase, Phase::Upload);
    let instruction = cox::instruction::UploadScheduledMethodology::try_from_slice(
        &upload.instructions[0].data[8..],
    )
    .unwrap();
    assert_eq!(instruction.offset, 0);
    assert_eq!(instruction.bytes.len(), 700);
    f.methodology
        .as_mut()
        .unwrap()
        .canonical
        .extend(&instruction.bytes);
    let resumed = f.plan(Some(&upload.cursor)).unwrap();
    let instruction = cox::instruction::UploadScheduledMethodology::try_from_slice(
        &resumed.instructions[0].data[8..],
    )
    .unwrap();
    assert_eq!(instruction.offset, 700);
    f.registered(true, false);
    assert_eq!(f.plan(None).unwrap().cursor.phase, Phase::Seal);
    f.methodology.as_mut().unwrap().sealed = true;
    assert_eq!(f.plan(None).unwrap().status, Status::PersistReceipt);
    f.persisted = true;
    let activation = f.plan(None).unwrap();
    assert_eq!(activation.cursor.phase, Phase::Activate);
    assert_eq!(
        &activation.instructions[0].data[..8],
        cox::instruction::ActivateUniverse::DISCRIMINATOR
    );
    f.pool.methodology = anchor_lang::prelude::Pubkey::find_program_address(
        &[b"methodology", &activation.cursor.successor_digest],
        &cox::ID,
    )
    .0;
    f.pool.classes.push(cox::Class::default());
    assert_eq!(
        f.plan(Some(&activation.cursor)).unwrap().status,
        Status::Complete
    );
    f.registry.runtime = anchor_lang::prelude::Pubkey::new_unique();
    assert_eq!(f.plan(None).unwrap().status, Status::Complete);
}
#[test]
fn accepted_boundaries_can_finish_late_but_missing_or_changed_boundaries_require_rescheduling() {
    let mut f = Fixture::new(31);
    f.pool.last_batch = 0;
    assert_eq!(
        f.plan(None).unwrap().cursor.phase,
        Phase::WaitingBoundaryPublication
    );
    f.now_ms = 8001;
    assert_eq!(
        f.plan(None).unwrap().status,
        Status::RescheduleRequired(RescheduleReason::BoundaryWindowMissed)
    );
    let mut batch: Batch = zero();
    batch.pool = anchor_lang::prelude::Pubkey::new_from_array(f.accounts.pool.to_bytes());
    batch.cutoff = 3;
    batch.predecessor_sequence = f.pool.sequence;
    batch.predecessor_digest = f.pool.state_digest;
    f.batch = Some(batch);
    f.pool.stage = Some(anchor_lang::prelude::Pubkey::new_from_array(
        f.accounts.batch.to_bytes(),
    ));
    assert_eq!(
        f.plan(None).unwrap().cursor.phase,
        Phase::WaitingAcceptedBasicBatch
    );
    f.pool.stage = None;
    f.pool.last_batch = 2;
    assert_eq!(f.plan(None).unwrap().cursor.phase, Phase::Register);
    f.epoch_stage = true;
    assert_eq!(f.plan(None).unwrap().cursor.phase, Phase::WaitingEpochStage);
    f.epoch_stage = false;
    f.pool.benchmark += 1;
    assert_eq!(
        f.plan(None).unwrap().status,
        Status::RescheduleRequired(RescheduleReason::BoundaryDoesNotMatchCapture)
    );
    f.pool.last_batch = 3;
    assert_eq!(
        f.plan(None).unwrap().status,
        Status::RescheduleRequired(RescheduleReason::BoundaryAlreadyPassed)
    );
    f.now_ms = 11000;
    assert_eq!(
        f.plan(None).unwrap().status,
        Status::RescheduleRequired(RescheduleReason::ExpiredSchedule)
    );
}
#[test]
fn full_capacity_growth_is_bounded_and_corrupted_uploads_or_cursors_cannot_resume() {
    let mut f = Fixture::new(255);
    f.registered(false, false);
    let growth = f.plan(None).unwrap();
    assert_eq!(growth.cursor.phase, Phase::GrowMethodology);
    let instruction =
        cox::instruction::GrowDynamicAccount::try_from_slice(&growth.instructions[0].data[8..])
            .unwrap();
    assert!(instruction.additional_bytes <= 8192);
    f.allocation = f.prepared.receipt.canonical.len() + 512;
    f.methodology.as_mut().unwrap().canonical = vec![0; 1];
    assert_eq!(f.plan(None).unwrap_err(), Error::Conflict);
    f.registered(true, true);
    let growth = f.plan(None).unwrap();
    assert_eq!(growth.cursor.phase, Phase::GrowPool);
    let instruction =
        cox::instruction::GrowDynamicAccount::try_from_slice(&growth.instructions[0].data[8..])
            .unwrap();
    assert!(instruction.additional_bytes <= 8192);
    let mut cursor = growth.cursor;
    cursor.observed_slot = 101;
    assert_eq!(f.plan(Some(&cursor)).unwrap_err(), Error::Cursor);
}

#[test]
fn rollout_requires_the_new_attestor_to_match_current_confirmed_registry_authority() {
    let mut f = Fixture::new(31);
    let current_operator = anchor_lang::prelude::Pubkey::new_unique();
    let mut request = f.prepared.request.clone();
    request.operator = current_operator.to_bytes();
    f.prepared = inclusion_pipeline::build_successor(request).unwrap();
    assert_eq!(f.plan(None).unwrap_err(), Error::Authority);
    f.registry.runtime = current_operator;
    assert_eq!(f.plan(None).unwrap().cursor.phase, Phase::Register);
}

#[test]
fn sealed_methodology_with_minimal_valid_allocation_never_attempts_forbidden_growth() {
    let mut f = Fixture::new(31);
    f.registered(true, true);
    let mut bytes = Vec::new();
    f.methodology
        .as_ref()
        .unwrap()
        .try_serialize(&mut bytes)
        .unwrap();
    f.allocation = bytes.len();
    assert!(f.allocation < f.prepared.receipt.canonical.len() + 512);
    assert_eq!(f.plan(None).unwrap().status, Status::PersistReceipt);
    f.allocation -= 1;
    assert_eq!(f.plan(None).unwrap_err(), Error::Conflict);
    f.allocation += 1;
    f.pool_bytes = 0;
    assert_eq!(f.plan(None).unwrap_err(), Error::State);
    f.pool_bytes = 8192;
    f.methodology.as_mut().unwrap().canonical.truncate(1);
    assert_eq!(f.plan(None).unwrap_err(), Error::Conflict);
}
