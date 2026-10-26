use relative_publisher::{
    benchmark::Observation,
    scheduler::{Checkpoint, DraftTransaction, PendingTransaction, Pool, Work},
    worker::{Chain, Error, Publisher, Snapshots, Store, Tick, TransactionStatus},
};
use std::sync::{Arc, Mutex};
#[derive(Default)]
struct State {
    saved: Checkpoint,
    trace: Vec<&'static str>,
    fail_sign: bool,
    signer_unavailable: bool,
    fail_save: bool,
    work: bool,
    stale_sign: bool,
    maintenance: bool,
    ceiling: Option<u64>,
    close: Option<u64>,
    closing_work: Vec<Work>,
    closing_attempts: Vec<u64>,
}
struct Disk(Arc<Mutex<State>>);
impl Store for Disk {
    fn load(&self) -> Result<Checkpoint, Error> {
        Ok(self.0.lock().unwrap().saved.clone())
    }
    fn save(&mut self, state: &Checkpoint) -> Result<(), Error> {
        let mut s = self.0.lock().unwrap();
        if s.fail_save {
            return Err(Error::Storage);
        }
        s.trace.push(if state.pending.is_some() {
            "save-signed"
        } else if state.unsigned.is_some() {
            "save-unsigned"
        } else {
            "save"
        });
        s.saved = state.clone();
        Ok(())
    }
}
struct Accounts(Arc<Mutex<State>>);
impl Chain for Accounts {
    fn price_timestamp_ceiling_ms(&self, wall_ms: u64) -> Result<u64, Error> {
        Ok(self.0.lock().unwrap().ceiling.unwrap_or(wall_ms))
    }
    async fn authoritative_work(&mut self, _: u64) -> Result<Vec<Work>, Error> {
        let mut s = self.0.lock().unwrap();
        s.trace.push("read");
        Ok(if !s.closing_work.is_empty() {
            s.closing_work.clone()
        } else if let Some(timestamp_ms) = s.close {
            vec![Work::Close {
                id: "epoch:close".into(),
                timestamp_ms,
            }]
        } else if s.maintenance {
            vec![Work::Maintenance {
                id: "refund".into(),
                pool: Pool::Epoch,
            }]
        } else if s.work {
            vec![Work::Entry {
                id: "order".into(),
                pool: Pool::Basic,
                eligible_after_ms: 9000,
            }]
        } else {
            vec![]
        })
    }
    async fn prepare(
        &mut self,
        _: &[Work],
        _: Option<&Observation>,
    ) -> Result<DraftTransaction, Error> {
        self.0.lock().unwrap().trace.push("prepare");
        Ok(DraftTransaction {
            request_id: "stable-request".into(),
            unsigned_bytes: vec![1, 2],
            blockhash: "hash".into(),
            last_valid_block_height: 100,
            expires_at_seconds: 100,
        })
    }
    async fn sign(&mut self, draft: &DraftTransaction) -> Result<PendingTransaction, Error> {
        let mut s = self.0.lock().unwrap();
        assert_eq!(s.saved.unsigned.as_ref().unwrap(), draft);
        s.trace.push("sign");
        if s.stale_sign {
            return Err(Error::StaleDraft);
        }
        if s.fail_sign {
            return Err(Error::Signer);
        }
        if s.signer_unavailable {
            return Err(Error::SignerUnavailable);
        }
        Ok(PendingTransaction {
            signature: "sig".into(),
            signed_bytes: vec![1, 2, 3],
            last_valid_block_height: 100,
        })
    }
    async fn broadcast(&mut self, pending: &PendingTransaction) -> Result<(), Error> {
        let mut s = self.0.lock().unwrap();
        assert_eq!(s.saved.pending.as_ref().unwrap(), pending);
        s.trace.push("broadcast");
        Ok(())
    }
    async fn reconcile(&mut self, _: &PendingTransaction) -> Result<TransactionStatus, Error> {
        self.0.lock().unwrap().trace.push("reconcile");
        Ok(TransactionStatus::Pending)
    }
}
struct Prices;
impl Snapshots for Prices {
    fn select(&self, _: &[Work], _: Option<u64>, _: u64) -> Result<Option<Observation>, Error> {
        Ok(Some(Observation {
            universe_digest: [1; 32],
            timestamp_us: 10_000_000,
            benchmark: 100,
            prices_e8: vec![100, 100],
            signed_payload: vec![1],
        }))
    }
}
fn create(state: Arc<Mutex<State>>) -> Publisher<Accounts, Prices, Disk> {
    Publisher::new(Accounts(state.clone()), Prices, Disk(state), 2, 2000).unwrap()
}
#[tokio::test]
async fn transient_signer_failure_keeps_unsigned_idempotency_and_recovers_without_restart() {
    let state = Arc::new(Mutex::new(State { work: true, signer_unavailable: true, ..State::default() }));
    let mut publisher = create(state.clone());
    assert_eq!(publisher.tick(10_000).await, Err(Error::SignerUnavailable));
    let original = state.lock().unwrap().saved.unsigned.clone().unwrap();
    state.lock().unwrap().signer_unavailable = false;
    assert_eq!(publisher.tick(11_000).await, Ok(Tick::Submitted(12_000)));
    let saved = state.lock().unwrap();
    assert_eq!(saved.trace.iter().filter(|step| **step == "prepare").count(), 1);
    assert_eq!(original.request_id, "stable-request");
    assert!(saved.saved.unsigned.is_none());
    assert!(saved.saved.pending.is_some());
}
#[tokio::test]
async fn restart_after_ambiguous_signing_reuses_persisted_unsigned_request_before_broadcast() {
    let state = Arc::new(Mutex::new(State {
        work: true,
        fail_sign: true,
        ..State::default()
    }));
    assert_eq!(create(state.clone()).tick(10_000).await, Err(Error::Signer));
    assert!(state.lock().unwrap().saved.unsigned.is_some());
    state.lock().unwrap().fail_sign = false;
    assert_eq!(
        create(state.clone()).tick(10_100).await,
        Ok(Tick::Submitted(11_100))
    );
    assert_eq!(
        state.lock().unwrap().trace,
        vec![
            "read",
            "save",
            "prepare",
            "save-unsigned",
            "sign",
            "sign",
            "save-signed",
            "broadcast"
        ]
    );
    assert_eq!(
        create(state.clone()).tick(11_100).await,
        Ok(Tick::Reconciling(12_100))
    );
    assert_eq!(
        state
            .lock()
            .unwrap()
            .trace
            .iter()
            .filter(|step| **step == "prepare")
            .count(),
        1
    );
}
#[tokio::test]
async fn journal_failure_prevents_signing_and_broadcast() {
    let state = Arc::new(Mutex::new(State {
        work: true,
        fail_save: true,
        ..State::default()
    }));
    assert_eq!(
        create(state.clone()).tick(10_000).await,
        Err(Error::Storage)
    );
    assert_eq!(state.lock().unwrap().trace, vec!["read"]);
}
#[tokio::test]
async fn no_orders_means_no_prices_signing_or_broadcast() {
    let state = Arc::new(Mutex::new(State::default()));
    assert_eq!(
        create(state.clone()).tick(10_000).await,
        Ok(Tick::Idle(None))
    );
    assert_eq!(state.lock().unwrap().trace, vec!["read"]);
}

