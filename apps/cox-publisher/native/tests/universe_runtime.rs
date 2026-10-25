#[path = "support/universe.rs"]
mod support;
use cox::UniverseVersion;
use relative_publisher::universe_runtime::{self, Receipt};
use std::fs;
fn receipts() -> (
    relative_publisher::universe_runtime::Receipt,
    relative_publisher::universe_runtime::Receipt,
) {
    support::receipts_to(31)
}

#[test]
fn signed_universe_receipts_preserve_old_references_and_restart_history() {
    let (first, next) = receipts();
    let initial = first.validate().unwrap();
    let active = next.validate().unwrap();
    assert_eq!(active.anchor.benchmark, initial.anchor.benchmark * 2);
    assert_eq!(&active.original_prices[..30], &initial.original_prices);
    assert_eq!(active.original_prices[30], 200);
    assert_eq!(active.mapping[30].basic_id, 31);
    let directory = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "relative-universe-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    first.persist(&directory).unwrap();
    universe_runtime::reconcile_committed(&directory, &first.canonical, &initial.anchor).unwrap();
    next.persist(&directory).unwrap();
    for _ in 0..2 {
        assert_eq!(
            universe_runtime::reconcile_committed(&directory, &next.canonical, &initial.anchor)
                .unwrap(),
            active
        );
    }
    fs::remove_dir_all(directory).unwrap();
}
#[test]
fn receipts_reject_wrong_lineage_prices_permanent_origins_and_storage() {
    let (first, next) = receipts();
    for mutation in 0..7 {
        let mut changed: Receipt =
            serde_json::from_slice(&serde_json::to_vec(&next).unwrap()).unwrap();
        if mutation == 0 {
            changed.genesis_hash = "other-network".into();
        } else if mutation == 1 {
            changed.previous_canonical = None;
        } else {
            let mut universe = UniverseVersion::from_canonical(&changed.canonical).unwrap();
            match mutation {
                2 => universe.instruments[0].original_price_e8 += 1,
                3 => universe.instruments[30].original_price_e8 += 1,
                4 => universe.capture.prices_e8[0] += 1,
                5 => universe.capture.trusted_storage_digest = [8; 32],
                _ => universe.predecessor_digest = [9; 32],
            }
            changed.canonical = universe.canonical_bytes().unwrap();
        }
        assert!(changed.validate().is_err(), "mutation {mutation}");
    }
    let mut changed = first;
    let mut universe = UniverseVersion::from_canonical(&changed.canonical).unwrap();
    universe.instruments[0].original_price_e8 += 1;
    changed.canonical = universe.canonical_bytes().unwrap();
    assert!(changed.validate().is_err());
}

#[test]
fn operator_binding_is_an_explicit_preparation_guard_not_historical_lineage() {
    let (_, mut receipt) = receipts();
    let mut universe = UniverseVersion::from_canonical(&receipt.canonical).unwrap();
    let prior_operator = universe.operator;
    universe.operator = anchor_lang::prelude::Pubkey::new_unique();
    receipt.canonical = universe.canonical_bytes().unwrap();
    receipt.validate().unwrap();
    assert!(receipt.validate_for_operator(&prior_operator).is_err());
    receipt.validate_for_operator(&universe.operator).unwrap();
}

