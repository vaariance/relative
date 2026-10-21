mod support;
use cox::{accounts as a, instruction as i, AdaptiveManifestConfig, Methodology, Pool, PriceWire};
use solana_sdk::{pubkey::Pubkey, signature::Signer, system_program};
use support::{pda, protocol::PoolHarness, Harness, ORIGIN};

fn config() -> AdaptiveManifestConfig {
    AdaptiveManifestConfig {
        version: "relative-adaptive-v1".into(),
        roster: vec![0, 1],
        pyth_feed_ids: vec![1, 2],
        origin: ORIGIN + 1,
        origin_prices: vec![100_000_000, 200_000_000],
        universe_digest: [43; 32],
        feed_check_digest: [42; 32],
        max_price_age_ms: 5_000,
        max_feed_age_ms: 60_000,
    }
}
fn upload(p: &mut PoolHarness, bytes: Vec<u8>) -> Pubkey {
    let admin = p.h.admin.insecure_clone();
    let digest = cox_math::artifact_digest(&bytes);
    let methodology = pda(&[b"methodology", &digest]);
    p.h.send(
        "register_adaptive",
        &[Harness::instruction(
            a::RegisterMethodology {
                admin: admin.pubkey(),
                registry: p.registry,
                methodology,
                system_program: system_program::ID,
            },
            i::RegisterMethodology {
                digest,
                length: bytes.len() as u32,
                activation_batch: 0,
            },
        )],
        &[&admin],
        true,
    );
    for (index, chunk) in bytes.chunks(600).enumerate() {
        p.h.send(
            "upload_adaptive",
            &[Harness::instruction(
                a::ManageMethodology {
                    admin: admin.pubkey(),
                    registry: p.registry,
                    methodology,
                },
                i::UploadMethodology {
                    offset: (index * 600) as u32,
                    bytes: chunk.to_vec(),
                },
            )],
            &[&admin],
            true,
        );
    }
    methodology
}
fn seal(p: &mut PoolHarness, key: Pubkey, value: AdaptiveManifestConfig, success: bool) {
    let admin = p.h.admin.insecure_clone();
    p.h.send(
        "seal_adaptive",
        &[Harness::instruction(
            a::ManageMethodology {
                admin: admin.pubkey(),
                registry: p.registry,
                methodology: key,
            },
            i::SealAdaptiveMethodology { config: value },
        )],
        &[&admin],
        success,
    );
}
fn initialize(
    p: &mut PoolHarness,
    methodology: Pubkey,
    adaptive: bool,
    success: bool,
) -> (Pubkey, Pubkey) {
    let admin = p.h.admin.insecure_clone();
    let pool = pda(&[b"pool", &1u64.to_le_bytes()]);
    let vault = pda(&[b"vault", pool.as_ref()]);
    let accounts = a::InitializePool {
        admin: admin.pubkey(),
        registry: p.registry,
        methodology,
        pool,
        mint: p.h.mint,
        vault,
        token_program: support::token_program(),
        system_program: system_program::ID,
        test_vault: None,
    };
    let instruction = if adaptive {
        Harness::instruction(
            accounts,
            i::InitializeAdaptivePool {
                pool_id: 1,
                trading_opens_at: ORIGIN + 120,
            },
        )
    } else {
        Harness::instruction(accounts, i::InitializePool { pool_id: 1 })
    };
    p.h.send(
        "initialize_selected_policy",
        &[instruction],
        &[&admin],
        success,
    );
    (pool, vault)
}
#[test]
fn adaptive_policy_seals_exact_bytes_rejects_substitution_and_separates_legacy_initialization() {
    let mut p = PoolHarness::new(2);
    let value = config();
    let bytes = cox::canonical_adaptive_manifest(&value, p.h.runtime.pubkey()).unwrap();
    let key = upload(&mut p, bytes.clone());
    let mut changed = value.clone();
    changed.pyth_feed_ids.swap(0, 1);
    seal(&mut p, key, changed, false);
    assert!(!p.h.read::<Methodology>(key).sealed);
    seal(&mut p, key, value.clone(), true);
    let methodology: Methodology = p.h.read(key);
    assert_eq!(methodology.schema_version, 2);
    assert_eq!(methodology.canonical, bytes);
    assert_eq!(
        cox::read_adaptive_manifest(&methodology).unwrap().config,
        value
    );
    seal(&mut p, key, value, false);
    initialize(&mut p, key, false, false);
    let legacy = p.methodology;
    initialize(&mut p, legacy, true, false);
    let (pool, _) = initialize(&mut p, key, true, true);
    assert_eq!(p.h.read::<Pool>(pool).origin, ORIGIN + 1);
}
#[test]
fn adaptive_bootstrap_is_bound_to_the_committed_origin_prices() {
    let mut p = PoolHarness::new(2);
    let value = config();
    let bytes = cox::canonical_adaptive_manifest(&value, p.h.runtime.pubkey()).unwrap();
    let key = upload(&mut p, bytes);
    seal(&mut p, key, value.clone(), true);
    let (pool, vault) = initialize(&mut p, key, true, true);
    p.h.time(ORIGIN + 10);
    let runtime = p.h.runtime.insecure_clone();
    let timestamp = value.origin;
    let benchmark = 100 * cox_math::SCALE;
    for (values, success) in [(vec![100_000_000; 2], false), (value.origin_prices, true)] {
        let prices = values
            .into_iter()
            .map(|price_e8| PriceWire {
                price_e8,
                venue: 3,
                step: 0,
                candle_start: timestamp,
                trade_age_minutes: 0,
            })
            .collect::<Vec<_>>();
        let snapshot = cox_math::artifact_digest(
            &cox::adaptive_snapshot_bytes(timestamp, benchmark, &value.roster, &prices).unwrap(),
        );
        p.h.send(
            "bound_origin",
            &[Harness::instruction(
                a::Publish {
                    payer: runtime.pubkey(),
                    runtime: runtime.pubkey(),
                    registry: p.registry,
                    pool,
                    methodology: key,
                    batch: pda(&[b"batch", pool.as_ref()]),
                    vault,
                    system_program: system_program::ID,
                    test_vault: None,
                },
                i::PublishAdaptive {
                    batch_id: 0,
                    sequence: 0,
                    predecessor: [0; 32],
                    prices,
                    snapshot,
                    archive_time: timestamp,
                    benchmark,
                },
            )],
            &[&runtime],
            success,
        );
    }
}
#[test]
fn adaptive_manifest_validation_and_hash_vectors_cover_every_bound_input() {
    let value = config();
    let runtime = Pubkey::new_from_array([9; 32]);
    let bytes = cox::canonical_adaptive_manifest(&value, runtime).unwrap();
    let digest = cox_math::artifact_digest(&bytes);
    assert_eq!(
        digest,
        [
            112, 254, 88, 218, 144, 207, 187, 64, 192, 36, 50, 197, 197, 58, 47, 243, 73, 84, 0,
            113, 228, 128, 171, 123, 38, 153, 143, 85, 15, 176, 129, 235
        ]
    );
    assert_eq!(bytes.len(), 1222);
    let mut legacy = cox::ManifestConfig {
        version: "test-v1".into(),
        roster: vec![0, 1],
        origin: ORIGIN,
        bybit: false,
        feed_check_digest: [42; 32],
    };
    let legacy_bytes = cox::canonical_manifest(&legacy, runtime).unwrap();
    assert_eq!(
        cox_math::artifact_digest(&legacy_bytes),
        [
            153, 169, 86, 249, 212, 155, 252, 203, 218, 133, 82, 37, 75, 121, 46, 165, 199, 241,
            39, 61, 190, 201, 121, 97, 3, 169, 158, 41, 48, 192, 44, 224
        ]
    );
    legacy.origin += 1;
    assert!(cox::canonical_manifest(&legacy, runtime).is_err());
    for bad in 0..9 {
        let mut changed = value.clone();
        match bad {
            0 => changed.roster.swap(0, 1),
            1 => changed.pyth_feed_ids[0] = 0,
            2 => changed.pyth_feed_ids[1] = changed.pyth_feed_ids[0],
            3 => changed.origin_prices[0] = 0,
            4 => changed.origin = 0,
            5 => changed.universe_digest = [0; 32],
            6 => changed.feed_check_digest = [0; 32],
            7 => changed.max_price_age_ms = 5001,
            _ => changed.max_feed_age_ms = 60001,
        };
        assert!(cox::canonical_adaptive_manifest(&changed, runtime).is_err());
    }
    for change in 0..7 {
        let mut changed = value.clone();
        match change {
            0 => changed.pyth_feed_ids[0] += 5,
            1 => changed.origin_prices[0] += 1,
            2 => changed.origin += 1,
            3 => changed.universe_digest[0] ^= 1,
            4 => changed.feed_check_digest[0] ^= 1,
            5 => changed.max_price_age_ms -= 1,
            _ => changed.max_feed_age_ms -= 1,
        };
        assert_ne!(
            cox_math::artifact_digest(
                &cox::canonical_adaptive_manifest(&changed, runtime).unwrap()
            ),
            digest
        );
    }
    assert_ne!(
        cox_math::artifact_digest(
            &cox::canonical_adaptive_manifest(&value, Pubkey::new_from_array([8; 32])).unwrap()
        ),
        digest
    );
    let mut full = value;
    full.roster = (0..30).collect();
    full.pyth_feed_ids = (1..=30).collect();
    full.origin_prices = vec![100_000_000; 30];
    let full_bytes = cox::canonical_adaptive_manifest(&full, runtime).unwrap();
    assert!(full_bytes.len() < cox::MANIFEST_LIMIT);
    let mut stored = Methodology {
        schema_version: 2,
        bump: 0,
        digest,
        canonical: bytes.clone(),
        sealed: true,
        activation_batch: 0,
        expected_length: bytes.len() as u32,
        roster: vec![0, 1],
        origin: ORIGIN + 1,
        bybit: false,
    };
    assert!(cox::read_adaptive_manifest(&stored).is_ok());
    stored.canonical.push(0);
    assert!(cox::read_adaptive_manifest(&stored).is_err());
}

#[test]
fn full_roster_adaptive_sealing_and_initialization_fit_legacy_packets() {
    let mut p = PoolHarness::new(2);
    let mut value = config();
    value.roster = (0..30).collect();
    value.pyth_feed_ids = (1..=30).collect();
    value.origin_prices = vec![100_000_000; 30];
    let bytes = cox::canonical_adaptive_manifest(&value, p.h.runtime.pubkey()).unwrap();
    let key = upload(&mut p, bytes);
    seal(&mut p, key, value, true);
    let (pool, _) = initialize(&mut p, key, true, true);
    assert_eq!(p.h.read::<Pool>(pool).classes.len(), 31);
    let measurement =
        p.h.measurements
            .iter()
            .find(|value| value.instruction == "seal_adaptive")
            .unwrap();
    assert!(measurement.transaction_bytes <= 1232);
    assert!(measurement.compute_units < 1_400_000);
}
