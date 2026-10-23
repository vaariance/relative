use crate::{
    benchmark::Observation,
    scheduler::{
        decide, Checkpoint, Decision, DraftTransaction, PendingTransaction, Work, CADENCE_MS,
    },
};
use std::path::PathBuf;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Chain,
    Snapshot,
    Storage,
    Signer,
    Clock,
    Simulation,
    StaleDraft,
    UniverseTransition,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransactionStatus {
    Pending,
    Accepted,
    Expired,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tick {
    Idle(Option<u64>),
    Waiting(u64),
    Submitted(u64),
    Reconciling(u64),
}
#[allow(async_fn_in_trait)]
pub trait Chain {
    fn price_timestamp_ceiling_ms(&self, wall_ms: u64) -> Result<u64, Error> {
        Ok(wall_ms)
    }
    fn next_wake_ms(&self) -> Option<u64> {
        None
    }
    fn needs_reconciliation(&self) -> bool {
        false
    }
    async fn authoritative_work(&mut self, now_ms: u64) -> Result<Vec<Work>, Error>;
    async fn prepare(
        &mut self,
        work: &[Work],
        observation: Option<&Observation>,
    ) -> Result<DraftTransaction, Error>;
    async fn sign(&mut self, draft: &DraftTransaction) -> Result<PendingTransaction, Error>;
    async fn broadcast(&mut self, pending: &PendingTransaction) -> Result<(), Error>;
    async fn reconcile(&mut self, pending: &PendingTransaction)
        -> Result<TransactionStatus, Error>;
}
pub trait Snapshots {
    fn selection_time_ms(&self, fallback: u64) -> Result<u64, Error> {
        Ok(fallback)
    }
    fn select(
        &self,
        work: &[Work],
        closing_ms: Option<u64>,
        now_ms: u64,
    ) -> Result<Option<Observation>, Error>;
}
pub trait Store {
    fn load(&self) -> Result<Checkpoint, Error>;
    fn save(&mut self, checkpoint: &Checkpoint) -> Result<(), Error>;
}
pub struct FileCheckpoint {
    pub path: PathBuf,
    pub identity: [u8; 32],
}
#[derive(serde::Serialize, serde::Deserialize)]
struct StoredCheckpoint {
    identity: [u8; 32],
    checkpoint: Checkpoint,
}
impl Store for FileCheckpoint {
    fn load(&self) -> Result<Checkpoint, Error> {
        let stored: Option<StoredCheckpoint> =
            crate::journal::read(&self.path).map_err(|_| Error::Storage)?;
        match stored {
            None => Ok(Checkpoint::default()),
            Some(value) if value.identity == self.identity => Ok(value.checkpoint),
            _ => Err(Error::Storage),
        }
    }
    fn save(&mut self, value: &Checkpoint) -> Result<(), Error> {
        crate::journal::atomic_write(
            &self.path,
            &StoredCheckpoint {
                identity: self.identity,
                checkpoint: value.clone(),
            },
        )
        .map_err(|_| Error::Storage)
    }
}

pub struct Publisher<C, P, S> {
    chain: C,
    prices: P,
    store: S,
    checkpoint: Option<Checkpoint>,
    batch_limit: usize,
    max_price_age_ms: u64,
}
impl<C: Chain, P: Snapshots, S: Store> Publisher<C, P, S> {
    pub fn new(
        chain: C,
        prices: P,
        store: S,
        batch_limit: usize,
        max_price_age_ms: u64,
    ) -> Result<Self, Error> {
        if batch_limit == 0 {
            return Err(Error::Chain);
        }
        Ok(Self {
            chain,
            prices,
            store,
            checkpoint: None,
            batch_limit,
            max_price_age_ms,
        })
    }
    fn persist(&mut self, state: Checkpoint) -> Result<(), Error> {
        self.store.save(&state)?;
        self.checkpoint = Some(state);
        Ok(())
    }
    pub async fn tick(&mut self, now_ms: u64) -> Result<Tick, Error> {
        if self.checkpoint.is_none() {
            self.checkpoint = Some(self.store.load()?);
        }
        let next_ms = now_ms.checked_add(CADENCE_MS).ok_or(Error::Clock)?;
        let mut state = self.checkpoint.clone().ok_or(Error::Storage)?;
        if let Some(pending) = &state.pending {
            match self.chain.reconcile(pending).await? {
                TransactionStatus::Pending => return Ok(Tick::Reconciling(next_ms)),
                TransactionStatus::Accepted | TransactionStatus::Expired => {
                    state.pending = None;
                    self.persist(state.clone())?;
                }
            }
        }
        if state
            .unsigned
            .as_ref()
            .is_some_and(|draft| draft.expires_at_seconds <= now_ms / 1000)
        {
            state.unsigned = None;
            self.persist(state.clone())?;
        }
        if state.unsigned.is_some() {
            return self.sign_and_send(state, next_ms).await;
        }
        let work = self.chain.authoritative_work(now_ms).await?;
        match decide(now_ms, &state, &work, self.batch_limit).map_err(|_| Error::Chain)? {
            Decision::Idle { wake_ms } => {
                let wake_ms = wake_ms.into_iter().chain(self.chain.next_wake_ms()).min();
                Ok(Tick::Idle(if self.chain.needs_reconciliation() {
                    Some(wake_ms.map_or(next_ms, |wake| wake.min(next_ms)))
                } else {
                    wake_ms
                }))
            },
            Decision::Wait { wake_ms } => Ok(Tick::Waiting(wake_ms)),
            Decision::Reconcile => Err(Error::Storage),
            Decision::Maintenance { work, next_pool } => {
                state.next_attempt_ms = next_ms;
                self.persist(state.clone())?;
                let draft = self.chain.prepare(&work, None).await?;
                state.next_pool = next_pool;
                state.maintenance_next = false;
                state.unsigned = Some(draft);
                self.persist(state.clone())?;
                self.sign_and_send(state, next_ms).await
            }
            Decision::Publish {
                work,
                closing_ms,
                next_pool,
                closing_next,
            } => {
                state.next_attempt_ms = next_ms;
                self.persist(state.clone())?;
                let selection_ms = self.prices.selection_time_ms(now_ms)?;
                let ceiling_ms = self.chain.price_timestamp_ceiling_ms(selection_ms)?;
                if closing_ms.is_some_and(|close| close > ceiling_ms) {
                    return Ok(Tick::Waiting(next_ms));
                }
                let Some(snapshot) = self.prices.select(&work, closing_ms, ceiling_ms)? else {
                    return Ok(Tick::Waiting(next_ms));
                };
                if snapshot.timestamp_us % 1000 != 0 {
                    return Err(Error::Snapshot);
                }
                let timestamp = snapshot.timestamp_us / 1000;
                if snapshot.benchmark <= 0 || snapshot.signed_payload.is_empty() || timestamp > selection_ms || timestamp > ceiling_ms
                    || closing_ms.is_some_and(|close| timestamp != close)
                    || (closing_ms.is_none() && (selection_ms - timestamp > self.max_price_age_ms || work.iter().any(|item| matches!(item, Work::Entry { eligible_after_ms, .. } if timestamp <= *eligible_after_ms)))) { return Err(Error::Snapshot); }
                let draft = self.chain.prepare(&work, Some(&snapshot)).await?;
                if draft.request_id.is_empty()
                    || draft.unsigned_bytes.is_empty()
                    || draft.unsigned_bytes.len() > 4096
                    || draft.expires_at_seconds <= now_ms / 1000
                {
                    return Err(Error::Chain);
                }
                state.next_pool = next_pool;
                state.closing_next = closing_next;
                state.maintenance_next = true;
                state.unsigned = Some(draft);
                self.persist(state.clone())?;
                self.sign_and_send(state, next_ms).await
            }
        }
    }
    async fn sign_and_send(&mut self, mut state: Checkpoint, next_ms: u64) -> Result<Tick, Error> {
        let draft = state.unsigned.as_ref().ok_or(Error::Storage)?;
        let pending = match self.chain.sign(draft).await {
            Ok(value) => value,
            Err(Error::StaleDraft) => {
                state.unsigned = None;
                self.persist(state)?;
                return Ok(Tick::Waiting(next_ms));
            }
            Err(error) => return Err(error),
        };
        if pending.signature.is_empty()
            || pending.signed_bytes.len() > 4096
            || pending.last_valid_block_height != draft.last_valid_block_height
        {
            return Err(Error::Signer);
        }
        state.pending = Some(pending.clone());
        state.unsigned = None;
        self.persist(state)?;
        self.chain.broadcast(&pending).await?;
        Ok(Tick::Submitted(next_ms))
    }
}