struct MissingPrices;
impl Snapshots for MissingPrices {
    fn select(&self, _: &[Work], _: Option<u64>, _: u64) -> Result<Option<Observation>, Error> {
        panic!("maintenance must not require price data")
    }
}
#[tokio::test]
async fn refunds_continue_without_a_fresh_price() {
    let state = Arc::new(Mutex::new(State {
        maintenance: true,
        ..State::default()
    }));
    let mut publisher = Publisher::new(
        Accounts(state.clone()),
        MissingPrices,
        Disk(state.clone()),
        2,
        2000,
    )
    .unwrap();
    assert_eq!(publisher.tick(10_000).await, Ok(Tick::Submitted(11_000)));
    assert!(state.lock().unwrap().saved.pending.is_some());
}
#[tokio::test]
async fn stale_unsigned_draft_is_cleared_without_broadcast_or_losing_signed_uncertainty() {
    let state = Arc::new(Mutex::new(State {
        work: true,
        stale_sign: true,
        ..State::default()
    }));
    let mut publisher = create(state.clone());
    assert_eq!(publisher.tick(10_000).await, Ok(Tick::Waiting(11_000)));
    assert!(state.lock().unwrap().saved.unsigned.is_none());
    assert!(!state.lock().unwrap().trace.contains(&"broadcast"));
    state.lock().unwrap().stale_sign = false;
    assert_eq!(publisher.tick(11_000).await, Ok(Tick::Submitted(12_000)));
    state.lock().unwrap().stale_sign = true;
    assert_eq!(
        create(state.clone()).tick(12_000).await,
        Ok(Tick::Reconciling(13_000))
    );
    assert!(state.lock().unwrap().saved.pending.is_some());
    assert_eq!(
        state
            .lock()
            .unwrap()
            .trace
            .iter()
            .filter(|step| **step == "prepare")
            .count(),
        2
    );
}
#[tokio::test]
async fn price_selection_uses_clock_after_authoritative_reads() {
    struct FreshPrices;
    impl Snapshots for FreshPrices {
        fn selection_time_ms(&self, fallback: u64) -> Result<u64, Error> {
            assert_eq!(fallback, 10_000);
            Ok(13_000)
        }
        fn select(
            &self,
            _: &[Work],
            closing: Option<u64>,
            now: u64,
        ) -> Result<Option<Observation>, Error> {
            assert_eq!(now, 13_000);
            assert_eq!(closing, None);
            Ok(Some(Observation {
                universe_digest: [1; 32],
                timestamp_us: 13_000_000,
                benchmark: 100,
                prices_e8: vec![100],
                signed_payload: vec![1],
            }))
        }
    }
    let state = Arc::new(Mutex::new(State {
        work: true,
        ..State::default()
    }));
    let mut publisher = Publisher::new(
        Accounts(state.clone()),
        FreshPrices,
        Disk(state.clone()),
        2,
        2_000,
    )
    .unwrap();
    assert_eq!(publisher.tick(10_000).await, Ok(Tick::Submitted(11_000)));
    assert!(state.lock().unwrap().saved.pending.is_some());
}

