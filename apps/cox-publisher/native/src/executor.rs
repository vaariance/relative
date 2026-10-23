use crate::{
    benchmark::{Anchor, Observation},
    chain::{plan_maintenance_for, ChainReader, ChainState},
    scheduler::{DraftTransaction, PendingTransaction, Pool, Work},
    transactions::{self, BasicPublication, Budget, DynamicBasicPublication, EpochPrice},
    worker::{self, TransactionStatus},
};
use anchor_lang::AccountDeserialize;
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use solana_hash::Hash;
use solana_instruction::Instruction;
use std::{
    collections::BTreeSet,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetMapping {
    pub basic_id: u16,
    pub epoch_id: u16,
    pub epoch_feed_id: [u8; 32],
}
#[allow(async_fn_in_trait)]
pub trait DraftSigner {
    async fn sign(&self, draft: &DraftTransaction) -> Result<PendingTransaction, worker::Error>;
}
pub struct Executor<S> {
    pub reader: ChainReader,
    pub signer: S,
    pub anchor: Anchor,
    pub mapping: Vec<AssetMapping>,
    pub budget: Budget,
    pub max_operations: usize,
    last_state: Option<ChainState>,
    now_ms: u64,
    publication_archive: Option<crate::publications::Archive>,
    preview_ledger_path: Option<std::path::PathBuf>,
    chain_changes: Option<std::sync::Arc<crate::changes::ChainChanges>>,
    wake_accounts: Option<tokio::sync::watch::Sender<Vec<String>>>,
    chain_activity: Option<tokio::sync::watch::Receiver<crate::feeds::WakeHint>>,
    discovery: crate::chain::Discovery,
    max_price_age_ms: u64,
    max_feed_age_ms: u64,
    dynamic: Option<(crate::universe_runtime::View, Anchor)>,
    snapshot_archive: Option<crate::runtime::SnapshotArchive>,
    epoch_stage_path: Option<std::path::PathBuf>,
    epoch_stage: Option<crate::epoch_stage::Stage>,
    epoch_stage_snapshot: Option<(relative_epoch::SnapshotAccount, usize)>,
    epoch_retry_ms: u64,
    inclusion: Option<crate::inclusion_execution::Shared>,
}
pub(crate) fn validate_methodology_policy(
    methodology: &cox::Methodology,
    anchor: &Anchor,
    mapping: &[AssetMapping],
    max_price_age_ms: u64,
    max_feed_age_ms: u64,
) -> Result<(), worker::Error> {
    let manifest = cox::read_adaptive_manifest(methodology).map_err(|_| worker::Error::Snapshot)?;
    let policy = manifest.config;
    if anchor.benchmark != 100 * cox_math::SCALE
        || policy.origin.checked_mul(1_000_000) != Some(anchor.timestamp_us)
        || policy.universe_digest != anchor.universe_digest
        || policy.max_price_age_ms != max_price_age_ms
        || policy.max_feed_age_ms != max_feed_age_ms
        || policy.roster.len() != mapping.len()
        || mapping.len() != anchor.assets.len()
    {
        return Err(worker::Error::Snapshot);
    }
    for (index, id) in policy.roster.iter().enumerate() {
        let position = mapping
            .iter()
            .position(|mapping| mapping.basic_id == u16::from(*id))
            .ok_or(worker::Error::Snapshot)?;
        let asset = &anchor.assets[position];
        if cox::IDS[usize::from(*id)] != asset.id
            || policy.pyth_feed_ids[index] != asset.feed_id
            || policy.origin_prices[index] != asset.origin_price_e8
        {
            return Err(worker::Error::Snapshot);
        }
    }
    Ok(())
}
fn now() -> Result<u64, worker::Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_secs())
        .map_err(|_| worker::Error::Clock)
}
fn chain_error<T, E>(value: Result<T, E>) -> Result<T, worker::Error> {
    value.map_err(|_| worker::Error::Chain)
}
fn id(work: &Work) -> &str {
    match work {
        Work::Maintenance { id, .. } | Work::Entry { id, .. } | Work::Close { id, .. } => id,
    }
}
fn epoch_selected(work: &[Work], opens: u64) -> bool {
    let prefix = format!("epoch:{opens}:");
    work.iter().any(|item| id(item).starts_with(&prefix))
}
fn is_basic(work: &Work) -> bool {
    if matches!(work,Work::Close{id,..} if id==crate::inclusion_execution::BOUNDARY_ID) {
        return true;
    }
    matches!(
        work,
        Work::Entry {
            pool: Pool::Basic,
            ..
        } | Work::Maintenance {
            pool: Pool::Basic,
            ..
        }
    )
}
impl<S: DraftSigner> Executor<S> {
    pub fn new(
        reader: ChainReader,
        signer: S,
        anchor: Anchor,
        mapping: Vec<AssetMapping>,
        budget: Budget,
        max_operations: usize,
    ) -> Result<Self, worker::Error> {
        if mapping.len() != anchor.assets.len()
            || mapping.is_empty()
            || max_operations == 0
            || max_operations > 16
            || mapping
                .iter()
                .any(|m| m.basic_id >= 256 || m.epoch_id >= 256 || m.epoch_feed_id == [0; 32])
            || mapping
                .iter()
                .map(|m| m.basic_id)
                .collect::<BTreeSet<_>>()
                .len()
                != mapping.len()
            || mapping
                .iter()
                .map(|m| m.epoch_id)
                .collect::<BTreeSet<_>>()
                .len()
                != mapping.len()
            || mapping
                .iter()
                .map(|m| m.epoch_feed_id)
                .collect::<BTreeSet<_>>()
                .len()
                != mapping.len()
        {
            return Err(worker::Error::Chain);
        }
        let discovery = crate::chain::Discovery::new(
            reader.epoch_program,
            reader.epoch_config,
            anchor.timestamp_us / 1_000_000 / cox_epoch::EPOCH_SECONDS * cox_epoch::EPOCH_SECONDS,
        )
        .map_err(|_| worker::Error::Chain)?;
        Ok(Self {
            reader,
            signer,
            anchor,
            mapping,
            budget,
            max_operations,
            last_state: None,
            now_ms: 0,
            discovery,
            publication_archive: None,
            preview_ledger_path: None,
            chain_changes: None,
            wake_accounts: None,
            chain_activity: None,
            max_price_age_ms: 5_000,
            max_feed_age_ms: 60_000,
            dynamic: None,
            snapshot_archive: None,
            epoch_stage_path: None,
            epoch_stage: None,
            epoch_stage_snapshot: None,
            epoch_retry_ms: 0,
            inclusion: None,
        })
    }
    pub fn with_chain_changes(
        mut self,
        changes: std::sync::Arc<crate::changes::ChainChanges>,
    ) -> Self {
        self.chain_changes = Some(changes);
        self
    }
    pub fn with_chain_activity(
        mut self,
        receiver: tokio::sync::watch::Receiver<crate::feeds::WakeHint>,
    ) -> Self {
        self.chain_activity = Some(receiver);
        self
    }
    pub fn with_wake_accounts(mut self, sender: tokio::sync::watch::Sender<Vec<String>>) -> Self {
        self.wake_accounts = Some(sender);
        self
    }
    pub fn with_preview_ledger(mut self, path: std::path::PathBuf) -> Self {
        self.preview_ledger_path = Some(path);
        self
    }
    pub fn with_inclusion(mut self, inclusion: crate::inclusion_execution::Shared) -> Self {
        self.inclusion = Some(inclusion);
        self
    }
    pub fn with_snapshot_archive(mut self, archive: crate::runtime::SnapshotArchive) -> Self {
        self.snapshot_archive = Some(archive);
        self
    }
    pub fn with_dynamic_view(
        mut self,
        view: crate::universe_runtime::View,
        root: Anchor,
    ) -> Result<Self, worker::Error> {
        if view.anchor != self.anchor || view.mapping != self.mapping {
            return Err(worker::Error::Snapshot);
        }
        self.dynamic = Some((view, root));
        Ok(self)
    }
    pub fn with_price_policy_limits(
        mut self,
        max_price_age_ms: u64,
        max_feed_age_ms: u64,
    ) -> Result<Self, worker::Error> {
        if !(1..=5_000).contains(&max_price_age_ms) || !(1..=60_000).contains(&max_feed_age_ms) {
            return Err(worker::Error::Snapshot);
        }
        self.max_price_age_ms = max_price_age_ms;
        self.max_feed_age_ms = max_feed_age_ms;
        Ok(self)
    }
    pub fn with_discovery_state(
        mut self,
        path: impl Into<std::path::PathBuf>,
        first_epoch: u64,
    ) -> Result<Self, worker::Error> {
        let path = path.into();
        let stage_path = path
            .parent()
            .ok_or(worker::Error::Storage)?
            .join("epoch-snapshot-stage.json");
        if let Ok(info) = std::fs::metadata(&stage_path) {
            if info.len() > 1_048_576 {
                return Err(worker::Error::Storage);
            }
        }
        self.epoch_stage = crate::journal::read::<Option<crate::epoch_stage::Stage>>(&stage_path)
            .map_err(|_| worker::Error::Storage)?
            .flatten();
        self.epoch_stage_path = Some(stage_path);
        self.discovery = crate::chain::Discovery::load(
            path,
            self.reader.epoch_program,
            self.reader.epoch_config,
            first_epoch,
        )
        .map_err(|_| worker::Error::Storage)?;
        Ok(self)
    }
    async fn read_state(&mut self) -> Result<ChainState, worker::Error> {
        chain_error(self.reader.read_with_discovery(&mut self.discovery).await)
    }
    pub fn with_publication_archive(mut self, directory: impl Into<std::path::PathBuf>) -> Self {
        let pool = transactions::BasicAccounts::derive(
            self.reader.basic_program,
            self.reader.basic_pool_id,
            [0; 32],
        )
        .pool;
        self.publication_archive = Some(crate::publications::Archive::new(
            directory,
            self.reader.basic_program,
            pool,
        ));
        self
    }
    async fn preserve_publication(&self, state: &ChainState) -> Result<(), worker::Error> {
        if !state.basic.pool.initialized {
            return Ok(());
        }
        let archive = self
            .publication_archive
            .as_ref()
            .ok_or(worker::Error::Storage)?;
        if let Some(record) = archive
            .read(state.basic.pool.sequence)
            .map_err(|_| worker::Error::Storage)?
        {
            return if record.state_digest == hex::encode(state.basic.pool.state_digest) {
                Ok(())
            } else {
                Err(worker::Error::Storage)
            };
        }
        let response=chain_error(self.reader.rpc.call("getAccountInfo",json!([archive.address().to_string(),{"commitment":"confirmed","encoding":"base64","minContextSlot":state.slot}])).await)?;
        let slot = response
            .pointer("/context/slot")
            .and_then(|v| v.as_u64())
            .filter(|slot| *slot >= state.slot)
            .ok_or(worker::Error::Chain)?;
        let account = response
            .get("value")
            .filter(|v| !v.is_null())
            .ok_or(worker::Error::Chain)?;
        if account.get("executable").and_then(|v| v.as_bool()) != Some(false)
            || account.pointer("/data/1").and_then(|v| v.as_str()) != Some("base64")
        {
            return Err(worker::Error::Chain);
        }
        let owner = account
            .get("owner")
            .and_then(|v| v.as_str())
            .ok_or(worker::Error::Chain)?
            .parse()
            .map_err(|_| worker::Error::Chain)?;
        let data = STANDARD
            .decode(
                account
                    .pointer("/data/0")
                    .and_then(|v| v.as_str())
                    .ok_or(worker::Error::Chain)?,
            )
            .map_err(|_| worker::Error::Chain)?;
        archive
            .preserve(
                owner,
                archive.address(),
                &data,
                slot,
                state.basic.pool.sequence,
                state.basic.pool.state_digest,
            )
            .map_err(|_| worker::Error::Storage)
    }
    fn validate_anchor(&self, state: &ChainState) -> Result<(), worker::Error> {
        if let Some((expected, root)) = &self.dynamic {
            if state.basic.methodology.digest != expected.digest {
                return Err(worker::Error::UniverseTransition);
            }
            let observed = crate::universe_runtime::view(&state.basic.methodology.canonical)
                .map_err(|_| worker::Error::Snapshot)?;
            if observed != *expected
                || state.basic.pool.schema_version != 5
                || state.basic.pool.origin.checked_mul(1_000_000) != Some(root.timestamp_us)
                || state.epoch_config.origin_benchmark != root.benchmark as u128
                || state.epoch_config.methodology != expected.source_methodology
                || state.basic.pool.origin_prices != expected.original_prices
                || state.basic.pool.classes.len() != self.mapping.len() + 1
            {
                return Err(worker::Error::Snapshot);
            }
        } else {
            if state.basic.pool.schema_version == 5 {
                return Err(worker::Error::UniverseTransition);
            }
            validate_methodology_policy(
                &state.basic.methodology,
                &self.anchor,
                &self.mapping,
                self.max_price_age_ms,
                self.max_feed_age_ms,
            )?;
            if state.basic.pool.origin.checked_mul(1_000_000) != Some(self.anchor.timestamp_us)
                || state.epoch_config.origin_benchmark != self.anchor.benchmark as u128
                || state.epoch_config.methodology != state.basic.methodology.digest
                || state.basic.pool.trading_opens_at > self.discovery.first_epoch()
            {
                return Err(worker::Error::Snapshot);
            }
            for (index, mapping) in self.mapping.iter().enumerate() {
                if cox::IDS[usize::from(mapping.basic_id)] != self.anchor.assets[index].id {
                    return Err(worker::Error::Snapshot);
                }
            }
            if state
                .basic
                .methodology
                .roster
                .iter()
                .any(|asset| !self.mapping.iter().any(|m| m.basic_id == u16::from(*asset)))
            {
                return Err(worker::Error::Snapshot);
            }
            if state.basic.pool.initialized {
                let expected = state
                    .basic
                    .methodology
                    .roster
                    .iter()
                    .map(|asset| {
                        self.mapping
                            .iter()
                            .position(|m| m.basic_id == u16::from(*asset))
                            .map(|i| self.anchor.assets[i].origin_price_e8)
                            .ok_or(worker::Error::Snapshot)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                if state.basic.pool.origin_prices != expected {
                    return Err(worker::Error::Snapshot);
                }
            }
        }
        if state.basic.pool.trading_opens_at > self.discovery.first_epoch() {
            return Err(worker::Error::Snapshot);
        }
        for epoch in &state.epochs {
            for asset in epoch
                .epoch
                .state
                .as_ref()
                .map(|state| state.universe())
                .unwrap_or(epoch.epoch.universe.as_slice())
            {
                let index = self
                    .mapping
                    .iter()
                    .position(|mapping| {
                        mapping.epoch_id == asset.id && mapping.epoch_feed_id == asset.feed_id
                    })
                    .ok_or(worker::Error::Snapshot)?;
                let original = self
                    .dynamic
                    .as_ref()
                    .map(|(view, _)| view.original_prices[index])
                    .unwrap_or(self.anchor.assets[index].origin_price_e8);
                if asset.origin_price != u128::from(original) {
                    return Err(worker::Error::Snapshot);
                }
            }
        }
        Ok(())
    }
    fn persist_epoch_stage(
        &mut self,
        stage: Option<crate::epoch_stage::Stage>,
    ) -> Result<(), worker::Error> {
        let path = self
            .epoch_stage_path
            .as_ref()
            .ok_or(worker::Error::Storage)?;
        crate::journal::atomic_write(path, &stage).map_err(|_| worker::Error::Storage)?;
        self.epoch_stage = stage;
        self.epoch_stage_snapshot = None;
        Ok(())
    }
    async fn read_epoch_stage_snapshot(
        &self,
        state: &ChainState,
        stage: &crate::epoch_stage::Stage,
    ) -> Result<Option<(relative_epoch::SnapshotAccount, usize)>, worker::Error> {
        let accounts = transactions::EpochAccounts::derive(
            self.reader.epoch_program,
            self.reader.epoch_config,
            self.discovery.first_epoch(),
        )
        .map_err(|_| worker::Error::Chain)?;
        let value=chain_error(self.reader.rpc.call("getAccountInfo",json!([accounts.snapshot(stage.timestamp()).to_string(),{"commitment":"confirmed","encoding":"base64","minContextSlot":state.slot}])).await)?;
        let account = value.get("value").ok_or(worker::Error::Chain)?;
        if account.is_null() {
            return Ok(None);
        }
        if account.get("owner").and_then(|value| value.as_str())
            != Some(self.reader.epoch_program.to_string().as_str())
            || account.get("executable").and_then(|value| value.as_bool()) != Some(false)
        {
            return Err(worker::Error::Snapshot);
        }
        let bytes = STANDARD
            .decode(
                account
                    .pointer("/data/0")
                    .and_then(|value| value.as_str())
                    .ok_or(worker::Error::Snapshot)?,
            )
            .map_err(|_| worker::Error::Snapshot)?;
        let saved = relative_epoch::SnapshotAccount::try_deserialize(&mut bytes.as_slice())
            .map_err(|_| worker::Error::Snapshot)?;
        stage.verify_snapshot(
            &saved,
            &stage.prices(&self.mapping)?,
            state.epoch_config.methodology,
        )?;
        Ok(Some((saved, bytes.len())))
    }
    fn epoch_stage_expired(&self, state: &ChainState, stage: &crate::epoch_stage::Stage) -> bool {
        if stage.closing() {
            return self.now_ms / 1000
                > stage
                    .timestamp()
                    .saturating_add(cox_epoch::CLOSING_GRACE_SECONDS);
        }
        self.now_ms / 1000
            > stage
                .timestamp()
                .saturating_add(state.epoch_config.max_entry_price_age)
            || !state.epochs.iter().any(|epoch| {
                epoch_selected(&stage.work, epoch.epoch.opens_at)
                    && self.now_ms / 1000
                        < epoch
                            .epoch
                            .state
                            .as_ref()
                            .map_or(0, |state| state.closes_at())
            })
    }
    fn epoch_stage_work(stage: &crate::epoch_stage::Stage) -> Result<Work, worker::Error> {
        let first = stage.work.first().ok_or(worker::Error::Storage)?;
        let mut pieces = id(first).split(':');
        if pieces.next() != Some("epoch") {
            return Err(worker::Error::Storage);
        }
        let opens = pieces
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or(worker::Error::Storage)?;
        Ok(Work::Maintenance {
            id: format!("epoch:{opens}:snapshot-stage"),
            pool: Pool::Epoch,
        })
    }
    async fn prepare_epoch_stage(
        &mut self,
        state: &ChainState,
        work: &[Work],
        observation: Option<&Observation>,
    ) -> Result<Vec<Instruction>, worker::Error> {
        if self.epoch_stage.is_none() {
            let observation = observation.ok_or(worker::Error::Snapshot)?;
            self.snapshot_archive
                .as_ref()
                .ok_or(worker::Error::Snapshot)?
                .validate(observation)?;
            let stage = crate::epoch_stage::Stage {
                schema: "relative.epoch-snapshot-stage/v1".into(),
                program: self.reader.epoch_program.to_string(),
                config: self.reader.epoch_config.to_string(),
                operator: self.reader.operator.to_string(),
                anchor: self.anchor.clone(),
                observation: observation.clone(),
                work: work
                    .iter()
                    .filter(|work| !is_basic(work))
                    .cloned()
                    .collect(),
            };
            stage.validate(
                self.reader.epoch_program,
                self.reader.epoch_config,
                self.reader.operator,
                &self.anchor,
            )?;
            let saved = self.read_epoch_stage_snapshot(state, &stage).await?;
            self.persist_epoch_stage(Some(stage))?;
            self.epoch_stage_snapshot = saved;
        }
        let stage = self.epoch_stage.as_ref().ok_or(worker::Error::Storage)?;
        stage.validate(
            self.reader.epoch_program,
            self.reader.epoch_config,
            self.reader.operator,
            &self.anchor,
        )?;
        let accounts = transactions::EpochAccounts::derive(
            self.reader.epoch_program,
            self.reader.epoch_config,
            self.discovery.first_epoch(),
        )
        .map_err(|_| worker::Error::Chain)?;
        if self.epoch_stage_expired(state, stage) {
            return Ok(vec![
                accounts.close_snapshot(self.reader.operator, stage.timestamp())
            ]);
        }
        self.snapshot_archive
            .as_ref()
            .ok_or(worker::Error::Snapshot)?
            .validate(&stage.observation)?;
        let prices = stage.prices(&self.mapping)?;
        let saved = self
            .epoch_stage_snapshot
            .as_ref()
            .map(|(snapshot, space)| (snapshot, *space));
        let mut instructions = stage.plan(&accounts, self.reader.operator, saved, &prices)?;
        if saved.is_some_and(|(snapshot, _)| snapshot.sealed) {
            for epoch in &state.epochs {
                if !epoch_selected(&stage.work, epoch.epoch.opens_at) {
                    continue;
                }
                let current = epoch.epoch.state.as_ref().ok_or(worker::Error::Chain)?;
                if stage.closing()
                    && current.phase() == cox_epoch::Phase::Open
                    && current.closes_at() == stage.timestamp()
                {
                    instructions.push(
                        epoch
                            .accounts
                            .begin_close(self.reader.operator, stage.timestamp()),
                    );
                } else if !stage.closing() {
                    for lot in &epoch.lots {
                        if stage.work.iter().any(|work| {
                            id(work) == format!("epoch:{}:{}", epoch.epoch.opens_at, lot.nonce)
                        }) && matches!(
                            lot.state.as_ref().map(|lot| lot.state()),
                            Some(cox_epoch::LotState::Pending)
                        ) {
                            instructions.push(epoch.accounts.execute(
                                self.reader.operator,
                                lot.nonce,
                                stage.timestamp(),
                            ));
                        }
                    }
                }
            }
            instructions.push(accounts.close_snapshot(self.reader.operator, stage.timestamp()));
        }
        Ok(instructions)
    }
    fn dynamic_publication(
        &self,
        state: &ChainState,
        observation: &Observation,
    ) -> Result<DynamicBasicPublication, worker::Error> {
        let universe = cox::read_dynamic_manifest(&state.basic.methodology)
            .map_err(|_| worker::Error::Snapshot)?;
        let timestamp = observation.timestamp_us / 1_000_000;
        if state.basic.batch.is_none()
            && timestamp
                .checked_sub(state.basic.pool.origin)
                .is_none_or(|batch| {
                    batch
                        <= state
                            .basic
                            .pool
                            .last_batch
                            .max(state.basic.pool.stage_batch)
                })
        {
            return Err(worker::Error::Snapshot);
        }
        if observation.universe_digest != self.anchor.universe_digest
            || observation.timestamp_us % 1_000_000 != 0
            || observation.prices_e8.len() != self.mapping.len()
        {
            return Err(worker::Error::Snapshot);
        }
        let prices = universe
            .instruments
            .iter()
            .map(|instrument| {
                self.mapping
                    .iter()
                    .position(|mapping| {
                        mapping.basic_id == instrument.class_id
                            && mapping.epoch_id == instrument.epoch_id
                    })
                    .map(|index| observation.prices_e8[index])
                    .ok_or(worker::Error::Snapshot)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let value = DynamicBasicPublication {
            publication: BasicPublication {
                origin: state.basic.pool.origin,
                batch_id: timestamp
                    .checked_sub(state.basic.pool.origin)
                    .ok_or(worker::Error::Snapshot)?,
                sequence: state
                    .basic
                    .pool
                    .sequence
                    .checked_add(1)
                    .ok_or(worker::Error::Chain)?,
                predecessor: state.basic.pool.state_digest,
                timestamp,
                benchmark: observation.benchmark,
                roster: universe
                    .instruments
                    .iter()
                    .map(|instrument| {
                        u8::try_from(instrument.class_id).map_err(|_| worker::Error::Snapshot)
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                prices_e8: prices,
            },
            universe,
        };
        value
            .snapshot_digest()
            .map_err(|_| worker::Error::Snapshot)?;
        Ok(value)
    }
    fn resume_dynamic_prices(&self, state: &ChainState) -> Result<Vec<Instruction>, worker::Error> {
        let batch = state
            .basic
            .batch
            .as_ref()
            .filter(|batch| batch.phase == 4 && batch.schema_version == 4)
            .ok_or(worker::Error::Chain)?;
        let observation = self
            .snapshot_archive
            .as_ref()
            .ok_or(worker::Error::Snapshot)?
            .accepted(
                batch
                    .cutoff
                    .checked_mul(1_000_000)
                    .ok_or(worker::Error::Clock)?,
            )?;
        self.resume_dynamic_prices_from(state, &observation)
    }
    fn resume_dynamic_prices_from(
        &self,
        state: &ChainState,
        observation: &Observation,
    ) -> Result<Vec<Instruction>, worker::Error> {
        let batch = state
            .basic
            .batch
            .as_ref()
            .filter(|batch| batch.phase == 4 && batch.schema_version == 4)
            .ok_or(worker::Error::Chain)?;
        let publication = self.dynamic_publication(state, observation)?;
        if publication.publication.batch_id != batch.batch_id
            || publication.publication.sequence != batch.sequence
            || publication.publication.predecessor != batch.predecessor_digest
            || publication.publication.benchmark != batch.benchmark
            || publication
                .snapshot_digest()
                .map_err(|_| worker::Error::Snapshot)?
                != batch.snapshot_digest
            || batch.prices.len() > publication.publication.prices_e8.len()
            || batch
                .prices
                .iter()
                .zip(&publication.publication.prices_e8)
                .any(|(saved, price)| {
                    saved.price_e8 != *price
                        || saved.venue != 3
                        || saved.step != 0
                        || saved.candle_start != batch.cutoff
                        || saved.trade_age_minutes != 0
                })
        {
            return Err(worker::Error::Snapshot);
        }
        let mut instructions = Vec::new();
        for (page, prices) in publication.publication.prices_e8[batch.prices.len()..]
            .chunks(16)
            .enumerate()
        {
            instructions.push(
                state
                    .basic
                    .accounts
                    .append_dynamic_prices(
                        self.reader.operator,
                        u16::try_from(batch.prices.len() + page * 16)
                            .map_err(|_| worker::Error::Chain)?,
                        batch.cutoff,
                        prices,
                    )
                    .map_err(|_| worker::Error::Snapshot)?,
            );
        }
        instructions.push(state.basic.accounts.seal_dynamic(self.reader.operator));
        Ok(instructions)
    }
    fn publication_instructions(
        &self,
        state: &ChainState,
        work: &[Work],
        observation: &Observation,
    ) -> Result<Vec<Instruction>, worker::Error> {
        if observation.universe_digest != self.anchor.universe_digest
            || observation.prices_e8.len() != self.mapping.len()
            || observation.timestamp_us % 1_000_000 != 0
            || observation.benchmark <= 0
            || observation.signed_payload.is_empty()
        {
            return Err(worker::Error::Snapshot);
        }
        let timestamp = observation.timestamp_us / 1_000_000;
        let mut instructions = Vec::new();
        if work.iter().any(is_basic) {
            if state.basic.registry.paused || state.basic.batch.is_some() {
                return Err(worker::Error::Chain);
            }
            let dynamic = state.basic.pool.schema_version == 5;
            if dynamic {
                let publication = self.dynamic_publication(state, observation)?;
                instructions.push(
                    state
                        .basic
                        .accounts
                        .begin_dynamic(self.reader.operator, &publication)
                        .map_err(|_| worker::Error::Snapshot)?,
                );
                for (page, prices) in publication.publication.prices_e8.chunks(16).enumerate() {
                    instructions.push(
                        state
                            .basic
                            .accounts
                            .append_dynamic_prices(
                                self.reader.operator,
                                (page * 16) as u16,
                                timestamp,
                                prices,
                            )
                            .map_err(|_| worker::Error::Snapshot)?,
                    );
                }
                instructions.push(state.basic.accounts.seal_dynamic(self.reader.operator));
            } else {
                let prices = state
                    .basic
                    .methodology
                    .roster
                    .iter()
                    .map(|asset| {
                        self.mapping
                            .iter()
                            .position(|m| m.basic_id == u16::from(*asset))
                            .map(|i| observation.prices_e8[i])
                            .ok_or(worker::Error::Snapshot)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let publication = BasicPublication {
                    origin: state.basic.pool.origin,
                    batch_id: timestamp
                        .checked_sub(state.basic.pool.origin)
                        .ok_or(worker::Error::Snapshot)?,
                    sequence: if state.basic.pool.initialized {
                        state
                            .basic
                            .pool
                            .sequence
                            .checked_add(1)
                            .ok_or(worker::Error::Chain)?
                    } else {
                        0
                    },
                    predecessor: state.basic.pool.state_digest,
                    timestamp,
                    benchmark: observation.benchmark,
                    roster: state.basic.methodology.roster.clone(),
                    prices_e8: prices,
                };
                instructions.push(chain_error(
                    state
                        .basic
                        .accounts
                        .publish(self.reader.operator, &publication),
                )?);
            }
            for request in state
                .basic
                .requests
                .iter()
                .take(if dynamic && self.mapping.len() > 32 {
                    0
                } else {
                    self.max_operations
                })
            {
                instructions.push(state.basic.accounts.process(
                    request.nonce,
                    solana_address::Address::new_from_array(request.owner.to_bytes()),
                    transactions::BasicProcess::Evaluate,
                ));
            }
        }
        let mut published = false;
        for epoch in &state.epochs {
            if !epoch_selected(work, epoch.epoch.opens_at) {
                continue;
            }
            let current = epoch.epoch.state.as_ref().ok_or(worker::Error::Chain)?;
            if !published {
                let mut prices = self
                    .mapping
                    .iter()
                    .enumerate()
                    .map(|(index, mapping)| EpochPrice {
                        asset_id: mapping.epoch_id,
                        feed_id: mapping.epoch_feed_id,
                        value: u128::from(observation.prices_e8[index]),
                    })
                    .collect::<Vec<_>>();
                prices.sort_by_key(|p| p.asset_id);
                instructions.push(chain_error(epoch.accounts.publish_snapshot(
                    self.reader.operator,
                    timestamp,
                    timestamp,
                    observation.benchmark as u128,
                    &prices,
                ))?);
                published = true;
            }
            if work.iter().any(|item|matches!(item,Work::Close{timestamp_ms,..} if epoch_selected(std::slice::from_ref(item),epoch.epoch.opens_at)&&*timestamp_ms==timestamp*1000)){
                if timestamp!=current.closes_at(){return Err(worker::Error::Snapshot);}
                instructions.push(epoch.accounts.begin_close(self.reader.operator,timestamp));
            } else {
                for lot in &epoch.lots{
                    if instructions.len()>=self.max_operations+2{break;}
                    if work.iter().any(|item|id(item)==format!("epoch:{}:{}",epoch.epoch.opens_at,lot.nonce)){
                        let entry=lot.state.as_ref().ok_or(worker::Error::Chain)?;
                        if timestamp<=entry.admitted_at() || timestamp>=current.closes_at(){return Err(worker::Error::Snapshot);}
                        instructions.push(epoch.accounts.execute(self.reader.operator,lot.nonce,timestamp));
                    }
                }
            }
        }
        if published {
            let epoch = state
                .epochs
                .iter()
                .find(|epoch| epoch_selected(work, epoch.epoch.opens_at))
                .ok_or(worker::Error::Chain)?;
            instructions.push(
                epoch
                    .accounts
                    .close_snapshot(self.reader.operator, timestamp),
            );
        }
        if instructions.is_empty() {
            return Err(worker::Error::Chain);
        }
        Ok(instructions)
    }
    async fn existing_epoch_snapshots(
        &self,
        instructions: &mut Vec<Instruction>,
        state: &ChainState,
        timestamp: u64,
        observation: &Observation,
    ) -> Result<(), worker::Error> {
        let Some(epoch) = state.epochs.first() else {
            return Ok(());
        };
        let snapshot = epoch.accounts.snapshot(timestamp);
        let value=chain_error(self.reader.rpc.call("getAccountInfo",json!([snapshot.to_string(),{"commitment":"confirmed","encoding":"base64","minContextSlot":state.slot}])).await)?;
        let account = value.get("value").ok_or(worker::Error::Chain)?;
        if account.is_null() {
            return Ok(());
        }
        if account.get("owner").and_then(|v| v.as_str())
            != Some(self.reader.epoch_program.to_string().as_str())
        {
            return Err(worker::Error::Chain);
        }
        let bytes = STANDARD
            .decode(
                account
                    .pointer("/data/0")
                    .and_then(|v| v.as_str())
                    .ok_or(worker::Error::Chain)?,
            )
            .map_err(|_| worker::Error::Chain)?;
        let saved = relative_epoch::SnapshotAccount::try_deserialize(&mut bytes.as_slice())
            .map_err(|_| worker::Error::Chain)?;
        if !saved.sealed
            || saved.config.to_bytes() != self.reader.epoch_config.to_bytes()
            || saved.sequence != timestamp
            || saved.oracle_timestamp != timestamp
            || saved.benchmark != observation.benchmark as u128
            || saved.methodology != state.epoch_config.methodology
            || saved.prices.len() != self.mapping.len()
        {
            return Err(worker::Error::Snapshot);
        }
        for (index, mapping) in self.mapping.iter().enumerate() {
            if !saved.prices.iter().any(|p| {
                p.asset_id == mapping.epoch_id
                    && p.feed_id == mapping.epoch_feed_id
                    && p.value == u128::from(observation.prices_e8[index])
            }) {
                return Err(worker::Error::Snapshot);
            }
        }
        let discriminator = &Sha256::digest(b"global:publish_snapshot")[..8];
        instructions.retain(|instruction| {
            instruction.program_id != self.reader.epoch_program
                || instruction.data.get(..8) != Some(discriminator)
        });
        Ok(())
    }
}
fn trim_optional_tail(
    instructions: &mut Vec<Instruction>,
    epoch_program: solana_address::Address,
) -> bool {
    let close = &Sha256::digest(b"global:close_snapshot")[..8];
    let publish = &Sha256::digest(b"global:publish_snapshot")[..8];
    let execute = &Sha256::digest(b"global:execute")[..8];
    let closing = &Sha256::digest(b"global:begin_close")[..8];
    if instructions
        .last()
        .is_some_and(|ix| ix.program_id == epoch_program && ix.data.get(..8) == Some(close))
    {
        if let Some(index) = instructions.iter().rposition(|ix| {
            ix.program_id == epoch_program
                && (ix.data.get(..8) == Some(execute) || ix.data.get(..8) == Some(closing))
        }) {
            instructions.remove(index);
        } else {
            instructions.retain(|ix| {
                ix.program_id != epoch_program
                    || (ix.data.get(..8) != Some(close) && ix.data.get(..8) != Some(publish))
            });
        }
    } else {
        instructions.pop();
    }
    !instructions.is_empty()
}
fn critical_digest(state: &ChainState) -> [u8; 32] {
    let mut hash = Sha256::new();
    let basic = &state.basic;
    hash.update(basic.pool.sequence.to_le_bytes());
    hash.update(basic.pool.state_digest);
    hash.update([u8::from(basic.registry.paused)]);
    hash.update(basic.registry.runtime.to_bytes());
    hash.update(basic.methodology.digest);
    hash.update(basic.pool.fee_version.to_le_bytes());
    hash.update(basic.pool.fee_bps.to_le_bytes());
    hash.update(basic.pool.fee_cap.to_le_bytes());
    hash.update(basic.pool.trading_opens_at.to_le_bytes());
    if let Some(mint) = basic.pool.test_collateral_mint {
        hash.update([1]);
        hash.update(mint.to_bytes());
    } else {
        hash.update([0]);
    }
    hash.update([u8::from(basic.pool.fee_pending)]);
    hash.update(basic.pool.fee_pending_version.to_le_bytes());
    hash.update(basic.pool.fee_pending_bps.to_le_bytes());
    hash.update(basic.pool.fee_pending_cap.to_le_bytes());
    hash.update(basic.pool.fee_pending_cutoff.to_le_bytes());
    if let Some(batch) = &basic.batch {
        hash.update([1]);
        hash.update(batch.batch_id.to_le_bytes());
        hash.update(batch.snapshot_digest);
        hash.update(batch.cursor.to_le_bytes());
        hash.update([batch.phase]);
        hash.update(batch.closed_queue_end.to_le_bytes());
        hash.update((batch.prices.len() as u32).to_le_bytes());
        for price in &batch.prices {
            hash.update(price.price_e8.to_le_bytes());
            hash.update([price.venue, price.step]);
            hash.update(price.candle_start.to_le_bytes());
            hash.update(price.trade_age_minutes.to_le_bytes());
        }
    } else {
        hash.update([0]);
    }
    hash.update(state.epoch_config.operator.to_bytes());
    hash.update(state.epoch_config.methodology);
    let mut epochs = state.epochs.iter().collect::<Vec<_>>();
    epochs.sort_by_key(|epoch| epoch.epoch.opens_at);
    for epoch in epochs {
        if let Some(current) = epoch.epoch.state.as_ref() {
            hash.update(epoch.epoch.opens_at.to_le_bytes());
            hash.update([current.phase() as u8]);
            hash.update(current.executed_lots().to_le_bytes());
            hash.update(current.scored_lots().to_le_bytes());
            hash.update(current.allocated_lots().to_le_bytes());
        }
    }
    hash.finalize().into()
}
fn draft_hash(bytes: &[u8], expiry: u64, height: u64) -> String {
    let mut hash = Sha256::new();
    hash.update(bytes);
    hash.update(expiry.to_le_bytes());
    hash.update(height.to_le_bytes());
    hex::encode(&hash.finalize()[..20])
}
fn pending_valid(operator: solana_address::Address, pending: &PendingTransaction) -> bool {
    if pending.signed_bytes.len() < 65
        || pending.signed_bytes.len() > transactions::MAX_TRANSACTION_BYTES
    {
        return false;
    }
    let at = pending.signed_bytes.len() - 64;
    let Ok(signature) = Signature::from_slice(&pending.signed_bytes[at..]) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&operator.to_bytes()) else {
        return false;
    };
    bs58::encode(signature.to_bytes()).into_string() == pending.signature
        && key
            .verify_strict(&pending.signed_bytes[..at], &signature)
            .is_ok()
}
impl<S: DraftSigner> worker::Chain for Executor<S> {
    fn price_timestamp_ceiling_ms(&self, wall_ms: u64) -> Result<u64, worker::Error> {
        let timestamp = self.last_state.as_ref().ok_or(worker::Error::Chain)?.confirmed_timestamp_ms;
        if timestamp == 0 || timestamp > wall_ms || wall_ms - timestamp > self.max_price_age_ms {
            return Err(worker::Error::Clock);
        }
        Ok(timestamp)
    }

    fn needs_reconciliation(&self) -> bool {
        self.discovery.incomplete
    }
    fn next_wake_ms(&self) -> Option<u64> {
        let inclusion = self.inclusion.as_ref().and_then(|control| {
            control
                .lock()
                .ok()
                .and_then(|control| control.wake_ms(self.now_ms))
        });
        let epoch = if self.epoch_retry_ms > self.now_ms {
            if let Some(stage) = self.epoch_stage.as_ref() {
                let age = if stage.closing() {
                    cox_epoch::CLOSING_GRACE_SECONDS
                } else {
                    self.last_state
                        .as_ref()
                        .map(|state| state.epoch_config.max_entry_price_age)
                        .unwrap_or(60)
                };
                Some(
                    self.epoch_retry_ms.min(
                        stage
                            .timestamp()
                            .saturating_add(age)
                            .saturating_add(1)
                            .saturating_mul(1000),
                    ),
                )
            } else {
                Some(self.epoch_retry_ms)
            }
        } else {
            None
        };
        inclusion.into_iter().chain(epoch).min()
    }
    async fn authoritative_work(&mut self, now_ms: u64) -> Result<Vec<Work>, worker::Error> {
        self.now_ms = now_ms;
        let state = self.read_state().await?;
        self.validate_anchor(&state)?;
        if let Some(changes) = &self.chain_changes {
            let activity = self
                .chain_activity
                .as_ref()
                .map(|receiver| *receiver.borrow())
                .unwrap_or_default();
            changes
                .confirm_activity(
                    state.slot,
                    state.digest,
                    activity.generation,
                    activity.latest_slot,
                )
                .map_err(|_| worker::Error::Storage)?;
        }
        if let Some(sender) = &self.wake_accounts {
            let mut accounts = vec![state.basic.accounts.vault.to_string()];
            if let Some(vault) = state.basic.accounts.test_vault {
                accounts.push(vault.to_string());
            }
            for epoch in &state.epochs {
                accounts.push(epoch.accounts.vault.to_string());
                accounts.push(epoch.accounts.test_vault.to_string());
            }
            accounts.sort();
            accounts.dedup();
            sender.send_if_modified(|current| {
                if *current == accounts {
                    false
                } else {
                    *current = accounts;
                    true
                }
            });
        }
        if let Some(path) = &self.preview_ledger_path {
            if let Ok(ledger) = crate::preview::Ledger::from_state(&state) {
                if ledger.persist(path).is_err() {
                    eprintln!("Preview ledger export deferred");
                }
            }
        }
        let mut work = chain_error(state.work(now_ms))?;
        if self.epoch_stage.is_none() && now_ms < self.epoch_retry_ms {
            work.retain(is_basic);
        }
        if let Some(stage) = self.epoch_stage.clone() {
            stage.validate(
                self.reader.epoch_program,
                self.reader.epoch_config,
                self.reader.operator,
                &self.anchor,
            )?;
            if self.now_ms < self.epoch_retry_ms && !self.epoch_stage_expired(&state, &stage) {
                work.retain(is_basic);
            } else {
                self.epoch_retry_ms = 0;
                self.epoch_stage_snapshot = self.read_epoch_stage_snapshot(&state, &stage).await?;
                let still_pending = stage.work.iter().any(|item| work.contains(item));
                if self.epoch_stage_snapshot.is_none()
                    && (!still_pending || self.epoch_stage_expired(&state, &stage))
                {
                    self.persist_epoch_stage(None)?;
                } else {
                    work.retain(is_basic);
                    work.push(Self::epoch_stage_work(&stage)?);
                }
            }
        }
        if let Some(control) = &self.inclusion {
            let inclusion_work =
                crate::inclusion_execution::observe(control, &self.reader.rpc, &state, now_ms)
                    .await?;
            crate::inclusion_execution::filter_work(control, now_ms, &mut work)?;
            work.extend(inclusion_work.into_iter().filter(|work|!matches!(work,Work::Maintenance{id,..} if id==crate::inclusion_execution::ROLLOUT_ID && self.epoch_stage.is_some())));
        }
        self.last_state = Some(state);
        Ok(work)
    }
    async fn prepare(
        &mut self,
        work: &[Work],
        observation: Option<&Observation>,
    ) -> Result<DraftTransaction, worker::Error> {
        if work.is_empty() {
            return Err(worker::Error::Chain);
        }
        let pool_work: Vec<_> = if self.mapping.len() > 30 || self.epoch_stage.is_some() {
            let basic = is_basic(&work[0]);
            work.iter()
                .filter(|item| is_basic(item) == basic)
                .cloned()
                .collect()
        } else {
            work.to_vec()
        };
        let work = pool_work.as_slice();
        let state = match self.last_state.take() {
            Some(state) => state,
            None => self.read_state().await?,
        };
        self.validate_anchor(&state)?;
        let authoritative = chain_error(state.work(self.now_ms))?;
        if work.iter().any(|item| {
            !authoritative.contains(item)
                && !(self.inclusion.is_some()
                    && crate::inclusion_execution::Controller::matches(item))
                && !self
                    .epoch_stage
                    .as_ref()
                    .is_some_and(|stage| Self::epoch_stage_work(stage).as_ref() == Ok(item))
        }) {
            return Err(worker::Error::Chain);
        }
        self.preserve_publication(&state).await?;
        let guard = critical_digest(&state);
        let has_epoch_work = work.iter().any(|work| !is_basic(work));
        let staged_epoch =
            has_epoch_work && (self.epoch_stage.is_some() || self.mapping.len() > 30);
        let rollout=work.iter().any(|work|matches!(work,Work::Maintenance{id,..} if id==crate::inclusion_execution::ROLLOUT_ID));
        let mut instructions = if rollout {
            let control = self.inclusion.as_ref().ok_or(worker::Error::Chain)?;
            let mut outcome = crate::inclusion_execution::plan(
                control,
                &self.reader.rpc,
                &state,
                self.reader.operator,
                self.now_ms,
                self.epoch_stage.is_some(),
            )
            .await?;
            if matches!(outcome, crate::inclusion_execution::Action::Waiting) {
                outcome = crate::inclusion_execution::plan(
                    control,
                    &self.reader.rpc,
                    &state,
                    self.reader.operator,
                    self.now_ms,
                    self.epoch_stage.is_some(),
                )
                .await?;
            }
            match outcome {
                crate::inclusion_execution::Action::Instructions(instructions) => instructions,
                crate::inclusion_execution::Action::Restart => {
                    return Err(worker::Error::UniverseTransition)
                }
                crate::inclusion_execution::Action::Waiting => {
                    return Err(worker::Error::StaleDraft)
                }
            }
        } else if staged_epoch {
            match self.prepare_epoch_stage(&state, work, observation).await {
                Ok(instructions) => {
                    self.epoch_retry_ms = 0;
                    instructions
                }
                Err(worker::Error::Snapshot) => {
                    self.epoch_retry_ms = self.now_ms.saturating_add(20 * 60 * 1000);
                    return Err(worker::Error::Snapshot);
                }
                Err(error) => return Err(error),
            }
        } else if let Some(observation) = observation {
            let mut instructions = self.publication_instructions(&state, work, observation)?;
            if work.iter().any(|item| !is_basic(item)) {
                self.existing_epoch_snapshots(
                    &mut instructions,
                    &state,
                    observation.timestamp_us / 1_000_000,
                    observation,
                )
                .await?;
            }
            instructions
        } else {
            if work
                .iter()
                .any(|item| !matches!(item, Work::Maintenance { .. }))
            {
                return Err(worker::Error::Chain);
            }
            if work.iter().any(is_basic)
                && state
                    .basic
                    .batch
                    .as_ref()
                    .is_some_and(|batch| batch.phase == 4)
            {
                self.resume_dynamic_prices(&state)?
            } else {
                chain_error(plan_maintenance_for(
                    &state,
                    self.reader.operator,
                    self.now_ms / 1000,
                    self.max_operations,
                    work,
                ))?
            }
        };
        if instructions.is_empty() {
            return Err(worker::Error::Chain);
        }
        let latest = chain_error(
            self.reader
                .rpc
                .call(
                    "getLatestBlockhash",
                    json!([{"commitment":"confirmed","minContextSlot":state.slot}]),
                )
                .await,
        )?;
        let blockhash = latest
            .pointer("/value/blockhash")
            .and_then(|v| v.as_str())
            .ok_or(worker::Error::Chain)?
            .to_owned();
        let height = latest
            .pointer("/value/lastValidBlockHeight")
            .and_then(|v| v.as_u64())
            .ok_or(worker::Error::Chain)?;
        let blockhash_value: Hash = blockhash.parse().map_err(|_| worker::Error::Chain)?;
        let transaction = loop {
            let transaction = match transactions::compile(
                self.reader.operator,
                blockhash_value.clone(),
                &instructions,
                &[self.reader.basic_program, self.reader.epoch_program],
                self.budget,
            ) {
                Ok(value) => value,
                Err(transactions::Error::TooLarge | transactions::Error::AccountLimit)
                    if instructions.len() > 1 =>
                {
                    if !trim_optional_tail(&mut instructions, self.reader.epoch_program) {
                        return Err(worker::Error::Chain);
                    }
                    continue;
                }
                Err(_) => return Err(worker::Error::Chain),
            };
            let result=chain_error(self.reader.rpc.call("simulateTransaction",json!([STANDARD.encode(&transaction.unsigned_transaction),{"encoding":"base64","commitment":"confirmed","sigVerify":false,"replaceRecentBlockhash":false,"minContextSlot":state.slot}])).await)?;
            let over_budget = result
                .pointer("/value/unitsConsumed")
                .and_then(|v| v.as_u64())
                .is_some_and(|units| units > u64::from(self.budget.compute_units))
                || result
                    .pointer("/value/err/InstructionError/1")
                    .and_then(|v| v.as_str())
                    == Some("ComputationalBudgetExceeded");
            if over_budget && instructions.len() > 1 {
                if !trim_optional_tail(&mut instructions, self.reader.epoch_program) {
                    return Err(worker::Error::Simulation);
                }
                continue;
            }
            if over_budget
                || !result
                    .pointer("/value/err")
                    .is_some_and(|value| value.is_null())
            {
                eprintln!("Publisher simulation rejected: {}", result.pointer("/value/err").unwrap_or(&serde_json::Value::Null));
                return Err(worker::Error::Simulation);
            }
            break transaction;
        };
        let clock = now()?;
        let mut expiry = clock.checked_add(20).ok_or(worker::Error::Clock)?;
        if let Some(observation) = observation {
            if work.iter().any(is_basic)
                && (!state.basic.pool.initialized && clock < state.basic.pool.trading_opens_at)
            {
                expiry = expiry.min(state.basic.pool.trading_opens_at);
            } else if work.iter().any(is_basic) && !staged_epoch {
                expiry = expiry.min(
                    (observation.timestamp_us / 1_000_000)
                        .checked_add(6)
                        .ok_or(worker::Error::Clock)?,
                );
            }
            for epoch in &state.epochs {
                if epoch_selected(work, epoch.epoch.opens_at)
                    && work.iter().any(|item| {
                        matches!(item, Work::Entry { .. })
                            && epoch_selected(std::slice::from_ref(item), epoch.epoch.opens_at)
                    })
                {
                    expiry = expiry.min(
                        epoch
                            .epoch
                            .state
                            .as_ref()
                            .ok_or(worker::Error::Chain)?
                            .closes_at(),
                    );
                }
            }
        }
        if staged_epoch {
            if let Some(stage) = self
                .epoch_stage
                .as_ref()
                .filter(|stage| !self.epoch_stage_expired(&state, stage))
            {
                let age = if stage.closing() {
                    cox_epoch::CLOSING_GRACE_SECONDS
                } else {
                    state.epoch_config.max_entry_price_age
                };
                expiry = expiry.min(
                    stage
                        .timestamp()
                        .checked_add(age)
                        .and_then(|end| end.checked_add(1))
                        .ok_or(worker::Error::Clock)?,
                );
            }
        }
        if expiry <= clock {
            return Err(worker::Error::Snapshot);
        }
        let hash = draft_hash(&transaction.unsigned_transaction, expiry, height);
        Ok(DraftTransaction {
            request_id: format!("rp:{}:{hash}", hex::encode(guard)),
            unsigned_bytes: transaction.unsigned_transaction,
            blockhash,
            last_valid_block_height: height,
            expires_at_seconds: expiry,
        })
    }
    async fn sign(
        &mut self,
        draft: &DraftTransaction,
    ) -> Result<PendingTransaction, worker::Error> {
        let fields = draft.request_id.split(':').collect::<Vec<_>>();
        if fields.len() != 3
            || fields[0] != "rp"
            || fields[2]
                != draft_hash(
                    &draft.unsigned_bytes,
                    draft.expires_at_seconds,
                    draft.last_valid_block_height,
                )
        {
            return Err(worker::Error::Signer);
        }
        if draft.expires_at_seconds <= now()? {
            return Err(worker::Error::StaleDraft);
        }
        let current = self.read_state().await?;
        self.validate_anchor(&current)?;
        if fields[1] != hex::encode(critical_digest(&current)) {
            return Err(worker::Error::StaleDraft);
        }
        self.preserve_publication(&current).await?;
        if draft.expires_at_seconds <= now()? {
            return Err(worker::Error::StaleDraft);
        }
        let pending = match self.signer.sign(draft).await {
            Err(worker::Error::Signer) if draft.expires_at_seconds <= now()? => {
                return Err(worker::Error::StaleDraft);
            }
            result => result?,
        };
        if !pending_valid(self.reader.operator, &pending)
            || pending
                .signed_bytes
                .get(..pending.signed_bytes.len().saturating_sub(64))
                != draft
                    .unsigned_bytes
                    .get(..draft.unsigned_bytes.len().saturating_sub(64))
            || pending.last_valid_block_height != draft.last_valid_block_height
        {
            return Err(worker::Error::Signer);
        }
        Ok(pending)
    }
    async fn broadcast(&mut self, pending: &PendingTransaction) -> Result<(), worker::Error> {
        if !pending_valid(self.reader.operator, pending) {
            return Err(worker::Error::Signer);
        }
        let result=chain_error(self.reader.rpc.call("sendTransaction",json!([STANDARD.encode(&pending.signed_bytes),{"encoding":"base64","skipPreflight":false,"preflightCommitment":"confirmed","maxRetries":0}])).await)?;
        if result.as_str() != Some(pending.signature.as_str()) {
            return Err(worker::Error::Chain);
        }
        Ok(())
    }
    async fn reconcile(
        &mut self,
        pending: &PendingTransaction,
    ) -> Result<TransactionStatus, worker::Error> {
        if !pending_valid(self.reader.operator, pending) {
            return Err(worker::Error::Signer);
        }
        let result = chain_error(
            self.reader
                .rpc
                .call(
                    "getSignatureStatuses",
                    json!([[pending.signature],{"searchTransactionHistory":true}]),
                )
                .await,
        )?;
        let status = result.pointer("/value/0").ok_or(worker::Error::Chain)?;
        if !status.is_null() {
            if status.get("err").is_some_and(|error| !error.is_null()) {
                return Ok(TransactionStatus::Expired);
            }
            if matches!(
                status.get("confirmationStatus").and_then(|v| v.as_str()),
                Some("confirmed" | "finalized")
            ) {
                return Ok(TransactionStatus::Accepted);
            }
            return Ok(TransactionStatus::Pending);
        }
        let height = chain_error(
            self.reader
                .rpc
                .call("getBlockHeight", json!([{"commitment":"finalized"}]))
                .await,
        )?
        .as_u64()
        .ok_or(worker::Error::Chain)?;
        if height <= pending.last_valid_block_height {
            self.broadcast(pending).await?;
            return Ok(TransactionStatus::Pending);
        }
        let again = chain_error(
            self.reader
                .rpc
                .call(
                    "getSignatureStatuses",
                    json!([[pending.signature],{"searchTransactionHistory":true}]),
                )
                .await,
        )?;
        let status = again.pointer("/value/0").ok_or(worker::Error::Chain)?;
        if status.is_null() {
            Ok(TransactionStatus::Expired)
        } else if status.get("err").is_some_and(|error| !error.is_null()) {
            Ok(TransactionStatus::Expired)
        } else if matches!(
            status.get("confirmationStatus").and_then(|v| v.as_str()),
            Some("confirmed" | "finalized")
        ) {
            Ok(TransactionStatus::Accepted)
        } else {
            Ok(TransactionStatus::Pending)
        }
    }
}

impl DraftSigner for crate::signing::RemoteSigner {
    async fn sign(&self, draft: &DraftTransaction) -> Result<PendingTransaction, worker::Error> {
        crate::signing::RemoteSigner::sign(self, draft).await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{benchmark::Asset, chain::tests::state, rpc::Rpc};
    use anchor_lang::Discriminator;
    use std::sync::Arc;
    struct NeverSigner;
    impl DraftSigner for NeverSigner {
        async fn sign(&self, _: &DraftTransaction) -> Result<PendingTransaction, worker::Error> {
            Err(worker::Error::Signer)
        }
    }
    #[test]
    fn price_ceiling_requires_recent_confirmed_clock_without_wall_time_extrapolation() {
        use crate::worker::Chain;
        let mut executor = executor();
        assert_eq!(executor.price_timestamp_ceiling_ms(14_411_000), Err(worker::Error::Chain));
        executor.last_state = Some(state());
        assert_eq!(executor.price_timestamp_ceiling_ms(14_411_000), Ok(14_410_000));
        assert_eq!(executor.price_timestamp_ceiling_ms(14_415_000), Ok(14_410_000));
        assert_eq!(executor.price_timestamp_ceiling_ms(14_415_001), Err(worker::Error::Clock));
        assert_eq!(executor.price_timestamp_ceiling_ms(14_409_999), Err(worker::Error::Clock));
        executor.last_state.as_mut().unwrap().confirmed_timestamp_ms = 0;
        assert_eq!(executor.price_timestamp_ceiling_ms(14_411_000), Err(worker::Error::Clock));
    }
    fn executor() -> Executor<NeverSigner> {
        let operator = solana_address::Address::new_from_array([7; 32]);
        let reader = ChainReader {
            rpc: Arc::new(Rpc::direct_devnet("test-key").unwrap()),
            operator,
            basic_program: solana_address::Address::new_from_array([1; 32]),
            basic_pool_id: 2,
            epoch_program: solana_address::Address::new_from_array([2; 32]),
            epoch_config: solana_address::Address::new_from_array([3; 32]),
        };
        let anchor = Anchor {
            universe_digest: [1; 32],
            timestamp_us: 14_400_000_000,
            benchmark: 100 * cox_math::SCALE,
            assets: vec![
                Asset {
                    id: "BTC".into(),
                    feed_id: 1,
                    origin_price_e8: 100,
                },
                Asset {
                    id: "ETH".into(),
                    feed_id: 2,
                    origin_price_e8: 200,
                },
            ],
        };
        Executor::new(
            reader,
            NeverSigner,
            anchor,
            vec![
                AssetMapping {
                    basic_id: 0,
                    epoch_id: 0,
                    epoch_feed_id: [1; 32],
                },
                AssetMapping {
                    basic_id: 1,
                    epoch_id: 1,
                    epoch_feed_id: [2; 32],
                },
            ],
            Budget {
                compute_units: 1_000_000,
                priority_fee_lamports: 0,
                heap_bytes: None,
            },
            4,
        )
        .unwrap()
    }
    fn bind_policy(methodology: &mut cox::Methodology, anchor: &Anchor) {
        let config = cox::AdaptiveManifestConfig {
            version: "relative-adaptive-v1".into(),
            roster: vec![0, 1],
            pyth_feed_ids: vec![1, 2],
            origin: anchor.timestamp_us / 1_000_000,
            origin_prices: vec![100, 200],
            universe_digest: anchor.universe_digest,
            feed_check_digest: [9; 32],
            max_price_age_ms: 5_000,
            max_feed_age_ms: 60_000,
        };
        methodology.schema_version = 2;
        methodology.canonical = cox::canonical_adaptive_manifest(
            &config,
            anchor_lang::prelude::Pubkey::new_from_array([7; 32]),
        )
        .unwrap();
        methodology.digest = cox_math::artifact_digest(&methodology.canonical);
        methodology.expected_length = methodology.canonical.len() as u32;
        methodology.sealed = true;
        methodology.origin = config.origin;
        methodology.roster = config.roster;
    }
    fn dynamic_executor(count: usize) -> Executor<NeverSigner> {
        let mut executor = executor();
        let universe = transactions::dynamic_test_universe(count);
        let view = crate::universe_runtime::view(&universe.canonical_bytes().unwrap()).unwrap();
        executor.anchor = view.anchor.clone();
        executor.mapping = view.mapping.clone();
        executor.dynamic = Some((view, executor.anchor.clone()));
        executor
    }
    #[test]
    fn dynamic_partial_price_restart_reuses_exact_accepted_timestamp_and_rejects_changed_prefix() {
        let executor = dynamic_executor(255);
        let mut state = crate::chain::tests::dynamic_stage(255, 4, 0);
        let observation = Observation {
            universe_digest: executor.anchor.universe_digest,
            timestamp_us: 14_410_000_000,
            benchmark: 101 * cox_math::SCALE,
            prices_e8: vec![101; 255],
            signed_payload: vec![1],
        };
        let publication = executor.dynamic_publication(&state, &observation).unwrap();
        let batch = state.basic.batch.as_mut().unwrap();
        batch.snapshot_digest = publication.snapshot_digest().unwrap();
        batch.prices = (0..32)
            .map(|_| cox::PriceWire {
                price_e8: 101,
                venue: 3,
                step: 0,
                candle_start: 14_410,
                trade_age_minutes: 0,
            })
            .collect();
        let instructions = executor
            .resume_dynamic_prices_from(&state, &observation)
            .unwrap();
        assert_eq!(instructions.len(), 15);
        assert_eq!(
            instructions[0],
            state
                .basic
                .accounts
                .append_dynamic_prices(executor.reader.operator, 32, 14_410, &[101; 16])
                .unwrap()
        );
        assert_eq!(
            instructions.last().unwrap(),
            &state.basic.accounts.seal_dynamic(executor.reader.operator)
        );
        let restarted = dynamic_executor(255);
        assert_eq!(
            restarted
                .resume_dynamic_prices_from(&state, &observation)
                .unwrap(),
            instructions
        );
        let mut wrong_time = observation.clone();
        wrong_time.timestamp_us += 1_000_000;
        assert!(matches!(
            executor.resume_dynamic_prices_from(&state, &wrong_time),
            Err(worker::Error::Snapshot)
        ));
        state.basic.batch.as_mut().unwrap().prices[0].price_e8 = 102;
        assert!(matches!(
            executor.resume_dynamic_prices_from(&state, &observation),
            Err(worker::Error::Snapshot)
        ));
    }
    #[test]
    fn dynamic_initial_publication_uses_staged_abi_and_defers_requests_for_large_universe() {
        let executor = dynamic_executor(255);
        let state = crate::chain::tests::dynamic_state(255);
        let observation = Observation {
            universe_digest: executor.anchor.universe_digest,
            timestamp_us: 14_410_000_000,
            benchmark: 101 * cox_math::SCALE,
            prices_e8: vec![101; 255],
            signed_payload: vec![1],
        };
        let work = vec![Work::Entry {
            id: "basic:request".into(),
            pool: Pool::Basic,
            eligible_after_ms: 0,
        }];
        let instructions = executor
            .publication_instructions(&state, &work, &observation)
            .unwrap();
        assert_eq!(instructions.len(), 18);
        assert_eq!(
            &instructions[0].data[..8],
            &Sha256::digest(b"global:begin_dynamic_publication")[..8]
        );
        assert_eq!(
            &instructions[17].data[..8],
            &Sha256::digest(b"global:seal_dynamic_publication")[..8]
        );
        let mut state = crate::chain::tests::dynamic_stage(255, 4, 0);
        let before = critical_digest(&state);
        state
            .basic
            .batch
            .as_mut()
            .unwrap()
            .prices
            .push(cox::PriceWire {
                price_e8: 101,
                venue: 3,
                step: 0,
                candle_start: 14_410,
                trade_age_minutes: 0,
            });
        assert_ne!(before, critical_digest(&state));
    }
    #[tokio::test]
    async fn staged_epoch_executes_only_original_pending_lot_and_preserves_exact_close_deadline() {
        let mut executor = dynamic_executor(31);
        let mut state = crate::chain::tests::dynamic_state(31);
        state.epoch_config.max_entry_price_age = 60;
        state.epochs.push(crate::chain::tests::epoch(true));
        let observation = Observation {
            universe_digest: executor.anchor.universe_digest,
            timestamp_us: 14_410_000_000,
            benchmark: 101 * cox_math::SCALE,
            prices_e8: vec![101; 31],
            signed_payload: vec![1],
        };
        let work = vec![Work::Entry {
            id: "epoch:14400:0".into(),
            pool: Pool::Epoch,
            eligible_after_ms: 14_401_000,
        }];
        let stage = crate::epoch_stage::Stage {
            schema: "relative.epoch-snapshot-stage/v1".into(),
            program: executor.reader.epoch_program.to_string(),
            config: executor.reader.epoch_config.to_string(),
            operator: executor.reader.operator.to_string(),
            anchor: executor.anchor.clone(),
            observation: observation.clone(),
            work: work.clone(),
        };
        let path = std::env::temp_dir().join(format!("epoch-executor-{}", std::process::id()));
        let archive = crate::runtime::SnapshotArchive::new(
            executor.anchor.clone(),
            crate::journal::FileHistory {
                directory: path.join("prices"),
            },
            5_000,
        )
        .unwrap();
        executor.snapshot_archive = Some(archive);
        executor.epoch_stage = Some(stage.clone());
        executor.now_ms = 14_411_000;
        let mut data = relative_epoch::SnapshotAccount::DISCRIMINATOR.to_vec();
        data.resize(20_000, 0);
        let mut snapshot =
            relative_epoch::SnapshotAccount::try_deserialize(&mut data.as_slice()).unwrap();
        snapshot.sealed = true;
        executor.epoch_stage_snapshot = Some((snapshot, 4_096));
        let instructions = executor
            .prepare_epoch_stage(
                &state,
                &[Executor::<NeverSigner>::epoch_stage_work(&stage).unwrap()],
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            instructions,
            vec![
                state.epochs[0]
                    .accounts
                    .execute(executor.reader.operator, 0, 14_410),
                state.epochs[0]
                    .accounts
                    .close_snapshot(executor.reader.operator, 14_410)
            ]
        );
        executor.now_ms = 14_471_000;
        assert!(executor.epoch_stage_expired(&state, &stage));
        let mut closing = stage.clone();
        closing.observation.timestamp_us = 28_800_000_000;
        closing.work = vec![Work::Close {
            id: "epoch:14400:close".into(),
            timestamp_ms: 28_800_000,
        }];
        executor.now_ms = (28_800 + cox_epoch::CLOSING_GRACE_SECONDS) * 1000;
        assert!(!executor.epoch_stage_expired(&state, &closing));
        executor.now_ms += 1_000;
        assert!(executor.epoch_stage_expired(&state, &closing));
        executor.epoch_stage = Some(closing);
        executor.now_ms = 28_801_000;
        executor.epoch_retry_ms = executor.now_ms + 1_200_000;
        assert_eq!(worker::Chain::next_wake_ms(&executor), Some(30_001_000));
        executor.epoch_stage = None;
        assert_eq!(worker::Chain::next_wake_ms(&executor), Some(30_001_000));

        let _ = std::fs::remove_dir_all(path);
    }
    #[test]
    fn adaptive_policy_pins_feeds_origin_prices_universe_and_freshness_before_signing() {
        let executor = executor();
        let mut state = state();
        bind_policy(&mut state.basic.methodology, &executor.anchor);
        let validate = |anchor: &Anchor, age, feed_age| {
            validate_methodology_policy(
                &state.basic.methodology,
                anchor,
                &executor.mapping,
                age,
                feed_age,
            )
        };
        validate(&executor.anchor, 5_000, 60_000).unwrap();
        for mutate in 0..5 {
            let mut anchor = executor.anchor.clone();
            match mutate {
                0 => anchor.assets[0].feed_id += 10,
                1 => anchor.assets[0].origin_price_e8 += 1,
                2 => anchor.universe_digest[0] ^= 1,
                3 => anchor.timestamp_us += 1_000_000,
                _ => anchor.benchmark += 1,
            }
            assert_eq!(
                validate(&anchor, 5_000, 60_000),
                Err(worker::Error::Snapshot)
            );
        }
        assert_eq!(
            validate(&executor.anchor, 4_000, 60_000),
            Err(worker::Error::Snapshot)
        );
        assert_eq!(
            validate(&executor.anchor, 5_000, 59_000),
            Err(worker::Error::Snapshot)
        );
        state.basic.methodology.canonical[20] ^= 1;
        assert_eq!(
            validate_methodology_policy(
                &state.basic.methodology,
                &executor.anchor,
                &executor.mapping,
                5_000,
                60_000
            ),
            Err(worker::Error::Snapshot)
        );
    }
    #[test]
    fn guard_accepts_arriving_orders_but_rejects_predecessor_fee_or_stage_changes() {
        let mut state = state();
        let original = critical_digest(&state);
        state.basic.pool.next_request_nonce += 1;
        state.basic.pool.pending += 100;
        assert_eq!(critical_digest(&state), original);
        state.basic.pool.fee_version += 1;
        assert_ne!(critical_digest(&state), original);
        state.basic.pool.fee_version -= 1;
        state.basic.pool.sequence += 1;
        assert_ne!(critical_digest(&state), original);
    }
    #[test]
    fn bootstrap_publication_uses_sequence_zero_and_binds_anchor_roster() {
        let executor = executor();
        let mut state = state();
        state.basic.pool.initialized = false;
        state.basic.pool.trading_opens_at = 14_400;
        state.basic.methodology.roster = vec![0, 1];
        state.epoch_config.origin_benchmark = 100 * cox_math::SCALE as u128;
        bind_policy(&mut state.basic.methodology, &executor.anchor);
        state.epoch_config.methodology = state.basic.methodology.digest;
        executor.validate_anchor(&state).unwrap();
        state.basic.pool.trading_opens_at = 7_200;
        executor.validate_anchor(&state).unwrap();
        state.basic.pool.trading_opens_at = 14_401;
        assert_eq!(
            executor.validate_anchor(&state),
            Err(worker::Error::Snapshot)
        );
        state.basic.pool.trading_opens_at = 14_400;
        state.epoch_config.methodology[0] ^= 1;
        assert_eq!(
            executor.validate_anchor(&state),
            Err(worker::Error::Snapshot)
        );
        state.epoch_config.methodology[0] ^= 1;
        let observation = Observation {
            universe_digest: [1; 32],
            timestamp_us: 14_400_000_000,
            benchmark: 1_000_000,
            prices_e8: vec![100, 200],
            signed_payload: vec![1],
        };
        let instructions = executor
            .publication_instructions(
                &state,
                &[Work::Entry {
                    id: "basic:bootstrap".into(),
                    pool: Pool::Basic,
                    eligible_after_ms: 14_399_999,
                }],
                &observation,
            )
            .unwrap();
        assert_eq!(
            u64::from_le_bytes(instructions[0].data[16..24].try_into().unwrap()),
            0
        );
        state.basic.methodology.roster.push(2);
        assert_eq!(
            executor.validate_anchor(&state),
            Err(worker::Error::Snapshot)
        );
    }
    #[test]
    fn v1_signed_bytes_use_trailing_signature_and_reject_message_mutation() {
        let secret = ed25519_dalek::SigningKey::from_bytes(&[8; 32]);
        let operator = solana_address::Address::new_from_array(secret.verifying_key().to_bytes());
        let instruction = Instruction {
            program_id: solana_address::Address::new_from_array([1; 32]),
            accounts: vec![],
            data: vec![1],
        };
        let transaction = transactions::compile(
            operator,
            Hash::new_from_array([2; 32]),
            &[instruction],
            &[solana_address::Address::new_from_array([1; 32])],
            Budget {
                compute_units: 100_000,
                priority_fee_lamports: 0,
                heap_bytes: None,
            },
        )
        .unwrap();
        use ed25519_dalek::Signer;
        let signature = secret.sign(&transaction.message).to_bytes();
        let bytes = transaction.with_signature(operator, signature).unwrap();
        let mut pending = PendingTransaction {
            signature: bs58::encode(signature).into_string(),
            signed_bytes: bytes,
            last_valid_block_height: 1,
        };
        assert!(pending_valid(operator, &pending));
        pending.signed_bytes[3] ^= 1;
        assert!(!pending_valid(operator, &pending));
    }
    #[test]
    fn transaction_identity_commits_expiry_and_valid_height() {
        assert_ne!(draft_hash(&[1, 2], 30, 100), draft_hash(&[1, 2], 31, 100));
        assert_ne!(draft_hash(&[1, 2], 30, 100), draft_hash(&[1, 2], 30, 101));
    }
    #[tokio::test]
    async fn expired_unsigned_draft_is_stale_before_any_rpc_or_signer_call() {
        let mut executor = executor();
        let guard = [8; 32];
        let unsigned_bytes = vec![1, 2, 3];
        let expiry = 1;
        let height = 100;
        let hash = draft_hash(&unsigned_bytes, expiry, height);
        let draft = DraftTransaction {
            request_id: format!("rp:{}:{hash}", hex::encode(guard)),
            unsigned_bytes,
            blockhash: "unused".into(),
            last_valid_block_height: height,
            expires_at_seconds: expiry,
        };
        assert_eq!(
            worker::Chain::sign(&mut executor, &draft).await,
            Err(worker::Error::StaleDraft)
        );
        assert_eq!(
            executor.reader.rpc.usage().unwrap().physical_http_requests,
            0
        );
    }
    #[test]
    fn size_trimming_keeps_snapshot_publication_and_rent_close_atomic() {
        let operator = solana_address::Address::new_from_array([7; 32]);
        let epoch = transactions::EpochAccounts::derive(
            solana_address::Address::new_from_array([2; 32]),
            solana_address::Address::new_from_array([3; 32]),
            14_400,
        )
        .unwrap();
        let publish = epoch
            .publish_snapshot(
                operator,
                1,
                14_401,
                1_000,
                &[EpochPrice {
                    asset_id: 0,
                    feed_id: [1; 32],
                    value: 1_000,
                }],
            )
            .unwrap();
        let close = epoch.close_snapshot(operator, 1);
        let mut instructions = vec![
            publish.clone(),
            epoch.execute(operator, 0, 1),
            epoch.execute(operator, 1, 1),
            close.clone(),
        ];
        assert!(trim_optional_tail(&mut instructions, epoch.program));
        assert_eq!(
            instructions,
            vec![
                publish.clone(),
                epoch.execute(operator, 0, 1),
                close.clone()
            ]
        );
        assert!(trim_optional_tail(&mut instructions, epoch.program));
        assert_eq!(instructions, vec![publish, close]);
        assert!(!trim_optional_tail(&mut instructions, epoch.program));
        assert!(instructions.is_empty());
        let basic = Instruction {
            program_id: solana_address::Address::new_from_array([1; 32]),
            accounts: vec![],
            data: vec![1],
        };
        let mut instructions = vec![basic.clone(), epoch.close_snapshot(operator, 1)];
        assert!(trim_optional_tail(&mut instructions, epoch.program));
        assert_eq!(instructions, vec![basic]);
    }
}