#[test]
fn genesis_preparation_binds_original_methodology_and_capture_before_migration() {
    use relative_publisher::{
        methodology,
        universe_runtime::{Evidence, GenesisRequest},
    };
    let (receipt, _) = receipts();
    let original = UniverseVersion::from_canonical(&receipt.canonical).unwrap();
    let Evidence::Genesis(capture) = receipt.evidence else {
        panic!("genesis fixture")
    };
    let anchor = universe_runtime::view(&receipt.canonical).unwrap().anchor;
    let prepared = methodology::prepare(methodology::Request {
        schema: "relative.methodology-request/v1".into(),
        version: "relative-adaptive-v1".into(),
        basic_program: cox::ID.to_string(),
        basic_pool_id: 2,
        operator: original.operator.to_string(),
        anchor: methodology::Anchor {
            universe_digest: anchor.universe_digest,
            timestamp_us: anchor.timestamp_us,
            benchmark: anchor.benchmark,
            assets: anchor
                .assets
                .iter()
                .map(|asset| methodology::Asset {
                    id: asset.id.clone(),
                    feed_id: asset.feed_id,
                    origin_price_e8: asset.origin_price_e8,
                })
                .collect(),
        },
        mapping: original
            .instruments
            .iter()
            .map(|asset| methodology::Mapping {
                basic_id: asset.class_id as u8,
                epoch_id: asset.epoch_id,
                epoch_feed_id: asset.pyth_core_feed_id,
            })
            .collect(),
        feed_check_digest: [7; 32],
        max_price_age_ms: 5000,
        max_feed_age_ms: 60000,
        trading_opens_at: 14400,
    })
    .unwrap();
    let request = GenesisRequest {
        schema: "relative.genesis-universe-request/v1".into(),
        methodology: prepared,
        capture,
        predecessor_sequence: 4,
        predecessor_state_digest: [8; 32],
    };
    let built = universe_runtime::prepare_genesis(request.clone()).unwrap();
    let view = built.validate().unwrap();
    assert_eq!(view.anchor, anchor);
    let manifest = UniverseVersion::from_canonical(&built.canonical).unwrap();
    assert_eq!(manifest.capture.predecessor_sequence, 4);
    assert!(manifest
        .instruments
        .iter()
        .all(|asset| asset.token_mint.is_none()));
    let mut wrong = request.clone();
    wrong.capture.assets[0].price_e8 += 1;
    assert!(universe_runtime::prepare_genesis(wrong).is_err());
    let mut wrong = request.clone();
    wrong.methodology.request.mapping[0].epoch_feed_id = [9; 32];
    assert!(universe_runtime::prepare_genesis(wrong).is_err());
    let mut wrong = request;
    wrong.predecessor_state_digest = [0; 32];
    assert!(universe_runtime::prepare_genesis(wrong).is_err());
}

