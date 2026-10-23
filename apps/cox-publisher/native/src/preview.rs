use crate::{
    backup::{self, Gcs, Transport},
    benchmark::{Anchor, Benchmark, History, Observation},
    chain::ChainState,
    journal,
};
use cox_math::{rounded_div, Class, SCALE};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetOrigin {
    pub asset_id: String,
    pub class_id: u16,
    pub price_e8: u64,
    pub benchmark: i128,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Universe {
    pub price_digest: [u8; 32],
    pub origins: Vec<AssetOrigin>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewCutoff {
    pub schema: String,
    pub price_digest: [u8; 32],
    pub cutoff_timestamp: u64,
}
impl PreviewCutoff {
    pub fn limit(&self, anchor: &Anchor, latest: u64) -> Result<u64, Error> {
        if self.schema != "relative.inclusion-preview-cutoff/v1"
            || self.price_digest == [0; 32] || self.cutoff_timestamp == 0
        {
            return Err(Error::Invalid);
        }
        Ok(if self.price_digest == anchor.universe_digest {
            latest.min(self.cutoff_timestamp)
        } else { latest })
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LedgerClass {
    pub backing: u64,
    pub units: u128,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ledger {
    pub program: String,
    pub pool: String,
    pub methodology_digest: String,
    pub sequence: u64,
    pub state_digest: String,
    pub timestamp: u64,
    pub benchmark: i128,
    pub prices_e8: Vec<u64>,
    pub classes: Vec<LedgerClass>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub universe: Option<Universe>,
}
impl Ledger {
    pub fn from_state(state: &ChainState) -> Result<Self, Error> {
        let basic = &state.basic;
        let pool = &basic.pool;
        if !matches!(pool.schema_version, 4 | 5) || !pool.initialized {
            return Err(Error::Invalid);
        }
        let universe = if pool.schema_version == 5 {
            let value = cox::read_dynamic_manifest(&basic.methodology).map_err(|_| Error::Invalid)?;
            Some(Universe { price_digest: value.capture.price_universe_digest, origins: value.instruments.iter().map(|asset| AssetOrigin {
                asset_id: asset.symbol.clone(), class_id: asset.class_id, price_e8: asset.original_price_e8, benchmark: asset.original_benchmark,
            }).collect() })
        } else { None };
        Ok(Self {
            universe,
            program: basic.accounts.program.to_string(),
            pool: basic.accounts.pool.to_string(),
            methodology_digest: hex::encode(basic.methodology.digest),
            sequence: pool.sequence,
            state_digest: hex::encode(pool.state_digest),
            timestamp: pool
                .origin
                .checked_add(pool.last_batch)
                .ok_or(Error::Invalid)?,
            benchmark: pool.benchmark,
            prices_e8: pool.last_prices.clone(),
            classes: pool
                .classes
                .iter()
                .map(|c| LedgerClass {
                    backing: c.backing,
                    units: c.units,
                })
                .collect(),
        })
    }
    pub fn persist(&self, path: &Path) -> Result<(), Error> {
        if journal::read::<Self>(path)
            .map_err(|_| Error::Storage)?
            .as_ref()
            != Some(self)
        {
            journal::atomic_write(path, self).map_err(|_| Error::Storage)?;
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scales {
    pub price: String,
    pub reference: String,
    pub collateral: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub class_id: u16,
    pub asset_id: String,
    pub price_e8: String,
    pub reference: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectedClass {
    pub class_id: u16,
    pub backing: String,
    pub units: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Projection {
    pub sequence: String,
    pub state_digest: String,
    pub publication_timestamp: u64,
    pub classes: Vec<ProjectedClass>,
    pub added_residual: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub schema: String,
    pub status: String,
    pub timestamp: u64,
    pub network: String,
    pub program: String,
    pub pool: String,
    pub methodology_digest: String,
    pub universe_digest: String,
    pub scales: Scales,
    pub benchmark: String,
    pub assets: Vec<Asset>,
    pub crypto_class: u16,
    pub crypto_reference: String,
    pub basic_projection: Option<Projection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_change: Option<crate::changes::Notification>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Storage,
    Conflict,
    Network,
}
struct Memory;
impl History for Memory {
    fn append(&mut self, _: &Observation) -> Result<(), crate::benchmark::Error> {
        Ok(())
    }
}
fn ratio(n: i128, scale: i128, d: i128) -> Result<i128, Error> {
    rounded_div(n.checked_mul(scale).ok_or(Error::Invalid)?, d).map_err(|_| Error::Invalid)
}
impl Record {
    pub fn derive(anchor: &Anchor, value: &Observation, ledger: &Ledger) -> Result<Self, Error> {
        Benchmark::new(anchor.clone(), Memory, Some(value.clone())).map_err(|_| Error::Invalid)?;
        if value.timestamp_us % 1_000_000 != 0
            || value.signed_payload.is_empty()
            || anchor.assets.len() > 255
            || anchor.benchmark <= 0
            || ledger.program.parse::<solana_address::Address>().is_err()
            || ledger.pool.parse::<solana_address::Address>().is_err()
            || hex::decode(&ledger.methodology_digest)
                .ok()
                .is_none_or(|d| d.len() != 32)
        {
            return Err(Error::Invalid);
        }
        if let Some(universe) = &ledger.universe {
            if universe.price_digest != anchor.universe_digest || universe.origins.len() != anchor.assets.len() { return Err(Error::Invalid); }
            for (index, (asset, origin)) in anchor.assets.iter().zip(&universe.origins).enumerate() {
                let class_id = if index < 30 { index } else { index + 1 };
                if origin.asset_id != asset.id || usize::from(origin.class_id) != class_id || origin.price_e8 == 0 || origin.benchmark <= 0 { return Err(Error::Invalid); }
            }
        } else if anchor.assets.len() > 30 || anchor.benchmark != 100 * SCALE { return Err(Error::Invalid); }
        let crypto_class = if ledger.universe.is_some() { 30 } else { anchor.assets.len() as u16 };
        let mut assets = Vec::with_capacity(anchor.assets.len());
        for (index, (asset, price)) in anchor.assets.iter().zip(&value.prices_e8).enumerate() {
            let origin = ledger.universe.as_ref().map(|universe| &universe.origins[index]);
            let since_origin = ratio(i128::from(*price), SCALE, i128::from(origin.map(|o| o.price_e8).unwrap_or(asset.origin_price_e8)))?;
            let benchmark_ratio = ratio(value.benchmark, SCALE, origin.map(|o| o.benchmark).unwrap_or(anchor.benchmark))?;
            assets.push(Asset {
                class_id: origin.map(|o| o.class_id).unwrap_or(index as u16),
                asset_id: asset.id.clone(),
                price_e8: price.to_string(),
                reference: ratio(100 * SCALE, since_origin, benchmark_ratio)?.to_string(),
            });
        }
        let timestamp = value.timestamp_us / 1_000_000;
        let basic_projection = if ledger.timestamp <= timestamp
            && ledger.benchmark > 0
            && ledger.prices_e8.len() == assets.len()
            && ledger.classes.len() == assets.len() + 1
        {
            let benchmark_gross = ratio(value.benchmark, SCALE, ledger.benchmark)?;
            let mut h = vec![SCALE; ledger.classes.len()];
            for (index, (current, previous)) in value.prices_e8.iter().zip(&ledger.prices_e8).enumerate() {
                h[usize::from(assets[index].class_id)] = ratio(
                    ratio(i128::from(*current), SCALE, i128::from(*previous))?,
                    SCALE,
                    benchmark_gross,
                )?;
            }
            let before = ledger
                .classes
                .iter()
                .map(|c| Class {
                    backing: c.backing,
                    units: c.units,
                })
                .collect::<Vec<_>>();
            let revalued = if ledger.universe.is_some() {
                cox_math::revalue_dynamic(&before, &h)
            } else {
                cox_math::revalue(&before, &h)
            }.map_err(|_| Error::Invalid)?;
            Some(Projection {
                sequence: ledger.sequence.to_string(),
                state_digest: ledger.state_digest.clone(),
                publication_timestamp: ledger.timestamp,
                classes: revalued
                    .classes
                    .iter()
                    .enumerate()
                    .map(|(i, c)| ProjectedClass {
                        class_id: i as u16,
                        backing: c.backing.to_string(),
                        units: c.units.to_string(),
                    })
                    .collect(),
                added_residual: revalued.residual.to_string(),
            })
        } else {
            None
        };
        Ok(Self {
            schema: "relative.preview/v1".into(),
            status: "estimate".into(),
            timestamp,
            network: "solana-devnet".into(),
            program: ledger.program.clone(),
            pool: ledger.pool.clone(),
            methodology_digest: ledger.methodology_digest.clone(),
            universe_digest: hex::encode(anchor.universe_digest),
            scales: Scales {
                price: "100000000".into(),
                reference: SCALE.to_string(),
                collateral: "1000000".into(),
            },
            benchmark: value.benchmark.to_string(),
            assets,
            crypto_class,
            crypto_reference: (100 * SCALE).to_string(),
            basic_projection,
            chain_change: None,
        })
    }
}
pub async fn upload<T: Transport>(
    transport: &T,
    prefix: &str,
    record: &Record,
) -> Result<(), Error> {
    let bytes = serde_json::to_vec(record).map_err(|_| Error::Invalid)?;
    backup::ensure(
        transport,
        &format!("{prefix}/{}.json", record.timestamp),
        &bytes,
    )
    .await
    .map_err(|e| match e {
        backup::Error::Conflict | backup::Error::Checksum => Error::Conflict,
        _ => Error::Network,
    })
}
#[derive(Serialize, Deserialize)]
struct Cursor {
    timestamp: u64,
}
fn regular_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, Error> {
    let info = fs::symlink_metadata(path).map_err(|_| Error::Storage)?;
    if !info.is_file() || info.file_type().is_symlink() || info.len() > 1_048_576 {
        return Err(Error::Storage);
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| Error::Storage)?).map_err(|_| Error::Invalid)
}
pub async fn run(config_path: &Path, backup_path: &Path) -> Result<(), Error> {
    let config = crate::runtime::Config::read(config_path).map_err(|_| Error::Invalid)?;
    if config.basic_pool_id != 2
        || config.anchor.assets.len() != 30
        || config
            .mapping
            .iter()
            .enumerate()
            .any(|(i, m)| usize::from(m.basic_id) != i)
    {
        return Err(Error::Invalid);
    }
    let backup = backup::Config::read(backup_path).map_err(|_| Error::Invalid)?;
    if backup.state_directory != config.state_directory {
        return Err(Error::Invalid);
    }
    let transport = Gcs::new(&backup).map_err(|_| Error::Network)?;
    let spool = config.state_directory.with_extension("preview-spool");
    fs::create_dir_all(&spool).map_err(|_| Error::Storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&spool, fs::Permissions::from_mode(0o700))
            .map_err(|_| Error::Storage)?;
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(spool.join("writer.lock"))
        .map_err(|_| Error::Storage)?;
    lock.try_lock().map_err(|_| Error::Storage)?;
    let prefix = format!("pool-{}/preview", config.basic_pool_id);
    let program = config
        .basic_program
        .parse::<solana_address::Address>()
        .map_err(|_| Error::Invalid)?;
    let pool = solana_address::Address::find_program_address(
        &[b"pool", &config.basic_pool_id.to_le_bytes()],
        &program,
    )
    .0
    .to_string();
    let producer = produce(
        &config.state_directory,
        &config.anchor,
        &spool,
        &config.basic_program,
        &pool,
    );
    let consumer = consume(&transport, &prefix, &spool);
    let notification_prefix = format!("pool-{}/chain-changes", config.basic_pool_id);
    let notification_spool = config.state_directory.with_extension("chain-spool");
    let notifications = async {
        crate::notifications::run(
            &transport,
            &notification_prefix,
            &config.state_directory,
            &notification_spool,
            &config.basic_program,
            &pool,
        )
        .await
        .map_err(|_| Error::Storage)
    };
    tokio::try_join!(producer, consumer, notifications)?;
    Ok(())
}
async fn produce(
    state: &Path,
    anchor: &Anchor,
    spool: &Path,
    program: &str,
    pool: &str,
) -> Result<(), Error> {
    let history = journal::FileHistory {
        directory: state.join("prices"),
    };
    let cursor_path = spool.join("cursor.json");
    let mut cursor = journal::read::<Cursor>(&cursor_path)
        .map_err(|_| Error::Storage)?
        .map(|c| c.timestamp);
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    loop {
        interval.tick().await;
        let Some(latest) = history.latest().map_err(|_| Error::Storage)? else {
            continue;
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::Invalid)?
            .as_secs();
        let latest_seconds = latest.timestamp_us / 1_000_000;
        if latest_seconds > now || now - latest_seconds > 60 {
            continue;
        }
        let ledger_path = state.join("preview-ledger.json");
        if !ledger_path.exists() {
            continue;
        }
        let ledger: Ledger = regular_json(&ledger_path)?;
        let active_anchor = history.active_anchor().map_err(|_| Error::Storage)?.unwrap_or_else(|| anchor.clone());
        let anchor = &active_anchor;
        if ledger.program != program || ledger.pool != pool {
            return Err(Error::Invalid);
        }
        if ledger.prices_e8.len() != anchor.assets.len()
            || ledger.universe.as_ref().is_some_and(|universe| universe.price_digest != anchor.universe_digest)
        {
            continue;
        }
        let cutoff = journal::read::<Option<PreviewCutoff>>(&state.join("inclusion-preview-cutoff.json"))
            .map_err(|_| Error::Storage)?.flatten();
        let latest_seconds = match cutoff {
            Some(cutoff) => cutoff.limit(anchor, latest_seconds)?,
            None => latest_seconds,
        };
        let start = cursor
            .and_then(|n| n.checked_add(1))
            .unwrap_or(latest_seconds);
        for timestamp in start..=latest_seconds.min(start.saturating_add(119)) {
            let Some(value) = history
                .exact(
                    &anchor.universe_digest,
                    timestamp.checked_mul(1_000_000).ok_or(Error::Invalid)?,
                )
                .map_err(|_| Error::Storage)?
            else {
                journal::atomic_write(&cursor_path, &Cursor { timestamp })
                    .map_err(|_| Error::Storage)?;
                cursor = Some(timestamp);
                continue;
            };
            let path = spool.join(format!("{timestamp}.json"));
            if !path.exists() {
                let mut record = Record::derive(anchor, &value, &ledger)?;
                record.chain_change = crate::changes::read(&state.join("chain-change.json"))
                    .map_err(|_| Error::Storage)?;
                journal::atomic_write(&path, &record).map_err(|_| Error::Storage)?;
            }
            journal::atomic_write(&cursor_path, &Cursor { timestamp })
                .map_err(|_| Error::Storage)?;
            cursor = Some(timestamp);
        }
    }
}
async fn consume<T: Transport>(transport: &T, prefix: &str, spool: &Path) -> Result<(), Error> {
    loop {
        let mut pending = Vec::<(u64, PathBuf)>::new();
        for entry in fs::read_dir(spool).map_err(|_| Error::Storage)? {
            let entry = entry.map_err(|_| Error::Storage)?;
            let path = entry.path();
            if let Some(n) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.parse::<u64>().ok())
            {
                if path.extension().is_some_and(|e| e == "json") {
                    pending.push((n, path));
                }
            }
        }
        if pending.len() > 100_000 {
            return Err(Error::Storage);
        }
        pending.sort_by_key(|(n, _)| *n);
        if pending.is_empty() {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        for (timestamp, path) in pending.into_iter().take(8) {
            let record: Record = regular_json(&path)?;
            if record.timestamp != timestamp
                || record.schema != "relative.preview/v1"
                || record.status != "estimate"
                || record.network != "solana-devnet"
            {
                return Err(Error::Invalid);
            }
            match upload(transport, prefix, &record).await {
                Ok(()) => fs::remove_file(path).map_err(|_| Error::Storage)?,
                Err(Error::Network) => {
                    eprintln!("Preview upload deferred");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    break;
                }
                Err(e) => return Err(e),
            }
        }
    }
}
