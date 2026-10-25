use super::Rpc;
use crate::{
    activation,
    benchmark::{Anchor, Benchmark, History, Observation},
    chain::{ChainReader, Discovery},
    executor::{DraftSigner, Executor, LocalRehearsalClock},
    inclusion_execution::{Approved, Controller},
    inclusion_pipeline::ScheduleEvidence,
    journal::{self, FileHistory},
    origin,
    pyth::{self, TrustedSigner},
    runtime::{Config, SnapshotArchive},
    scheduler::{DraftTransaction, PendingTransaction, Work},
    transactions::Budget,
    universe_runtime::{self, Receipt},
    worker::{self, FileCheckpoint, Publisher, Snapshots, Tick},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use serde::Deserialize;
use serde_json::json;
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rehearsal {
    schema: String,
    mode: String,
    runtime_config_path: PathBuf,
    rpc_url: Option<String>,
    node_path: Option<PathBuf>,
    node_loader_path: Option<PathBuf>,
    signer_helper_path: Option<PathBuf>,
    signer_config_path: Option<PathBuf>,
    feed_signer_seed_path: PathBuf,
    receipt_path: PathBuf,
    report_path: PathBuf,
    policy_digest: Option<[u8; 32]>,
    observation_timestamps_seconds: Option<Vec<u64>>,
    prices_e8: Option<Vec<u64>>,
    max_ticks: Option<usize>,
    stop_after_idle_ticks: Option<usize>,
    sleep_ms: Option<u64>,
    advance_clock_seconds: Option<u64>,
    observe_each_tick: Option<bool>,
    inclusion_timestamp_seconds: Option<u64>,
    inclusion_candidate_path: Option<PathBuf>,
    inclusion_schedule_path: Option<PathBuf>,
    inclusion_enabled: Option<bool>,
}

impl Rehearsal {
    fn read() -> Self {
        let path = PathBuf::from(
            std::env::var_os("RELATIVE_LOCAL_REHEARSAL_CONFIG")
                .expect("absolute rehearsal config path"),
        );
        assert!(path.is_absolute());
        let config: Self = journal::read(&path)
            .unwrap()
            .expect("rehearsal configuration");
        assert_eq!(config.schema, "relative.local-rehearsal/v1");
        for path in [
            &config.runtime_config_path,
            &config.feed_signer_seed_path,
            &config.receipt_path,
            &config.report_path,
        ]
        .into_iter()
        .chain(config.node_path.iter())
        .chain(config.node_loader_path.iter())
        .chain(config.signer_helper_path.iter())
        .chain(config.signer_config_path.iter())
        .chain(config.inclusion_candidate_path.iter())
        .chain(config.inclusion_schedule_path.iter())
        {
            assert!(path.is_absolute(), "rehearsal paths must be absolute");
        }
        config
    }
    fn feed_key(&self) -> SigningKey {
        let seed: [u8; 32] = journal::read(&self.feed_signer_seed_path)
            .unwrap()
            .expect("disposable test feed seed");
        SigningKey::from_bytes(&seed)
    }
    fn trusted(&self) -> Vec<TrustedSigner> {
        vec![TrustedSigner {
            public_key: self.feed_key().verifying_key().to_bytes(),
            expires_at_seconds: i64::MAX,
        }]
    }
}

fn signed_feed(key: &SigningKey, config: &Config, timestamp: u64, prices: &[u64]) -> Vec<u8> {
    assert_eq!(prices.len(), config.anchor.assets.len());
    let timestamp_us = timestamp.checked_mul(1_000_000).unwrap();
    let mut payload = 2_479_346_549_u32.to_le_bytes().to_vec();
    payload.extend_from_slice(&timestamp_us.to_le_bytes());
    payload.extend_from_slice(&[4, prices.len().try_into().unwrap()]);
    for (asset, price) in config.anchor.assets.iter().zip(prices) {
        payload.extend_from_slice(&asset.feed_id.to_le_bytes());
        payload.extend_from_slice(&[4, 0]);
        payload.extend_from_slice(&i64::try_from(*price).unwrap().to_le_bytes());
        payload.push(4);
        payload.extend_from_slice(&(-8_i16).to_le_bytes());
        payload.push(5);
        payload.extend_from_slice(&1_i64.to_le_bytes());
        payload.extend_from_slice(&[12, 1]);
        payload.extend_from_slice(&timestamp_us.to_le_bytes());
    }
    let mut envelope = 2_182_742_457_u32.to_le_bytes().to_vec();
    envelope.extend_from_slice(&key.sign(&payload).to_bytes());
    envelope.extend_from_slice(&key.verifying_key().to_bytes());
    envelope.extend_from_slice(&u16::try_from(payload.len()).unwrap().to_le_bytes());
    envelope.extend_from_slice(&payload);
    envelope
}

fn generate(settings: &Rehearsal, config: &Config) {
    let timestamp = config.anchor.timestamp_us / 1_000_000;
    let prices = config
        .anchor
        .assets
        .iter()
        .map(|asset| asset.origin_price_e8)
        .collect::<Vec<_>>();
    let signed = signed_feed(&settings.feed_key(), config, timestamp, &prices);
    let capture = origin::verify_capture(
        origin::Request {
            schema: "relative.origin-request/v1".into(),
            assets: config
                .anchor
                .assets
                .iter()
                .map(|asset| origin::Asset {
                    id: asset.id.clone(),
                    feed_id: asset.feed_id,
                })
                .collect(),
            max_feed_age_ms: config.max_feed_age_ms,
        },
        &signed,
        &settings.trusted(),
        timestamp,
    )
    .unwrap();
    let receipt = universe_runtime::prepare_fresh_genesis(universe_runtime::FreshGenesisRequest {
        schema: "relative.fresh-genesis-universe-request/v1".into(),
        basic_program: config.basic_program.clone(),
        basic_pool_id: config.basic_pool_id,
        operator: config.operator.clone(),
        policy_digest: settings.policy_digest.expect("explicit test policy digest"),
        universe_digest: config.anchor.universe_digest,
        mapping: config.mapping.clone(),
        capture,
    })
    .unwrap();
    let view = receipt.validate().unwrap();
    assert_eq!(view.anchor, config.anchor);
    assert_eq!(view.mapping, config.mapping);
    receipt.persist(&config.state_directory).unwrap();
    journal::atomic_write(&settings.receipt_path, &receipt).unwrap();
    let history = FileHistory {
        directory: config.state_directory.join("prices"),
    };
    history
        .stage_observation(&config.anchor, &receipt.captured_observation().unwrap())
        .unwrap();
    universe_runtime::reconcile_committed(
        &config.state_directory,
        &receipt.canonical,
        &config.anchor,
    )
    .unwrap();
    journal::atomic_write(
        &config.state_directory.join("identity.json"),
        &json!({"identity":config.identity().unwrap(),"anchor":config.anchor}),
    )
    .unwrap();
    journal::atomic_write(&settings.report_path, &json!({"mode":"generate", "evidence":"controlled-local-test-signer-not-live-Pyth", "receiptDigest":hex::encode(view.digest), "assetCount":view.mapping.len(),"cryptoClass":view.crypto_class})).unwrap();
}

#[derive(serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InclusionCandidate {
    preparation: relative_methodology::transition::Preparation,
    policy: relative_methodology::inclusion::InclusionPolicy,
    previous_canonical: Vec<u8>,
    capture_request: activation::Request,
    schedule_parameters: serde_json::Value,
}

