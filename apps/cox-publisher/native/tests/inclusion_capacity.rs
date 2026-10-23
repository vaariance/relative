#[path = "support/universe.rs"]
mod support;
use anchor_lang::{prelude::Pubkey, AccountSerialize};
use cox::{UniverseSchedule, UniverseVersion};
use relative_methodology::{
    inclusion::*,
    transition::{self, Binding, OriginalReference},
};
use relative_publisher::{
    activation,
    inclusion_execution::Approved,
    inclusion_pipeline::{self, Commitment, ScheduleEvidence},
    origin, universe_runtime,
};

fn maximum_request(authority: &str) -> inclusion_pipeline::Request {
    let (first, expanded) = support::receipts_to(255);
    let mut genesis = UniverseVersion::from_canonical(&first.canonical).unwrap();
    for (index, instrument) in genesis.instruments.iter_mut().enumerate() {
        instrument.stable_id = format!("{index:064}");
    }
    genesis.digest = genesis.canonical_digest().unwrap();
    let mut previous = UniverseVersion::from_canonical(&expanded.canonical).unwrap();
    for (index, instrument) in previous.instruments.iter_mut().enumerate() {
        instrument.stable_id = format!("{index:064}");
        if index < 30 {
            *instrument = genesis.instruments[index].clone();
        } else {
            instrument.symbol = format!("ASSET{index:011}");
            instrument.token_mint = Some(Pubkey::new_from_array([index as u8; 32]));
        }
    }
    previous.instruments.truncate(254);
    previous.capture.prices_e8.truncate(254);
    previous.expected_instruments = 254;
    previous.predecessor_digest = genesis.digest;
    let (bytes, signers) = support::signed(3_000_000, 254, 200);
    let capture = origin::verify_capture(
        origin::Request {
            schema: "relative.origin-request/v1".into(),
            assets: previous
                .instruments
                .iter()
                .map(|asset| origin::Asset {
                    id: asset.symbol.clone(),
                    feed_id: asset.pyth_pro_feed_id,
                })
                .collect(),
            max_feed_age_ms: 60_000,
        },
        &bytes,
        &signers,
        3,
    )
    .unwrap();
    previous.capture.signed_payload_digest = hex::decode(&capture.signed_payload_sha256)
        .unwrap()
        .try_into()
        .unwrap();
    previous.capture.trusted_storage_digest =
        universe_runtime::trusted_storage_digest(&capture).unwrap();
    previous.sealed = false;
    previous.digest = [0; 32];
    previous
        .seal_successor(&genesis, 200 * cox_math::SCALE)
        .unwrap();
    let mut addition = previous.instruments.last().unwrap().clone();
    addition.stable_id = format!("{:064}", 254);
    addition.symbol = format!("ASSET{:011}", 254);
    addition.class_id = 255;
    addition.epoch_id = 254;
    addition.pyth_pro_feed_id = 255;
    addition.pyth_core_feed_id = [255; 32];
    addition.token_mint = Some(Pubkey::new_from_array([254; 32]));
    addition.original_price_e8 = 400;
    addition.original_benchmark = 400 * cox_math::SCALE;
    addition.original_timestamp = 5;
    let mut instruments = previous.instruments.clone();
    instruments.push(addition);
    let policy = InclusionPolicy {
        minimum_notice_seconds: 0,
        validation_max_age_seconds: 10_000,
        max_assets: 255,
    };
    let schedule = |instrument: &cox::Instrument, at: u64| {
        let definition = AssetDefinition {
            stable_asset_id: instrument.stable_id.clone(),
            token_mint: instrument.token_mint.map(|mint| mint.to_string()),
            exposure_group: format!("group-{:058}", instrument.epoch_id),
            feed: FeedIdentity::Pro {
                price_feed_id: instrument.pyth_pro_feed_id as u64,
            },
        };
        let evidence = ValidationEvidence {
            asset_digest: asset_identity_digest(&definition).unwrap(),
            source_authority: authority.into(),
            source_fact_digest: "f".repeat(64),
            assessment_digest: "e".repeat(64),
            checked_at: 0,
            valid_until: 10_000,
        };
        schedule_asset(
            approve_asset(
                validate_candidate(candidate_asset(definition).unwrap(), evidence, 0, &policy)
                    .unwrap(),
                previous.operator.to_string(),
                0,
                &policy,
            )
            .unwrap(),
            at,
            0,
            &policy,
        )
        .unwrap()
    };
    let first = activate_universe(
        None,
        &instruments[..30]
            .iter()
            .map(|asset| schedule(asset, 1))
            .collect::<Vec<_>>(),
        1,
        &policy,
    )
    .unwrap();
    let prior = activate_universe(
        Some(&first),
        &instruments[30..254]
            .iter()
            .map(|asset| schedule(asset, 3))
            .collect::<Vec<_>>(),
        3,
        &policy,
    )
    .unwrap();
    let active =
        activate_universe(Some(&prior), &[schedule(&instruments[254], 5)], 5, &policy).unwrap();
    let bindings = |universe: &UniverseSnapshot| {
        universe
            .assets
            .iter()
            .map(|asset| {
                let instrument = instruments
                    .iter()
                    .find(|instrument| instrument.stable_id == asset.definition.stable_asset_id)
                    .unwrap();
                Binding {
                    stable_asset_id: instrument.stable_id.clone(),
                    runtime_asset_id: instrument.symbol.clone(),
                    pro_feed_id: instrument.pyth_pro_feed_id,
                    basic_class_id: instrument.class_id,
                    epoch_asset_id: instrument.epoch_id,
                    epoch_feed_id: instrument.pyth_core_feed_id,
                    original_reference: (instrument.original_timestamp < 5).then_some(
                        OriginalReference {
                            timestamp_us: instrument.original_timestamp * 1_000_000,
                            price_e8: instrument.original_price_e8,
                            benchmark: instrument.original_benchmark,
                        },
                    ),
                }
            })
            .collect()
    };
    let preparation = transition::prepare(transition::Request {
        schema: "relative.inclusion-request/v1".into(),
        previous_bindings: bindings(&prior),
        next_bindings: bindings(&active),
        previous: prior,
        next: active,
    })
    .unwrap();
    let previous_canonical = previous.canonical_bytes().unwrap();
    let (bytes, signers) = support::signed(5_000_000, 255, 400);
    let captured = activation::verify_capture(
        activation::Request {
            schema: "relative.activation-capture-request/v1".into(),
            previous_anchor: universe_runtime::view(&previous_canonical).unwrap().anchor,
            next_universe_digest: [255; 32],
            fullnext_assets: instruments
                .iter()
                .map(|asset| origin::Asset {
                    id: asset.symbol.clone(),
                    feed_id: asset.pyth_pro_feed_id,
                })
                .collect(),
            activation_timestamp_us: 5_000_000,
            max_feed_age_ms: 60_000,
        },
        4_000_000,
        &bytes,
        &signers,
        5,
    )
    .unwrap();
    let (address, bump) = Pubkey::find_program_address(
        &[
            b"universe-schedule",
            previous.pool.as_ref(),
            &3_u64.to_le_bytes(),
        ],
        &cox::ID,
    );
    let schedule = UniverseSchedule {
        schema_version: 1,
        bump,
        pool: previous.pool,
        predecessor_digest: previous.digest,
        source_methodology: previous.source_methodology,
        version: 3,
        identities_digest: cox::instrument_identities_digest(&instruments).unwrap(),
        expected_instruments: 255,
        activation_timestamp: 5,
        expires_at: 86_405,
        cancelled: false,
        consumed: false,
    };
    let mut account_data = Vec::new();
    schedule.try_serialize(&mut account_data).unwrap();
    inclusion_pipeline::Request {
        schema: "relative.inclusion-successor-request/v1".into(),
        preparation,
        policy,
        operator: previous.operator.to_bytes(),
        previous_canonical,
        schedule: ScheduleEvidence {
            genesis_hash: relative_publisher::rpc::DEVNET_GENESIS.into(),
            program: cox::ID.to_string(),
            address: address.to_string(),
            owner: cox::ID.to_string(),
            slot: 12345678901234567890,
            commitment: Commitment::Confirmed,
            account_data,
        },
        captured,
        predecessor_sequence: 12345678901234567890,
        predecessor_state_digest: [255; 32],
    }
}
#[test]
fn full_capacity_wide_identity_payloads_fit_explicit_operational_limits() {
    let request = maximum_request(&format!("x{}", "\0".repeat(255)));
    let approved = Approved {
        schema: "relative.inclusion-approved/v1".into(),
        preparation: request.preparation.clone(),
        policy: request.policy.clone(),
        previous_canonical: request.previous_canonical.clone(),
        schedule: request.schedule.clone(),
        capture_request: request.captured.request.clone(),
    };
    approved.validate().unwrap();
    let prepared = inclusion_pipeline::build_successor(request).unwrap();
    let request_bytes = serde_json::to_vec(&prepared.request).unwrap().len();
    let prepared_bytes = serde_json::to_vec(&prepared).unwrap().len();
    let approved_bytes = serde_json::to_vec(&approved).unwrap().len();
    let receipt_bytes = serde_json::to_vec(&prepared.receipt).unwrap().len();
    let stored = serde_json::json!({"schema":"relative.inclusion-execution/v1","approved":approved,"digest":([255_u8;32].to_vec()),"captured":prepared.request.captured,"prepared":prepared,"cursor":{"schema":"relative.inclusion-rollout-cursor/v1","successor_digest":([255_u8;32].to_vec()),"observed_slot":u64::MAX,"phase":"WaitingBoundaryPublication"},"phase":"Prepared","reason":null});
    let stored_bytes = serde_json::to_vec(&stored).unwrap().len();
    println!("capacity bytes request={request_bytes}, prepared={prepared_bytes}, approved={approved_bytes}, receipt={receipt_bytes}, stored={stored_bytes}");
    assert!(request_bytes as u64 <= relative_publisher::preparation::MAX_REQUEST_BYTES);
    assert!(approved_bytes as u64 <= relative_publisher::journal::MAX_JOURNAL_BYTES);
    assert!(prepared_bytes as u64 <= relative_publisher::journal::MAX_JOURNAL_BYTES);
    assert!(stored_bytes as u64 <= relative_publisher::journal::MAX_JOURNAL_BYTES);
    let directory = std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "relative-inclusion-capacity-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
    std::fs::create_dir(&directory).unwrap();
    let request_path = directory.join("request.json");
    std::fs::write(
        &request_path,
        serde_json::to_vec(&prepared.request).unwrap(),
    )
    .unwrap();
    let result =
        inclusion_pipeline::prepare_file(&request_path, &directory.join("prepared.json")).unwrap();
    assert_eq!(result, prepared);
    let journal_path = directory.join("journal.json");
    relative_publisher::journal::atomic_write(&journal_path, &stored).unwrap();
    assert_eq!(
        relative_publisher::journal::read::<serde_json::Value>(&journal_path).unwrap(),
        Some(stored)
    );
    std::fs::remove_dir_all(directory).unwrap();
}
