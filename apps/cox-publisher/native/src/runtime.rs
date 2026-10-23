use crate::{
    benchmark::{Anchor, Benchmark, Observation},
    chain::ChainReader,
    executor::{AssetMapping, Executor},
    feeds::{self, GrpcConfig, PythConfig, WakeHint},
    journal::{self, FileHistory},
    pyth,
    rpc::Rpc,
    scheduler::{Work, CADENCE_MS},
    signing::RemoteSigner,
    transactions::Budget,
    worker::{self, FileCheckpoint, Publisher, Snapshots, Tick},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solana_address::Address;
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, watch};

const IDLE_MS: u64 = 20 * 60 * 1_000;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub schema: String,
    pub enabled: bool,
    pub network: String,
    pub state_directory: PathBuf,
    pub operator: String,
    pub basic_program: String,
    pub basic_pool_id: u64,
    pub first_epoch_opens_at: u64,
    pub epoch_program: String,
    pub epoch_config: String,
    pub key_version: String,
    pub anchor: Anchor,
    pub mapping: Vec<AssetMapping>,
    pub compute_units: u32,
    pub priority_fee_lamports: u64,
    pub heap_bytes: Option<u32>,
    pub batch_limit: usize,
    pub max_operations: usize,
    pub max_price_age_ms: u64,
    pub max_feed_age_ms: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Configuration,
    Disabled,
    Storage,
    Locked,
    Network,
    Signer,
    Feed,
    Clock,
    Publisher,
}
impl Config {
    pub fn read(path: &Path) -> Result<Self, Error> {
        let bytes = std::fs::read(path).map_err(|_| Error::Configuration)?;
        if bytes.len() > 262_144 {
            return Err(Error::Configuration);
        }
        let config: Self = serde_json::from_slice(&bytes).map_err(|_| Error::Configuration)?;
        config.validate()?;
        Ok(config)
    }
    pub fn validate(&self) -> Result<(), Error> {
        if self.schema != "relative.publisher/v1"
            || self.network != "solana-devnet"
            || !self.state_directory.is_absolute()
            || self.basic_pool_id == 1
            || self.first_epoch_opens_at % cox_epoch::EPOCH_SECONDS != 0
            || self.first_epoch_opens_at < self.anchor.timestamp_us / 1_000_000
            || self.key_version.is_empty()
            || self.batch_limit == 0
            || self.batch_limit > 16
            || self.max_operations == 0
            || self.max_operations > 16
            || !(1..=5_000).contains(&self.max_price_age_ms)
            || !(1..=60_000).contains(&self.max_feed_age_ms)
            || !(1..=1_400_000).contains(&self.compute_units)
            || self.priority_fee_lamports > 100_000
            || self
                .heap_bytes
                .is_some_and(|heap| !(32_768..=262_144).contains(&heap) || heap % 1024 != 0)
            || self.anchor.benchmark != 100 * cox_math::SCALE
            || self.anchor.timestamp_us % 1_000_000 != 0
            || self.anchor.universe_digest == [0; 32]
            || self.mapping.len() != self.anchor.assets.len()
        {
            return Err(Error::Configuration);
        }
        let keys = [
            &self.operator,
            &self.basic_program,
            &self.epoch_program,
            &self.epoch_config,
        ]
        .map(|key| key.parse::<Address>().map_err(|_| Error::Configuration));
        for key in keys {
            if key? == Address::default() {
                return Err(Error::Configuration);
            }
        }
        if self.basic_program == self.epoch_program {
            return Err(Error::Configuration);
        }
        let ids = self
            .mapping
            .iter()
            .map(|asset| asset.basic_id)
            .collect::<std::collections::BTreeSet<_>>();
        let epoch = self
            .mapping
            .iter()
            .map(|asset| asset.epoch_id)
            .collect::<std::collections::BTreeSet<_>>();
        let feeds = self
            .mapping
            .iter()
            .map(|asset| asset.epoch_feed_id)
            .collect::<std::collections::BTreeSet<_>>();
        if ids.len() != self.mapping.len()
            || epoch.len() != ids.len()
            || feeds.len() != ids.len()
            || self.mapping.iter().any(|asset| {
                asset.basic_id >= 30 || asset.epoch_id >= 256 || asset.epoch_feed_id == [0; 32]
            })
        {
            return Err(Error::Configuration);
        }
        Benchmark::new(self.anchor.clone(), MemoryHistory, None)
            .map_err(|_| Error::Configuration)?;
        Ok(())
    }
    pub fn identity(&self) -> Result<[u8; 32], Error> {
        Ok(Sha256::digest(serde_json::to_vec(self).map_err(|_| Error::Configuration)?).into())
    }
}
struct MemoryHistory;
impl crate::benchmark::History for MemoryHistory {
    fn append(&mut self, _: &Observation) -> Result<(), crate::benchmark::Error> {
        Ok(())
    }
}

