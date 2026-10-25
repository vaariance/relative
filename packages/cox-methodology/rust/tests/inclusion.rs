use relative_methodology::inclusion::*;

fn policy() -> InclusionPolicy {
    InclusionPolicy {
        minimum_notice_seconds: 100,
        validation_max_age_seconds: 100_000,
        max_assets: 64,
    }
}
fn definition(i: usize) -> AssetDefinition {
    let alphabet = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    AssetDefinition {
        stable_asset_id: format!("asset-{i}"),
        token_mint: Some(format!(
            "{}{}{}",
            "1".repeat(30),
            alphabet[i / alphabet.len()] as char,
            alphabet[i % alphabet.len()] as char
        )),
        exposure_group: format!("underlying-{i}"),
        feed: FeedIdentity::Pro {
            price_feed_id: 100 + i as u64,
        },
    }
}
fn evidence(asset: &AssetDefinition) -> ValidationEvidence {
    ValidationEvidence {
        asset_digest: asset_identity_digest(asset).unwrap(),
        source_authority: "audited-provider-facts".into(),
        source_fact_digest: "a".repeat(64),
        assessment_digest: "b".repeat(64),
        checked_at: 0,
        valid_until: 100_000,
    }
}
fn validated(asset: AssetDefinition) -> ValidatedAsset {
    let ev = evidence(&asset);
    validate_candidate(candidate_asset(asset).unwrap(), ev, 0, &policy()).unwrap()
}
fn scheduled_definition(asset: AssetDefinition, activates_at: u64) -> ScheduledAsset {
    schedule_asset(
        approve_asset(validated(asset), "2".repeat(32), 0, &policy()).unwrap(),
        activates_at,
        100,
        &policy(),
    )
    .unwrap()
}
fn scheduled(i: usize, activates_at: u64) -> ScheduledAsset {
    scheduled_definition(definition(i), activates_at)
}
fn initial() -> UniverseSnapshot {
    activate_universe(
        None,
        &[scheduled(0, 14_400), scheduled(1, 14_400)],
        14_400,
        &policy(),
    )
    .unwrap()
}

#[test]
fn canonical_commitments_match_typescript_byte_for_byte() {
    assert_eq!(
        asset_identity_digest(&definition(0)).unwrap(),
        "42eec8610a19ef727d82f4790566cac22a782ff1515b389e2047d82dcadab42b"
    );
    assert_eq!(
        asset_identity_digest(&definition(1)).unwrap(),
        "55172dd133420f3a772d5dfe8477de503d6cb0d6a0ad65a78a9d73004b561aa0"
    );
    let universe = initial();
    assert_eq!(
        universe.digest,
        "e6b483e00259c0fc2fd30aef2efcfbe3ca68b63751951b324d96219511c549af"
    );
    assert_eq!(universe.version, 1);
    assert_eq!(universe.predecessor_digest, None);
    assert_eq!(universe.methodology, METHODOLOGY);
    let reversed = activate_universe(
        None,
        &[scheduled(1, 14_400), scheduled(0, 14_400)],
        14_400,
        &policy(),
    )
    .unwrap();
    assert_eq!(universe, reversed);
    let tuple: serde_json::Value = serde_json::from_str(&universe.canonical).unwrap();
    assert_eq!(tuple[5][0][4], "1");
    assert_eq!(tuple[5][0][5], "2");
    assert_eq!(tuple[5][0][3], serde_json::json!(["pyth-pro", 100]));
}

#[test]
fn identity_binds_all_asset_fields_and_feed_namespace() {
    let original = definition(0);
    let original_digest = asset_identity_digest(&original).unwrap();
    let mut variants = Vec::new();
    let mut value = original.clone();
    value.stable_asset_id = "different".into();
    variants.push(value);
    let mut value = original.clone();
    value.token_mint = Some("2".repeat(32));
    variants.push(value);
    let mut value = original.clone();
    value.exposure_group = "other-underlying".into();
    variants.push(value);
    let mut value = original.clone();
    value.feed = FeedIdentity::Pro { price_feed_id: 999 };
    variants.push(value);
    let mut value = original.clone();
    value.feed = FeedIdentity::Core {
        price_feed_id: "c".repeat(64),
    };
    variants.push(value);
    for variant in variants {
        assert_ne!(asset_identity_digest(&variant).unwrap(), original_digest);
        assert_eq!(
            validate_candidate(
                candidate_asset(variant).unwrap(),
                evidence(&original),
                0,
                &policy()
            ),
            Err(Error::InvalidValidationEvidence)
        );
    }
}

