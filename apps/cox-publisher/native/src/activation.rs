use crate::{
    benchmark::{self, Anchor},
    feeds::{self, PythConfig},
    origin, preparation,
    pyth::{self, TrustedSigner},
    rpc::{Rpc, DEVNET_GENESIS},
};
use cox_math::geometric::geometric_level;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, watch};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema: String,
    pub previous_anchor: Anchor,
    pub next_universe_digest: [u8; 32],
    pub fullnext_assets: Vec<origin::Asset>,
    pub activation_timestamp_us: u64,
    pub max_feed_age_ms: u64,
}
impl Request {
    fn origin_request(&self) -> origin::Request {
        origin::Request {
            schema: "relative.origin-request/v1".into(),
            assets: self.fullnext_assets.clone(),
            max_feed_age_ms: self.max_feed_age_ms,
        }
    }
    pub fn validate(&self) -> Result<(), Error> {
        self.origin_request()
            .validate()
            .map_err(|_| Error::Request)?;
        let previous = &self.previous_anchor;
        if self.schema != "relative.activation-capture-request/v1"
            || previous.universe_digest == [0; 32]
            || self.next_universe_digest == [0; 32]
            || self.next_universe_digest == previous.universe_digest
            || previous.timestamp_us == 0
            || previous.timestamp_us % 1_000_000 != 0
            || previous.benchmark <= 0
            || previous.assets.len() < 2
            || previous.assets.len() >= self.fullnext_assets.len()
            || self.activation_timestamp_us <= previous.timestamp_us
            || self.activation_timestamp_us % 1_000_000 != 0
            || previous
                .assets
                .iter()
                .zip(&self.fullnext_assets)
                .any(|(old, next)| {
                    old.id != next.id || old.feed_id != next.feed_id || old.origin_price_e8 == 0
                })
        {
            return Err(Error::Request);
        }
        Ok(())
    }
    pub fn validate_schedule(&self, requested_at_us: u64) -> Result<(), Error> {
        self.validate()?;
        let delay = self
            .activation_timestamp_us
            .checked_sub(requested_at_us)
            .ok_or(Error::Schedule)?;
        if delay == 0 || delay > 600_000_000 {
            return Err(Error::Schedule);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Captured {
    pub schema: String,
    pub request: Request,
    pub requested_at_us: u64,
    pub captured: origin::Captured,
    pub old_benchmark: i128,
    pub next_anchor: Anchor,
    pub submitted_transactions: u64,
    pub digest: String,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Request,
    Schedule,
    Credentials,
    Rpc,
    Feed,
    MissedBoundary,
    Verification,
    Arithmetic,
    Clock,
    Storage,
}

pub fn verify_capture(
    request: Request,
    requested_at_us: u64,
    bytes: &[u8],
    signers: &[TrustedSigner],
    verified_at_seconds: u64,
) -> Result<Captured, Error> {
    request.validate_schedule(requested_at_us)?;
    let captured = origin::verify_capture(
        request.origin_request(),
        bytes,
        signers,
        verified_at_seconds,
    )
    .map_err(|_| Error::Verification)?;
    if captured.timestamp_us != request.activation_timestamp_us {
        return Err(Error::MissedBoundary);
    }
    let old_prices = request
        .previous_anchor
        .assets
        .iter()
        .map(|asset| asset.origin_price_e8)
        .collect::<Vec<_>>();
    let current_prices = captured.assets[..old_prices.len()]
        .iter()
        .map(|asset| asset.price_e8)
        .collect::<Vec<_>>();
    let old_benchmark = geometric_level(
        &old_prices,
        &current_prices,
        request.previous_anchor.benchmark,
    )
    .map_err(|_| Error::Arithmetic)?;
    let next_anchor = Anchor {
        universe_digest: request.next_universe_digest,
        timestamp_us: captured.timestamp_us,
        benchmark: old_benchmark,
        assets: captured
            .assets
            .iter()
            .map(|asset| benchmark::Asset {
                id: asset.id.clone(),
                feed_id: asset.feed_id,
                origin_price_e8: asset.price_e8,
            })
            .collect(),
    };
    let mut result = Captured {
        schema: "relative.activation-capture/v1".into(),
        request,
        requested_at_us,
        captured,
        old_benchmark,
        next_anchor,
        submitted_transactions: 0,
        digest: String::new(),
    };
    result.digest = hex::encode(Sha256::digest(
        serde_json::to_vec(&result).map_err(|_| Error::Verification)?,
    ));
    Ok(result)
}

pub fn capture_update(
    request: &Request,
    requested_at_us: u64,
    bytes: &[u8],
    signers: &[TrustedSigner],
    verified_at_seconds: u64,
) -> Result<Option<Captured>, Error> {
    request.validate_schedule(requested_at_us)?;
    let batch = pyth::verify_payload(
        bytes,
        signers,
        verified_at_seconds,
        request.max_feed_age_ms * 1000,
    )
    .map_err(|_| Error::Verification)?;
    if batch.timestamp_us < request.activation_timestamp_us {
        return Ok(None);
    }
    if batch.timestamp_us > request.activation_timestamp_us {
        return Err(Error::MissedBoundary);
    }
    verify_capture(
        request.clone(),
        requested_at_us,
        bytes,
        signers,
        verified_at_seconds,
    )
    .map(Some)
}

pub fn validate_capture(value: &Captured) -> Result<(), Error> {
    origin::validate_capture(&value.captured).map_err(|_| Error::Verification)?;
    let bytes =
        hex::decode(&value.captured.raw_signed_payload_hex).map_err(|_| Error::Verification)?;
    let signers = value
        .captured
        .verification
        .trusted_signers
        .iter()
        .map(|signer| TrustedSigner {
            public_key: signer.public_key,
            expires_at_seconds: signer.expires_at_seconds,
        })
        .collect::<Vec<_>>();
    let expected = verify_capture(
        value.request.clone(),
        value.requested_at_us,
        &bytes,
        &signers,
        value.captured.verification.verified_at_seconds,
    )?;
    if expected != *value {
        return Err(Error::Verification);
    }
    Ok(())
}

pub fn persist_capture(output: &Path, value: &Captured) -> Result<(), Error> {
    validate_capture(value)?;
    preparation::persist(output, value).map_err(|_| Error::Storage)
}
fn now_us() -> Result<u64, Error> {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::Clock)?
            .as_micros(),
    )
    .map_err(|_| Error::Clock)
}

pub async fn capture_file(input: &Path, output: &Path) -> Result<Captured, Error> {
    let request: Request = preparation::read_request(input).map_err(|_| Error::Request)?;
    let requested_at_us = now_us()?;
    request.validate_schedule(requested_at_us)?;
    if output.exists() {
        return Err(Error::Storage);
    }
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
    let deadline = request
        .activation_timestamp_us
        .checked_add(5_000_000)
        .ok_or(Error::Schedule)?;
    let remaining = deadline
        .checked_sub(now_us()?)
        .ok_or(Error::MissedBoundary)?;
    let (stop_tx, stop_rx) = watch::channel(false);
    let (price_tx, mut price_rx) = mpsc::channel(4);
    let task = tokio::spawn(feeds::run_pyth(
        PythConfig {
            token: pyth_key,
            feed_ids: request
                .fullnext_assets
                .iter()
                .map(|asset| asset.feed_id)
                .collect(),
            subscription_id: 12,
        },
        price_tx,
        stop_rx,
    ));
    let result = tokio::time::timeout(Duration::from_micros(remaining), async {
        loop {
            let bytes = price_rx.recv().await.ok_or(Error::Feed)?;
            let now = now_us()? / 1_000_000;
            if let Some(captured) =
                capture_update(&request, requested_at_us, &bytes, &signers, now)?
            {
                break Ok(captured);
            }
        }
    })
    .await
    .map_err(|_| Error::MissedBoundary);
    let _ = stop_tx.send(true);
    task.abort();
    let _ = task.await;
    let captured = result??;
    persist_capture(output, &captured)?;
    Ok(captured)
}