fn inclusion_candidate(settings: &Rehearsal, config: &Config) {
    use relative_methodology::{
        inclusion::*,
        transition::{self, Binding, OriginalReference},
    };
    let receipt: Receipt = journal::read(&settings.receipt_path).unwrap().unwrap();
    let previous = cox::UniverseVersion::from_canonical(&receipt.canonical).unwrap();
    let at = settings
        .inclusion_timestamp_seconds
        .expect("explicit local activation");
    let origin = config.anchor.timestamp_us / 1_000_000;
    assert_eq!(previous.version, 1);
    assert_eq!(previous.instruments.len(), 31);
    let policy = InclusionPolicy {
        minimum_notice_seconds: 0,
        validation_max_age_seconds: 864_000,
        max_assets: 255,
    };
    let scheduled = |instrument: &cox::Instrument, timestamp: u64| {
        let definition = AssetDefinition {
            stable_asset_id: instrument.stable_id.clone(),
            token_mint: instrument.token_mint.map(|value| value.to_string()),
            exposure_group: instrument.stable_id.clone(),
            feed: FeedIdentity::Pro {
                price_feed_id: instrument.pyth_pro_feed_id.into(),
            },
        };
        let evidence = ValidationEvidence {
            asset_digest: asset_identity_digest(&definition).unwrap(),
            source_authority: "controlled-local-test-catalogue-not-live-Pyth".into(),
            source_fact_digest: "a".repeat(64),
            assessment_digest: "b".repeat(64),
            checked_at: origin - 1,
            valid_until: at + 86400,
        };
        schedule_asset(
            approve_asset(
                validate_candidate(
                    candidate_asset(definition).unwrap(),
                    evidence,
                    origin - 1,
                    &policy,
                )
                .unwrap(),
                config.operator.clone(),
                origin - 1,
                &policy,
            )
            .unwrap(),
            timestamp,
            origin - 1,
            &policy,
        )
        .unwrap()
    };
    let prior = activate_universe(
        None,
        &previous
            .instruments
            .iter()
            .map(|value| scheduled(value, origin))
            .collect::<Vec<_>>(),
        origin,
        &policy,
    )
    .unwrap();
    let mut instruments = previous.instruments.clone();
    let addition = cox::Instrument {
        stable_id: "test32".into(),
        symbol: "TEST32".into(),
        class_id: 32,
        epoch_id: 31,
        pyth_pro_feed_id: 32,
        pyth_core_feed_id: [32; 32],
        token_mint: None,
        original_price_e8: 1,
        original_benchmark: 1,
        original_timestamp: at,
    };
    assert!(!instruments
        .iter()
        .any(|value| value.pyth_pro_feed_id == 32 || value.pyth_core_feed_id == [32; 32]));
    instruments.push(addition.clone());
    let next = activate_universe(Some(&prior), &[scheduled(&addition, at)], at, &policy).unwrap();
    let bindings = |universe: &UniverseSnapshot| {
        universe
            .assets
            .iter()
            .map(|asset| {
                let instrument = instruments
                    .iter()
                    .find(|value| value.stable_id == asset.definition.stable_asset_id)
                    .unwrap();
                Binding {
                    stable_asset_id: instrument.stable_id.clone(),
                    runtime_asset_id: instrument.symbol.clone(),
                    pro_feed_id: instrument.pyth_pro_feed_id,
                    basic_class_id: instrument.class_id,
                    epoch_asset_id: instrument.epoch_id,
                    epoch_feed_id: instrument.pyth_core_feed_id,
                    original_reference: (instrument.original_timestamp == origin).then_some(
                        OriginalReference {
                            timestamp_us: origin * 1_000_000,
                            price_e8: instrument.original_price_e8,
                            benchmark: instrument.original_benchmark,
                        },
                    ),
                }
            })
            .collect()
    };
    let preparation = transition::prepare(transition::Request {
        schema: "relative.inclusion-request/v2".into(),
        previous_bindings: bindings(&prior),
        next_bindings: bindings(&next),
        previous: prior,
        next,
    })
    .unwrap();
    let digest: [u8; 32] = hex::decode(&preparation.request.next.digest)
        .unwrap()
        .try_into()
        .unwrap();
    let capture_request = activation::Request {
        schema: "relative.activation-capture-request/v1".into(),
        previous_anchor: config.anchor.clone(),
        next_universe_digest: digest,
        fullnext_assets: instruments
            .iter()
            .map(|value| origin::Asset {
                id: value.symbol.clone(),
                feed_id: value.pyth_pro_feed_id,
            })
            .collect(),
        activation_timestamp_us: at * 1_000_000,
        max_feed_age_ms: config.max_feed_age_ms,
    };
    capture_request.validate().unwrap();
    let result = InclusionCandidate {
        preparation,
        policy,
        previous_canonical: receipt.canonical,
        capture_request,
        schedule_parameters: json!({"version":"2", "identitiesDigest":hex::encode(cox::instrument_identities_digest_for_schema(previous.schema_version,&instruments).unwrap()), "activationTimestamp":at.to_string(), "expiresAt":(at+3600).to_string(), "frozenEpochOpensAt":(at/14400*14400).to_string(), "syntheticAsset":"TEST32", "expectedInstruments":32}),
    };
    journal::atomic_write(settings.inclusion_candidate_path.as_ref().unwrap(), &result).unwrap();
    journal::atomic_write(&settings.report_path, &result.schedule_parameters).unwrap();
}