#[test]
fn duplicates_are_rejected_across_each_exposure_dimension() {
    let original = definition(0);
    let mut variants = Vec::new();
    let mut value = definition(1);
    value.stable_asset_id = original.stable_asset_id.clone();
    variants.push(value);
    let mut value = definition(1);
    value.token_mint = original.token_mint.clone();
    variants.push(value);
    let mut value = definition(1);
    value.exposure_group = original.exposure_group.clone();
    variants.push(value);
    let mut value = definition(1);
    value.feed = original.feed.clone();
    variants.push(value);
    for variant in variants {
        assert_eq!(
            activate_universe(
                None,
                &[scheduled(0, 14_400), scheduled_definition(variant, 14_400)],
                14_400,
                &policy()
            ),
            Err(Error::DuplicateAssetExposure)
        );
    }
    assert_eq!(
        activate_universe(Some(&initial()), &[scheduled(0, 14_500)], 14_500, &policy()),
        Err(Error::DuplicateAssetExposure)
    );
}

#[test]
fn evidence_is_validated_at_every_transition() {
    let asset = definition(0);
    let valid = evidence(&asset);
    let mut invalids = Vec::new();
    let mut value = valid.clone();
    value.asset_digest = "c".repeat(64);
    invalids.push(value);
    let mut value = valid.clone();
    value.source_fact_digest = "not-a-digest".into();
    invalids.push(value);
    let mut value = valid.clone();
    value.assessment_digest = "A".repeat(64);
    invalids.push(value);
    let mut value = valid.clone();
    value.source_authority = " \u{feff}\u{2028}".into();
    invalids.push(value);
    for ev in invalids {
        assert_eq!(
            validate_candidate(candidate_asset(asset.clone()).unwrap(), ev, 0, &policy()),
            Err(Error::InvalidValidationEvidence)
        );
    }
    let mut ev = valid.clone();
    ev.checked_at = 1;
    assert_eq!(
        validate_candidate(candidate_asset(asset.clone()).unwrap(), ev, 0, &policy()),
        Err(Error::StaleValidation)
    );
    let mut ev = valid.clone();
    ev.valid_until = 0;
    assert_eq!(
        validate_candidate(candidate_asset(asset.clone()).unwrap(), ev, 0, &policy()),
        Err(Error::StaleValidation)
    );
    let mut ev = valid.clone();
    ev.valid_until = 200_000;
    assert_eq!(
        validate_candidate(
            candidate_asset(asset.clone()).unwrap(),
            ev,
            100_001,
            &policy()
        ),
        Err(Error::StaleValidation)
    );
    assert_eq!(
        approve_asset(validated(asset.clone()), "2".repeat(32), 100_000, &policy()),
        Err(Error::StaleValidation)
    );
    let approved = approve_asset(validated(asset), "2".repeat(32), 0, &policy()).unwrap();
    assert_eq!(
        schedule_asset(approved, 100_000, 100, &policy()),
        Err(Error::StaleValidation)
    );
    assert_eq!(
        activate_universe(
            None,
            &[scheduled(0, 14_400), scheduled(1, 14_400)],
            100_000,
            &policy()
        ),
        Err(Error::PrematureActivation)
    );
}