struct StateLock {
    _file: File,
}
impl StateLock {
    fn acquire(directory: &Path, identity: [u8; 32], anchor: &Anchor) -> Result<Self, Error> {
        std::fs::create_dir_all(directory).map_err(|_| Error::Storage)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(directory.join("publisher.lock"))
            .map_err(|_| Error::Storage)?;
        file.try_lock().map_err(|_| Error::Locked)?;
        #[derive(Serialize, Deserialize, PartialEq, Eq)]
        struct Binding {
            identity: [u8; 32],
            anchor: Anchor,
        }
        let binding = Binding {
            identity,
            anchor: anchor.clone(),
        };
        let path = directory.join("identity.json");
        match journal::read::<Binding>(&path).map_err(|_| Error::Storage)? {
            Some(prior) if prior != binding => return Err(Error::Storage),
            Some(_) => {}
            None => journal::atomic_write(&path, &binding).map_err(|_| Error::Storage)?,
        }
        Ok(Self { _file: file })
    }
}
#[derive(Clone)]
pub struct SnapshotArchive {
    anchor: Anchor,
    history: FileHistory,
    latest: Arc<RwLock<Option<Observation>>>,
    max_age_ms: u64,
    trusted_signers: Arc<RwLock<Option<Vec<pyth::TrustedSigner>>>>,
    max_feed_age_us: u64,
}
impl SnapshotArchive {
    fn new(anchor: Anchor, history: FileHistory, max_age_ms: u64) -> Result<Self, Error> {
        let resumed = history
            .latest_for_anchor(&anchor)
            .map_err(|_| Error::Storage)?;
        Benchmark::new(anchor.clone(), MemoryHistory, resumed.clone())
            .map_err(|_| Error::Storage)?;
        Ok(Self {
            anchor,
            history,
            latest: Arc::new(RwLock::new(resumed)),
            max_age_ms,
            trusted_signers: Arc::new(RwLock::new(None)),
            max_feed_age_us: 60_000_000,
        })
    }
    fn validate(&self, value: &Observation) -> Result<(), worker::Error> {
        if value.timestamp_us % 1_000_000 != 0 {
            return Err(worker::Error::Snapshot);
        }
        Benchmark::new(self.anchor.clone(), MemoryHistory, Some(value.clone()))
            .map_err(|_| worker::Error::Snapshot)?;
        if let Some(signers) = self
            .trusted_signers
            .read()
            .map_err(|_| worker::Error::Storage)?
            .as_ref()
        {
            let batch = pyth::verify_payload(
                &value.signed_payload,
                signers,
                value.timestamp_us / 1_000_000,
                self.max_feed_age_us,
            )
            .map_err(|_| worker::Error::Snapshot)?;
            if batch.prices.len() != self.anchor.assets.len() {
                return Err(worker::Error::Snapshot);
            }
            let mut calculator = Benchmark::new(self.anchor.clone(), MemoryHistory, None)
                .map_err(|_| worker::Error::Snapshot)?;
            if calculator
                .observe(&batch, |_| Ok(()))
                .map_err(|_| worker::Error::Snapshot)?
                != *value
            {
                return Err(worker::Error::Snapshot);
            }
        }
        Ok(())
    }
}
impl Snapshots for SnapshotArchive {
    fn selection_time_ms(&self, _: u64) -> Result<u64, worker::Error> {
        now_ms().map_err(|_| worker::Error::Clock)
    }
    fn select(
        &self,
        work: &[Work],
        closing_ms: Option<u64>,
        now_ms: u64,
    ) -> Result<Option<Observation>, worker::Error> {
        let mut value = if let Some(close) = closing_ms {
            if close > now_ms {
                return Ok(None);
            }
            self.history
                .exact(
                    &self.anchor.universe_digest,
                    close.checked_mul(1000).ok_or(worker::Error::Clock)?,
                )
                .map_err(|_| worker::Error::Storage)?
        } else {
            self.latest
                .read()
                .map_err(|_| worker::Error::Storage)?
                .clone()
        };
        if closing_ms.is_none()
            && value
                .as_ref()
                .is_some_and(|value| value.timestamp_us / 1000 > now_ms)
        {
            value = self
                .history
                .exact(
                    &self.anchor.universe_digest,
                    (now_ms / 1000)
                        .checked_mul(1_000_000)
                        .ok_or(worker::Error::Clock)?,
                )
                .map_err(|_| worker::Error::Storage)?;
        }
        let Some(value) = value else { return Ok(None) };
        self.validate(&value)?;
        let timestamp = value.timestamp_us / 1000;
        if timestamp > now_ms {
            return Ok(None);
        }
        if closing_ms.is_none() && (now_ms-timestamp>self.max_age_ms || work.iter().any(|item|matches!(item,Work::Entry{eligible_after_ms,..} if timestamp<=*eligible_after_ms))){return Ok(None);}
        Ok(Some(value))
    }
}
fn now_ms() -> Result<u64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Clock)?
        .as_millis()
        .try_into()
        .map_err(|_| Error::Clock)
}
fn secret(name: &str) -> Result<String, Error> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or(Error::Configuration)
}
async fn stopped(stop: &mut watch::Receiver<bool>) {
    while !*stop.borrow() {
        if stop.changed().await.is_err() {
            break;
        }
    }
}

#[derive(Default)]
struct SignerRefresh {
    last_attempt_ms: Option<u64>,
    storage_until_ms: u64,
}
impl SignerRefresh {
    fn storage_changed(&mut self, now: u64) {
        if now >= self.storage_until_ms {
            self.last_attempt_ms = None;
        }
        self.storage_until_ms = now.saturating_add(6_000);
    }
    fn due(&self, now: u64, signers: &[pyth::TrustedSigner], key: Option<[u8; 32]>) -> bool {
        let storage = now < self.storage_until_ms;
        let cooldown = if storage { CADENCE_MS } else { IDLE_MS };
        if self
            .last_attempt_ms
            .is_some_and(|last| now.saturating_sub(last) < cooldown)
        {
            return false;
        }
        let Some(key) = key else {
            return storage;
        };
        storage
            || !signers.iter().any(|signer| {
                signer.public_key == key
                    && i128::from(signer.expires_at_seconds) > i128::from(now / 1000) + 30
            })
    }
    fn attempted(&mut self, now: u64) {
        self.last_attempt_ms = Some(now);
    }
}

