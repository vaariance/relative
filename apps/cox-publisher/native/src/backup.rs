use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{stream, StreamExt, TryStreamExt};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const MAX_CONFIG_BYTES: u64 = 16_384;
const MAX_MANIFEST_BYTES: usize = 64 * 1024 * 1024;
const MAX_DEPTH: usize = 5;
const MUTABLE: [&str; 8] = [
    "identity.json",
    "checkpoint.json",
    "discovery.json",
    "preview-ledger.json",
    "chain-change.json",
    "rpc-usage.json",
    "prices/latest.json",
    "prices/active-anchor.json",
];
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub schema: String,
    pub bucket: String,
    pub prefix: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication_history_prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication_identity: Option<crate::publications::Identity>,
    pub state_directory: PathBuf,
    pub markers_directory: PathBuf,
    #[serde(default)]
    pub incremental: bool,
    #[serde(default)]
    pub retain_price_seconds: Option<u64>,
    #[serde(default)]
    pub retain_publications: Option<usize>,
    pub max_file_bytes: u64,
    pub max_files: usize,
    pub max_total_bytes: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Configuration,
    Storage,
    UnsafePath,
    Limit,
    Mutated,
    Manifest,
    Credentials,
    Network,
    Checksum,
    Conflict,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub crc32c: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: String,
    pub prefix: String,
    pub identity_sha256: String,
    pub entries: Vec<Entry>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteMetadata {
    pub name: String,
    pub generation: String,
    pub bytes: u64,
    pub crc32c: String,
    pub sha256: String,
}
pub enum Created {
    New(RemoteMetadata),
    Exists,
}
pub struct RemoteObject {
    pub metadata: RemoteMetadata,
    pub body: Vec<u8>,
}
#[allow(async_fn_in_trait)]
pub trait Transport {
    async fn create(&self, object: &str, bytes: &[u8], sha256: &str) -> Result<Created, Error>;
    async fn get(&self, object: &str, max_bytes: u64) -> Result<RemoteObject, Error>;
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Report {
    pub manifest_object: String,
    pub manifest_sha256: String,
    pub files: usize,
    pub bytes: u64,
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn crc32c(bytes: &[u8]) -> String {
    let mut checksum = !0_u32;
    for byte in bytes {
        checksum ^= u32::from(*byte);
        for _ in 0..8 {
            checksum = (checksum >> 1) ^ (0x82f63b78_u32 & 0_u32.wrapping_sub(checksum & 1));
        }
    }
    STANDARD.encode((!checksum).to_be_bytes())
}
fn segments(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
}
impl Config {
    pub fn read(path: &Path) -> Result<Self, Error> {
        let bytes = read_regular(path, MAX_CONFIG_BYTES)?;
        let value: Self = serde_json::from_slice(&bytes).map_err(|_| Error::Configuration)?;
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<(), Error> {
        if self.schema != "relative.backup/v1"
            || !(3..=222).contains(&self.bucket.len())
            || !self
                .bucket
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
            || !self.bucket.as_bytes()[0].is_ascii_alphanumeric()
            || !self.bucket.as_bytes()[self.bucket.len() - 1].is_ascii_alphanumeric()
            || !segments(&self.prefix)
            || !self.state_directory.is_absolute()
            || !self.markers_directory.is_absolute()
            || self.markers_directory == self.state_directory
            || self
                .markers_directory
                .starts_with(self.state_directory.join("prices"))
            || self
                .markers_directory
                .starts_with(self.state_directory.join("publications"))
            || self.max_file_bytes == 0
            || self.max_file_bytes > 16 * 1024 * 1024
            || self.max_files == 0
            || self.max_files > 200_000
            || self
                .retain_price_seconds
                .is_some_and(|n| !self.incremental || !(129_600..=172_800).contains(&n))
            || self.retain_publications.is_some_and(|n| {
                !self.incremental
                    || self.publication_history_prefix.is_none()
                    || !(2..=100_000).contains(&n)
            })
            || self.max_total_bytes < self.max_file_bytes
            || self.max_total_bytes > 64 * 1024 * 1024 * 1024
        {
            return Err(Error::Configuration);
        }
        match (&self.publication_history_prefix, &self.publication_identity) {
            (None, None) => {}
            (Some(prefix), Some(identity)) => {
                if !segments(prefix)
                    || prefix == &self.prefix
                    || prefix.starts_with(&format!("{}/", self.prefix))
                    || self.prefix.starts_with(&format!("{prefix}/"))
                    || identity.genesis_hash != crate::rpc::DEVNET_GENESIS
                    || identity.program.parse::<solana_address::Address>().is_err()
                    || identity.pool.parse::<solana_address::Address>().is_err()
                {
                    return Err(Error::Configuration);
                }
            }
            _ => return Err(Error::Configuration),
        }
        Ok(())
    }
}
fn check_components(path: &Path) -> Result<(), Error> {
    if !path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        })
    {
        return Err(Error::UnsafePath);
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(info) if info.file_type().is_symlink() => return Err(Error::UnsafePath),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Error::Storage),
        }
    }
    Ok(())
}
fn read_regular(path: &Path, maximum: u64) -> Result<Vec<u8>, Error> {
    check_components(path)?;
    let before = fs::symlink_metadata(path).map_err(|_| Error::Storage)?;
    if !before.is_file() {
        return Err(Error::UnsafePath);
    }
    if before.len() > maximum {
        return Err(Error::Limit);
    }
    let mut file = File::open(path).map_err(|_| Error::Storage)?;
    let opened = file.metadata().map_err(|_| Error::Storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.ino() != before.ino() || opened.dev() != before.dev() {
            return Err(Error::Mutated);
        }
    }
    if !opened.is_file() || opened.len() != before.len() {
        return Err(Error::Mutated);
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    (&mut file)
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Storage)?;
    let after = fs::symlink_metadata(path).map_err(|_| Error::Mutated)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if after.ino() != before.ino() || after.dev() != before.dev() {
            return Err(Error::Mutated);
        }
    }
    if after.file_type().is_symlink()
        || after.len() != before.len()
        || bytes.len() as u64 != before.len()
        || after.modified().ok() != before.modified().ok()
    {
        return Err(Error::Mutated);
    }
    Ok(bytes)
}
fn numeric(value: &str) -> bool {
    !value.is_empty()
        && (value == "0" || !value.starts_with('0'))
        && value.bytes().all(|b| b.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}
fn json_number(value: &str) -> bool {
    value.strip_suffix(".json").is_some_and(numeric)
}
fn allowed_file(path: &str) -> bool {
    if MUTABLE.contains(&path) {
        return true;
    }
    let parts = path.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        ["publications", sequence] => json_number(sequence),
        ["prices", "anchors", digest] => digest.strip_suffix(".json").is_some_and(valid_digest),
        ["prices", universe, hour, timestamp] => {
            valid_digest(universe) && numeric(hour) && json_number(timestamp)
        }
        _ => false,
    }
}
fn allowed_directory(path: &str) -> bool {
    let parts = path.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        ["prices"] | ["publications"] | ["prices", "anchors"] => true,
        ["prices", universe] => valid_digest(universe),
        ["prices", universe, hour] => valid_digest(universe) && numeric(hour),
        _ => false,
    }
}
fn mutable_values(config: &Config) -> Result<Vec<(String, Option<Vec<u8>>)>, Error> {
    MUTABLE
        .iter()
        .map(|path| {
            let local = config.state_directory.join(path);
            match fs::symlink_metadata(&local) {
                Ok(_) => read_regular(&local, config.max_file_bytes)
                    .map(|value| ((*path).into(), Some(value))),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(((*path).into(), None))
                }
                Err(_) => Err(Error::Storage),
            }
        })
        .collect()
}
fn walk(
    config: &Config,
    directory: &Path,
    relative: &str,
    paths: &mut Vec<String>,
    seen: &mut usize,
) -> Result<(), Error> {
    if relative.split('/').count() > MAX_DEPTH {
        return Err(Error::Limit);
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| Error::Storage)? {
        *seen += 1;
        if *seen > config.max_files.saturating_mul(8).saturating_add(1000) {
            return Err(Error::Limit);
        }
        let entry = entry.map_err(|_| Error::Storage)?;
        names.push(
            entry
                .file_name()
                .into_string()
                .map_err(|_| Error::UnsafePath)?,
        );
    }
    names.sort();
    for name in names {
        let path = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        let local = config.state_directory.join(&path);
        if allowed_directory(&path) {
            let info = fs::symlink_metadata(&local).map_err(|_| Error::Storage)?;
            if !info.is_dir() || info.file_type().is_symlink() {
                return Err(Error::UnsafePath);
            }
            walk(config, &local, &path, paths, seen)?;
        } else if allowed_file(&path) {
            paths.push(path);
            if paths.len() > config.max_files {
                return Err(Error::Limit);
            }
        }
    }
    Ok(())
}
pub fn capture(config: &Config) -> Result<Manifest, Error> {
    capture_snapshot(config).map(|(manifest, _)| manifest)
}
fn capture_snapshot(
    config: &Config,
) -> Result<(Manifest, std::collections::BTreeMap<String, Vec<u8>>), Error> {
    config.validate()?;
    check_components(&config.state_directory)?;
    let pointers = mutable_values(config)?;
    if pointers != mutable_values(config)? {
        return Err(Error::Mutated);
    }
    let frozen = pointers
        .into_iter()
        .filter_map(|(path, bytes)| bytes.map(|bytes| (path, bytes)))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut paths = Vec::new();
    walk(config, &config.state_directory, "", &mut paths, &mut 0)?;
    paths.sort();
    let mut entries = Vec::with_capacity(paths.len());
    let mut total = 0_u64;
    paths.retain(|path| !MUTABLE.contains(&path.as_str()));
    paths.extend(frozen.keys().cloned());
    paths.sort();
    for path in paths {
        let bytes = match frozen.get(&path) {
            Some(bytes) => bytes.clone(),
            None => read_regular(&config.state_directory.join(&path), config.max_file_bytes)?,
        };
        total = total.checked_add(bytes.len() as u64).ok_or(Error::Limit)?;
        if total > config.max_total_bytes {
            return Err(Error::Limit);
        }
        entries.push(Entry {
            path,
            bytes: bytes.len() as u64,
            sha256: digest(&bytes),
            crc32c: crc32c(&bytes),
        });
    }
    let identity_sha256 = entries
        .iter()
        .find(|entry| entry.path == "identity.json")
        .ok_or(Error::Manifest)?
        .sha256
        .clone();
    let manifest = Manifest {
        schema: "relative.backup-manifest/v1".into(),
        prefix: config.prefix.clone(),
        identity_sha256,
        entries,
    };
    validate_manifest(&manifest, config)?;
    Ok((manifest, frozen))
}
fn validate_manifest(manifest: &Manifest, config: &Config) -> Result<(), Error> {
    if manifest.schema != "relative.backup-manifest/v1"
        || manifest.prefix != config.prefix
        || !valid_digest(&manifest.identity_sha256)
        || manifest.entries.is_empty()
        || manifest.entries.len() > config.max_files
    {
        return Err(Error::Manifest);
    }
    let mut paths = BTreeSet::new();
    let mut previous: Option<&str> = None;
    let mut total = 0_u64;
    for entry in &manifest.entries {
        if !segments(&entry.path)
            || !allowed_file(&entry.path)
            || !paths.insert(&entry.path)
            || previous.is_some_and(|prior| prior >= entry.path.as_str())
            || !valid_digest(&entry.sha256)
            || STANDARD
                .decode(&entry.crc32c)
                .map_err(|_| Error::Manifest)?
                .len()
                != 4
            || entry.bytes > config.max_file_bytes
        {
            return Err(Error::Manifest);
        }
        previous = Some(&entry.path);
        total = total.checked_add(entry.bytes).ok_or(Error::Limit)?;
    }
    if total > config.max_total_bytes
        || !manifest
            .entries
            .iter()
            .any(|entry| entry.path == "identity.json" && entry.sha256 == manifest.identity_sha256)
    {
        return Err(Error::Manifest);
    }
    if serde_json::to_vec(manifest)
        .map_err(|_| Error::Manifest)?
        .len()
        > MAX_MANIFEST_BYTES
    {
        return Err(Error::Limit);
    }
    Ok(())
}
fn content_object(prefix: &str, sha256: &str) -> String {
    format!("{prefix}/objects/{sha256}")
}
fn check_remote(metadata: &RemoteMetadata, object: &str, bytes: &[u8]) -> Result<(), Error> {
    if metadata.name != object
        || !numeric(&metadata.generation)
        || metadata.generation == "0"
        || metadata.bytes != bytes.len() as u64
        || metadata.sha256 != digest(bytes)
        || metadata.crc32c != crc32c(bytes)
    {
        return Err(Error::Checksum);
    }
    Ok(())
}
pub(crate) async fn ensure<T: Transport>(
    transport: &T,
    object: &str,
    bytes: &[u8],
) -> Result<(), Error> {
    match transport.create(object, bytes, &digest(bytes)).await? {
        Created::New(metadata) => check_remote(&metadata, object, bytes),
        Created::Exists => {
            let prior = transport.get(object, bytes.len() as u64).await?;
            check_remote(&prior.metadata, object, &prior.body)?;
            if prior.body != bytes {
                return Err(Error::Conflict);
            }
            Ok(())
        }
    }
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Receipt {
    object: String,
    sha256: String,
    bytes: u64,
    crc32c: String,
}
fn receipt_path(root: &Path, object: &str) -> PathBuf {
    let key = digest(object.as_bytes());
    root.join(&key[..2]).join(format!("{key}.json"))
}
async fn ensure_incremental<T: Transport>(
    transport: &T,
    root: &Path,
    enabled: bool,
    object: &str,
    bytes: &[u8],
) -> Result<(), Error> {
    if !enabled {
        return ensure(transport, object, bytes).await;
    }
    let expected = Receipt {
        object: object.into(),
        sha256: digest(bytes),
        bytes: bytes.len() as u64,
        crc32c: crc32c(bytes),
    };
    let path = receipt_path(root, object);
    check_components(&path)?;
    if let Some(receipt) = crate::journal::read::<Receipt>(&path).map_err(|_| Error::Storage)? {
        return if receipt == expected {
            Ok(())
        } else {
            Err(Error::Conflict)
        };
    }
    ensure(transport, object, bytes).await?;
    crate::journal::atomic_write(&path, &expected).map_err(|_| Error::Storage)
}
fn prune(config: &Config, manifest: &Manifest, receipts: &Path) -> Result<(), Error> {
    if config.retain_price_seconds.is_none() && config.retain_publications.is_none() {
        return Ok(());
    }
    let retain = config.retain_price_seconds.unwrap_or(u64::MAX);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Storage)?
        .as_secs();
    let cutoff = now.saturating_sub(retain).saturating_mul(1_000_000);
    let latest = manifest
        .entries
        .iter()
        .filter_map(|e| price_timestamp(&e.path))
        .max()
        .unwrap_or(0);
    let mut publications = manifest
        .entries
        .iter()
        .filter_map(|entry| publication_sequence(&entry.path))
        .collect::<Vec<_>>();
    publications.sort_unstable();
    let first_kept = config.retain_publications.and_then(|n| {
        publications
            .get(publications.len().saturating_sub(n))
            .copied()
    });
    let mut keep = BTreeSet::new();
    for entry in &manifest.entries {
        let object = content_object(&config.prefix, &entry.sha256);
        let old = price_timestamp(&entry.path).is_some_and(|t| t < cutoff && t < latest)
            || publication_sequence(&entry.path)
                .zip(first_kept)
                .is_some_and(|(n, first)| n < first);
        if old {
            let path = config.state_directory.join(&entry.path);
            if digest(&read_regular(&path, config.max_file_bytes)?) != entry.sha256 {
                return Err(Error::Mutated);
            }
            fs::remove_file(path).map_err(|_| Error::Storage)?;
        } else {
            keep.insert(receipt_path(receipts, &object));
        }
        if let Some(prefix) = config.publication_history_prefix.as_ref().filter(|_| !old) {
            if let Some(sequence) = entry
                .path
                .strip_prefix("publications/")
                .and_then(|s| s.strip_suffix(".json"))
            {
                keep.insert(receipt_path(
                    receipts,
                    &format!("{prefix}/{sequence}/{}.json", entry.sha256),
                ));
            }
        }
    }
    if receipts.exists() {
        for shard in fs::read_dir(receipts).map_err(|_| Error::Storage)? {
            let shard = shard.map_err(|_| Error::Storage)?.path();
            check_components(&shard)?;
            if !shard.is_dir() {
                return Err(Error::UnsafePath);
            }
            for file in fs::read_dir(&shard).map_err(|_| Error::Storage)? {
                let path = file.map_err(|_| Error::Storage)?.path();
                check_components(&path)?;
                if !keep.contains(&path) {
                    fs::remove_file(path).map_err(|_| Error::Storage)?;
                }
            }
        }
    }
    let mut markers = fs::read_dir(&config.markers_directory)
        .map_err(|_| Error::Storage)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(valid_digest)
        })
        .collect::<Vec<_>>();
    markers.sort_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok());
    let drop_count = markers.len().saturating_sub(3);
    for path in markers.into_iter().take(drop_count) {
        check_components(&path)?;
        fs::remove_file(path).map_err(|_| Error::Storage)?;
    }
    Ok(())
}
fn publication_sequence(path: &str) -> Option<u64> {
    path.strip_prefix("publications/")?
        .strip_suffix(".json")?
        .parse()
        .ok()
}
fn price_timestamp(path: &str) -> Option<u64> {
    let parts = path.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        ["prices", universe, hour, name] if valid_digest(universe) && numeric(hour) => {
            name.strip_suffix(".json")?.parse().ok()
        }
        _ => None,
    }
}
pub async fn backup<T: Transport>(config: &Config, transport: &T) -> Result<Report, Error> {
    config.validate()?;
    let _lock = if config.incremental {
        check_components(&config.markers_directory)?;
        fs::create_dir_all(&config.markers_directory).map_err(|_| Error::Storage)?;
        check_components(&config.markers_directory.join("backup.lock"))?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(config.markers_directory.join("backup.lock"))
            .map_err(|_| Error::Storage)?;
        file.try_lock().map_err(|_| Error::Storage)?;
        Some(file)
    } else {
        None
    };
    let (manifest, frozen) = capture_snapshot(config)?;
    let publication_archive = config
        .publication_identity
        .as_ref()
        .map(|identity| {
            let program = identity.program.parse().map_err(|_| Error::Configuration)?;
            let pool = identity.pool.parse().map_err(|_| Error::Configuration)?;
            let archive = crate::publications::Archive::new(
                config.state_directory.join("publications"),
                program,
                pool,
            );
            Ok::<_, Error>(archive)
        })
        .transpose()?;
    let receipt_root = config.markers_directory.join("receipts").join(digest(
        format!(
            "{}:{}:{}:{}",
            config.bucket,
            config.prefix,
            config.publication_history_prefix.as_deref().unwrap_or(""),
            manifest.identity_sha256
        )
        .as_bytes(),
    ));
    let mut ordered = manifest.entries.iter().collect::<Vec<_>>();
    ordered.sort_by_key(|entry| (!entry.path.starts_with("publications/"), entry.path.clone()));
    let publication_count = ordered
        .iter()
        .take_while(|e| e.path.starts_with("publications/"))
        .count();
    for group in [&ordered[..publication_count], &ordered[publication_count..]] {
        stream::iter(group.iter().map(|entry| async {
            let bytes = match frozen.get(&entry.path) {
                Some(bytes) => bytes.clone(),
                None => read_regular(
                    &config.state_directory.join(&entry.path),
                    config.max_file_bytes,
                )?,
            };
            if bytes.len() as u64 != entry.bytes
                || digest(&bytes) != entry.sha256
                || crc32c(&bytes) != entry.crc32c
            {
                return Err(Error::Mutated);
            }
            if let (Some(prefix), Some(archive), Some(sequence)) = (
                &config.publication_history_prefix,
                &publication_archive,
                entry
                    .path
                    .strip_prefix("publications/")
                    .and_then(|name| name.strip_suffix(".json")),
            ) {
                let record = archive
                    .validate_record(sequence.parse().map_err(|_| Error::Manifest)?, &bytes)
                    .map_err(|_| Error::Manifest)?;
                if record
                    .observed_slot
                    .or(record.finalized_slot)
                    .is_some_and(|slot| slot > 9_007_199_254_740_991)
                {
                    return Err(Error::Manifest);
                }
                ensure_incremental(
                    transport,
                    &receipt_root,
                    config.incremental,
                    &format!("{prefix}/{sequence}/{}.json", entry.sha256),
                    &bytes,
                )
                .await?;
            }
            ensure_incremental(
                transport,
                &receipt_root,
                config.incremental,
                &content_object(&config.prefix, &entry.sha256),
                &bytes,
            )
            .await
        }))
        .buffer_unordered(if config.incremental { 32 } else { 1 })
        .try_collect::<Vec<_>>()
        .await?;
    }
    let bytes = serde_json::to_vec(&manifest).map_err(|_| Error::Manifest)?;
    let sha256 = digest(&bytes);
    let object = format!("{}/manifests/{sha256}.json", config.prefix);
    ensure(transport, &object, &bytes).await?;
    check_components(&config.markers_directory)?;
    crate::journal::atomic_write(
        &config.markers_directory.join(format!("{sha256}.json")),
        &manifest,
    )
    .map_err(|_| Error::Storage)?;
    if config.incremental {
        prune(config, &manifest, &receipt_root)?;
    }
    Ok(Report {
        manifest_object: object,
        manifest_sha256: sha256,
        files: manifest.entries.len(),
        bytes: manifest.entries.iter().map(|entry| entry.bytes).sum(),
    })
}
pub async fn restore<T: Transport>(
    config: &Config,
    transport: &T,
    manifest_sha256: &str,
    destination: &Path,
) -> Result<Manifest, Error> {
    config.validate()?;
    if !valid_digest(manifest_sha256) {
        return Err(Error::Manifest);
    }
    check_components(destination)?;
    if !destination.is_absolute() || destination.exists() {
        return Err(Error::UnsafePath);
    }
    let object = format!("{}/manifests/{manifest_sha256}.json", config.prefix);
    let remote = transport.get(&object, MAX_MANIFEST_BYTES as u64).await?;
    check_remote(&remote.metadata, &object, &remote.body)?;
    if digest(&remote.body) != manifest_sha256 {
        return Err(Error::Checksum);
    }
    let manifest: Manifest = serde_json::from_slice(&remote.body).map_err(|_| Error::Manifest)?;
    validate_manifest(&manifest, config)?;
    fs::create_dir(destination).map_err(|_| Error::Storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o700))
            .map_err(|_| Error::Storage)?;
    }
    stream::iter(manifest.entries.iter().map(|entry| async {
        let object = content_object(&config.prefix, &entry.sha256);
        let remote = transport.get(&object, config.max_file_bytes).await?;
        check_remote(&remote.metadata, &object, &remote.body)?;
        if digest(&remote.body) != entry.sha256
            || remote.body.len() as u64 != entry.bytes
            || crc32c(&remote.body) != entry.crc32c
        {
            return Err(Error::Checksum);
        }
        let local = destination.join(&entry.path);
        let parent = local.parent().ok_or(Error::UnsafePath)?;
        fs::create_dir_all(parent).map_err(|_| Error::Storage)?;
        check_components(&local)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&local).map_err(|_| Error::Storage)?;
        file.write_all(&remote.body)
            .and_then(|_| file.sync_all())
            .map_err(|_| Error::Storage)?;
        Ok::<(), Error>(())
    }))
    .buffer_unordered(32)
    .try_collect::<Vec<_>>()
    .await?;
    File::open(destination)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| Error::Storage)?;
    Ok(manifest)
}