fn approve_inclusion(settings: &Rehearsal, config: &Config) {
    let candidate: InclusionCandidate =
        journal::read(settings.inclusion_candidate_path.as_ref().unwrap())
            .unwrap()
            .unwrap();
    let schedule: ScheduleEvidence =
        journal::read(settings.inclusion_schedule_path.as_ref().unwrap())
            .unwrap()
            .unwrap();
    let approved = Approved {
        schema: "relative.inclusion-approved/v1".into(),
        preparation: candidate.preparation,
        policy: candidate.policy,
        previous_canonical: candidate.previous_canonical,
        schedule,
        capture_request: candidate.capture_request,
    };
    approved.validate().unwrap();
    journal::atomic_write(
        &config.state_directory.join("inclusion-approved.json"),
        &approved,
    )
    .unwrap();
    journal::atomic_write(&settings.report_path, &json!({"approved":true,"activationTimestampUs":approved.capture_request.activation_timestamp_us,"evidence":"controlled-local-registry-schedule-and-candidate"})).unwrap();
}

fn observe(settings: &Rehearsal, config: &Config) {
    let history = FileHistory {
        directory: config.state_directory.join("prices"),
    };
    let resumed = history.latest_for_anchor(&config.anchor).unwrap();
    let mut calculator = Benchmark::new(config.anchor.clone(), history, resumed).unwrap();
    let prices = settings.prices_e8.clone().unwrap_or_else(|| {
        config
            .anchor
            .assets
            .iter()
            .map(|asset| asset.origin_price_e8)
            .collect()
    });
    let mut observations = Vec::new();
    for timestamp in settings
        .observation_timestamps_seconds
        .as_ref()
        .expect("explicit observation timestamps")
    {
        let payload = signed_feed(&settings.feed_key(), config, *timestamp, &prices);
        let batch = pyth::verify_payload(
            &payload,
            &settings.trusted(),
            *timestamp,
            config.max_feed_age_ms * 1000,
        )
        .unwrap();
        observations.push(calculator.observe(&batch, |_| Ok(())).unwrap());
    }
    journal::atomic_write(&settings.report_path, &json!({"mode":"observe", "evidence":"controlled-local-test-signer-not-live-Pyth", "observations":observations})).unwrap();
}

