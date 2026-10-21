use anchor_lang::{prelude::Pubkey, AnchorDeserialize, AnchorSerialize};
use relative_publisher::methodology::{self, Anchor, Asset, Error, Mapping, Request};
use std::{
    fs,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn request() -> Request {
    Request {
        schema: "relative.methodology-request/v1".into(),
        version: "relative-adaptive-v1".into(),
        basic_program: cox::ID.to_string(),
        basic_pool_id: 2,
        operator: Pubkey::new_from_array([7; 32]).to_string(),
        anchor: Anchor {
            universe_digest: [9; 32],
            timestamp_us: 14_400_000_000,
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
                    origin_price_e8: 200,
                },
            ],
        },
        mapping: vec![
            Mapping {
                basic_id: 0,
                epoch_id: 0,
                epoch_feed_id: [1; 32],
            },
            Mapping {
                basic_id: 1,
                epoch_id: 1,
                epoch_feed_id: [2; 32],
            },
        ],
        feed_check_digest: [42; 32],
        max_price_age_ms: 5_000,
        max_feed_age_ms: 60_000,
        trading_opens_at: 28_800,
    }
}
#[test]
fn preparation_matches_exact_contract_manifest_and_instruction_arguments() {
    let result = methodology::prepare(request()).unwrap();
    let config = cox::AdaptiveManifestConfig {
        version: "relative-adaptive-v1".into(),
        roster: vec![0, 1],
        pyth_feed_ids: vec![1, 2],
        origin: 14_400,
        origin_prices: vec![100, 200],
        universe_digest: [9; 32],
        feed_check_digest: [42; 32],
        max_price_age_ms: 5_000,
        max_feed_age_ms: 60_000,
    };
    let canonical =
        cox::canonical_adaptive_manifest(&config, Pubkey::new_from_array([7; 32])).unwrap();
    assert_eq!(hex::decode(&result.canonical_hex).unwrap(), canonical);
    assert_eq!(
        result.digest,
        hex::encode(cox_math::artifact_digest(&canonical))
    );
    assert_eq!(
        result.seal_instruction_args_hex,
        hex::encode(config.try_to_vec().unwrap())
    );
    assert_eq!(
        result.pool_admission.instruction_args_hex,
        "02000000000000008070000000000000"
    );
    let decoded = cox::AdaptiveManifest::try_from_slice(&canonical).unwrap();
    assert_eq!(decoded.config, config);
    assert_eq!(decoded.policy, cox::ADAPTIVE_POLICY);
    assert_eq!(result.canonical_length as usize, canonical.len());
    assert!(!result.activated);
    methodology::validate(&result).unwrap();
    assert_eq!(
        result.digest,
        "74d0dde9b1041389264ef8cce397b0be1e916b51805058490d9ae497ffcbcec1"
    );
    assert_eq!(
        result.methodology_address,
        "mviLhyBC5fxc14UJvQYPhUNhNyE7qZ5XZ7yX7H7Gnd3"
    );
    assert_eq!(result.canonical_length, 1222);
}
#[test]
fn invalid_origins_mappings_feeds_and_admission_fail_before_output() {
    for change in 0..19 {
        let mut input = request();
        match change {
            0 => input.anchor.benchmark += 1,
            1 => input.anchor.timestamp_us += 1,
            2 => input.trading_opens_at = 1,
            3 => input.trading_opens_at = 0,
            4 => input.mapping.swap(0, 1),
            5 => input.mapping[0].basic_id = 30,
            6 => input.mapping[1].epoch_id = 0,
            7 => input.mapping[1].epoch_feed_id = [1; 32],
            8 => input.anchor.assets[0].id = "btc".into(),
            9 => input.anchor.assets[0].feed_id = 0,
            10 => input.anchor.assets[1].feed_id = 1,
            11 => input.anchor.assets[0].origin_price_e8 = 0,
            12 => input.feed_check_digest = [0; 32],
            13 => input.max_price_age_ms = 5_001,
            14 => input.max_feed_age_ms = 60_001,
            15 => input.basic_pool_id = 1,
            16 => input.operator = Pubkey::default().to_string(),
            17 => input.version = "invalid version".into(),
            _ => input.mapping.pop().map(|_| ()).unwrap(),
        }
        assert!(methodology::prepare(input).is_err(), "mutation {change}");
    }
}
#[test]
fn serialized_preparation_revalidates_and_rejects_any_changed_admission() {
    let artifact = methodology::prepare(request()).unwrap();
    let restored = serde_json::from_slice(&serde_json::to_vec(&artifact).unwrap()).unwrap();
    methodology::validate(&restored).unwrap();
    for change in 0..4 {
        let mut altered = artifact.clone();
        match change {
            0 => altered.activated = true,
            1 => altered.digest = "0".repeat(64),
            2 => altered.pool_admission.trading_opens_at += 14_400,
            _ => altered.seal_instruction_args_hex.push_str("00"),
        }
        assert_eq!(
            methodology::validate(&altered),
            Err(Error::InvalidCommitment)
        );
    }
}
#[test]
fn cli_writes_create_only_without_network_secrets_and_rejects_nested_unknown_fields() {
    let root = fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "relative-methodology-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    fs::create_dir(&root).unwrap();
    let input = root.join("request.json");
    let output = root.join("prepared.json");
    fs::write(&input, serde_json::to_vec(&request()).unwrap()).unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_relative-publisher"))
            .env_remove("ALCHEMY_API_KEY")
            .env_remove("PYTH_API_KEY")
            .env_remove("SIGNER_URL")
            .args(["prepare-methodology", "--request"])
            .arg(&input)
            .arg("--output")
            .arg(&output)
            .output()
            .unwrap()
    };
    let result = run();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(report["activated"], false);
    let bytes = fs::read(&output).unwrap();
    let artifact = serde_json::from_slice(&bytes).unwrap();
    methodology::validate(&artifact).unwrap();
    assert!(!run().status.success());
    assert_eq!(bytes, fs::read(&output).unwrap());
    fs::remove_file(&output).unwrap();
    for level in 0..4 {
        let mut json = serde_json::to_value(request()).unwrap();
        match level {
            0 => json["network"] = "mainnet".into(),
            1 => json["anchor"]["rebalance"] = true.into(),
            2 => json["anchor"]["assets"][0]["mint"] = "unverified".into(),
            _ => json["mapping"][0]["stableAssetId"] = "guessed".into(),
        }
        fs::write(&input, serde_json::to_vec(&json).unwrap()).unwrap();
        assert!(!run().status.success());
        assert!(!output.exists());
    }
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    fs::remove_dir_all(root).unwrap();
}
