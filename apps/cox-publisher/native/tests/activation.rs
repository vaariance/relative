use ed25519_dalek::{Signer, SigningKey};
use relative_publisher::{
    activation::{self, Error, Request},
    benchmark::{Anchor, Asset},
    origin,
    pyth::TrustedSigner,
};
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn request() -> Request {
    Request {
        schema: "relative.activation-capture-request/v1".into(),
        previous_anchor: Anchor {
            universe_digest: [1; 32],
            timestamp_us: 1_000_000,
            benchmark: 100_000_000_000_000,
            assets: vec![
                Asset {
                    id: "ETH".into(),
                    feed_id: 2,
                    origin_price_e8: 100,
                },
                Asset {
                    id: "BTC".into(),
                    feed_id: 1,
                    origin_price_e8: 50,
                },
            ],
        },
        next_universe_digest: [2; 32],
        fullnext_assets: vec![
            origin::Asset {
                id: "ETH".into(),
                feed_id: 2,
            },
            origin::Asset {
                id: "BTC".into(),
                feed_id: 1,
            },
            origin::Asset {
                id: "SOL".into(),
                feed_id: 3,
            },
        ],
        activation_timestamp_us: 3_000_000,
        max_feed_age_ms: 60_000,
    }
}
fn signed(timestamp: u64, feeds: &[u32]) -> (Vec<u8>, Vec<TrustedSigner>) {
    let key = SigningKey::from_bytes(&[9; 32]);
    let mut payload = 2_479_346_549_u32.to_le_bytes().to_vec();
    payload.extend_from_slice(&timestamp.to_le_bytes());
    payload.extend_from_slice(&[4, feeds.len() as u8]);
    for feed in feeds {
        payload.extend_from_slice(&feed.to_le_bytes());
        payload.extend_from_slice(&[4, 0]);
        payload.extend_from_slice(&(100_i64 * i64::from(*feed)).to_le_bytes());
        payload.push(4);
        payload.extend_from_slice(&(-8_i16).to_le_bytes());
        payload.push(5);
        payload.extend_from_slice(&1_i64.to_le_bytes());
        payload.extend_from_slice(&[12, 1]);
        payload.extend_from_slice(&timestamp.to_le_bytes());
    }
    let mut bytes = 2_182_742_457_u32.to_le_bytes().to_vec();
    bytes.extend_from_slice(&key.sign(&payload).to_bytes());
    bytes.extend_from_slice(&key.verifying_key().to_bytes());
    bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&payload);
    (
        bytes,
        vec![TrustedSigner {
            public_key: key.verifying_key().to_bytes(),
            expires_at_seconds: 1000,
        }],
    )
}
fn capture() -> activation::Captured {
    let (bytes, signers) = signed(3_000_000, &[3, 1, 2]);
    activation::verify_capture(request(), 2_000_000, &bytes, &signers, 3).unwrap()
}
#[test]
fn exact_signed_superset_preserves_order_and_benchmark_continuity() {
    let captured = capture();
    assert_eq!(captured.old_benchmark, 200_000_000_000_000);
    assert_eq!(captured.next_anchor.benchmark, captured.old_benchmark);
    assert_eq!(captured.next_anchor.universe_digest, [2; 32]);
    assert_eq!(captured.next_anchor.timestamp_us, 3_000_000);
    assert_eq!(
        captured
            .next_anchor
            .assets
            .iter()
            .map(|a| a.origin_price_e8)
            .collect::<Vec<_>>(),
        vec![200, 100, 300]
    );
    assert_eq!(
        captured.request.previous_anchor.assets[0].origin_price_e8,
        100
    );
    assert_eq!(captured.captured.assets[0].id, "ETH");
    assert_eq!(captured.submitted_transactions, 0);
    let (bytes, _) = signed(3_000_000, &[3, 1, 2]);
    assert_eq!(
        hex::decode(&captured.captured.raw_signed_payload_hex).unwrap(),
        bytes
    );
    activation::validate_capture(&captured).unwrap();
    let restored = serde_json::from_slice(&serde_json::to_vec(&captured).unwrap()).unwrap();
    assert_eq!(captured, restored);
    activation::validate_capture(&restored).unwrap();
    let at_boundary = cox_math::geometric::geometric_level(
        &[200, 100, 300],
        &[200, 100, 300],
        captured.next_anchor.benchmark,
    )
    .unwrap();
    assert_eq!(at_boundary, captured.old_benchmark);
}
#[test]
fn early_updates_are_skipped_and_later_prices_never_substitute_for_missing_boundary() {
    for timestamp in [1_000_000, 2_000_000] {
        let (bytes, signers) = signed(timestamp, &[1, 2, 3]);
        assert_eq!(
            activation::capture_update(&request(), 2_000_000, &bytes, &signers, 3),
            Ok(None)
        );
    }
    let (bytes, signers) = signed(3_000_000, &[1, 2, 3]);
    assert!(
        activation::capture_update(&request(), 2_000_000, &bytes, &signers, 3)
            .unwrap()
            .is_some()
    );
    let (bytes, signers) = signed(4_000_000, &[1, 2, 3]);
    assert_eq!(
        activation::capture_update(&request(), 2_000_000, &bytes, &signers, 4),
        Err(Error::MissedBoundary)
    );
    assert_eq!(
        activation::verify_capture(request(), 2_000_000, &bytes, &signers, 4),
        Err(Error::MissedBoundary)
    );
}
#[test]
fn prefix_uniqueness_schedule_and_single_envelope_capacity_are_required() {
    for change in 0..11 {
        let mut value = request();
        match change {
            0 => value.fullnext_assets.swap(0, 1),
            1 => value.fullnext_assets[0].feed_id = 9,
            2 => value.fullnext_assets[2].id = "BTC".into(),
            3 => value.fullnext_assets[2].feed_id = 2,
            4 => value.previous_anchor.assets[0].origin_price_e8 = 0,
            5 => value.next_universe_digest = [0; 32],
            6 => value.next_universe_digest = [1; 32],
            7 => value.activation_timestamp_us = 3_000_001,
            8 => value.previous_anchor.timestamp_us = 3_000_000,
            9 => value.fullnext_assets.truncate(2),
            _ => {
                value.fullnext_assets = (1..=256)
                    .map(|i| origin::Asset {
                        id: format!("ASSET{i}"),
                        feed_id: i,
                    })
                    .collect()
            }
        }
        assert_eq!(value.validate(), Err(Error::Request));
    }
    assert_eq!(request().validate_schedule(3_000_000), Err(Error::Schedule));
    assert_eq!(request().validate_schedule(3_000_001), Err(Error::Schedule));
    let mut far = request();
    far.activation_timestamp_us = 603_000_000;
    assert_eq!(far.validate_schedule(2_000_000), Err(Error::Schedule));
    far.activation_timestamp_us = 602_000_000;
    far.validate_schedule(2_000_000).unwrap();
    let mut maximum = request();
    maximum
        .fullnext_assets
        .extend((4..=255).map(|i| origin::Asset {
            id: format!("ASSET{i}"),
            feed_id: i,
        }));
    maximum.validate().unwrap();
}
#[test]
fn incomplete_wrong_time_untrusted_and_tampered_payloads_fail() {
    for (timestamp, ids) in [
        (3_000_000, vec![1, 2]),
        (3_000_000, vec![1, 2, 4]),
        (3_000_001, vec![1, 2, 3]),
    ] {
        let (bytes, signers) = signed(timestamp, &ids);
        assert!(activation::verify_capture(request(), 2_000_000, &bytes, &signers, 4).is_err());
    }
    let (mut bytes, signers) = signed(3_000_000, &[1, 2, 3]);
    assert_eq!(
        activation::verify_capture(request(), 2_000_000, &bytes, &[], 3),
        Err(Error::Verification)
    );
    assert_eq!(
        activation::verify_capture(request(), 2_000_000, &bytes, &signers, 9),
        Err(Error::Verification)
    );
    *bytes.last_mut().unwrap() ^= 1;
    assert_eq!(
        activation::verify_capture(request(), 2_000_000, &bytes, &signers, 3),
        Err(Error::Verification)
    );
}
#[test]
fn artifact_tampering_and_cross_universe_replay_fail_revalidation() {
    for change in 0..8 {
        let mut value = capture();
        match change {
            0 => value.old_benchmark += 1,
            1 => value.next_anchor.assets[0].origin_price_e8 += 1,
            2 => value.captured.assets.swap(0, 1),
            3 => value.captured.verification.signature_verified = false,
            4 => value.request.activation_timestamp_us += 1_000_000,
            5 => value.request.next_universe_digest = [3; 32],
            6 => value.requested_at_us = 3_000_000,
            _ => value.submitted_transactions = 1,
        }
        assert!(activation::validate_capture(&value).is_err());
    }
}
#[test]
fn capture_artifact_persistence_is_create_only() {
    let directory = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "relative-activation-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    fs::create_dir(&directory).unwrap();
    let path = directory.join("capture.json");
    let captured = capture();
    activation::persist_capture(&path, &captured).unwrap();
    let bytes = fs::read(&path).unwrap();
    assert_eq!(
        activation::persist_capture(&path, &captured),
        Err(Error::Storage)
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    let mut invalid = captured;
    invalid.digest = "0".repeat(64);
    let second = directory.join("invalid.json");
    assert!(activation::persist_capture(&second, &invalid).is_err());
    assert!(!second.exists());
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn malformed_cli_requests_fail_before_network_and_never_print_credentials() {
    let directory = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "relative-activation-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    fs::create_dir(&directory).unwrap();
    let input = directory.join("request.json");
    let output = directory.join("capture.json");
    for change in 0..4 {
        let mut value = serde_json::to_value(request()).unwrap();
        match change {
            0 => value["synthetic_verified"] = true.into(),
            1 => value["fullnext_assets"][0]["price_e8"] = 1.into(),
            2 => value["schema"] = "relative.origin-request/v1".into(),
            _ => value["activation_timestamp_us"] = 0.into(),
        }
        fs::write(&input, serde_json::to_vec(&value).unwrap()).unwrap();
        let result = std::process::Command::new(env!("CARGO_BIN_EXE_relative-publisher"))
            .env("ALCHEMY_API_KEY", "PRIVATE_SENTINEL")
            .env("PYTH_API_KEY", "PRIVATE_SENTINEL")
            .args(["capture-activation", "--request"])
            .arg(&input)
            .arg("--output")
            .arg(&output)
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(!output.exists());
        assert!(!String::from_utf8_lossy(&result.stderr).contains("PRIVATE_SENTINEL"));
        assert!(!String::from_utf8_lossy(&result.stdout).contains("PRIVATE_SENTINEL"));
    }
    fs::remove_dir_all(directory).unwrap();
}
