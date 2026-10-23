use anchor_lang::prelude::Pubkey;
use cox::{Instrument, UniverseCapture, UniverseVersion, IDS};
use ed25519_dalek::{Signer, SigningKey};
use relative_publisher::{
    activation, origin,
    pyth::TrustedSigner,
    rpc::DEVNET_GENESIS,
    universe_runtime::{self, Evidence, Receipt},
};

pub fn signed(timestamp: u64, count: usize, price: i64) -> (Vec<u8>, Vec<TrustedSigner>) {
    let key = SigningKey::from_bytes(&[9; 32]);
    let mut payload = 2_479_346_549_u32.to_le_bytes().to_vec();
    payload.extend_from_slice(&timestamp.to_le_bytes());
    payload.extend_from_slice(&[4, count as u8]);
    for feed in 1..=count as u32 {
        payload.extend_from_slice(&feed.to_le_bytes());
        payload.extend_from_slice(&[4, 0]);
        payload.extend_from_slice(&price.to_le_bytes());
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
fn assets(count: usize) -> Vec<origin::Asset> {
    (0..count)
        .map(|index| origin::Asset {
            id: IDS
                .get(index)
                .map_or_else(|| format!("ASSET{index}"), |value| value.to_string()),
            feed_id: index as u32 + 1,
        })
        .collect()
}
fn canonical(
    capture: &origin::Captured,
    previous: Option<&UniverseVersion>,
    benchmark: i128,
    price_digest: [u8; 32],
) -> Vec<u8> {
    let mut universe = UniverseVersion::draft(
        0,
        Pubkey::find_program_address(&[b"pool", &2_u64.to_le_bytes()], &cox::ID).0,
        Pubkey::new_from_array([2; 32]),
        [3; 32],
        previous.map_or(1, |value| value.version + 1),
        previous.map_or([0; 32], |value| value.digest),
        capture.assets.len() as u16,
        UniverseCapture {
            price_universe_digest: price_digest,
            timestamp: capture.timestamp_us / 1_000_000,
            benchmark,
            prices_e8: capture.assets.iter().map(|value| value.price_e8).collect(),
            signed_payload_digest: hex::decode(&capture.signed_payload_sha256)
                .unwrap()
                .try_into()
                .unwrap(),
            trusted_storage_digest: universe_runtime::trusted_storage_digest(capture).unwrap(),
            predecessor_sequence: 1,
            predecessor_state_digest: [4; 32],
        },
    )
    .unwrap();
    universe.instruments = capture
        .assets
        .iter()
        .enumerate()
        .map(|(index, asset)| {
            previous
                .and_then(|value| value.instruments.get(index))
                .cloned()
                .unwrap_or_else(|| Instrument {
                    stable_id: asset.id.to_ascii_lowercase(),
                    symbol: asset.id.clone(),
                    class_id: cox::class_for_asset_index(index).unwrap(),
                    epoch_id: index as u16,
                    pyth_pro_feed_id: asset.feed_id,
                    pyth_core_feed_id: [index as u8 + 1; 32],
                    token_mint: None,
                    original_price_e8: asset.price_e8,
                    original_benchmark: benchmark,
                    original_timestamp: capture.timestamp_us / 1_000_000,
                })
        })
        .collect();
    universe.canonical_bytes().unwrap()
}
pub fn receipts_to(count: usize) -> (Receipt, Receipt) {
    let (bytes, signers) = signed(1_000_000, 30, 100);
    let origin = origin::verify_capture(
        origin::Request {
            schema: "relative.origin-request/v1".into(),
            assets: assets(30),
            max_feed_age_ms: 60_000,
        },
        &bytes,
        &signers,
        1,
    )
    .unwrap();
    let first = Receipt {
        schema: "relative.runtime-universe-receipt/v1".into(),
        genesis_hash: DEVNET_GENESIS.into(),
        canonical: canonical(&origin, None, 100 * cox_math::SCALE, [5; 32]),
        previous_canonical: None,
        evidence: Evidence::Genesis(origin),
    };
    let view = first.validate().unwrap();
    let (bytes, signers) = signed(3_000_000, count, 200);
    let capture = activation::verify_capture(
        activation::Request {
            schema: "relative.activation-capture-request/v1".into(),
            previous_anchor: view.anchor,
            next_universe_digest: [6; 32],
            fullnext_assets: assets(count),
            activation_timestamp_us: 3_000_000,
            max_feed_age_ms: 60_000,
        },
        2_000_000,
        &bytes,
        &signers,
        3,
    )
    .unwrap();
    let prior = UniverseVersion::from_canonical(&first.canonical).unwrap();
    let next = Receipt {
        schema: first.schema.clone(),
        genesis_hash: first.genesis_hash.clone(),
        canonical: canonical(
            &capture.captured,
            Some(&prior),
            capture.old_benchmark,
            [6; 32],
        ),
        previous_canonical: Some(first.canonical.clone()),
        evidence: Evidence::Inclusion(capture),
    };
    (first, next)
}