async fn benchmark_task(
    rpc: Arc<Rpc>,
    archive: SnapshotArchive,
    max_feed_age_ms: u64,
    mut prices: mpsc::Receiver<Vec<u8>>,
    mut notifications: watch::Receiver<WakeHint>,
    usage_path: PathBuf,
    mut stop: watch::Receiver<bool>,
) -> Result<(), Error> {
    let resumed = archive.latest.read().map_err(|_| Error::Storage)?.clone();
    let mut benchmark = Benchmark::new(archive.anchor.clone(), archive.history.clone(), resumed)
        .map_err(|_| Error::Storage)?;
    let mut signers = archive
        .trusted_signers
        .read()
        .map_err(|_| Error::Storage)?
        .clone()
        .ok_or(Error::Feed)?;
    let mut refresh = SignerRefresh::default();
    let mut signer_generation = notifications.borrow().signer_generation;
    loop {
        tokio::select! {
            _=stopped(&mut stop)=>return Ok(()),
            changed=notifications.changed()=>{
                changed.map_err(|_|Error::Feed)?;
                let generation=notifications.borrow_and_update().signer_generation;
                if generation != signer_generation {
                    signer_generation=generation;
                    refresh.storage_changed(now_ms()?);
                }
            },
            bytes=prices.recv()=>{
                let bytes=bytes.ok_or(Error::Feed)?;let now=now_ms()?;
                let public_key=pyth::payload_signer(&bytes).ok();
                if refresh.due(now, &signers, public_key) {
                    refresh.attempted(now);
                    if let Ok(updated)=crate::rpc::with_trigger("signer-refresh",pyth::read_trusted_signers(&rpc)).await {
                        let mut retained=archive.trusted_signers.write().map_err(|_|Error::Storage)?;
                        let keys=retained.as_mut().ok_or(Error::Feed)?;
                        for signer in &updated {
                            if !keys.iter().any(|key| key.public_key==signer.public_key && key.expires_at_seconds==signer.expires_at_seconds) { keys.push(signer.clone()); }
                        }
                        signers=updated;
                    }
                    rpc.persist_usage(&usage_path).map_err(|_|Error::Storage)?;
                }
                let Ok(batch)=pyth::verify_payload(&bytes,&signers,now/1000,max_feed_age_ms*1000)else{continue};
                if batch.timestamp_us%1_000_000!=0 || batch.timestamp_us>now*1000 || now*1000-batch.timestamp_us>60_000_000
                    || batch.prices.len()!=archive.anchor.assets.len(){continue;}
                match benchmark.observe(&batch,|_|Ok(())){
                    Ok(value)=>*archive.latest.write().map_err(|_|Error::Storage)?=Some(value),
                    Err(crate::benchmark::Error::TimeRegression)=>{},
                    Err(crate::benchmark::Error::Conflict|crate::benchmark::Error::Persistence)=>return Err(Error::Storage),
                    Err(_)=>return Err(Error::Feed),
                }
            }
        }
    }
}
async fn pyth_task(
    config: PythConfig,
    prices: mpsc::Sender<Vec<u8>>,
    mut stop: watch::Receiver<bool>,
) -> Result<(), Error> {
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        if let Err(error) = feeds::run_pyth(
            PythConfig {
                token: config.token.clone(),
                feed_ids: config.feed_ids.clone(),
                subscription_id: config.subscription_id,
            },
            prices.clone(),
            stop.clone(),
        )
        .await
        {
            if matches!(
                error,
                feeds::FeedError::Configuration
                    | feeds::FeedError::Subscribe
                    | feeds::FeedError::ConsumerStopped
            ) {
                return Err(Error::Feed);
            }
        }
        tokio::select! {_=stopped(&mut stop)=>return Ok(()),_=tokio::time::sleep(Duration::from_secs(1))=>{}}
    }
}
fn next_delay(tick: &Tick, now: u64) -> u64 {
    match tick {
        Tick::Idle(wake) => wake
            .map(|at| at.saturating_sub(now))
            .unwrap_or(IDLE_MS)
            .min(IDLE_MS)
            .max(1),
        Tick::Waiting(at) | Tick::Submitted(at) | Tick::Reconciling(at) => {
            at.saturating_sub(now).clamp(1, CADENCE_MS)
        }
    }
}
fn wake_delay(tick: &Tick, now: u64, recent_notification: bool) -> u64 {
    let delay = next_delay(tick, now);
    if recent_notification {
        delay.min(CADENCE_MS)
    } else {
        delay
    }
}

