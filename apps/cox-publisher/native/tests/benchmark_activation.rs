use relative_methodology::inclusion::{
    activate_universe, approve_asset, asset_identity_digest, candidate_asset, schedule_asset,
    validate_candidate, AssetDefinition, FeedIdentity, InclusionPolicy, UniverseSnapshot,
    ValidationEvidence,
};
use relative_publisher::{
    benchmark::{Anchor, Asset, Batch, Benchmark, Error, FeedPrice, History, Observation},
    journal::FileHistory,
};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Memory {
    anchors: Arc<Mutex<Vec<Anchor>>>,
    fail: bool,
}
impl History for Memory {
    fn append(&mut self, _: &Observation) -> Result<(), Error> {
        Ok(())
    }
    fn activate(&mut self, anchor: &Anchor) -> Result<(), Error> {
        if self.fail {
            return Err(Error::Persistence);
        }
        self.anchors.lock().unwrap().push(anchor.clone());
        Ok(())
    }
}
fn policy() -> InclusionPolicy {
    InclusionPolicy {
        minimum_notice_seconds: 100,
        validation_max_age_seconds: 100_000,
        max_assets: 64,
    }
}
fn definition(i: u32) -> AssetDefinition {
    AssetDefinition {
        stable_asset_id: format!("asset-{i}"),
        token_mint: Some(format!("{}{}", "1".repeat(31), i + 1)),
        exposure_group: format!("underlying-{i}"),
        feed: FeedIdentity::Pro {
            price_feed_id: u64::from(i + 1),
        },
    }
}
fn scheduled(i: u32, at: u64) -> relative_methodology::inclusion::ScheduledAsset {
    let asset = definition(i);
    let evidence = ValidationEvidence {
        asset_digest: asset_identity_digest(&asset).unwrap(),
        source_authority: "audited-provider-facts".into(),
        source_fact_digest: "a".repeat(64),
        assessment_digest: "b".repeat(64),
        checked_at: 0,
        valid_until: 100_000,
    };
    schedule_asset(
        approve_asset(
            validate_candidate(candidate_asset(asset).unwrap(), evidence, 0, &policy()).unwrap(),
            "2".repeat(32),
            0,
            &policy(),
        )
        .unwrap(),
        at,
        100,
        &policy(),
    )
    .unwrap()
}
fn universes() -> (UniverseSnapshot, UniverseSnapshot) {
    let first = activate_universe(
        None,
        &[scheduled(0, 14_400), scheduled(1, 14_400)],
        14_400,
        &policy(),
    )
    .unwrap();
    let second =
        activate_universe(Some(&first), &[scheduled(2, 28_800)], 28_800, &policy()).unwrap();
    (first, second)
}
fn anchor(first: &UniverseSnapshot) -> Anchor {
    Anchor {
        universe_digest: hex::decode(&first.digest).unwrap().try_into().unwrap(),
        timestamp_us: 14_400_000_000,
        benchmark: 100_000_000_000_000,
        assets: vec![
            Asset {
                id: "asset-0".into(),
                feed_id: 1,
                origin_price_e8: 100,
            },
            Asset {
                id: "asset-1".into(),
                feed_id: 2,
                origin_price_e8: 100,
            },
        ],
    }
}
fn batch(timestamp_us: u64, prices: &[i64]) -> Batch {
    Batch {
        timestamp_us,
        prices: prices
            .iter()
            .enumerate()
            .map(|(index, price)| FeedPrice {
                feed_id: index as u32 + 1,
                price: *price,
                exponent: -8,
                confidence: 1,
            })
            .collect(),
        signed_payload: vec![1],
    }
}
#[test]
fn activation_uses_verified_prices_and_preserves_the_benchmark_level() {
    let (first, next) = universes();
    let history = Memory::default();
    let mut calculator = Benchmark::new(anchor(&first), history.clone(), None).unwrap();
    let prior = calculator
        .observe(&batch(28_800_000_000, &[121, 100, 25]), |_| Ok(()))
        .unwrap();
    assert_eq!(prior.benchmark, 110_000_000_000_000);
    let activated = calculator.activate(&first, &next).unwrap();
    assert_eq!(activated.benchmark, prior.benchmark);
    assert_eq!(activated.timestamp_us, prior.timestamp_us);
    assert_eq!(
        activated
            .assets
            .iter()
            .map(|asset| asset.origin_price_e8)
            .collect::<Vec<_>>(),
        vec![121, 100, 25]
    );
    assert_eq!(history.anchors.lock().unwrap().as_slice(), &[activated]);
    assert!(calculator.preview().is_none());
    assert_eq!(
        calculator
            .observe(&batch(28_800_000_000, &[121, 100, 25]), |_| Ok(()))
            .unwrap()
            .benchmark,
        prior.benchmark
    );
    let after = calculator
        .observe(&batch(28_801_000_000, &[242, 200, 50]), |_| Ok(()))
        .unwrap();
    assert_eq!(after.benchmark, prior.benchmark * 2);
}
#[test]
fn absent_or_unverified_additional_feeds_cannot_set_an_origin_price() {
    let (first, next) = universes();
    let mut calculator = Benchmark::new(anchor(&first), Memory::default(), None).unwrap();
    assert_eq!(
        calculator.activate(&first, &next),
        Err(Error::InvalidUniverseTransition)
    );
    calculator
        .observe(&batch(28_800_000_000, &[121, 100]), |_| Ok(()))
        .unwrap();
    assert_eq!(
        calculator.activate(&first, &next),
        Err(Error::InvalidUniverseTransition)
    );
    assert_eq!(
        calculator.observe(&batch(28_800_000_000, &[121, 100, 25]), |_| Err(
            Error::Verification
        )),
        Err(Error::Verification)
    );
    assert_eq!(
        calculator.activate(&first, &next),
        Err(Error::InvalidUniverseTransition)
    );
    calculator
        .observe(&batch(28_800_000_000, &[121, 100, 25]), |_| Ok(()))
        .unwrap();
    assert_eq!(
        calculator.activate(&first, &next),
        Err(Error::InvalidUniverseTransition)
    );
}
#[test]
fn wrong_roster_mapping_timestamp_or_snapshot_digest_is_rejected() {
    let (first, next) = universes();
    for mutation in 0..4 {
        let mut initial = anchor(&first);
        if mutation == 0 {
            initial.assets[0].id = "other-asset".into();
        }
        if mutation == 1 {
            initial.universe_digest = [7; 32];
        }
        let mut calculator = Benchmark::new(initial, Memory::default(), None).unwrap();
        calculator
            .observe(
                &batch(
                    if mutation == 2 {
                        28_801_000_000
                    } else {
                        28_800_000_000
                    },
                    &[121, 100, 25],
                ),
                |_| Ok(()),
            )
            .unwrap();
        let mut supplied = next.clone();
        if mutation == 3 {
            supplied.digest = "c".repeat(64);
        }
        assert_eq!(
            calculator.activate(&first, &supplied),
            Err(Error::InvalidUniverseTransition)
        );
    }
}
#[test]
fn unrelated_valid_universe_history_cannot_be_spliced_into_the_anchor() {
    let (first, next) = universes();
    let unrelated = activate_universe(
        None,
        &[scheduled(0, 14_401), scheduled(1, 14_401)],
        14_401,
        &policy(),
    )
    .unwrap();
    let spliced =
        activate_universe(Some(&unrelated), &[scheduled(2, 28_800)], 28_800, &policy()).unwrap();
    let mut calculator = Benchmark::new(anchor(&first), Memory::default(), None).unwrap();
    calculator
        .observe(&batch(28_800_000_000, &[121, 100, 25]), |_| Ok(()))
        .unwrap();
    assert_eq!(
        calculator.activate(&first, &spliced),
        Err(Error::InvalidUniverseTransition)
    );
    assert_eq!(
        calculator.activate(&unrelated, &next),
        Err(Error::InvalidUniverseTransition)
    );
}
#[test]
fn persistence_failure_keeps_old_anchor_and_preview_unchanged() {
    let (first, next) = universes();
    let old_anchor = anchor(&first);
    let mut calculator = Benchmark::new(
        old_anchor.clone(),
        Memory {
            fail: true,
            ..Memory::default()
        },
        None,
    )
    .unwrap();
    let prior = calculator
        .observe(&batch(28_800_000_000, &[121, 100, 25]), |_| Ok(()))
        .unwrap();
    assert_eq!(calculator.activate(&first, &next), Err(Error::Persistence));
    assert_eq!(calculator.anchor(), &old_anchor);
    assert_eq!(calculator.preview(), Some(&prior));
}
#[test]
fn histories_without_an_activation_implementation_fail_closed() {
    struct AppendOnly;
    impl History for AppendOnly {
        fn append(&mut self, _: &Observation) -> Result<(), Error> {
            Ok(())
        }
    }
    let (first, next) = universes();
    let old_anchor = anchor(&first);
    let mut calculator = Benchmark::new(old_anchor.clone(), AppendOnly, None).unwrap();
    calculator
        .observe(&batch(28_800_000_000, &[121, 100, 25]), |_| Ok(()))
        .unwrap();
    assert_eq!(calculator.activate(&first, &next), Err(Error::Persistence));
    assert_eq!(calculator.anchor(), &old_anchor);
}
#[test]
fn resumed_benchmarks_require_a_new_verified_batch_before_inclusion() {
    let (first, next) = universes();
    let original = anchor(&first);
    let mut calculator = Benchmark::new(original.clone(), Memory::default(), None).unwrap();
    let prior = calculator
        .observe(&batch(28_800_000_000, &[121, 100, 25]), |_| Ok(()))
        .unwrap();
    let mut restored = Benchmark::new(original, Memory::default(), Some(prior)).unwrap();
    assert_eq!(
        restored.activate(&first, &next),
        Err(Error::InvalidUniverseTransition)
    );
}
#[test]
fn activation_anchor_survives_restart_without_reinterpreting_old_preview() {
    let directory = std::env::temp_dir().join(format!(
        "relative-activation-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let history = FileHistory {
        directory: directory.clone(),
    };
    let (first, next) = universes();
    let original = anchor(&first);
    let mut calculator = Benchmark::new(original.clone(), history.clone(), None).unwrap();
    let old = calculator
        .observe(&batch(28_800_000_000, &[121, 100, 25]), |_| Ok(()))
        .unwrap();
    let activated = calculator.activate(&first, &next).unwrap();
    assert_eq!(history.active_anchor().unwrap(), Some(activated.clone()));
    assert_eq!(history.latest_for_anchor(&original), Err(Error::Conflict));
    assert_eq!(history.clone().append(&old), Err(Error::Conflict));
    assert_eq!(history.latest_for_anchor(&activated).unwrap(), None);
    assert_eq!(
        history
            .exact(&original.universe_digest, old.timestamp_us)
            .unwrap(),
        Some(old)
    );
    let mut resumed = Benchmark::new(
        activated.clone(),
        history.clone(),
        history.latest_for_anchor(&activated).unwrap(),
    )
    .unwrap();
    let new = resumed
        .observe(&batch(28_801_000_000, &[121, 100, 25]), |_| Ok(()))
        .unwrap();
    assert_eq!(new.benchmark, activated.benchmark);
    assert_eq!(history.latest_for_anchor(&activated).unwrap(), Some(new));
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn cryptographically_consistent_universe_cannot_remove_or_rebind_existing_assets() {
    use sha2::{Digest, Sha256};
    let (first, next) = universes();
    for remove in [false, true] {
        let mut changed = next.clone();
        let mut canonical: serde_json::Value = serde_json::from_str(&changed.canonical).unwrap();
        if remove {
            changed.assets.remove(0);
            canonical[5].as_array_mut().unwrap().remove(0);
            for asset in canonical[5].as_array_mut().unwrap() {
                asset[5] = serde_json::json!("2");
            }
        } else {
            changed.assets[0].definition.feed = FeedIdentity::Pro { price_feed_id: 4 };
            canonical[5][0][3] = serde_json::json!(["pyth-pro", 4]);
        }
        changed.canonical = canonical.to_string();
        changed.digest = hex::encode(Sha256::digest(changed.canonical.as_bytes()));
        relative_methodology::inclusion::assert_snapshot(&changed).unwrap();
        let mut calculator = Benchmark::new(anchor(&first), Memory::default(), None).unwrap();
        calculator
            .observe(&batch(28_800_000_000, &[121, 100, 25, 50]), |_| Ok(()))
            .unwrap();
        assert_eq!(
            calculator.activate(&first, &changed),
            Err(Error::InvalidUniverseTransition)
        );
    }
}

#[test]
fn benchmark_capacity_matches_the_full_methodology_universe() {
    let initial = Anchor {
        universe_digest: [9; 32],
        timestamp_us: 1_000_000,
        benchmark: 100_000_000_000_000,
        assets: (0..255)
            .map(|index| Asset {
                id: format!("asset-{index}"),
                feed_id: index + 1,
                origin_price_e8: 100,
            })
            .collect(),
    };
    let mut calculator = Benchmark::new(initial.clone(), Memory::default(), None).unwrap();
    let prices = vec![200; 255];
    let observation = calculator
        .observe(&batch(2_000_000, &prices), |_| Ok(()))
        .unwrap();
    assert_eq!(observation.benchmark, initial.benchmark * 2);
    let mut oversized = initial;
    oversized.assets.push(Asset {
        id: "asset-255".into(),
        feed_id: 256,
        origin_price_e8: 100,
    });
    assert!(matches!(
        Benchmark::new(oversized, Memory::default(), None),
        Err(Error::InvalidAnchor)
    ));
}