fn observe_tick(settings: &Rehearsal, config: &Config, timestamp_ms: u64) {
    assert_eq!(timestamp_ms % 1000, 0);
    let history = FileHistory {
        directory: config.state_directory.join("prices"),
    };
    let anchor = history
        .active_anchor()
        .unwrap()
        .unwrap_or_else(|| config.anchor.clone());
    let mut active = config.clone();
    active.anchor = anchor.clone();
    let prices = if let Some(prices) = &settings.prices_e8 {
        assert_eq!(prices.len(), config.anchor.assets.len());
        active
            .anchor
            .assets
            .iter()
            .map(|asset| {
                config
                    .anchor
                    .assets
                    .iter()
                    .position(|initial| initial.feed_id == asset.feed_id)
                    .map_or(asset.origin_price_e8, |index| prices[index])
            })
            .collect::<Vec<_>>()
    } else {
        active
            .anchor
            .assets
            .iter()
            .map(|asset| asset.origin_price_e8)
            .collect()
    };
    let latest = history.latest_for_anchor(&anchor).unwrap();
    let timestamp_us = timestamp_ms.checked_mul(1000).unwrap();
    if let Some(latest) = &latest {
        assert!(
            latest.timestamp_us <= timestamp_us,
            "future local feed history"
        );
        if latest.timestamp_us == timestamp_us {
            assert_eq!(latest.prices_e8, prices, "same-timestamp feed disagreement");
            return;
        }
    }
    let signed = signed_feed(&settings.feed_key(), &active, timestamp_ms / 1000, &prices);
    let batch = pyth::verify_payload(
        &signed,
        &settings.trusted(),
        timestamp_ms / 1000,
        config.max_feed_age_ms * 1000,
    )
    .unwrap();
    Benchmark::new(anchor, history, latest)
        .unwrap()
        .observe(&batch, |_| Ok(()))
        .unwrap();
}

