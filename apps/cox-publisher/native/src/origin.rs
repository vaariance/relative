use crate::{
    benchmark::price_e8,
    feeds::{self, PythConfig},
    preparation,
    pyth::{self, TrustedSigner},
    rpc::{Rpc, DEVNET_GENESIS},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, watch};

const STORAGE_ACCOUNT: &str = "3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL";
const STORAGE_OWNER: &str = "pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Asset {
    pub id: String,
    pub feed_id: u32,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema: String,
    pub assets: Vec<Asset>,
    pub max_feed_age_ms: u64,
}
impl Request {
    pub fn validate(&self) -> Result<(), Error> {
        let mut names = BTreeSet::new();
        let mut feeds = BTreeSet::new();
        if self.schema != "relative.origin-request/v1"
            || !(2..=255).contains(&self.assets.len())
            || !(1..=60_000).contains(&self.max_feed_age_ms)
        {
            return Err(Error::Request);
        }
        for asset in &self.assets {
            if asset.id.is_empty()
                || asset.id.len() > 64
                || !asset
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
                || asset.feed_id == 0
                || !names.insert(&asset.id)
                || !feeds.insert(asset.feed_id)
            {
                return Err(Error::Request);
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapturedAsset {
    pub id: String,
    pub feed_id: u32,
    pub price_e8: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Signer {
    pub public_key: [u8; 32],
    pub expires_at_seconds: i64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Verification {
    pub signature_verified: bool,
    pub full_roster_verified: bool,
    pub whole_second_verified: bool,
    pub verified_at_seconds: u64,
    pub storage_account: String,
    pub storage_owner: String,
    pub storage_commitment: String,
    pub trusted_signers: Vec<Signer>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Captured {
    pub schema: String,
    pub network: String,
    pub genesis_hash: String,
    pub request: Request,
    pub timestamp_us: u64,
    pub assets: Vec<CapturedAsset>,
    pub raw_signed_payload_hex: String,
    pub signed_payload_sha256: String,
    pub verification: Verification,
    pub submitted_transactions: u64,
    pub digest: String,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Request,
    Credentials,
    Rpc,
    Feed,
    Verification,
    Clock,
    Storage,
}
pub fn verify_capture(
    request: Request,
    bytes: &[u8],
    signers: &[TrustedSigner],
    now_seconds: u64,
) -> Result<Captured, Error> {
    request.validate()?;
    let data = pyth::verify_payload(bytes, signers, now_seconds, request.max_feed_age_ms * 1000)
        .map_err(|_| Error::Verification)?;
    if data.timestamp_us % 1_000_000 != 0
        || data.timestamp_us / 1_000_000 > now_seconds
        || now_seconds - data.timestamp_us / 1_000_000 > 5
        || data.prices.len() != request.assets.len()
    {
        return Err(Error::Verification);
    }
    let mut assets = Vec::with_capacity(request.assets.len());
    for asset in &request.assets {
        let value = data
            .prices
            .iter()
            .find(|value| value.feed_id == asset.feed_id)
            .ok_or(Error::Verification)?;
        assets.push(CapturedAsset {
            id: asset.id.clone(),
            feed_id: asset.feed_id,
            price_e8: price_e8(value.price, value.exponent).map_err(|_| Error::Verification)?,
        });
    }
    let mut result = Captured {
        schema: "relative.origin-capture/v1".into(),
        network: "solana-devnet".into(),
        genesis_hash: DEVNET_GENESIS.into(),
        request,
        timestamp_us: data.timestamp_us,
        assets,
        raw_signed_payload_hex: hex::encode(bytes),
        signed_payload_sha256: hex::encode(Sha256::digest(bytes)),
        verification: Verification {
            signature_verified: true,
            full_roster_verified: true,
            whole_second_verified: true,
            verified_at_seconds: now_seconds,
            storage_account: STORAGE_ACCOUNT.into(),
            storage_owner: STORAGE_OWNER.into(),
            storage_commitment: "confirmed".into(),
            trusted_signers: signers
                .iter()
                .map(|signer| Signer {
                    public_key: signer.public_key,
                    expires_at_seconds: signer.expires_at_seconds,
                })
                .collect(),
        },
        submitted_transactions: 0,
        digest: String::new(),
    };
    result.digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&result).map_err(|_| Error::Verification)?,
    ));
    Ok(result)
}
pub fn validate_capture(value: &Captured) -> Result<(), Error> {
    let bytes = hex::decode(&value.raw_signed_payload_hex).map_err(|_| Error::Verification)?;
    let signers = value
        .verification
        .trusted_signers
        .iter()
        .map(|signer| TrustedSigner {
            public_key: signer.public_key,
            expires_at_seconds: signer.expires_at_seconds,
        })
        .collect::<Vec<_>>();
    if verify_capture(
        value.request.clone(),
        &bytes,
        &signers,
        value.verification.verified_at_seconds,
    )? != *value
    {
        return Err(Error::Verification);
    }
    Ok(())
}
pub async fn capture_file(input: &Path, output: &Path) -> Result<Captured, Error> {
    let request: Request = preparation::read_request(input).map_err(|_| Error::Request)?;
    request.validate()?;
    let alchemy = std::env::var("ALCHEMY_API_KEY").map_err(|_| Error::Credentials)?;
    let pyth_key = std::env::var("PYTH_API_KEY").map_err(|_| Error::Credentials)?;
    let rpc = Rpc::direct_devnet(&alchemy).map_err(|_| Error::Credentials)?;
    let genesis = rpc
        .call("getGenesisHash", serde_json::json!([]))
        .await
        .map_err(|_| Error::Rpc)?;
    if genesis.as_str() != Some(DEVNET_GENESIS) {
        return Err(Error::Rpc);
    }
    let signers = pyth::read_trusted_signers(&rpc)
        .await
        .map_err(|_| Error::Verification)?;
    let (stop_tx, stop_rx) = watch::channel(false);
    let (price_tx, mut price_rx) = mpsc::channel(1);
    let task = tokio::spawn(feeds::run_pyth(
        PythConfig {
            token: pyth_key,
            feed_ids: request.assets.iter().map(|a| a.feed_id).collect(),
            subscription_id: 11,
        },
        price_tx,
        stop_rx,
    ));
    let captured = tokio::time::timeout(Duration::from_secs(30), async {
        let bytes = price_rx.recv().await.ok_or(Error::Feed)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::Clock)?
            .as_secs();
        verify_capture(request, &bytes, &signers, now)
    })
    .await
    .map_err(|_| Error::Feed);
    let _ = stop_tx.send(true);
    task.abort();
    let _ = task.await;
    let captured = captured??;
    preparation::persist(output, &captured).map_err(|_| Error::Storage)?;
    Ok(captured)
}