#[test]
fn scheduling_and_activation_enforce_notice_and_monotonic_time() {
    for activates_at in [0, 99] {
        let approved =
            approve_asset(validated(definition(0)), "2".repeat(32), 0, &policy()).unwrap();
        assert_eq!(
            schedule_asset(approved, activates_at, 0, &policy()),
            Err(Error::InvalidActivationSchedule)
        );
    }
    let approved = approve_asset(validated(definition(0)), "2".repeat(32), 100, &policy()).unwrap();
    assert_eq!(
        schedule_asset(approved, 200, 99, &policy()),
        Err(Error::InvalidActivationSchedule)
    );
    assert_eq!(
        activate_universe(
            None,
            &[scheduled(0, 14_400), scheduled(1, 14_400)],
            14_399,
            &policy()
        ),
        Err(Error::PrematureActivation)
    );
    assert_eq!(
        activate_universe(Some(&initial()), &[scheduled(2, 14_400)], 14_400, &policy()),
        Err(Error::NonMonotonicActivation)
    );
    assert_eq!(
        activate_universe(Some(&initial()), &[], 14_500, &policy()),
        Err(Error::EmptyActivation)
    );
}

#[test]
fn malformed_identity_and_feed_values_fail_explicitly() {
    for stable_id in ["", "Asset", "-asset", "asset/name", &"a".repeat(65)] {
        let mut asset = definition(0);
        asset.stable_asset_id = stable_id.into();
        assert_eq!(candidate_asset(asset), Err(Error::InvalidAssetIdentity));
    }
    for mint in ["0".repeat(32), "1".repeat(31), "1".repeat(45)] {
        let mut asset = definition(0);
        asset.token_mint = Some(mint);
        assert_eq!(candidate_asset(asset), Err(Error::InvalidAssetIdentity));
    }
    for feed in [
        FeedIdentity::Pro { price_feed_id: 0 },
        FeedIdentity::Pro {
            price_feed_id: MAX_SAFE_INTEGER + 1,
        },
        FeedIdentity::Core {
            price_feed_id: format!("0x{}", "a".repeat(64)),
        },
    ] {
        let mut asset = definition(0);
        asset.feed = feed;
        assert_eq!(candidate_asset(asset), Err(Error::InvalidFeedIdentity));
    }
    let mut numeric = definition(0);
    numeric.stable_asset_id = "0coin".into();
    assert!(candidate_asset(numeric).is_ok());
    assert_eq!(
        approve_asset(validated(definition(0)), "invalid".into(), 0, &policy()),
        Err(Error::InvalidApproval)
    );
}