#[derive(Deserialize)]
struct Token {
    access_token: String,
    expires_in: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GcsMetadata {
    name: String,
    generation: String,
    size: String,
    crc32c: String,
    metadata: std::collections::BTreeMap<String, String>,
}
impl GcsMetadata {
    fn checked(self) -> Result<RemoteMetadata, Error> {
        Ok(RemoteMetadata {
            name: self.name,
            generation: self.generation,
            bytes: self.size.parse().map_err(|_| Error::Checksum)?,
            crc32c: self.crc32c,
            sha256: self.metadata.get("sha256").ok_or(Error::Checksum)?.clone(),
        })
    }
}
pub struct Gcs {
    client: Client,
    bucket: String,
    token: Mutex<Option<(String, u64)>>,
}
impl Gcs {
    pub fn new(config: &Config) -> Result<Self, Error> {
        config.validate()?;
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(30))
                .connect_timeout(Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| Error::Network)?,
            bucket: config.bucket.clone(),
            token: Mutex::new(None),
        })
    }
    async fn token(&self) -> Result<String, Error> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::Credentials)?
            .as_secs();
        let mut cached = self.token.lock().await;
        if let Some((token, expiry)) = &*cached {
            if *expiry > now + 60 {
                return Ok(token.clone());
            }
        }
        let response = self.client.get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token")
            .header("Metadata-Flavor", "Google").send().await.map_err(|_| Error::Credentials)?;
        if !response.status().is_success()
            || response
                .headers()
                .get("Metadata-Flavor")
                .and_then(|value| value.to_str().ok())
                != Some("Google")
        {
            return Err(Error::Credentials);
        }
        let token: Token = serde_json::from_slice(&bounded(response, MAX_CONFIG_BYTES).await?)
            .map_err(|_| Error::Credentials)?;
        if token.access_token.is_empty() || token.expires_in <= 60 || token.expires_in > 86_400 {
            return Err(Error::Credentials);
        }
        let expiry = now
            .checked_add(token.expires_in)
            .ok_or(Error::Credentials)?;
        *cached = Some((token.access_token.clone(), expiry));
        Ok(token.access_token)
    }
    fn url(&self, object: &str, upload: bool) -> Result<Url, Error> {
        let mut url = Url::parse(if upload {
            "https://storage.googleapis.com/upload/storage/v1/b/"
        } else {
            "https://storage.googleapis.com/storage/v1/b/"
        })
        .map_err(|_| Error::Configuration)?;
        let mut path = url.path_segments_mut().map_err(|_| Error::Configuration)?;
        path.pop_if_empty().push(&self.bucket).push("o");
        if !upload {
            path.push(object);
        }
        drop(path);
        Ok(url)
    }
}
async fn bounded(mut response: reqwest::Response, maximum: u64) -> Result<Vec<u8>, Error> {
    if response.content_length().is_some_and(|size| size > maximum) {
        return Err(Error::Limit);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Network)? {
        if bytes.len() as u64 + chunk.len() as u64 > maximum {
            return Err(Error::Limit);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
impl Transport for Gcs {
    async fn create(&self, object: &str, bytes: &[u8], sha256: &str) -> Result<Created, Error> {
        if !segments(object) || !valid_digest(sha256) || digest(bytes) != sha256 {
            return Err(Error::Configuration);
        }
        let mut url = self.url(object, true)?;
        url.query_pairs_mut()
            .append_pair("uploadType", "multipart")
            .append_pair("ifGenerationMatch", "0")
            .append_pair("name", object);
        let boundary = format!("relative-{sha256}");
        let metadata =
            serde_json::json!({"name":object,"metadata":{"sha256":sha256},"crc32c":crc32c(bytes)});
        let mut body = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let response = self
            .client
            .post(url)
            .bearer_auth(self.token().await?)
            .header(
                "Content-Type",
                format!("multipart/related; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .map_err(|_| Error::Network)?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Ok(Created::Exists);
        }
        if !response.status().is_success() {
            return Err(Error::Network);
        }
        let metadata: GcsMetadata =
            serde_json::from_slice(&bounded(response, MAX_CONFIG_BYTES).await?)
                .map_err(|_| Error::Checksum)?;
        Ok(Created::New(metadata.checked()?))
    }
    async fn get(&self, object: &str, max_bytes: u64) -> Result<RemoteObject, Error> {
        if !segments(object) {
            return Err(Error::Configuration);
        }
        let token = self.token().await?;
        let url = self.url(object, false)?;
        let response = self
            .client
            .get(url.clone())
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|_| Error::Network)?;
        if !response.status().is_success() {
            return Err(Error::Network);
        }
        let metadata: GcsMetadata =
            serde_json::from_slice(&bounded(response, MAX_CONFIG_BYTES).await?)
                .map_err(|_| Error::Checksum)?;
        let metadata = metadata.checked()?;
        if metadata.name != object
            || !numeric(&metadata.generation)
            || metadata.generation == "0"
            || metadata.bytes > max_bytes
        {
            return Err(Error::Checksum);
        }
        let mut media = url;
        media
            .query_pairs_mut()
            .append_pair("alt", "media")
            .append_pair("generation", &metadata.generation);
        let response = self
            .client
            .get(media)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| Error::Network)?;
        if !response.status().is_success() {
            return Err(Error::Network);
        }
        let body = bounded(response, max_bytes).await?;
        check_remote(&metadata, object, &body)?;
        Ok(RemoteObject { metadata, body })
    }
}