struct StagedLocalHistory {
    history: FileHistory,
    anchor: Anchor,
}
impl History for StagedLocalHistory {
    fn append(&mut self, observation: &Observation) -> Result<(), crate::benchmark::Error> {
        self.history.stage_observation(&self.anchor, observation)
    }
}
struct ContinuousSidecar {
    active: Benchmark<FileHistory>,
    next: Option<Benchmark<StagedLocalHistory>>,
    approved: Approved,
    requested_at_us: u64,
    anchor_adoptions: u64,
    captured: bool,
    armed: bool,
}
impl ContinuousSidecar {
    fn new(config: &Config, approved: Approved, now: u64) -> Self {
        approved
            .capture_request
            .validate_schedule(now * 1000)
            .unwrap();
        let history = FileHistory {
            directory: config.state_directory.join("prices"),
        };
        let anchor = history
            .active_anchor()
            .unwrap()
            .unwrap_or_else(|| config.anchor.clone());
        let resumed = history.latest_for_anchor(&anchor).unwrap();
        Self {
            active: Benchmark::new(anchor, history, resumed).unwrap(),
            next: None,
            approved,
            requested_at_us: now * 1000,
            anchor_adoptions: 0,
            captured: false,
            armed: false,
        }
    }
    fn tick(
        &mut self,
        settings: &Rehearsal,
        config: &Config,
        shared: &crate::inclusion_execution::Shared,
        now: u64,
    ) {
        if !self.armed {
            if let Some(request) = shared.lock().unwrap().capture_request(now) {
                assert_eq!(request, self.approved.capture_request);
                request.validate_schedule(now * 1000).unwrap();
                self.requested_at_us = now * 1000;
                self.armed = true;
            }
        }
        let history = FileHistory {
            directory: config.state_directory.join("prices"),
        };
        let committed = history.active_anchor().unwrap().unwrap();
        if committed != *self.active.anchor() {
            self.active = Benchmark::new(
                committed.clone(),
                history.clone(),
                history.latest_for_anchor(&committed).unwrap(),
            )
            .unwrap();
            self.anchor_adoptions += 1;
            assert_eq!(
                self.anchor_adoptions, 1,
                "exactly one atomic in-process adoption"
            );
        }
        let mut feed_config = config.clone();
        feed_config.anchor.assets = self
            .approved
            .capture_request
            .fullnext_assets
            .iter()
            .map(|asset| crate::benchmark::Asset {
                id: asset.id.clone(),
                feed_id: asset.feed_id,
                origin_price_e8: config
                    .anchor
                    .assets
                    .iter()
                    .find(|old| old.feed_id == asset.feed_id)
                    .map_or(10_000_000_000, |old| old.origin_price_e8),
            })
            .collect();
        let mut prices = settings.prices_e8.clone().unwrap_or_else(|| {
            config
                .anchor
                .assets
                .iter()
                .map(|asset| asset.origin_price_e8)
                .collect()
        });
        assert_eq!(prices.len(), config.anchor.assets.len());
        prices.push(10_000_000_000);
        let payload = signed_feed(&settings.feed_key(), &feed_config, now / 1000, &prices);
        let batch = pyth::verify_payload(
            &payload,
            &settings.trusted(),
            now / 1000,
            config.max_feed_age_ms * 1000,
        )
        .unwrap();
        let mut active_config = config.clone();
        active_config.anchor = self.active.anchor().clone();
        let active_payload = signed_feed(
            &settings.feed_key(),
            &active_config,
            now / 1000,
            &prices[..active_config.anchor.assets.len()],
        );
        let active_batch = pyth::verify_payload(
            &active_payload,
            &settings.trusted(),
            now / 1000,
            config.max_feed_age_ms * 1000,
        )
        .unwrap();
        self.active.observe(&active_batch, |_| Ok(())).unwrap();
        if !self.captured && now * 1000 == self.approved.capture_request.activation_timestamp_us {
            assert!(
                self.armed,
                "confirmed schedule must arm capture before boundary"
            );
            let capture = activation::verify_capture(
                self.approved.capture_request.clone(),
                self.requested_at_us,
                &payload,
                &settings.trusted(),
                now / 1000,
            )
            .unwrap();
            assert_eq!(
                capture.old_benchmark,
                self.active.preview().unwrap().benchmark,
                "benchmark continuity at exact boundary"
            );
            shared
                .lock()
                .unwrap()
                .accept_capture(capture.clone())
                .unwrap();
            self.next = Some(
                Benchmark::new(
                    capture.next_anchor.clone(),
                    StagedLocalHistory {
                        history,
                        anchor: capture.next_anchor,
                    },
                    None,
                )
                .unwrap(),
            );
            self.captured = true;
        }
        if let Some(next) = self.next.as_mut() {
            next.observe(&batch, |_| Ok(())).unwrap();
        }
    }
}

struct PolicySigner {
    node: PathBuf,
    loader: Option<PathBuf>,
    helper: PathBuf,
    config: PathBuf,
    operator: String,
    signed_v1: Arc<AtomicU64>,
}
impl DraftSigner for PolicySigner {
    async fn sign(&self, draft: &DraftTransaction) -> Result<PendingTransaction, worker::Error> {
        if draft.unsigned_bytes.first() != Some(&solana_message::v1::V1_PREFIX) {
            return Err(worker::Error::Signer);
        }
        let mut command = Command::new(&self.node);
        if let Some(loader) = &self.loader {
            command.arg("--import").arg(loader);
        }
        let mut process = command
            .arg(&self.helper)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|_| worker::Error::Signer)?;
        let request = json!({"unsignedTransactionBase64":STANDARD.encode(&draft.unsigned_bytes),"expectedOperator":self.operator,"requestId":draft.request_id,"signerConfigPath":self.config});
        process
            .stdin
            .take()
            .ok_or(worker::Error::Signer)?
            .write_all(&serde_json::to_vec(&request).map_err(|_| worker::Error::Signer)?)
            .map_err(|_| worker::Error::Signer)?;
        let output = process
            .wait_with_output()
            .map_err(|_| worker::Error::Signer)?;
        if !output.status.success() {
            return Err(worker::Error::Signer);
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Signed {
            signed_transaction_base64: String,
            signature: String,
        }
        let response: Signed =
            serde_json::from_slice(&output.stdout).map_err(|_| worker::Error::Signer)?;
        let pending = PendingTransaction {
            signature: response.signature,
            signed_bytes: STANDARD
                .decode(response.signed_transaction_base64)
                .map_err(|_| worker::Error::Signer)?,
            last_valid_block_height: draft.last_valid_block_height,
        };
        if pending.signed_bytes.first() != Some(&solana_message::v1::V1_PREFIX) {
            return Err(worker::Error::Signer);
        }
        self.signed_v1.fetch_add(1, Ordering::Relaxed);
        Ok(pending)
    }
}

struct LocalSnapshots {
    archive: SnapshotArchive,
}
impl Snapshots for LocalSnapshots {
    fn select(
        &self,
        work: &[Work],
        closing_ms: Option<u64>,
        now_ms: u64,
    ) -> Result<Option<Observation>, worker::Error> {
        self.archive.local_rehearsal_reload()?;
        self.archive.select(work, closing_ms, now_ms)
    }
}

