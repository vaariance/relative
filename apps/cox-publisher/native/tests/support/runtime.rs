use relative_publisher::{
    benchmark::{Anchor, Asset},
    executor::AssetMapping,
    runtime::Config,
};
use solana_address::Address;
use std::path::PathBuf;

pub fn config(state_directory: PathBuf, basic_pool_id: u64) -> Config {
    Config {
        schema: "relative.publisher/v1".into(),
        enabled: false,
        network: "solana-devnet".into(),
        state_directory,
        operator: Address::new_from_array([1; 32]).to_string(),
        basic_program: Address::new_from_array([2; 32]).to_string(),
        basic_pool_id,
        first_epoch_opens_at: 14_400,
        epoch_program: Address::new_from_array([3; 32]).to_string(),
        epoch_config: Address::new_from_array([4; 32]).to_string(),
        key_version: "test-key".into(),
        anchor: Anchor {
            universe_digest: [5; 32],
            timestamp_us: 1_000_000,
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
                    origin_price_e8: 100,
                },
            ],
        },
        mapping: vec![
            AssetMapping {
                basic_id: 1,
                epoch_id: 0,
                epoch_feed_id: [1; 32],
            },
            AssetMapping {
                basic_id: 2,
                epoch_id: 1,
                epoch_feed_id: [2; 32],
            },
        ],
        compute_units: 1_400_000,
        priority_fee_lamports: 100,
        heap_bytes: Some(262_144),
        batch_limit: 2,
        max_operations: 2,
        max_price_age_ms: 5_000,
        max_feed_age_ms: 60_000,
    }
}