struct ConfirmedPrices;
impl Snapshots for ConfirmedPrices {
    fn select(
        &self,
        _: &[Work],
        close: Option<u64>,
        ceiling: u64,
    ) -> Result<Option<Observation>, Error> {
        assert!(close.is_none_or(|close| close == ceiling));
        Ok(Some(Observation {
            universe_digest: [1; 32],
            timestamp_us: ceiling * 1000,
            benchmark: 100,
            prices_e8: vec![100],
            signed_payload: vec![1],
        }))
    }
}
#[tokio::test]
async fn current_second_prices_are_capped_at_confirmed_clock() {
    let state = Arc::new(Mutex::new(State {
        work: true,
        ceiling: Some(10_000),
        ..State::default()
    }));
    let mut publisher = Publisher::new(
        Accounts(state.clone()),
        ConfirmedPrices,
        Disk(state.clone()),
        2,
        2000,
    )
    .unwrap();
    assert_eq!(publisher.tick(11_000).await, Ok(Tick::Submitted(12_000)));
}
#[tokio::test]
async fn confirmed_price_ceiling_does_not_relax_wall_clock_freshness() {
    let state = Arc::new(Mutex::new(State {
        work: true,
        ceiling: Some(10_000),
        ..State::default()
    }));
    let mut publisher = Publisher::new(
        Accounts(state.clone()),
        ConfirmedPrices,
        Disk(state.clone()),
        2,
        2000,
    )
    .unwrap();
    assert_eq!(publisher.tick(13_000).await, Err(Error::Snapshot));
    assert!(!state.lock().unwrap().trace.contains(&"prepare"));
}
#[tokio::test]
async fn exact_epoch_close_waits_for_confirmed_clock_without_substitution() {
    let state = Arc::new(Mutex::new(State {
        close: Some(11_000),
        ceiling: Some(10_000),
        ..State::default()
    }));
    let mut publisher = Publisher::new(
        Accounts(state.clone()),
        ConfirmedPrices,
        Disk(state.clone()),
        2,
        2000,
    )
    .unwrap();
    assert_eq!(publisher.tick(11_000).await, Ok(Tick::Waiting(12_000)));
    assert!(!state.lock().unwrap().trace.contains(&"prepare"));
    state.lock().unwrap().ceiling = Some(11_000);
    assert_eq!(publisher.tick(12_000).await, Ok(Tick::Submitted(13_000)));
}
#[tokio::test]
async fn snapshot_provider_cannot_ignore_confirmed_clock_ceiling() {
    let state = Arc::new(Mutex::new(State {
        work: true,
        ceiling: Some(9_000),
        ..State::default()
    }));
    assert_eq!(
        create(state.clone()).tick(10_000).await,
        Err(Error::Snapshot)
    );
    assert!(!state.lock().unwrap().trace.contains(&"prepare"));
}

