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
    use relative_publisher::{methodology, universe_runtime::{Evidence, GenesisRequest}};
    let (receipt, _) = receipts();
    let original = UniverseVersion::from_canonical(&receipt.canonical).unwrap();
    let Evidence::Genesis(capture) = receipt.evidence else { panic!("genesis fixture") };
    let anchor = universe_runtime::view(&receipt.canonical).unwrap().anchor;
    let prepared = methodology::prepare(methodology::Request {
        schema: "relative.methodology-request/v1".into(), version: "relative-adaptive-v1".into(),
        basic_program: cox::ID.to_string(), basic_pool_id: 2, operator: original.operator.to_string(),
        anchor: methodology::Anchor {
            universe_digest: anchor.universe_digest, timestamp_us: anchor.timestamp_us,
            benchmark: anchor.benchmark,
            assets: anchor.assets.iter().map(|asset| methodology::Asset {
                id: asset.id.clone(), feed_id: asset.feed_id, origin_price_e8: asset.origin_price_e8,
            }).collect(),
        },
        mapping: original.instruments.iter().map(|asset| methodology::Mapping {
            basic_id: asset.class_id as u8, epoch_id: asset.epoch_id, epoch_feed_id: asset.pyth_core_feed_id,
        }).collect(),
        feed_check_digest: [7; 32], max_price_age_ms: 5000, max_feed_age_ms: 60000,
        trading_opens_at: 14400,
    }).unwrap();
    let request = GenesisRequest {
        schema: "relative.genesis-universe-request/v1".into(), methodology: prepared,
        capture, predecessor_sequence: 4, predecessor_state_digest: [8; 32],
    };
    let built = universe_runtime::prepare_genesis(request.clone()).unwrap();
    let view = built.validate().unwrap();
    assert_eq!(view.anchor, anchor);
    let manifest = UniverseVersion::from_canonical(&built.canonical).unwrap();
    assert_eq!(manifest.capture.predecessor_sequence, 4);
    assert!(manifest.instruments.iter().all(|asset| asset.token_mint.is_none()));
    let mut wrong = request.clone(); wrong.capture.assets[0].price_e8 += 1;
    assert!(universe_runtime::prepare_genesis(wrong).is_err());
    let mut wrong = request.clone(); wrong.methodology.request.mapping[0].epoch_feed_id = [9; 32];
    assert!(universe_runtime::prepare_genesis(wrong).is_err());
    let mut wrong = request; wrong.predecessor_state_digest = [0; 32];
    assert!(universe_runtime::prepare_genesis(wrong).is_err());
}

#[test]
fn confirmed_activation_resumes_latest_verified_candidate_observation_after_restart() {
    use relative_publisher::{benchmark::History, journal::FileHistory, pyth};
    let (first, next) = receipts();
    let initial = first.validate().unwrap();
    let active = next.validate().unwrap();
    let root = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!(
        "relative-staged-resume-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    first.persist(&root).unwrap(); next.persist(&root).unwrap();
    let mut history = FileHistory { directory: root.join("prices") };
    history.activate(&initial.anchor).unwrap();
    history.append(&first.captured_observation().unwrap()).unwrap();
    let mut observation = next.captured_observation().unwrap();
    observation.timestamp_us += 1_000_000;
    let (signed, signers) = support::signed(observation.timestamp_us, 31, 200);
    observation.signed_payload = signed;
    assert_eq!(pyth::verify_payload(&observation.signed_payload, &signers,
        observation.timestamp_us / 1_000_000, 60_000_000).unwrap().timestamp_us, observation.timestamp_us);
    history.stage_observation(&active.anchor, &observation).unwrap();
    assert_eq!(history.active_anchor().unwrap(), Some(initial.anchor.clone()));
    universe_runtime::reconcile_committed(&root, &next.canonical, &initial.anchor).unwrap();
    assert_eq!(history.latest().unwrap(), Some(observation));
    fs::remove_dir_all(root).unwrap();
}