#[test]
fn safe_integral_seconds_and_policy_bounds_match_js() {
    assert_eq!(
        activate_universe(None, &[], MAX_SAFE_INTEGER + 1, &policy()),
        Err(Error::InvalidTimestamp)
    );
    let mut invalid = policy();
    invalid.max_assets = 257;
    assert_eq!(
        activate_universe(None, &[], 0, &invalid),
        Err(Error::InvalidInclusionPolicy)
    );
    invalid = policy();
    invalid.minimum_notice_seconds = MAX_SAFE_INTEGER + 1;
    assert_eq!(
        activate_universe(None, &[], 0, &invalid),
        Err(Error::InvalidInclusionPolicy)
    );
    invalid = policy();
    invalid.validation_max_age_seconds = 0;
    assert_eq!(
        activate_universe(None, &[], 0, &invalid),
        Err(Error::InvalidInclusionPolicy)
    );
    let mut ev = evidence(&definition(0));
    ev.checked_at = MAX_SAFE_INTEGER + 1;
    assert_eq!(
        validate_candidate(candidate_asset(definition(0)).unwrap(), ev, 0, &policy()),
        Err(Error::InvalidTimestamp)
    );
    assert!(serde_json::from_str::<ValidationEvidence>(r#"{"assetDigest":"a","sourceAuthority":"a","sourceFactDigest":"a","assessmentDigest":"a","checkedAt":0.5,"validUntil":100}"#).is_err());
}

#[test]
fn frozen_epochs_retain_the_opening_universe_and_validate_history() {
    let first = initial();
    let mut frozen = freeze_epoch_universe(&[first.clone()], 14_400).unwrap();
    let second =
        activate_universe(Some(&first), &[scheduled(2, 14_401)], 14_401, &policy()).unwrap();
    assert_eq!(frozen.closes_at, 28_800);
    assert_eq!(
        freeze_epoch_universe(&[first.clone(), second.clone()], 14_400)
            .unwrap()
            .universe,
        first
    );
    assert_eq!(
        freeze_epoch_universe(&[first.clone(), second.clone()], 28_800)
            .unwrap()
            .universe,
        second
    );
    assert_eq!(
        freeze_epoch_universe(&[first.clone()], 0),
        Err(Error::NoEligibleUniverse)
    );
    assert_eq!(
        freeze_epoch_universe(&[first.clone()], 14_401),
        Err(Error::InvalidEpochBoundary)
    );
    assert_eq!(
        freeze_epoch_universe(&[second, first.clone()], 28_800),
        Err(Error::InvalidUniverseHistory)
    );
    frozen.universe.assets[0].definition.stable_asset_id = "changed".into();
    assert_eq!(first.assets[0].definition.stable_asset_id, "asset-0");
    let mut corrupt = first;
    corrupt.digest = "c".repeat(64);
    assert_eq!(
        freeze_epoch_universe(&[corrupt], 14_400),
        Err(Error::InvalidUniverseDigest)
    );
    assert_eq!(
        freeze_epoch_universe(&[], MAX_SAFE_INTEGER),
        Err(Error::InvalidTimestamp)
    );
}

#[test]
fn inclusion_reweights_all_assets_without_changing_prior_snapshots() {
    let first = initial();
    let next = activate_universe(Some(&first), &[scheduled(2, 14_500)], 14_500, &policy()).unwrap();
    assert_eq!(next.version, 2);
    assert_eq!(next.predecessor_digest.as_ref(), Some(&first.digest));
    let tuple: serde_json::Value = serde_json::from_str(&next.canonical).unwrap();
    for asset in tuple[5].as_array().unwrap() {
        assert_eq!(asset[4], "1");
        assert_eq!(asset[5], "3");
    }
    assert_eq!(first.assets.len(), 2);
    assert_snapshot(&first).unwrap();
    assert_snapshot(&next).unwrap();
}

#[test]
fn full_universe_capacity_is_distinct_from_thirty_member_baskets() {
    let additions = (0..32).map(|i| scheduled(i, 14_400)).collect::<Vec<_>>();
    assert_eq!(
        activate_universe(None, &additions, 14_400, &policy())
            .unwrap()
            .assets
            .len(),
        32
    );
    let mut limited = policy();
    limited.max_assets = 31;
    assert_eq!(
        activate_universe(None, &additions, 14_400, &limited),
        Err(Error::UniverseCapacityExceeded)
    );
    assert_eq!(
        activate_universe(None, &[scheduled(0, 14_400)], 14_400, &policy()),
        Err(Error::UniverseCapacityExceeded)
    );
    let additions = (0..255).map(|i| scheduled(i, 14_400)).collect::<Vec<_>>();
    limited.max_assets = 255;
    assert_eq!(
        activate_universe(None, &additions, 14_400, &limited)
            .unwrap()
            .assets
            .len(),
        255
    );
}

#[test]
fn persisted_snapshots_round_trip_and_digest_tampering_is_rejected() {
    let original = initial();
    let encoded = serde_json::to_string(&original).unwrap();
    let decoded: UniverseSnapshot = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded, original);
    assert_snapshot(&decoded).unwrap();
    let mut corrupt = original.clone();
    corrupt.canonical.push(' ');
    assert_eq!(assert_snapshot(&corrupt), Err(Error::InvalidUniverseDigest));
    let mut corrupt = original.clone();
    corrupt.methodology = "OTHER".into();
    assert_eq!(assert_snapshot(&corrupt), Err(Error::InvalidUniverse));
    let mut corrupt = original;
    corrupt.assets[0].definition.feed = FeedIdentity::Pro { price_feed_id: 999 };
    assert_eq!(assert_snapshot(&corrupt), Err(Error::InvalidUniverseDigest));
}

fn transition_request() -> relative_methodology::transition::Request {
    use relative_methodology::transition::{Binding, OriginalReference, Request};
    let previous = initial();
    let next =
        activate_universe(Some(&previous), &[scheduled(2, 28_800)], 28_800, &policy()).unwrap();
    let bind = |index: usize, retained: bool| Binding {
        stable_asset_id: format!("asset-{index}"),
        runtime_asset_id: format!("ASSET{index}"),
        pro_feed_id: 100 + index as u32,
        basic_class_id: index as u16,
        epoch_asset_id: index as u16,
        epoch_feed_id: [index as u8 + 1; 32],
        original_reference: retained.then_some(OriginalReference {
            timestamp_us: 14_400_000_000,
            price_e8: 100,
            benchmark: 100_000_000_000_000,
        }),
    };
    Request {
        schema: "relative.inclusion-request/v1".into(),
        previous,
        next,
        previous_bindings: (0..2).map(|i| bind(i, true)).collect(),
        next_bindings: (0..3).map(|i| bind(i, i < 2)).collect(),
    }
}
#[test]
fn inclusion_preparation_commits_explicit_mapping_and_preserves_permanent_references() {
    use relative_methodology::transition::{self, Blocker};
    let request = transition_request();
    let artifact = transition::prepare(request.clone()).unwrap();
    assert_eq!(transition::prepare(request.clone()).unwrap(), artifact);
    assert_eq!(artifact.activation_timestamp_us, 28_800_000_000);
    assert_eq!(artifact.reference_capture_required, vec!["asset-2"]);
    assert_eq!(artifact.required_pro_feed_ids, vec![100, 101, 102]);
    assert!(artifact.blockers.contains(&Blocker::BasicDynamicRoster));
    assert!(artifact
        .blockers
        .contains(&Blocker::VerifiedActivationPriceCapture));
    assert_eq!(
        &artifact.request.next_bindings[..2],
        request.previous_bindings.as_slice()
    );
    transition::validate(&artifact).unwrap();
    let json = serde_json::to_vec(&artifact).unwrap();
    let restored = serde_json::from_slice(&json).unwrap();
    transition::validate(&restored).unwrap();
    let mut tampered = artifact.clone();
    tampered.blockers.clear();
    assert_eq!(
        transition::validate(&tampered),
        Err(transition::Error::InvalidCommitment)
    );
    let mut tampered = artifact;
    tampered.request.next_bindings[0]
        .original_reference
        .as_mut()
        .unwrap()
        .price_e8 += 1;
    assert_eq!(
        transition::validate(&tampered),
        Err(transition::Error::ReferenceChanged)
    );
}
#[test]
fn inclusion_preparation_rejects_rebinding_guessed_origins_and_duplicate_class_ids() {
    use relative_methodology::transition::{self, Error};
    for change in 0..7 {
        let mut request = transition_request();
        match change {
            0 => request.next_bindings[0].runtime_asset_id = "BTC".into(),
            1 => request.next_bindings[0].pro_feed_id += 9,
            2 => request.next_bindings[2].basic_class_id = 0,
            3 => request.next_bindings[2].epoch_feed_id = request.next_bindings[0].epoch_feed_id,
            4 => {
                request.next_bindings[2].original_reference =
                    request.next_bindings[0].original_reference.clone()
            }
            5 => request.previous_bindings[0].original_reference = None,
            _ => request.next_bindings.swap(0, 1),
        }
        assert!(matches!(
            transition::prepare(request),
            Err(Error::InvalidBinding | Error::ReferenceChanged)
        ));
    }
    let mut request = transition_request();
    request.next.predecessor_digest = None;
    assert!(transition::prepare(request).is_err());
}

fn price_definition(i: usize) -> AssetDefinition {
    let mut asset = definition(i);
    asset.token_mint = None;
    asset
}

#[test]
fn price_only_identity_uses_explicit_v2_domains_and_null_mint() {
    let definition = price_definition(0);
    let digest = asset_identity_digest(&definition).unwrap();
    let expected = serde_json::json!([
        "RELATIVE/ASSET/V2",
        "asset-0",
        null,
        "underlying-0",
        ["pyth-pro", 100]
    ]);
    use sha2::{Digest, Sha256};
    assert_eq!(digest, hex::encode(Sha256::digest(expected.to_string())));
    let encoded = serde_json::to_value(&definition).unwrap();
    assert!(encoded["tokenMint"].is_null());
    assert_eq!(
        serde_json::from_value::<AssetDefinition>(encoded).unwrap(),
        definition
    );
    assert_ne!(digest, asset_identity_digest(&self::definition(0)).unwrap());
    let universe = activate_universe(
        None,
        &[
            scheduled_definition(price_definition(0), 14_400),
            scheduled_definition(price_definition(1), 14_400),
        ],
        14_400,
        &policy(),
    )
    .unwrap();
    assert_snapshot(&universe).unwrap();
    let canonical: serde_json::Value = serde_json::from_str(&universe.canonical).unwrap();
    assert_eq!(canonical[0], "RELATIVE/UNIVERSE/V2");
    assert!(canonical[5][0][1].is_null());
    let restored = serde_json::from_slice(&serde_json::to_vec(&universe).unwrap()).unwrap();
    assert_snapshot(&restored).unwrap();
    assert_eq!(universe, restored);
    let mut spoofed = universe;
    spoofed.canonical = spoofed
        .canonical
        .replace("RELATIVE/UNIVERSE/V2", "RELATIVE/UNIVERSE/V1");
    spoofed.digest = hex::encode(Sha256::digest(spoofed.canonical.as_bytes()));
    assert_eq!(assert_snapshot(&spoofed), Err(Error::InvalidUniverseDigest));
}

#[test]
fn price_only_candidates_still_require_bound_validation_and_approval() {
    let definition = price_definition(0);
    let candidate = candidate_asset(definition.clone()).unwrap();
    let wrong_evidence = evidence(&self::definition(0));
    assert_eq!(
        validate_candidate(candidate, wrong_evidence, 0, &policy()),
        Err(Error::InvalidValidationEvidence)
    );
    assert_eq!(
        approve_asset(validated(definition), "invalid".into(), 0, &policy()),
        Err(Error::InvalidApproval)
    );
}

#[test]
fn price_only_universes_preserve_all_non_mint_duplicate_checks() {
    let original = price_definition(0);
    for dimension in 0..3 {
        let mut duplicate = price_definition(1);
        match dimension {
            0 => duplicate.stable_asset_id = original.stable_asset_id.clone(),
            1 => duplicate.exposure_group = original.exposure_group.clone(),
            _ => duplicate.feed = original.feed.clone(),
        }
        assert_eq!(
            activate_universe(
                None,
                &[
                    scheduled_definition(original.clone(), 14_400),
                    scheduled_definition(duplicate, 14_400),
                ],
                14_400,
                &policy()
            ),
            Err(Error::DuplicateAssetExposure)
        );
    }
    for invalid_mint in ["".to_string(), "0".repeat(32), "not-a-solana-mint".into()] {
        let mut definition = original.clone();
        definition.token_mint = Some(invalid_mint);
        assert_eq!(
            candidate_asset(definition),
            Err(Error::InvalidAssetIdentity)
        );
    }
}

#[test]
fn minted_v1_universe_can_add_price_only_instruments_without_rewriting_history() {
    let previous = initial();
    let previous_bytes = serde_json::to_vec(&previous).unwrap();
    let next = activate_universe(
        Some(&previous),
        &[scheduled_definition(price_definition(2), 28_800)],
        28_800,
        &policy(),
    )
    .unwrap();
    assert_eq!(next.predecessor_digest.as_ref(), Some(&previous.digest));
    assert_eq!(&next.assets[..2], previous.assets.as_slice());
    assert!(next.canonical.starts_with("[\"RELATIVE/UNIVERSE/V2\","));
    assert_eq!(serde_json::to_vec(&previous).unwrap(), previous_bytes);
    assert_snapshot(&next).unwrap();
    assert_snapshot(&previous).unwrap();
    assert_eq!(
        freeze_epoch_universe(&[previous.clone(), next], 14_400)
            .unwrap()
            .universe,
        previous
    );
}

#[test]
fn inclusion_preparation_accepts_price_only_assets_without_bypassing_runtime_blockers() {
    use relative_methodology::transition::{self, Blocker};
    let previous = activate_universe(
        None,
        &[
            scheduled_definition(price_definition(0), 14_400),
            scheduled_definition(price_definition(1), 14_400),
        ],
        14_400,
        &policy(),
    )
    .unwrap();
    let next = activate_universe(
        Some(&previous),
        &[scheduled_definition(price_definition(2), 28_800)],
        28_800,
        &policy(),
    )
    .unwrap();
    let mut request = transition_request();
    request.previous = previous;
    request.next = next;
    let preparation = transition::prepare(request).unwrap();
    assert_eq!(preparation.reference_capture_required, vec!["asset-2"]);
    assert!(preparation.blockers.contains(&Blocker::BasicDynamicRoster));
    assert!(preparation
        .blockers
        .contains(&Blocker::VerifiedActivationPriceCapture));
    transition::validate(&preparation).unwrap();
}

#[test]
fn missed_activation_requires_a_new_schedule_and_capacity_reserves_crypto() {
    assert_eq!(MAX_UNIVERSE_ASSETS, 255);
    assert_eq!(
        activate_universe(
            None,
            &[scheduled(0, 14_400), scheduled(1, 14_400)],
            14_401,
            &policy()
        ),
        Err(Error::PrematureActivation)
    );
    let mut invalid = policy();
    invalid.max_assets = 256;
    assert_eq!(
        activate_universe(None, &[], 0, &invalid),
        Err(Error::InvalidInclusionPolicy)
    );
    let mut request = transition_request();
    request.next_bindings[2].basic_class_id = 30;
    assert_eq!(
        relative_methodology::transition::prepare(request),
        Err(relative_methodology::transition::Error::InvalidBinding)
    );
}

#[test]
fn validation_authority_has_an_explicit_utf8_byte_bound_without_truncation() {
    let definition = definition(0);
    let mut evidence = evidence(&definition);
    evidence.source_authority = "é".repeat(128);
    assert_eq!(evidence.source_authority.len(), MAX_SOURCE_AUTHORITY_BYTES);
    validate_candidate(
        candidate_asset(definition.clone()).unwrap(),
        evidence.clone(),
        0,
        &policy(),
    )
    .unwrap();
    evidence.source_authority.push('x');
    assert_eq!(
        evidence.source_authority.len(),
        MAX_SOURCE_AUTHORITY_BYTES + 1
    );
    assert_eq!(
        validate_candidate(candidate_asset(definition).unwrap(), evidence, 0, &policy()),
        Err(Error::InvalidValidationEvidence)
    );
}

#[test]
fn fresh_inclusion_reserves_class_zero_and_keeps_class_thirty_as_an_asset() {
    use relative_methodology::transition::{self, Error};
    let mut request = transition_request();
    request.schema = "relative.inclusion-request/v2".into();
    for binding in request
        .previous_bindings
        .iter_mut()
        .chain(&mut request.next_bindings)
    {
        binding.basic_class_id += 29;
    }
    let prepared = transition::prepare(request.clone()).unwrap();
    transition::validate(&prepared).unwrap();
    assert_eq!(prepared.request.previous_bindings[1].basic_class_id, 30);
    for previous in [false, true] {
        let mut invalid = request.clone();
        if previous {
            invalid.previous_bindings[0].basic_class_id = 0;
        } else {
            invalid.next_bindings[2].basic_class_id = 0;
        }
        assert_eq!(transition::prepare(invalid), Err(Error::InvalidBinding));
    }
    request.next_bindings[0].basic_class_id = 32;
    assert_eq!(transition::prepare(request), Err(Error::ReferenceChanged));
}

#[test]
fn legacy_inclusion_encoding_remains_unchanged_and_unknown_versions_are_rejected() {
    use relative_methodology::transition::{self, Error};
    let prepared = transition::prepare(transition_request()).unwrap();
    assert_eq!(
        prepared.digest,
        "fd8cb1a459608e934ac4c1e00a37b1efef961f12c15e333cc88ee70d4c0d697d"
    );
    let mut invalid = transition_request();
    invalid.schema = "relative.inclusion-request/v3".into();
    assert_eq!(transition::prepare(invalid), Err(Error::InvalidBinding));
}