#[derive(Default)]
struct FairState {
    saved: Checkpoint,
    maintenance: Vec<Work>,
    entries: Vec<Work>,
    prepared: Vec<Work>,
    pending_work: Option<Work>,
    missing_closes: usize,
}
struct FairDisk(Arc<Mutex<FairState>>);
impl Store for FairDisk {
    fn load(&self) -> Result<Checkpoint, Error> {
        Ok(self.0.lock().unwrap().saved.clone())
    }
    fn save(&mut self, checkpoint: &Checkpoint) -> Result<(), Error> {
        self.0.lock().unwrap().saved = checkpoint.clone();
        Ok(())
    }
}
struct FairChain(Arc<Mutex<FairState>>);
impl Chain for FairChain {
    async fn authoritative_work(&mut self, _: u64) -> Result<Vec<Work>, Error> {
        let state = self.0.lock().unwrap();
        let mut work = vec![Work::Close {
            id: "predecessor".into(),
            timestamp_ms: 9_000,
        }];
        work.extend(state.maintenance.first().cloned());
        work.extend(state.entries.iter().cloned());
        Ok(work)
    }
    async fn prepare(
        &mut self,
        work: &[Work],
        observation: Option<&Observation>,
    ) -> Result<DraftTransaction, Error> {
        assert_eq!(work.len(), 1);
        assert_eq!(
            observation.is_none(),
            matches!(work[0], Work::Maintenance { .. })
        );
        let mut state = self.0.lock().unwrap();
        state.prepared.push(work[0].clone());
        state.pending_work = Some(work[0].clone());
        Ok(DraftTransaction {
            request_id: format!("work-{}", state.prepared.len()),
            unsigned_bytes: vec![1],
            blockhash: "hash".into(),
            last_valid_block_height: 100,
            expires_at_seconds: 100,
        })
    }
    async fn sign(&mut self, draft: &DraftTransaction) -> Result<PendingTransaction, Error> {
        Ok(PendingTransaction {
            signature: draft.request_id.clone(),
            signed_bytes: vec![1],
            last_valid_block_height: draft.last_valid_block_height,
        })
    }
    async fn broadcast(&mut self, _: &PendingTransaction) -> Result<(), Error> {
        Ok(())
    }
    async fn reconcile(&mut self, _: &PendingTransaction) -> Result<TransactionStatus, Error> {
        let mut state = self.0.lock().unwrap();
        let work = state.pending_work.take().unwrap();
        match work {
            Work::Maintenance { .. } => {
                assert_eq!(state.maintenance.remove(0), work);
            }
            Work::Entry { .. } => state.entries.retain(|item| *item != work),
            Work::Close { .. } => panic!("missing exact close must never prepare"),
        }
        Ok(TransactionStatus::Accepted)
    }
}
struct FairPrices(Arc<Mutex<FairState>>);
impl Snapshots for FairPrices {
    fn select(
        &self,
        _: &[Work],
        closing_ms: Option<u64>,
        now_ms: u64,
    ) -> Result<Option<Observation>, Error> {
        if let Some(close) = closing_ms {
            assert_eq!(close, 9_000);
            self.0.lock().unwrap().missing_closes += 1;
            return Ok(None);
        }
        Ok(Some(Observation {
            universe_digest: [1; 32],
            timestamp_us: now_ms * 1_000,
            benchmark: 100,
            prices_e8: vec![100],
            signed_payload: vec![1],
        }))
    }
}
fn fair_state(entries: bool) -> Arc<Mutex<FairState>> {
    Arc::new(Mutex::new(FairState {
        maintenance: ["init", "grow", "copy", "seal"]
            .into_iter()
            .map(|id| Work::Maintenance {
                id: id.into(),
                pool: Pool::Epoch,
            })
            .collect(),
        entries: if entries {
            [Pool::Basic, Pool::Epoch]
                .into_iter()
                .map(|pool| Work::Entry {
                    id: format!("{pool:?}:entry"),
                    pool,
                    eligible_after_ms: 9_000,
                })
                .collect()
        } else {
            vec![]
        },
        ..FairState::default()
    }))
}
async fn run_fair_ticks(state: &Arc<Mutex<FairState>>) {
    for now_ms in (10_000..40_000).step_by(1_000) {
        let mut publisher = Publisher::new(
            FairChain(state.clone()),
            FairPrices(state.clone()),
            FairDisk(state.clone()),
            1,
            2_000,
        )
        .unwrap();
        publisher.tick(now_ms).await.unwrap();
    }
}
#[tokio::test]
async fn missing_exact_close_does_not_starve_resumable_successor_maintenance_after_restart() {
    let state = fair_state(false);
    run_fair_ticks(&state).await;
    let state = state.lock().unwrap();
    assert!(state.maintenance.is_empty());
    assert_eq!(state.prepared.len(), 4);
    assert!(state.missing_closes >= 4);
    assert!(state
        .prepared
        .iter()
        .all(|work| matches!(work, Work::Maintenance { .. })));
}
#[tokio::test]
async fn missing_exact_close_yields_to_basic_and_epoch_entries_as_well_as_maintenance() {
    let state = fair_state(true);
    run_fair_ticks(&state).await;
    let state = state.lock().unwrap();
    assert!(state.maintenance.is_empty());
    assert!(state.entries.is_empty());
    assert_eq!(state.prepared.len(), 6);
    assert!(state.missing_closes > 0);
    let first_entry = state
        .prepared
        .iter()
        .position(|work| matches!(work, Work::Entry { .. }))
        .unwrap();
    let last_maintenance = state
        .prepared
        .iter()
        .rposition(|work| matches!(work, Work::Maintenance { .. }))
        .unwrap();
    assert!(first_entry < last_maintenance);
}