#[derive(Default)]
struct WakeSchedule {
    generation: u64,
    protocol_generation: u64,
    notification_until_ms: u64,
    deadline_ms: u64,
    idle: bool,
    failures: u8,
    trigger: Option<&'static str>,
}
impl WakeSchedule {
    fn due(&self, now: u64) -> bool {
        now >= self.deadline_ms
    }
    fn after_tick(&mut self, tick: &Tick, now: u64) {
        self.failures = 0;
        let recent = now < self.notification_until_ms;
        self.deadline_ms = now.saturating_add(wake_delay(tick, now, recent));
        self.idle = matches!(tick, Tick::Idle(_));
        self.trigger = Some(match tick {
            Tick::Idle(_) if recent => "confirmation",
            Tick::Idle(Some(at)) if at.saturating_sub(now) <= IDLE_MS => "scheduled",
            Tick::Idle(_) => "safety",
            _ => "active",
        });
    }
    fn confirmed(&mut self, hint: WakeHint, slot: u64) {
        if hint.protocol_generation == self.protocol_generation && slot >= hint.latest_slot {
            self.notification_until_ms = 0;
        }
    }
    fn failed(&mut self, now: u64) {
        let delay = if self.failures < 6 {
            CADENCE_MS * (1_u64 << self.failures)
        } else {
            IDLE_MS
        };
        self.failures = self.failures.saturating_add(1);
        self.deadline_ms = now.saturating_add(delay);
        self.idle = true;
        self.trigger = Some("recovery");
    }
    fn notify(&mut self, hint: WakeHint, now: u64) -> bool {
        if hint.generation == self.generation {
            return false;
        }
        self.generation = hint.generation;
        if hint.protocol_generation != self.protocol_generation {
            self.protocol_generation = hint.protocol_generation;
            self.notification_until_ms = now.saturating_add(6_000);
        }
        if !self.idle {
            return false;
        }
        self.deadline_ms = now;
        self.trigger = Some(if hint.reconcile {
            "stream-recovery"
        } else {
            "event"
        });
        true
    }
}

