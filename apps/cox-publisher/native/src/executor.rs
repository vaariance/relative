use crate::{
    benchmark::{Anchor, Observation},
    chain::{plan_maintenance_for, ChainReader, ChainState},
    scheduler::{DraftTransaction, PendingTransaction, Pool, Work},
    transactions::{self, BasicPublication, Budget, EpochPrice},
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AssetMapping {
    pub basic_id: u8,
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
    discovery: crate::chain::Discovery,
    max_price_age_ms: u64,
    max_feed_age_ms: u64,
}
fn validate_methodology_policy(
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
            .position(|mapping| mapping.basic_id == *id)
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
                .any(|m| m.basic_id >= 30 || m.epoch_id >= 256 || m.epoch_feed_id == [0; 32])
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
            max_price_age_ms: 5_000,
            max_feed_age_ms: 60_000,
        })
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
            || state.basic.pool.trading_opens_at != self.discovery.first_epoch()
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
            .any(|asset| !self.mapping.iter().any(|m| m.basic_id == *asset))
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
                        .position(|m| m.basic_id == *asset)
                        .map(|i| self.anchor.assets[i].origin_price_e8)
                        .ok_or(worker::Error::Snapshot)
                })
                .collect::<Result<Vec<_>, _>>()?;
            if state.basic.pool.origin_prices != expected {
                return Err(worker::Error::Snapshot);
            }
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
                if asset.origin_price != u128::from(self.anchor.assets[index].origin_price_e8) {
                    return Err(worker::Error::Snapshot);
                }
            }
        }
        Ok(())
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
            let prices = state
                .basic
                .methodology
                .roster
                .iter()
                .map(|asset| {
                    self.mapping
                        .iter()
                        .position(|m| m.basic_id == *asset)
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
            for request in state.basic.requests.iter().take(self.max_operations) {
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
    fn needs_reconciliation(&self) -> bool {
        self.discovery.incomplete
    }
    async fn authoritative_work(&mut self, now_ms: u64) -> Result<Vec<Work>, worker::Error> {
        self.now_ms = now_ms;
        let state = self.read_state().await?;
        self.validate_anchor(&state)?;
        let work = chain_error(state.work(now_ms))?;
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
        let state = match self.last_state.take() {
            Some(state) => state,
            None => self.read_state().await?,
        };
        self.validate_anchor(&state)?;
        let authoritative = chain_error(state.work(self.now_ms))?;
        if work.iter().any(|item| !authoritative.contains(item)) {
            return Err(worker::Error::Chain);
        }
        self.preserve_publication(&state).await?;
        let guard = critical_digest(&state);
        let mut instructions = if let Some(observation) = observation {
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
            chain_error(plan_maintenance_for(
                &state,
                self.reader.operator,
                self.now_ms / 1000,
                self.max_operations,
                work,
            ))?
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
                return Err(worker::Error::Simulation);
            }
            break transaction;
        };
        let current = self.read_state().await?;
        if critical_digest(&current) != guard {
            return Err(worker::Error::StaleDraft);
        }
        let clock = now()?;
        let mut expiry = clock.checked_add(20).ok_or(worker::Error::Clock)?;
        if let Some(observation) = observation {
            if work.iter().any(is_basic)
                && (!state.basic.pool.initialized && clock < state.basic.pool.trading_opens_at)
            {
                expiry = expiry.min(state.basic.pool.trading_opens_at);
            } else if work.iter().any(is_basic) {
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
            || draft.expires_at_seconds <= now()?
        {
            return Err(worker::Error::Signer);
        }
        let current = self.read_state().await?;
        self.validate_anchor(&current)?;
        if fields[1] != hex::encode(critical_digest(&current)) {
            return Err(worker::Error::StaleDraft);
        }
        self.preserve_publication(&current).await?;
        let pending = self.signer.sign(draft).await?;
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
        let current = self.read_state().await?;
        self.validate_anchor(&current)?;
        self.preserve_publication(&current).await?;
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
    use std::sync::Arc;
    struct NeverSigner;
    impl DraftSigner for NeverSigner {
        async fn sign(&self, _: &DraftTransaction) -> Result<PendingTransaction, worker::Error> {
            Err(worker::Error::Signer)
        }
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
        state.epoch_config.methodology[0] ^= 1;
        assert_eq!(executor.validate_anchor(&state), Err(worker::Error::Snapshot));
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