struct AvailableBoundary(Arc<Mutex<State>>);
impl Snapshots for AvailableBoundary {
    fn select(
        &self,
        _: &[Work],
        closing_ms: Option<u64>,
        _: u64,
    ) -> Result<Option<Observation>, Error> {
        let timestamp = closing_ms.expect("exact closing timestamp");
        self.0.lock().unwrap().closing_attempts.push(timestamp);
        Ok((timestamp == 10_000).then_some(Observation {
            universe_digest: [1; 32],
            timestamp_us: timestamp * 1000,
            benchmark: 100,
            prices_e8: vec![100],
            signed_payload: vec![1],
        }))
    }
}
#[tokio::test]
async fn missing_epoch_closes_yield_to_later_boundary_with_persisted_restart_cursor() {
    let state = Arc::new(Mutex::new(State {
        closing_work: [8_000, 9_000, 10_000]
            .into_iter()
            .map(|timestamp_ms| Work::Close {
                id: format!("close:{timestamp_ms}"),
                timestamp_ms,
            })
            .collect(),
        ..State::default()
    }));
    for (now, expected) in [
        (10_000, Tick::Waiting(11_000)),
        (11_000, Tick::Waiting(12_000)),
        (12_000, Tick::Submitted(13_000)),
    ] {
        let mut publisher = Publisher::new(
            Accounts(state.clone()),
            AvailableBoundary(state.clone()),
            Disk(state.clone()),
            2,
            2_000,
        )
        .unwrap();
        assert_eq!(publisher.tick(now).await.unwrap(), expected);
    }
    let actual = state.lock().unwrap();
    assert_eq!(actual.closing_attempts, vec![8_000, 9_000, 10_000]);
    assert_eq!(actual.saved.last_closing_ms, Some(10_000));
    assert_eq!(
        actual
            .trace
            .iter()
            .filter(|&&entry| entry == "prepare")
            .count(),
        1
    );
    assert!(actual.saved.pending.is_some());
}
