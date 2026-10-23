#[path = "universe.rs"]
mod support;
use anchor_lang::{prelude::Pubkey, AccountSerialize};
use cox::{UniverseSchedule, UniverseVersion};
use relative_methodology::{
    inclusion::*,
    transition::{self, Binding, OriginalReference},
};
use relative_publisher::{
    inclusion_pipeline::{Commitment, Request, ScheduleEvidence},
    universe_runtime::Evidence,
};

pub fn request_with_count(count: usize) -> Request {
    let (first, next) = support::receipts_to(count);
    let previous = UniverseVersion::from_canonical(&first.canonical).unwrap();
    let successor = UniverseVersion::from_canonical(&next.canonical).unwrap();
    let policy = InclusionPolicy {
        minimum_notice_seconds: 0,
        validation_max_age_seconds: 1000,
        max_assets: 255,
    };
    let scheduled = |instrument: &cox::Instrument, at: u64| {
        let definition = AssetDefinition {
            stable_asset_id: instrument.stable_id.clone(),
            token_mint: instrument.token_mint.map(|key| key.to_string()),
            exposure_group: instrument.stable_id.clone(),
            feed: FeedIdentity::Pro {
                price_feed_id: u64::from(instrument.pyth_pro_feed_id),
            },
        };
        let evidence = ValidationEvidence {
            asset_digest: asset_identity_digest(&definition).unwrap(),
            source_authority: "verified-pyth-catalogue".into(),
            source_fact_digest: "a".repeat(64),
            assessment_digest: "b".repeat(64),
            checked_at: 0,
            valid_until: 1000,
        };
        schedule_asset(
            approve_asset(
                validate_candidate(candidate_asset(definition).unwrap(), evidence, 0, &policy)
                    .unwrap(),
                "2".repeat(32),
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
    let prior = activate_universe(
        None,
        &previous
            .instruments
            .iter()
            .map(|value| scheduled(value, 1))
            .collect::<Vec<_>>(),
        1,
        &policy,
    )
    .unwrap();
    let active = activate_universe(
        Some(&prior),
        &successor
            .instruments
            .iter()
            .skip(30)
            .map(|instrument| scheduled(instrument, 3))
            .collect::<Vec<_>>(),
        3,
        &policy,
    )
    .unwrap();
    let bindings = |universe: &UniverseSnapshot| {
        universe
            .assets
            .iter()
            .map(|asset| {
                let value = successor
                    .instruments
                    .iter()
                    .find(|value| value.stable_id == asset.definition.stable_asset_id)
                    .unwrap();
                Binding {
                    stable_asset_id: value.stable_id.clone(),
                    runtime_asset_id: value.symbol.clone(),
                    pro_feed_id: value.pyth_pro_feed_id,
                    basic_class_id: value.class_id,
                    epoch_asset_id: value.epoch_id,
                    epoch_feed_id: value.pyth_core_feed_id,
                    original_reference: (value.original_timestamp == 1).then_some(
                        OriginalReference {
                            timestamp_us: value.original_timestamp * 1_000_000,
                            price_e8: value.original_price_e8,
                            benchmark: value.original_benchmark,
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
    let (address, bump) = Pubkey::find_program_address(
        &[
            b"universe-schedule",
            previous.pool.as_ref(),
            &2_u64.to_le_bytes(),
        ],
        &cox::ID,
    );
    let schedule = UniverseSchedule {
        schema_version: 1,
        bump,
        pool: previous.pool,
        predecessor_digest: previous.digest,
        source_methodology: previous.source_methodology,
        version: 2,
        identities_digest: cox::instrument_identities_digest(&successor.instruments).unwrap(),
        expected_instruments: count as u16,
        activation_timestamp: 3,
        expires_at: 10,
        cancelled: false,
        consumed: false,
    };
    let mut account_data = Vec::new();
    schedule.try_serialize(&mut account_data).unwrap();
    Request {
        schema: "relative.inclusion-successor-request/v1".into(),
        preparation,
        policy,
        operator: previous.operator.to_bytes(),
        previous_canonical: first.canonical,
        schedule: ScheduleEvidence {
            genesis_hash: relative_publisher::rpc::DEVNET_GENESIS.into(),
            program: cox::ID.to_string(),
            address: address.to_string(),
            owner: cox::ID.to_string(),
            slot: 100,
            commitment: Commitment::Confirmed,
            account_data,
        },
        captured: match next.evidence {
            Evidence::Inclusion(capture) => capture,
            _ => unreachable!(),
        },
        predecessor_sequence: 1,
        predecessor_state_digest: [4; 32],
    }
}
