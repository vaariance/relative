use ed25519_dalek::{Signer, SigningKey};
use relative_publisher::{
    origin::{self, Asset, Error, Request},
    pyth::TrustedSigner,
};
use std::{
    fs,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn request() -> Request {
    Request {
        schema: "relative.origin-request/v1".into(),
        assets: vec![
            Asset {
                id: "ETH".into(),
                feed_id: 2,
            },
            Asset {
                id: "BTC".into(),
                feed_id: 1,
            },
        ],
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
            expires_at_seconds: 100,
        }],
    )
}
#[test]
fn signed_origin_preserves_request_order_and_exact_raw_payload_without_configuration_secrets() {
    let (bytes, signers) = signed(2_000_000, &[1, 2]);
    let captured = origin::verify_capture(request(), &bytes, &signers, 2).unwrap();
    assert_eq!(
        captured
            .assets
            .iter()
            .map(|a| (&a.id, a.feed_id, a.price_e8))
            .collect::<Vec<_>>(),
        vec![(&"ETH".to_owned(), 2, 200), (&"BTC".to_owned(), 1, 100)]
    );
    assert_eq!(
        hex::decode(&captured.raw_signed_payload_hex).unwrap(),
        bytes
    );
    assert_eq!(captured.timestamp_us, 2_000_000);
    assert_eq!(captured.submitted_transactions, 0);
    assert!(
        captured.verification.signature_verified
            && captured.verification.whole_second_verified
            && captured.verification.full_roster_verified
    );
    origin::validate_capture(&captured).unwrap();
    let json = serde_json::to_string(&captured).unwrap();
    for name in [
        "PYTH_API_KEY",
        "ALCHEMY_API_KEY",
        "https://solana-devnet.g.alchemy.com",
        "universe_digest",
        "methodology",
    ] {
        assert!(!json.contains(name));
    }
    let restored = serde_json::from_str(&json).unwrap();
    origin::validate_capture(&restored).unwrap();
    for change in 0..5 {
        let mut changed = captured.clone();
        match change {
            0 => changed.assets[0].price_e8 += 1,
            1 => changed.assets.swap(0, 1),
            2 => changed.genesis_hash = "wrong-chain".into(),
            3 => changed.verification.signature_verified = false,
            _ => changed.timestamp_us += 1_000_000,
        }
        assert_eq!(origin::validate_capture(&changed), Err(Error::Verification));
    }
}
#[test]
fn stale_fractional_incomplete_untrusted_and_tampered_payloads_fail_closed() {
    let (bytes, signers) = signed(2_000_000, &[1, 2]);
    assert_eq!(
        origin::verify_capture(request(), &bytes, &signers, 8),
        Err(Error::Verification)
    );
    assert_eq!(
        origin::verify_capture(request(), &bytes, &signers, 1),
        Err(Error::Verification)
    );
    assert_eq!(
        origin::verify_capture(request(), &bytes, &[], 2),
        Err(Error::Verification)
    );
    for (timestamp, ids) in [
        (2_000_001, vec![1, 2]),
        (2_000_000, vec![1]),
        (2_000_000, vec![1, 3]),
        (2_000_000, vec![1, 2, 3]),
    ] {
        let (wrong, signers) = signed(timestamp, &ids);
        assert_eq!(
            origin::verify_capture(request(), &wrong, &signers, 2),
            Err(Error::Verification)
        );
    }
    let mut wrong = bytes;
    *wrong.last_mut().unwrap() ^= 1;
    assert_eq!(
        origin::verify_capture(request(), &wrong, &signers, 2),
        Err(Error::Verification)
    );
}
#[test]
fn invalid_request_exits_before_credentials_network_or_output_and_redacts_environment() {
    let directory = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "relative-origin-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    fs::create_dir(&directory).unwrap();
    let input = directory.join("request.json");
    let output = directory.join("origin.json");
    for change in 0..7 {
        let mut json = serde_json::to_value(request()).unwrap();
        match change {
            0 => json["assets"][1]["feed_id"] = 2.into(),
            1 => json["assets"][1]["id"] = "ETH".into(),
            2 => json["assets"][1]["feed_id"] = 0.into(),
            3 => json["max_feed_age_ms"] = 60_001.into(),
            4 => json["methodology"] = "invented".into(),
            5 => json["assets"][0]["origin_price_e8"] = 123.into(),
            _ => json["assets"] = serde_json::json!([]),
        }
        fs::write(&input, serde_json::to_vec(&json).unwrap()).unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_relative-publisher"))
            .env("ALCHEMY_API_KEY", "PRIVATE_SENTINEL")
            .env("PYTH_API_KEY", "PRIVATE_SENTINEL")
            .args(["capture-origin", "--request"])
            .arg(&input)
            .arg("--output")
            .arg(&output)
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(!output.exists());
        assert!(!String::from_utf8_lossy(&result.stderr).contains("PRIVATE_SENTINEL"));
    }
    fs::remove_dir_all(directory).unwrap();
}
