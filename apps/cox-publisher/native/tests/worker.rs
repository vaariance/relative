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
    fail_save: bool,
    work: bool,
    stale_sign: bool,
    maintenance: bool,
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
    async fn authoritative_work(&mut self, _: u64) -> Result<Vec<Work>, Error> {
        let mut s = self.0.lock().unwrap();
        s.trace.push("read");
        Ok(if s.maintenance {
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