#[test]
fn confirmed_activation_resumes_latest_verified_candidate_observation_after_restart() {
    use relative_publisher::{benchmark::History, journal::FileHistory, pyth};
    let (first, next) = receipts();
    let initial = first.validate().unwrap();
    let active = next.validate().unwrap();
    let root = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "relative-staged-resume-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    first.persist(&root).unwrap();
    next.persist(&root).unwrap();
    let mut history = FileHistory {
        directory: root.join("prices"),
    };
    history.activate(&initial.anchor).unwrap();
    history
        .append(&first.captured_observation().unwrap())
        .unwrap();
    let mut observation = next.captured_observation().unwrap();
    observation.timestamp_us += 1_000_000;
    let (signed, signers) = support::signed(observation.timestamp_us, 31, 200);
    observation.signed_payload = signed;
    assert_eq!(
        pyth::verify_payload(
            &observation.signed_payload,
            &signers,
            observation.timestamp_us / 1_000_000,
            60_000_000
        )
        .unwrap()
        .timestamp_us,
        observation.timestamp_us
    );
    history
        .stage_observation(&active.anchor, &observation)
        .unwrap();
    assert_eq!(
        history.active_anchor().unwrap(),
        Some(initial.anchor.clone())
    );
    universe_runtime::reconcile_committed(&root, &next.canonical, &initial.anchor).unwrap();
    assert_eq!(history.latest().unwrap(), Some(observation));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn running_snapshot_consumers_adopt_committed_universe_without_process_restart() {
    use relative_publisher::{
        benchmark::History, journal::FileHistory, runtime::SnapshotArchive, worker::Snapshots,
    };
    let (first, next) = receipts();
    let initial = first.validate().unwrap();
    let active = next.validate().unwrap();
    let root = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "relative-live-adoption-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    first.persist(&root).unwrap();
    next.persist(&root).unwrap();
    universe_runtime::reconcile_committed(&root, &first.canonical, &initial.anchor).unwrap();
    let archive = SnapshotArchive::new(
        initial.anchor.clone(),
        FileHistory {
            directory: root.join("prices"),
        },
        5000,
    )
    .unwrap();
    let existing_consumer = archive.clone();
    let old = existing_consumer
        .select(&[], None, initial.anchor.timestamp_us / 1000)
        .unwrap()
        .unwrap();
    assert_eq!(old.prices_e8.len(), 30);
    assert_eq!(
        archive
            .adopt_committed(&next.canonical, &initial.anchor)
            .unwrap(),
        active
    );
    let selected = existing_consumer
        .select(&[], None, active.anchor.timestamp_us / 1000)
        .unwrap()
        .unwrap();
    assert_eq!(selected, next.captured_observation().unwrap());
    assert_eq!(selected.prices_e8.len(), 31);
    let mut resumed = FileHistory {
        directory: root.join("prices"),
    };
    assert_eq!(
        resumed.active_anchor().unwrap(),
        Some(active.anchor.clone())
    );
    assert!(resumed.append(&old).is_err());
    let restarted = SnapshotArchive::new(active.anchor.clone(), resumed, 5000).unwrap();
    assert_eq!(
        restarted
            .select(&[], None, active.anchor.timestamp_us / 1000)
            .unwrap(),
        Some(selected)
    );
    assert!(archive
        .adopt_committed(&first.canonical, &initial.anchor)
        .is_err());
    assert_eq!(
        existing_consumer
            .select(&[], None, active.anchor.timestamp_us / 1000)
            .unwrap()
            .unwrap()
            .prices_e8
            .len(),
        31
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn corrupted_staged_benchmark_cannot_replace_the_running_universe() {
    use relative_publisher::{
        journal::{self, FileHistory},
        runtime::SnapshotArchive,
        worker::Snapshots,
    };
    let (first, next) = receipts();
    let initial = first.validate().unwrap();
    let active = next.validate().unwrap();
    let root = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "relative-corrupt-adoption-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
    first.persist(&root).unwrap();
    next.persist(&root).unwrap();
    universe_runtime::reconcile_committed(&root, &first.canonical, &initial.anchor).unwrap();
    let history = FileHistory {
        directory: root.join("prices"),
    };
    let archive = SnapshotArchive::new(initial.anchor.clone(), history.clone(), 5_000).unwrap();
    let old = archive
        .select(&[], None, initial.anchor.timestamp_us / 1_000)
        .unwrap();
    let mut corrupted = next.captured_observation().unwrap();
    history
        .stage_observation(&active.anchor, &corrupted)
        .unwrap();
    corrupted.benchmark += 1;
    journal::atomic_write(
        &history
            .directory
            .join(hex::encode(active.anchor.universe_digest))
            .join((corrupted.timestamp_us / 3_600_000_000).to_string())
            .join(format!("{}.json", corrupted.timestamp_us)),
        &corrupted,
    )
    .unwrap();
    assert_eq!(
        archive.adopt_committed(&next.canonical, &initial.anchor),
        Err(relative_publisher::worker::Error::Storage)
    );
    assert_eq!(
        history.active_anchor().unwrap(),
        Some(initial.anchor.clone())
    );
    assert_eq!(
        archive
            .select(&[], None, initial.anchor.timestamp_us / 1_000)
            .unwrap(),
        old
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn fresh_generation_initializes_31_assets_at_100_without_adaptive_root_or_pool_two() {
    use relative_publisher::universe_runtime::{Evidence, FreshGenesisRequest};
    let (_, next) = receipts();
    let Evidence::Inclusion(inclusion) = next.evidence else {
        panic!("inclusion fixture")
    };
    let prior = UniverseVersion::from_canonical(&next.canonical).unwrap();
    let request = FreshGenesisRequest {
        schema: "relative.fresh-genesis-universe-request/v1".into(),
        basic_program: cox::ID.to_string(),
        basic_pool_id: 7,
        operator: prior.operator.to_string(),
        policy_digest: [19; 32],
        universe_digest: [20; 32],
        mapping: prior
            .instruments
            .iter()
            .enumerate()
            .map(
                |(index, asset)| relative_publisher::executor::AssetMapping {
                    basic_id: (index + 1) as u16,
                    epoch_id: asset.epoch_id,
                    epoch_feed_id: asset.pyth_core_feed_id,
                },
            )
            .collect(),
        capture: inclusion.captured,
    };
    let fresh = universe_runtime::prepare_fresh_genesis(request.clone()).unwrap();
    let view = fresh.validate().unwrap();
    assert_eq!(view.mapping.len(), 31);
    assert_eq!(view.crypto_class, 0);
    assert_eq!(view.mapping[0].basic_id, 1);
    assert_eq!(view.mapping[30].basic_id, 31);
    assert_eq!(view.anchor.benchmark, 100 * cox_math::SCALE);
    assert!(view
        .original_benchmarks
        .iter()
        .all(|reference| *reference == 100 * cox_math::SCALE));
    let manifest = UniverseVersion::from_canonical(&fresh.canonical).unwrap();
    assert_eq!(manifest.capture.predecessor_sequence, 0);
    assert_eq!(
        manifest.pool,
        anchor_lang::prelude::Pubkey::find_program_address(
            &[b"pool", &7u64.to_le_bytes()],
            &cox::ID
        )
        .0
    );
    assert_eq!(manifest.source_methodology, [19; 32]);
    let mut wrong = request.clone();
    wrong.mapping[30].basic_id = 0;
    assert!(universe_runtime::prepare_fresh_genesis(wrong).is_err());
    let mut wrong = request.clone();
    wrong.capture.assets[0].price_e8 += 1;
    assert!(universe_runtime::prepare_fresh_genesis(wrong).is_err());
    let mut wrong = request;
    wrong.policy_digest = [0; 32];
    assert!(universe_runtime::prepare_fresh_genesis(wrong).is_err());
}

#[test]
fn schema_two_successor_receipts_preserve_crypto_zero_without_reinterpreting_legacy() {
    let (mut first, mut next) = receipts();
    let legacy = first.validate().unwrap();
    assert_eq!(legacy.crypto_class, 30);
    assert_eq!(legacy.mapping[0].basic_id, 0);
    let mut initial = UniverseVersion::from_canonical(&first.canonical).unwrap();
    initial.schema_version = 2;
    for (index, instrument) in initial.instruments.iter_mut().enumerate() {
        instrument.class_id = (index + 1) as u16;
    }
    first.canonical = initial.canonical_bytes().unwrap();
    let initial = UniverseVersion::from_canonical(&first.canonical).unwrap();
    let mut successor = UniverseVersion::from_canonical(&next.canonical).unwrap();
    successor.schema_version = 2;
    successor.predecessor_digest = initial.digest;
    for (index, instrument) in successor.instruments.iter_mut().enumerate() {
        instrument.class_id = (index + 1) as u16;
    }
    next.canonical = successor.canonical_bytes().unwrap();
    next.previous_canonical = Some(first.canonical.clone());
    assert_eq!(first.validate().unwrap().crypto_class, 0);
    let active = next.validate().unwrap();
    assert_eq!(active.crypto_class, 0);
    assert_eq!(active.mapping[29].basic_id, 30);
    assert_eq!(active.mapping[30].basic_id, 31);
    assert_eq!(active.original_prices[..30], legacy.original_prices);
    assert_eq!(legacy.mapping[29].basic_id, 29);
}
