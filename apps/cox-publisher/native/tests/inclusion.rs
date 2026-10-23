#[path = "support/inclusion.rs"]
mod support;
use anchor_lang::prelude::Pubkey;
use cox::UniverseVersion;
use relative_publisher::inclusion_pipeline;
fn request() -> relative_publisher::inclusion_pipeline::Request {
    support::request_with_count(31)
}

#[test]
fn approved_preparation_builds_a_canonical_price_only_successor_without_network_or_transactions() {
    let prepared = inclusion_pipeline::build_successor(request()).unwrap();
    assert_eq!(prepared.status, inclusion_pipeline::Status::Prepared);
    inclusion_pipeline::validate(&prepared).unwrap();
    let successor = UniverseVersion::from_canonical(&prepared.receipt.canonical).unwrap();
    let previous = UniverseVersion::from_canonical(&prepared.request.previous_canonical).unwrap();
    assert_eq!(&successor.instruments[..30], &previous.instruments);
    assert!(successor.instruments[30].token_mint.is_none());
    assert_eq!(successor.instruments[30].class_id, 31);
    assert_eq!(successor.capture.benchmark, 200 * cox_math::SCALE);
    assert_eq!(
        prepared
            .receipt
            .captured_observation()
            .unwrap()
            .timestamp_us,
        3_000_000
    );
}
#[test]
fn preparation_rejects_unbound_schedule_account_identity_and_altered_governance_evidence() {
    for mutation in 0..8 {
        let mut changed = request();
        match mutation {
            0 => changed.schedule.owner = Pubkey::new_unique().to_string(),
            1 => changed.schedule.address = Pubkey::new_unique().to_string(),
            2 => changed.schedule.genesis_hash = "other-network".into(),
            3 => changed.schedule.slot = 0,
            4 => changed.schedule.account_data[8] ^= 1,
            5 => {
                changed
                    .preparation
                    .request
                    .next_bindings
                    .last_mut()
                    .unwrap()
                    .epoch_feed_id = [9; 32]
            }
            6 => {
                changed
                    .preparation
                    .request
                    .next
                    .assets
                    .last_mut()
                    .unwrap()
                    .evidence
                    .source_fact_digest = "not-a-hash".into()
            }
            _ => changed.captured.old_benchmark += 1,
        }
        assert!(
            inclusion_pipeline::build_successor(changed).is_err(),
            "mutation {mutation}"
        );
    }
}
#[test]
fn prepared_artifacts_are_create_only_and_revalidated_before_persistence() {
    let prepared = inclusion_pipeline::build_successor(request()).unwrap();
    let dir = std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "relative-inclusion-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    std::fs::create_dir(&dir).unwrap();
    let output = dir.join("successor.json");
    inclusion_pipeline::persist(&output, &prepared).unwrap();
    assert!(inclusion_pipeline::persist(&output, &prepared).is_err());
    let mut changed = prepared;
    changed.digest = "0".repeat(64);
    assert!(inclusion_pipeline::persist(&dir.join("false-activation.json"), &changed).is_err());
    assert!(!dir.join("false-activation.json").exists());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn successor_can_record_a_new_operator_without_rewriting_the_previous_attestor() {
    let mut request = request();
    let previous = UniverseVersion::from_canonical(&request.previous_canonical).unwrap();
    let current_operator = Pubkey::new_unique();
    request.operator = current_operator.to_bytes();
    let prepared = inclusion_pipeline::build_successor(request).unwrap();
    let next = UniverseVersion::from_canonical(&prepared.receipt.canonical).unwrap();
    assert_eq!(next.operator, current_operator);
    assert_ne!(next.operator, previous.operator);
    prepared
        .receipt
        .validate_for_operator(&current_operator)
        .unwrap();
    assert!(prepared
        .receipt
        .validate_for_operator(&previous.operator)
        .is_err());
}