pub async fn run(path: &Path) -> Result<(), Error> {
    let config = Config::read(path)?;
    if !config.enabled {
        return Err(Error::Disabled);
    }
    let identity = config.identity()?;
    let _lock = StateLock::acquire(&config.state_directory, identity, &config.anchor)?;
    let key = secret("ALCHEMY_API_KEY")?;
    let pyth_key = secret("PYTH_API_KEY")?;
    let rpc = Arc::new(Rpc::direct_devnet(&key).map_err(|_| Error::Configuration)?);
    crate::rpc::with_trigger(
        "startup",
        rpc.call("getSlot", serde_json::json!([{"commitment":"confirmed"}])),
    )
    .await
    .map_err(|_| Error::Network)?;
    let operator = config.operator.parse().map_err(|_| Error::Configuration)?;
    let signer = RemoteSigner::new(
        &secret("SIGNER_URL")?,
        secret("SIGNER_AUDIENCE")?,
        config.key_version.clone(),
        operator,
    )
    .map_err(|_| Error::Configuration)?;
    signer
        .verify_identity(now_ms()? / 1000)
        .await
        .map_err(|_| Error::Signer)?;
    let reader = ChainReader {
        rpc: rpc.clone(),
        operator,
        basic_program: config
            .basic_program
            .parse()
            .map_err(|_| Error::Configuration)?,
        basic_pool_id: config.basic_pool_id,
        epoch_program: config
            .epoch_program
            .parse()
            .map_err(|_| Error::Configuration)?,
        epoch_config: config
            .epoch_config
            .parse()
            .map_err(|_| Error::Configuration)?,
    };
    let changes = Arc::new(
        crate::changes::ChainChanges::open(&config.state_directory.join("chain-change.json"))
            .map_err(|_| Error::Storage)?,
    );
    changes.set_health(false).map_err(|_| Error::Storage)?;
    let basic_accounts = crate::transactions::BasicAccounts::derive(
        config
            .basic_program
            .parse()
            .map_err(|_| Error::Configuration)?,
        config.basic_pool_id,
        [0; 32],
    );
    let test_vault = Address::find_program_address(
        &[b"test-vault", basic_accounts.pool.as_ref()],
        &basic_accounts.program,
    )
    .0;
    let (custody_watches, custody_watch) = watch::channel(vec![
        basic_accounts.vault.to_string(),
        test_vault.to_string(),
    ]);
    let (wakes, mut wake) = watch::channel(WakeHint::default());
    let chain = Executor::new(
        reader,
        signer,
        config.anchor.clone(),
        config.mapping.clone(),
        Budget {
            compute_units: config.compute_units,
            priority_fee_lamports: config.priority_fee_lamports,
            heap_bytes: config.heap_bytes,
        },
        config.max_operations,
    )
    .map_err(|_| Error::Configuration)?
    .with_price_policy_limits(config.max_price_age_ms, config.max_feed_age_ms)
    .map_err(|_| Error::Configuration)?
    .with_chain_changes(changes.clone())
    .with_chain_activity(wake.clone())
    .with_wake_accounts(custody_watches)
    .with_preview_ledger(config.state_directory.join("preview-ledger.json"))
    .with_publication_archive(config.state_directory.join("publications"))
    .with_discovery_state(
        config.state_directory.join("discovery.json"),
        config.first_epoch_opens_at,
    )
    .map_err(|_| Error::Configuration)?;
    let mut archive = SnapshotArchive::new(
        config.anchor.clone(),
        FileHistory {
            directory: config.state_directory.join("prices"),
        },
        config.max_price_age_ms,
    )?;
    archive.max_feed_age_us = config.max_feed_age_ms * 1000;
    *archive
        .trusted_signers
        .write()
        .map_err(|_| Error::Storage)? = Some(
        crate::rpc::with_trigger("startup", pyth::read_trusted_signers(&rpc))
            .await
            .map_err(|_| Error::Feed)?,
    );
    if let Some(value) = archive.latest.read().map_err(|_| Error::Storage)?.as_ref() {
        archive.validate(value).map_err(|_| Error::Storage)?;
    }
    let mut publisher = Publisher::new(
        chain,
        archive.clone(),
        FileCheckpoint {
            path: config.state_directory.join("checkpoint.json"),
            identity,
        },
        config.batch_limit,
        config.max_price_age_ms,
    )
    .map_err(|_| Error::Configuration)?;
    let (stops, stop) = watch::channel(false);
    let (prices, price) = mpsc::channel(64);
    let mut grpc = tokio::spawn(feeds::run_grpc(
        GrpcConfig {
            endpoint: "https://solana-devnet.streaming.alchemy.com".into(),
            token: key,
            program_ids: vec![config.basic_program, config.epoch_program],
            account_ids: custody_watch,
        },
        wakes,
        stop.clone(),
    ));
    let mut pyth = tokio::spawn(pyth_task(
        PythConfig {
            token: pyth_key,
            feed_ids: config
                .anchor
                .assets
                .iter()
                .map(|asset| asset.feed_id)
                .collect(),
            subscription_id: 1,
        },
        prices,
        stop.clone(),
    ));
    let mut benchmark = tokio::spawn(benchmark_task(
        rpc.clone(),
        archive,
        config.max_feed_age_ms,
        price,
        wake.clone(),
        config.state_directory.join("rpc-usage.json"),
        stop,
    ));
    let shutdown = shutdown();
    tokio::pin!(shutdown);
    let mut schedule = WakeSchedule::default();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    heartbeat.tick().await;
    let result=async{
        loop{
            if !schedule.due(now_ms()?) { return Err(Error::Clock); }
            let tick=tokio::select!{
                _=&mut shutdown=>return Ok(()),
                _=&mut grpc=>return Err(Error::Feed),
                _=&mut pyth=>return Err(Error::Feed),
                _=&mut benchmark=>return Err(Error::Feed),
                result=crate::rpc::with_trigger(schedule.trigger.unwrap_or("startup"),publisher.tick(now_ms()?))=>result,
            };
            let now=now_ms()?;
            match tick{
                Ok(ref value)=>{
                    changes.set_health(wake.borrow().connected).map_err(|_|Error::Storage)?;
                    if let Some(confirmed)=crate::changes::read(&config.state_directory.join("chain-change.json")).map_err(|_|Error::Storage)? {
                        schedule.confirmed(*wake.borrow(),confirmed.observed_slot);
                    }
                    schedule.after_tick(value,now);
                },
                Err(error @ (worker::Error::Storage|worker::Error::Clock|worker::Error::Signer))=>{
                    eprintln!("Publisher stopped: {error:?}");
                    return Err(Error::Publisher);
                },
                Err(error)=>{
                    changes.set_health(false).map_err(|_|Error::Storage)?;
                    eprintln!("Publisher reconciliation deferred: {error:?}");
                    schedule.failed(now);
                },
            };
            rpc.persist_usage(&config.state_directory.join("rpc-usage.json")).map_err(|_|Error::Storage)?;
            let deadline=tokio::time::Instant::now()+Duration::from_millis(schedule.deadline_ms.saturating_sub(now));
            loop{
                tokio::select!{
                    _=&mut shutdown=>return Ok(()),
                    _=&mut grpc=>return Err(Error::Feed),
                    _=&mut pyth=>return Err(Error::Feed),
                    _=&mut benchmark=>return Err(Error::Feed),
                    _=tokio::time::sleep_until(deadline)=>break,
                    _=heartbeat.tick()=>changes.heartbeat().map_err(|_|Error::Storage)?,
                    changed=wake.changed()=>{
                        changed.map_err(|_|Error::Feed)?;
                        let hint=*wake.borrow_and_update();
                        changes.set_health(hint.connected).map_err(|_|Error::Storage)?;
                        if schedule.notify(hint,now_ms()?) { break; }
                    },
                }
            }
        }
    }.await;
    changes.set_health(false).map_err(|_| Error::Storage)?;
    let _ = stops.send(true);
    for task in [&mut grpc] {
        if !task.is_finished()
            && tokio::time::timeout(Duration::from_secs(3), &mut *task)
                .await
                .is_err()
        {
            task.abort();
        }
    }
    if !pyth.is_finished()
        && tokio::time::timeout(Duration::from_secs(3), &mut pyth)
            .await
            .is_err()
    {
        pyth.abort();
    }
    if !benchmark.is_finished()
        && tokio::time::timeout(Duration::from_secs(3), &mut benchmark)
            .await
            .is_err()
    {
        benchmark.abort();
    }
    result
}
async fn shutdown() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}};
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        benchmark::{Asset, History},
        scheduler::Pool,
        worker::Store,
    };
    fn anchor() -> Anchor {
        Anchor {
            universe_digest: [3; 32],
            timestamp_us: 1_000_000,
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
                    origin_price_e8: 100,
                },
            ],
        }
    }
    fn config(directory: PathBuf) -> Config {
        Config {
            schema: "relative.publisher/v1".into(),
            enabled: false,
            network: "solana-devnet".into(),
            state_directory: directory,
            operator: Address::new_from_array([1; 32]).to_string(),
            basic_program: Address::new_from_array([2; 32]).to_string(),
            basic_pool_id: 2,
            first_epoch_opens_at: 14_400,
            epoch_program: Address::new_from_array([3; 32]).to_string(),
            epoch_config: Address::new_from_array([4; 32]).to_string(),
            key_version: "key1".into(),
            anchor: anchor(),
            mapping: vec![
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
            compute_units: 1_400_000,
            priority_fee_lamports: 100,
            heap_bytes: Some(262_144),
            batch_limit: 2,
            max_operations: 2,
            max_price_age_ms: 5_000,
            max_feed_age_ms: 60_000,
        }
    }
    fn directory() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "relative-runtime-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }
    fn observation(timestamp_us: u64) -> Observation {
        Observation {
            universe_digest: [3; 32],
            timestamp_us,
            benchmark: 100 * cox_math::SCALE,
            prices_e8: vec![100, 100],
            signed_payload: vec![1],
        }
    }
    #[test]
    fn configuration_rejects_retired_pool_wrong_network_duplicate_mappings_and_unknown_fields() {
        let mut value = config(directory());
        value.validate().unwrap();
        value.basic_pool_id = 1;
        assert_eq!(value.validate(), Err(Error::Configuration));
        value.basic_pool_id = 2;
        value.network = "mainnet".into();
        assert_eq!(value.validate(), Err(Error::Configuration));
        value.network = "solana-devnet".into();
        value.mapping[1].basic_id = 0;
        assert_eq!(value.validate(), Err(Error::Configuration));
        let mut json = serde_json::to_value(config(directory())).unwrap();
        json["rpc_proxy"] = serde_json::json!("forbidden");
        assert!(serde_json::from_value::<Config>(json).is_err());
    }
    #[test]
    fn restart_binding_and_single_writer_lock_prevent_cross_configuration_reuse() {
        let path = directory();
        let value = config(path.clone());
        let identity = value.identity().unwrap();
        let locked = StateLock::acquire(&path, identity, &value.anchor).unwrap();
        assert!(matches!(
            StateLock::acquire(&path, identity, &value.anchor),
            Err(Error::Locked)
        ));
        drop(locked);
        let locked = StateLock::acquire(&path, identity, &value.anchor).unwrap();
        drop(locked);
        assert!(matches!(
            StateLock::acquire(&path, [9; 32], &value.anchor),
            Err(Error::Storage)
        ));
        let mut store = FileCheckpoint {
            path: path.join("checkpoint.json"),
            identity,
        };
        let mut checkpoint = crate::scheduler::Checkpoint::default();
        checkpoint.next_attempt_ms = 7;
        store.save(&checkpoint).unwrap();
        assert_eq!(store.load().unwrap(), checkpoint);
        assert_eq!(
            FileCheckpoint {
                path: path.join("checkpoint.json"),
                identity: [9; 32]
            }
            .load(),
            Err(worker::Error::Storage)
        );
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn exact_closing_never_substitutes_later_price_and_live_selection_requires_fresh_future_execution(
    ) {
        let path = directory();
        let mut history = FileHistory {
            directory: path.clone(),
        };
        history.append(&observation(2_000_000)).unwrap();
        history.append(&observation(3_000_000)).unwrap();
        let archive = SnapshotArchive::new(anchor(), history, 5_000).unwrap();
        assert_eq!(
            archive
                .select(&[], Some(2_000), 80_000)
                .unwrap()
                .unwrap()
                .timestamp_us,
            2_000_000
        );
        assert!(archive.select(&[], Some(2_500), 80_000).unwrap().is_none());
        assert!(archive.select(&[], None, 9_000).unwrap().is_none());
        assert_eq!(
            archive
                .select(&[], None, 2_000)
                .unwrap()
                .unwrap()
                .timestamp_us,
            2_000_000
        );
        let work = [Work::Entry {
            id: "basic".into(),
            pool: Pool::Basic,
            eligible_after_ms: 3_000,
        }];
        assert!(archive.select(&work, None, 3_000).unwrap().is_none());
        assert!(archive.select(&[], None, 3_001).unwrap().is_some());
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn a_new_feed_second_during_account_reads_does_not_hide_the_eligible_snapshot() {
        let path = directory();
        let mut history = FileHistory {
            directory: path.clone(),
        };
        history.append(&observation(2_000_000)).unwrap();
        history.append(&observation(3_000_000)).unwrap();
        let archive = SnapshotArchive::new(anchor(), history, 5_000).unwrap();
        let mut work = [Work::Entry {
            id: "basic".into(),
            pool: Pool::Basic,
            eligible_after_ms: 1_500,
        }];
        assert_eq!(
            archive
                .select(&work, None, 2_500)
                .unwrap()
                .unwrap()
                .timestamp_us,
            2_000_000
        );
        work[0] = Work::Entry {
            id: "basic".into(),
            pool: Pool::Basic,
            eligible_after_ms: 2_000,
        };
        assert!(archive.select(&work, None, 2_500).unwrap().is_none());
        assert!(archive.select(&[], None, 1_500).unwrap().is_none());
        assert!(archive.select(&[], Some(2_500), 4_000).unwrap().is_none());
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn corrupted_resumed_benchmark_and_universe_fail_closed() {
        let path = directory();
        let mut history = FileHistory {
            directory: path.clone(),
        };
        let mut bad = observation(2_000_000);
        bad.benchmark += 1;
        history.append(&bad).unwrap();
        assert!(matches!(
            SnapshotArchive::new(anchor(), history, 5_000),
            Err(Error::Storage)
        ));
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn active_ticks_keep_one_second_cadence_and_idle_ticks_use_reconciliation_timer() {
        assert_eq!(next_delay(&Tick::Idle(None), 0), 1_200_000);
        assert_eq!(next_delay(&Tick::Idle(Some(3_000)), 0), 3_000);
        assert_eq!(next_delay(&Tick::Waiting(5_000), 0), 1_000);
        assert_eq!(next_delay(&Tick::Submitted(1_000), 900), 100);
    }
    #[test]
    fn processed_notification_keeps_retrying_before_confirmed_rpc_sees_the_order() {
        assert_eq!(wake_delay(&Tick::Idle(None), 0, true), 1_000);
        assert_eq!(wake_delay(&Tick::Idle(None), 0, false), 1_200_000);
        assert_eq!(wake_delay(&Tick::Waiting(1_000), 900, true), 100);
    }
    #[test]
    fn idle_future_closing_sleeps_until_due_or_twenty_minute_safety() {
        assert_eq!(next_delay(&Tick::Idle(Some(14_400_000)), 0), 1_200_000);
        assert_eq!(next_delay(&Tick::Idle(Some(14_400_000)), 14_399_500), 500);
        assert_eq!(next_delay(&Tick::Idle(Some(14_400_000)), 14_400_000), 1);
    }
    struct CountingChain {
        reads: Arc<std::sync::atomic::AtomicUsize>,
        closes_at: Option<u64>,
    }
    impl worker::Chain for CountingChain {
        async fn authoritative_work(&mut self, now: u64) -> Result<Vec<Work>, worker::Error> {
            self.reads
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(self
                .closes_at
                .filter(|at| *at > now)
                .map(|at| {
                    vec![Work::Close {
                        id: "epoch".into(),
                        timestamp_ms: at,
                    }]
                })
                .unwrap_or_default())
        }
        async fn prepare(
            &mut self,
            _: &[Work],
            _: Option<&Observation>,
        ) -> Result<crate::scheduler::DraftTransaction, worker::Error> {
            unreachable!()
        }
        async fn sign(
            &mut self,
            _: &crate::scheduler::DraftTransaction,
        ) -> Result<crate::scheduler::PendingTransaction, worker::Error> {
            unreachable!()
        }
        async fn broadcast(
            &mut self,
            _: &crate::scheduler::PendingTransaction,
        ) -> Result<(), worker::Error> {
            unreachable!()
        }
        async fn reconcile(
            &mut self,
            _: &crate::scheduler::PendingTransaction,
        ) -> Result<worker::TransactionStatus, worker::Error> {
            unreachable!()
        }
    }
    async fn count_if_due(
        schedule: &mut WakeSchedule,
        publisher: &mut Publisher<CountingChain, SnapshotArchive, FileCheckpoint>,
        now: u64,
    ) {
        if schedule.due(now) {
            schedule.after_tick(&publisher.tick(now).await.unwrap(), now);
        }
    }
    #[tokio::test]
    async fn idle_controller_makes_no_chain_reads_for_twenty_minutes_despite_health_and_price_notifications(
    ) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let path = directory();
        let archive = SnapshotArchive::new(
            anchor(),
            FileHistory {
                directory: path.join("prices"),
            },
            5_000,
        )
        .unwrap();
        let reads = Arc::new(AtomicUsize::new(0));
        let mut publisher = Publisher::new(
            CountingChain {
                reads: reads.clone(),
                closes_at: None,
            },
            archive,
            FileCheckpoint {
                path: path.join("checkpoint.json"),
                identity: [1; 32],
            },
            2,
            5_000,
        )
        .unwrap();
        let mut schedule = WakeSchedule::default();
        count_if_due(&mut schedule, &mut publisher, 0).await;
        for now in (1_000..IDLE_MS).step_by(1_000) {
            let hint = WakeHint {
                connected: now % 2_000 == 0,
                signer_generation: now,
                ..WakeHint::default()
            };
            assert!(!schedule.notify(hint, now));
            count_if_due(&mut schedule, &mut publisher, now).await;
        }
        assert_eq!(reads.load(Ordering::Relaxed), 1);
        count_if_due(&mut schedule, &mut publisher, IDLE_MS).await;
        assert_eq!(reads.load(Ordering::Relaxed), 2);
        count_if_due(&mut schedule, &mut publisher, IDLE_MS + 1).await;
        assert_eq!(reads.load(Ordering::Relaxed), 2);
        let reconnect = WakeHint {
            generation: 1,
            reconcile: true,
            connected: true,
            ..WakeHint::default()
        };
        assert!(schedule.notify(reconnect, IDLE_MS + 2));
        count_if_due(&mut schedule, &mut publisher, IDLE_MS + 2).await;
        assert_eq!(reads.load(Ordering::Relaxed), 3);
        assert_eq!(schedule.deadline_ms, 2 * IDLE_MS + 2);
        for generation in 2..102 {
            schedule.notify(
                WakeHint {
                    generation,
                    protocol_generation: generation,
                    latest_slot: generation,
                    ..WakeHint::default()
                },
                IDLE_MS + 3,
            );
        }
        count_if_due(&mut schedule, &mut publisher, IDLE_MS + 3).await;
        assert_eq!(reads.load(Ordering::Relaxed), 4);
        std::fs::remove_dir_all(path).ok();
    }
    #[tokio::test]
    async fn future_epoch_closing_wakes_once_at_its_deadline_without_trade_activity() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let path = directory();
        let archive = SnapshotArchive::new(
            anchor(),
            FileHistory {
                directory: path.join("prices"),
            },
            5_000,
        )
        .unwrap();
        let reads = Arc::new(AtomicUsize::new(0));
        let mut publisher = Publisher::new(
            CountingChain {
                reads: reads.clone(),
                closes_at: Some(600_000),
            },
            archive,
            FileCheckpoint {
                path: path.join("checkpoint.json"),
                identity: [1; 32],
            },
            2,
            5_000,
        )
        .unwrap();
        let mut schedule = WakeSchedule::default();
        count_if_due(&mut schedule, &mut publisher, 0).await;
        for now in (1_000..600_000).step_by(1_000) {
            count_if_due(&mut schedule, &mut publisher, now).await;
        }
        assert_eq!(reads.load(Ordering::Relaxed), 1);
        assert_eq!(schedule.trigger, Some("scheduled"));
        count_if_due(&mut schedule, &mut publisher, 600_000).await;
        assert_eq!(reads.load(Ordering::Relaxed), 2);
        std::fs::remove_dir_all(path).ok();
    }
    #[test]
    fn coalesced_reconnect_cannot_hide_an_unconfirmed_protocol_event() {
        let mut schedule = WakeSchedule::default();
        schedule.after_tick(&Tick::Idle(None), 0);
        let coalesced = WakeHint {
            generation: 2,
            protocol_generation: 1,
            reconcile: true,
            connected: true,
            ..WakeHint::default()
        };
        assert!(schedule.notify(coalesced, 100));
        schedule.after_tick(&Tick::Idle(None), 100);
        assert_eq!(schedule.deadline_ms, 1_100);
        assert_eq!(schedule.trigger, Some("confirmation"));
        schedule.after_tick(&Tick::Idle(None), 6_100);
        assert_eq!(schedule.deadline_ms, 1_206_100);
        assert_eq!(schedule.trigger, Some("safety"));
    }
    #[test]
    fn confirmed_slot_stops_processed_retry_window_only_after_matching_activity() {
        let mut schedule = WakeSchedule::default();
        schedule.after_tick(&Tick::Idle(None), 0);
        let event = WakeHint {
            generation: 1,
            protocol_generation: 1,
            latest_slot: 100,
            ..WakeHint::default()
        };
        assert!(schedule.notify(event, 100));
        schedule.confirmed(event, 99);
        schedule.after_tick(&Tick::Idle(None), 100);
        assert_eq!(schedule.deadline_ms, 1_100);
        let newer = WakeHint {
            generation: 2,
            protocol_generation: 2,
            latest_slot: 101,
            ..event
        };
        schedule.confirmed(newer, 101);
        assert_eq!(schedule.notification_until_ms, 6_100);
        schedule.confirmed(event, 100);
        schedule.after_tick(&Tick::Idle(None), 100);
        assert_eq!(schedule.deadline_ms, 1_200_100);
    }
    #[test]
    fn failed_reconciliation_has_bounded_retries_and_relevant_events_override_backoff() {
        let mut schedule = WakeSchedule::default();
        let mut now = 0;
        for expected in [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, IDLE_MS, IDLE_MS] {
            schedule.failed(now);
            assert_eq!(schedule.deadline_ms - now, expected);
            now = schedule.deadline_ms;
        }
        let event = WakeHint {
            generation: 1,
            ..WakeHint::default()
        };
        assert!(schedule.notify(event, now - 100));
        assert!(schedule.due(now - 100));
        schedule.after_tick(&Tick::Idle(None), now);
        schedule.failed(now);
        assert_eq!(schedule.deadline_ms - now, 1_000);
    }
    #[test]
    fn signer_refresh_is_rotation_or_expiry_driven_and_unknown_keys_are_bounded() {
        let keys = vec![pyth::TrustedSigner {
            public_key: [1; 32],
            expires_at_seconds: 10_000,
        }];
        let mut refresh = SignerRefresh::default();
        for now in [0, 1_000, 60_000, 1_200_000] {
            assert!(!refresh.due(now, &keys, Some([1; 32])));
        }
        assert!(!refresh.due(60_000, &keys, None));
        assert!(refresh.due(60_000, &keys, Some([2; 32])));
        refresh.attempted(60_000);
        assert!(!refresh.due(61_000, &keys, Some([2; 32])));
        assert!(!refresh.due(1_259_999, &keys, Some([2; 32])));
        assert!(refresh.due(1_260_000, &keys, Some([2; 32])));
        let fresh = SignerRefresh::default();
        assert!(fresh.due(9_970_000, &keys, Some([1; 32])));
        assert!(!fresh.due(9_969_000, &keys, Some([1; 32])));
    }
    #[test]
    fn signer_storage_changes_allow_bounded_confirmed_state_catchup_without_per_second_forever() {
        let keys = vec![pyth::TrustedSigner {
            public_key: [1; 32],
            expires_at_seconds: 10_000,
        }];
        let mut refresh = SignerRefresh::default();
        refresh.storage_changed(10_000);
        assert!(refresh.due(10_000, &keys, Some([1; 32])));
        refresh.attempted(10_000);
        refresh.storage_changed(10_001);
        assert!(!refresh.due(10_001, &keys, Some([1; 32])));
        assert!(refresh.due(11_000, &keys, Some([1; 32])));
        refresh.attempted(11_000);
        assert!(!refresh.due(17_000, &keys, Some([1; 32])));
        assert!(!refresh.due(17_000, &keys, Some([2; 32])));
    }
    #[test]
    fn production_archive_rechecks_signed_payload_instead_of_trusting_json_prices() {
        let path = directory();
        let mut history = FileHistory {
            directory: path.clone(),
        };
        history.append(&observation(2_000_000)).unwrap();
        let archive = SnapshotArchive::new(anchor(), history, 5_000).unwrap();
        *archive.trusted_signers.write().unwrap() = Some(vec![pyth::TrustedSigner {
            public_key: [7; 32],
            expires_at_seconds: 100,
        }]);
        assert_eq!(
            archive.select(&[], None, 2_000),
            Err(worker::Error::Snapshot)
        );
        std::fs::remove_dir_all(path).unwrap();
    }
    #[tokio::test]
    async fn disabled_configuration_stops_before_reading_secrets_or_calling_network() {
        let path = directory();
        std::fs::create_dir_all(&path).unwrap();
        let file = path.join("config.json");
        journal::atomic_write(&file, &config(path.clone())).unwrap();
        assert_eq!(run(&file).await, Err(Error::Disabled));
        assert!(!path.join("publisher.lock").exists());
        std::fs::remove_dir_all(path).unwrap();
    }
}