async fn chain_time(rpc: &Rpc) -> u64 {
    let address = "SysvarC1ock11111111111111111111111111111111";
    let clock = rpc
        .call(
            "getAccountInfo",
            json!([address,{"commitment":"processed","encoding":"base64"}]),
        )
        .await
        .unwrap();
    let data = clock
        .pointer("/value/data/0")
        .and_then(serde_json::Value::as_str)
        .expect("local Clock account bytes");
    let data = STANDARD.decode(data).unwrap();
    assert!(data.len() >= 40);
    let timestamp = i64::from_le_bytes(data[32..40].try_into().unwrap());
    u64::try_from(timestamp).unwrap().checked_mul(1000).unwrap()
}

async fn run(settings: &Rehearsal, config: &Config) {
    let rpc = Arc::new(
        Rpc::local_rehearsal(settings.rpc_url.as_ref().expect("numeric-loopback RPC URL")).unwrap(),
    );
    let local_genesis = rpc
        .call("getGenesisHash", json!([]))
        .await
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();
    let _genesis_scope = crate::rpc::LocalProtocolGenesis::at(local_genesis.clone());
    config.verify_state_identity().unwrap();
    let operator = config.operator.parse().unwrap();
    let reader = ChainReader {
        rpc: rpc.clone(),
        operator,
        basic_program: config.basic_program.parse().unwrap(),
        basic_pool_id: config.basic_pool_id,
        epoch_program: config.epoch_program.parse().unwrap(),
        epoch_config: config.epoch_config.parse().unwrap(),
    };
    let mut discovery = Discovery::new(
        reader.epoch_program,
        reader.epoch_config,
        config.first_epoch_opens_at,
    )
    .unwrap();
    let state = reader.read_with_discovery(&mut discovery).await.unwrap();
    let receipt: Receipt = journal::read(&settings.receipt_path)
        .unwrap()
        .expect("controlled signed genesis receipt");
    let view = receipt
        .validate_for_operator(&anchor_lang::prelude::Pubkey::new_from_array(
            operator.to_bytes(),
        ))
        .unwrap();
    assert_eq!(view.anchor, config.anchor);
    assert_eq!(view.mapping, config.mapping);
    let initial = universe_runtime::initial_receipt(
        &config.state_directory,
        &state.basic.methodology.canonical,
    )
    .unwrap();
    assert_eq!(initial, receipt);
    let trusted = settings.trusted();
    let view = universe_runtime::reconcile_committed_checked(
        &config.state_directory,
        &state.basic.methodology.canonical,
        &config.anchor,
        |view, observation| {
            let mut archive = SnapshotArchive::new(
                view.anchor.clone(),
                FileHistory {
                    directory: config.state_directory.join("prices"),
                },
                config.max_price_age_ms,
            )
            .map_err(|_| universe_runtime::Error::Storage)?;
            archive.local_rehearsal_signers(trusted.clone());
            archive
                .validate(observation)
                .map_err(|_| universe_runtime::Error::Storage)
        },
    )
    .unwrap();
    eprintln!("local preflight: pool.origin={} root.origin={} epoch.originBenchmark={} root.benchmark={} epoch.methodologyMatches={} classes={} mappings={} originPricesMatch={} pool.tradingOpensAt={} firstEpoch={}",
        state.basic.pool.origin, config.anchor.timestamp_us / 1_000_000,
        state.epoch_config.origin_benchmark, config.anchor.benchmark,
        state.epoch_config.methodology == view.source_methodology,
        state.basic.pool.classes.len(), view.mapping.len(),
        state.basic.pool.origin_prices == view.original_prices,
        state.basic.pool.trading_opens_at, config.first_epoch_opens_at);
    let mut snapshots = SnapshotArchive::new(
        view.anchor.clone(),
        FileHistory {
            directory: config.state_directory.join("prices"),
        },
        config.max_price_age_ms,
    )
    .unwrap();
    snapshots.local_rehearsal_signers(settings.trusted());
    let feed_watch = snapshots.local_rehearsal_feed_watch();
    let changes = Arc::new(
        crate::changes::ChainChanges::open(&config.state_directory.join("chain-change.json"))
            .unwrap(),
    );
    let signed_v1 = Arc::new(AtomicU64::new(0));
    let signer = PolicySigner {
        node: settings.node_path.clone().expect("absolute Node path"),
        loader: settings.node_loader_path.clone(),
        helper: settings
            .signer_helper_path
            .clone()
            .expect("absolute local policy helper"),
        config: settings
            .signer_config_path
            .clone()
            .expect("absolute disposable signer config"),
        operator: config.operator.clone(),
        signed_v1: signed_v1.clone(),
    };
    let inclusion = Controller::open(&config.state_directory).unwrap();
    let mut sidecar = if settings.inclusion_enabled.unwrap_or(false) {
        inclusion.lock().unwrap().refresh_file().unwrap();
        let approved: Approved =
            journal::read(&config.state_directory.join("inclusion-approved.json"))
                .unwrap()
                .unwrap();
        approved.validate().unwrap();
        Some(ContinuousSidecar::new(
            config,
            approved,
            chain_time(&rpc).await,
        ))
    } else {
        None
    };
    let audit_reader = ChainReader {
        rpc: rpc.clone(),
        operator,
        basic_program: reader.basic_program,
        basic_pool_id: reader.basic_pool_id,
        epoch_program: reader.epoch_program,
        epoch_config: reader.epoch_config,
    };
    let chain = Executor::new(
        reader,
        signer,
        view.anchor.clone(),
        view.mapping.clone(),
        Budget {
            compute_units: config.compute_units,
            priority_fee_lamports: config.priority_fee_lamports,
            heap_bytes: config.heap_bytes,
        },
        config.max_operations,
    )
    .unwrap()
    .with_price_policy_limits(config.max_price_age_ms, config.max_feed_age_ms)
    .unwrap()
    .with_inclusion(inclusion.clone())
    .with_chain_changes(changes)
    .with_preview_ledger(config.state_directory.join("preview-ledger.json"))
    .with_publication_archive(config.state_directory.join("publications"))
    .with_discovery_state(
        config.state_directory.join("discovery.json"),
        config.first_epoch_opens_at,
    )
    .unwrap()
    .with_dynamic_view(view, config.anchor.clone())
    .unwrap()
    .with_snapshot_archive(snapshots.clone());
    let mut publisher = Publisher::new(
        chain,
        LocalSnapshots { archive: snapshots },
        FileCheckpoint {
            path: config.state_directory.join("checkpoint.json"),
            identity: config.identity().unwrap(),
        },
        config.batch_limit,
        config.max_price_age_ms,
    )
    .unwrap();
    let mut ticks = Vec::new();
    let mut idle = 0;
    let advance_seconds = settings.advance_clock_seconds.unwrap_or(1);
    assert!(
        advance_seconds <= 60,
        "bounded local tick clock advancement"
    );
    for index in 0..settings.max_ticks.unwrap_or(200).min(10_000) {
        let mut timestamp_ms = chain_time(&rpc).await;
        if index > 0 && advance_seconds > 0 {
            let next = timestamp_ms
                .checked_add(advance_seconds.checked_mul(1000).unwrap())
                .unwrap();
            rpc.call("surfnet_timeTravel", json!([{"absoluteTimestamp":next}]))
                .await
                .unwrap();
            timestamp_ms = chain_time(&rpc).await;
            assert!(timestamp_ms >= next, "local validator clock advancement");
        }
        let _clock = LocalRehearsalClock::at(timestamp_ms / 1000);
        if let Some(sidecar) = sidecar.as_mut() {
            sidecar.tick(settings, config, &inclusion, timestamp_ms);
        } else if settings.observe_each_tick.unwrap_or(true) {
            observe_tick(settings, config, timestamp_ms);
        }
        let tick = crate::rpc::with_trigger("local-rehearsal", publisher.tick(timestamp_ms)).await;
        eprintln!("local rehearsal tick {timestamp_ms}: {tick:?}");
        let chain_audit = if sidecar.is_some() {
            let actual = audit_reader.read().await.unwrap();
            Some(
                json!({"confirmedSlot":actual.slot,"confirmedTimestampMs":actual.confirmed_timestamp_ms,"methodologyDigest":hex::encode(actual.basic.methodology.digest),"underlyingAssets":actual.basic.pool.classes.len()-1,"publicationSequence":actual.basic.pool.sequence,"lastBatch":actual.basic.pool.last_batch,"acceptedBatch":actual.basic.batch.as_ref().map(|batch|json!({"batchId":batch.batch_id,"sequence":batch.sequence,"cutoff":batch.cutoff,"predecessorSequence":batch.predecessor_sequence,"snapshotDigest":hex::encode(batch.snapshot_digest),"feedCount":batch.prices.len(),"cursor":batch.cursor,"queueEnd":batch.closed_queue_end,"phase":batch.phase}))}),
            )
        } else {
            None
        };
        ticks.push(
            json!({"timestampMs":timestamp_ms,"result":format!("{tick:?}"),"chain":chain_audit}),
        );
        journal::atomic_write(&settings.report_path, &json!({"mode":"run","evidence":"actual-V1-loopback-RPC-controlled-local-test-signers", "feedEvidence":"controlled-test-signatures-not-live-Pyth","wireVersion":1,"signedV1Transactions":signed_v1.load(Ordering::Relaxed),"actualLocalGenesis":local_genesis,"continuousProcessId":std::process::id(),"anchorAdoptions":sidecar.as_ref().map(|sidecar|sidecar.anchor_adoptions),"activeAssets":sidecar.as_ref().map(|sidecar|sidecar.active.anchor().assets.len()),"exactBoundaryCaptured":sidecar.as_ref().map(|sidecar|sidecar.captured),"subscriptionFeedIds":feed_watch.borrow().clone(),"ticks":ticks,"rpcUsage":rpc.usage().unwrap()})).unwrap();
        match tick.expect("actual publisher tick") {
            Tick::Idle(_) => idle += 1,
            _ => idle = 0,
        }
        if idle >= settings.stop_after_idle_ticks.unwrap_or(2)
            && sidecar
                .as_ref()
                .is_none_or(|sidecar| sidecar.anchor_adoptions == 1)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(
            settings.sleep_ms.unwrap_or(1000).min(5_000),
        ))
        .await;
    }
    rpc.persist_usage(&config.state_directory.join("rpc-usage.json"))
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires explicit disposable local rehearsal configuration and local V1-capable validator"]
async fn local_rehearsal_driver() {
    let settings = Rehearsal::read();
    let config = Config::read(&settings.runtime_config_path).unwrap();
    match settings.mode.as_str() {
        "generate" => generate(&settings, &config),
        "observe" => observe(&settings, &config),
        "inclusion-candidate" => inclusion_candidate(&settings, &config),
        "approve-inclusion" => {
            let rpc = Rpc::local_rehearsal(settings.rpc_url.as_ref().unwrap()).unwrap();
            let genesis = rpc
                .call("getGenesisHash", json!([]))
                .await
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned();
            let _scope = crate::rpc::LocalProtocolGenesis::at(genesis);
            approve_inclusion(&settings, &config)
        }
        "run" => run(&settings, &config).await,
        _ => panic!("mode must be generate, observe or run"),
    }
}

#[test]
fn rehearsal_rpc_is_loopback_only_and_production_remains_devnet_pinned() {
    for endpoint in [
        "https://127.0.0.1:8899",
        "http://example.com",
        "http://localhost:8899",
        "http://127.0.0.1:8899/path",
        "http://user@127.0.0.1:8899",
        "http://127.0.0.1:8899?key=x",
    ] {
        assert!(Rpc::local_rehearsal(endpoint).is_err(), "{endpoint}");
    }
    assert!(Rpc::local_rehearsal("http://127.0.0.1:8899").is_ok());
    assert!(Rpc::local_rehearsal("http://[::1]:8899").is_ok());
    assert_eq!(
        super::DEVNET_GENESIS,
        "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
    );
}

#[test]
fn controlled_sidecar_persists_verified_prices_and_rejects_future_history() {
    mod fixture {
        use crate as relative_publisher;
        include!("../tests/support/runtime.rs");
    }
    let directory =
        std::env::temp_dir().join(format!("relative-sidecar-test-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let config = fixture::config(directory.join("state"), 0);
    let seed = directory.join("feed-seed.json");
    journal::atomic_write(&seed, &[42_u8; 32]).unwrap();
    let settings: Rehearsal =
        serde_json::from_value(json!({"schema":"relative.local-rehearsal/v1",
        "mode":"run", "runtimeConfigPath":directory.join("runtime.json"),
        "feedSignerSeedPath":seed,"receiptPath":directory.join("receipt.json"),
        "reportPath":directory.join("report.json"), "pricesE8":[121,100]}))
        .unwrap();
    observe_tick(&settings, &config, 2000);
    observe_tick(&settings, &config, 2000);
    let history = FileHistory {
        directory: config.state_directory.join("prices"),
    };
    let latest = history.latest_for_anchor(&config.anchor).unwrap().unwrap();
    assert_eq!(latest.benchmark, 110 * cox_math::SCALE);
    let mut archive = SnapshotArchive::new(config.anchor.clone(), history, 5000).unwrap();
    archive.local_rehearsal_signers(settings.trusted());
    archive.local_rehearsal_reload().unwrap();
    archive.validate(&latest).unwrap();
    assert!(std::panic::catch_unwind(|| observe_tick(&settings, &config, 1000)).is_err());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn rehearsal_protocol_genesis_scope_restores_devnet_binding() {
    assert_eq!(crate::rpc::protocol_genesis(), crate::rpc::DEVNET_GENESIS);
    {
        let _first = crate::rpc::LocalProtocolGenesis::at("controlled-local-a".into());
        assert_eq!(crate::rpc::protocol_genesis(), "controlled-local-a");
        {
            let _second = crate::rpc::LocalProtocolGenesis::at("controlled-local-b".into());
            assert_eq!(crate::rpc::protocol_genesis(), "controlled-local-b");
        }
        assert_eq!(crate::rpc::protocol_genesis(), "controlled-local-a");
    }
    assert_eq!(crate::rpc::protocol_genesis(), crate::rpc::DEVNET_GENESIS);
}
