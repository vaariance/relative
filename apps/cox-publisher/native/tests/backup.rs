use anchor_lang::{prelude::Pubkey, AccountSerialize};
use relative_publisher::backup::{
    self, Config, Created, Entry, Error, RemoteMetadata, RemoteObject, Transport,
};
use sha2::{Digest, Sha256};
use solana_address::Address;
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Mutex};
fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    config: Config,
}
impl Fixture {
    fn new() -> Self {
        let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = parent.join(format!(
            "relative-backup-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("identity.json"), b"identity").unwrap();
        fs::write(state.join("checkpoint.json"), b"checkpoint").unwrap();
        fs::write(state.join("discovery.json"), b"discovery").unwrap();
        fs::create_dir_all(state.join("prices").join("a".repeat(64)).join("0")).unwrap();
        fs::write(
            state
                .join("prices")
                .join("a".repeat(64))
                .join("0/1000000.json"),
            b"price",
        )
        .unwrap();
        fs::write(state.join("prices/latest.json"), b"latest").unwrap();
        fs::write(state.join("prices/active-anchor.json"), b"anchor").unwrap();
        fs::create_dir_all(state.join("prices/anchors")).unwrap();
        fs::write(
            state
                .join("prices/anchors")
                .join(format!("{}.json", "a".repeat(64))),
            b"anchor",
        )
        .unwrap();
        fs::create_dir_all(state.join("publications")).unwrap();
        fs::write(state.join("publications/0.json"), b"publication").unwrap();
        Self {
            config: Config {
                schema: "relative.backup/v1".into(),
                bucket: "fixture-bucket".into(),
                prefix: "basic-2/native".into(),
                publication_history_prefix: None,
                publication_identity: None,
                state_directory: state,
                markers_directory: root.join("markers"),
                incremental: false,
                retain_price_seconds: None,
                retain_publications: None,
                max_file_bytes: 1024,
                max_files: 100,
                max_total_bytes: 100_000,
            },
            root,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[derive(Default)]
struct Memory {
    values: Mutex<BTreeMap<String, RemoteObject>>,
    uploads: Mutex<Vec<String>>,
    mutation: Mutex<Option<(PathBuf, Vec<u8>)>>,
    corrupt_ack: bool,
}
impl Transport for Memory {
    async fn create(&self, object: &str, body: &[u8], sha256: &str) -> Result<Created, Error> {
        self.uploads.lock().unwrap().push(object.into());
        if let Some((path, bytes)) = self.mutation.lock().unwrap().take() {
            fs::write(path, bytes).unwrap();
        }
        let mut objects = self.values.lock().unwrap();
        if objects.contains_key(object) {
            return Ok(Created::Exists);
        }
        let mut metadata = RemoteMetadata {
            name: object.into(),
            generation: "12345".into(),
            bytes: body.len() as u64,
            crc32c: backup::crc32c(body),
            sha256: sha256.into(),
        };
        objects.insert(
            object.into(),
            RemoteObject {
                metadata: metadata.clone(),
                body: body.into(),
            },
        );
        if self.corrupt_ack {
            metadata.crc32c = "AAAAAA==".into();
        }
        Ok(Created::New(metadata))
    }
    async fn get(&self, object: &str, max_bytes: u64) -> Result<RemoteObject, Error> {
        let objects = self.values.lock().unwrap();
        let value = objects.get(object).ok_or(Error::Network)?;
        if value.body.len() as u64 > max_bytes {
            return Err(Error::Limit);
        }
        Ok(RemoteObject {
            metadata: value.metadata.clone(),
            body: value.body.clone(),
        })
    }
}
#[test]
fn crc32c_matches_castagnoli_check_vector() {
    assert_eq!(backup::crc32c(b"123456789"), "4waSgw==");
    assert_eq!(backup::crc32c(b""), "AAAAAA==");
}
#[test]
fn capture_is_deterministic_and_excludes_credentials_configs_locks_and_temporary_files() {
    let f = Fixture::new();
    let before = backup::capture(&f.config).unwrap();
    for path in [
        "config.json",
        "secret.env",
        "publisher.lock",
        ".temporary.tmp",
        "prices/.latest.tmp",
        "publications/1.json.tmp",
        "publications/keys.json",
    ] {
        fs::write(f.config.state_directory.join(path), b"secret").unwrap();
    }
    fs::create_dir_all(f.config.state_directory.join("signing")).unwrap();
    fs::write(f.config.state_directory.join("signing/key.json"), b"secret").unwrap();
    assert_eq!(backup::capture(&f.config).unwrap(), before);
    assert_eq!(before.entries.len(), 8);
    assert_eq!(before.identity_sha256, digest(b"identity"));
    assert!(before
        .entries
        .windows(2)
        .all(|pair| pair[0].path < pair[1].path));
}
#[tokio::test]
async fn content_addressed_backup_and_local_restore_verify_the_complete_manifest() {
    let f = Fixture::new();
    let transport = Memory::default();
    let report = backup::backup(&f.config, &transport).await.unwrap();
    assert!(report
        .manifest_object
        .starts_with("basic-2/native/manifests/"));
    assert!(!report.manifest_object.contains("pool-0"));
    assert_eq!(report.files, 8);
    assert_eq!(
        transport.uploads.lock().unwrap().last(),
        Some(&report.manifest_object)
    );
    assert!(f
        .config
        .markers_directory
        .join(format!("{}.json", report.manifest_sha256))
        .exists());
    let destination = f.root.join("restore");
    let manifest = backup::restore(&f.config, &transport, &report.manifest_sha256, &destination)
        .await
        .unwrap();
    for entry in &manifest.entries {
        let bytes = fs::read(destination.join(&entry.path)).unwrap();
        assert_eq!(digest(&bytes), entry.sha256);
        assert_eq!(backup::crc32c(&bytes), entry.crc32c);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(destination.join(&entry.path))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0
            );
        }
    }
    assert_eq!(
        backup::restore(&f.config, &transport, &report.manifest_sha256, &destination).await,
        Err(Error::UnsafePath)
    );
    assert_eq!(
        backup::backup(&f.config, &transport)
            .await
            .unwrap()
            .manifest_sha256,
        report.manifest_sha256
    );
}
#[tokio::test]
async fn generation_conflicts_download_and_verify_existing_bytes_instead_of_trusting_412() {
    let f = Fixture::new();
    let transport = Memory::default();
    backup::backup(&f.config, &transport).await.unwrap();
    let object = format!("{}/objects/{}", f.config.prefix, digest(b"identity"));
    transport
        .values
        .lock()
        .unwrap()
        .get_mut(&object)
        .unwrap()
        .body = b"tampered".to_vec();
    assert_eq!(
        backup::backup(&f.config, &transport).await,
        Err(Error::Checksum)
    );
}
#[tokio::test]
async fn checksum_mismatch_never_writes_a_success_marker_or_manifest() {
    let f = Fixture::new();
    let transport = Memory {
        corrupt_ack: true,
        ..Memory::default()
    };
    assert_eq!(
        backup::backup(&f.config, &transport).await,
        Err(Error::Checksum)
    );
    assert!(!f.config.markers_directory.exists());
    assert!(transport
        .uploads
        .lock()
        .unwrap()
        .iter()
        .all(|path| !path.contains("/manifests/")));
}
#[tokio::test]
async fn immutable_file_mutation_before_its_upload_fails_closed() {
    let f = Fixture::new();
    let path = f
        .config
        .state_directory
        .join("prices")
        .join("a".repeat(64))
        .join("0/1000000.json");
    let transport = Memory {
        mutation: Mutex::new(Some((path, b"changed".to_vec()))),
        ..Memory::default()
    };
    assert_eq!(
        backup::backup(&f.config, &transport).await,
        Err(Error::Mutated)
    );
    assert!(!f.config.markers_directory.exists());
}
#[tokio::test]
async fn live_checkpoint_changes_do_not_modify_the_frozen_backup_snapshot() {
    let f = Fixture::new();
    let transport = Memory {
        mutation: Mutex::new(Some((
            f.config.state_directory.join("checkpoint.json"),
            b"new-checkpoint".to_vec(),
        ))),
        ..Memory::default()
    };
    let report = backup::backup(&f.config, &transport).await.unwrap();
    let destination = f.root.join("restore");
    backup::restore(&f.config, &transport, &report.manifest_sha256, &destination)
        .await
        .unwrap();
    assert_eq!(
        fs::read(destination.join("checkpoint.json")).unwrap(),
        b"checkpoint"
    );
    assert_eq!(
        fs::read(f.config.state_directory.join("checkpoint.json")).unwrap(),
        b"new-checkpoint"
    );
}
#[test]
fn limits_and_strict_configuration_reject_unbounded_work_or_path_escape() {
    let f = Fixture::new();
    let mut config = f.config.clone();
    config.max_files = 1;
    assert_eq!(backup::capture(&config), Err(Error::Limit));
    config = f.config.clone();
    config.max_file_bytes = 1;
    assert_eq!(backup::capture(&config), Err(Error::Limit));
    config = f.config.clone();
    config.prefix = "../escape".into();
    assert_eq!(config.validate(), Err(Error::Configuration));
    config = f.config.clone();
    config.markers_directory = config.state_directory.clone();
    assert_eq!(config.validate(), Err(Error::Configuration));
    let mut value = serde_json::to_value(&f.config).unwrap();
    value["credentials"] = serde_json::json!("secret");
    assert!(serde_json::from_value::<Config>(value).is_err());
}
#[cfg(unix)]
#[test]
fn included_symlinks_and_symlinked_roots_are_rejected() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    fs::remove_file(f.config.state_directory.join("checkpoint.json")).unwrap();
    symlink(
        "/etc/passwd",
        f.config.state_directory.join("checkpoint.json"),
    )
    .unwrap();
    assert_eq!(backup::capture(&f.config), Err(Error::UnsafePath));
    fs::remove_file(f.config.state_directory.join("checkpoint.json")).unwrap();
    symlink(
        f.config.state_directory.join("prices"),
        f.root.join("linked"),
    )
    .unwrap();
    let mut config = f.config.clone();
    config.state_directory = f.root.join("linked");
    assert_eq!(backup::capture(&config), Err(Error::UnsafePath));
}
#[tokio::test]
async fn malicious_manifest_paths_and_collisions_are_rejected_before_restore_writes() {
    let f = Fixture::new();
    let transport = Memory::default();
    let base = backup::capture(&f.config).unwrap();
    for path in ["../secret", "config.json", "identity.json"] {
        let mut manifest = base.clone();
        manifest.entries.push(Entry {
            path: path.into(),
            bytes: 8,
            sha256: digest(b"identity"),
            crc32c: backup::crc32c(b"identity"),
        });
        manifest.entries.sort_by(|a, b| a.path.cmp(&b.path));
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let hash = digest(&bytes);
        let object = format!("{}/manifests/{hash}.json", f.config.prefix);
        transport.create(&object, &bytes, &hash).await.unwrap();
        assert_eq!(
            backup::restore(&f.config, &transport, &hash, &f.root.join("restore")).await,
            Err(Error::Manifest)
        );
        assert!(!f.root.join("restore").exists());
    }
}
#[tokio::test]
async fn restore_rejects_content_hash_changes_even_if_remote_checksums_are_self_consistent() {
    let f = Fixture::new();
    let transport = Memory::default();
    let report = backup::backup(&f.config, &transport).await.unwrap();
    let object = format!("{}/objects/{}", f.config.prefix, digest(b"identity"));
    let mut values = transport.values.lock().unwrap();
    let value = values.get_mut(&object).unwrap();
    value.body = b"different".to_vec();
    value.metadata.bytes = value.body.len() as u64;
    value.metadata.sha256 = digest(&value.body);
    value.metadata.crc32c = backup::crc32c(&value.body);
    drop(values);
    assert_eq!(
        backup::restore(
            &f.config,
            &transport,
            &report.manifest_sha256,
            &f.root.join("restore")
        )
        .await,
        Err(Error::Checksum)
    );
}

fn publication_fixture(
    program: Address,
    pool: Address,
    sequence: u64,
    previous: [u8; 32],
) -> (Vec<u8>, [u8; 32]) {
    let mut state = (12u32).to_le_bytes().to_vec();
    state.extend_from_slice(b"COX/STATE/V1");
    state.extend_from_slice(program.as_ref());
    state.extend_from_slice(pool.as_ref());
    state.extend_from_slice(&sequence.to_le_bytes());
    state.extend_from_slice(&(sequence + 20).to_le_bytes());
    state.extend_from_slice(&(sequence + 100).to_le_bytes());
    state.extend_from_slice(&previous);
    state.extend_from_slice(&[4; 32]);
    state.extend_from_slice(&[5; 32]);
    state.extend_from_slice(&100i128.to_le_bytes());
    state.extend_from_slice(&2u32.to_le_bytes());
    state.extend_from_slice(&10u64.to_le_bytes());
    state.extend_from_slice(&20u64.to_le_bytes());
    state.extend_from_slice(&3u32.to_le_bytes());
    for _ in 0..3 {
        state.extend_from_slice(&100i128.to_le_bytes());
    }
    state.extend_from_slice(&3u32.to_le_bytes());
    state.extend_from_slice(&[0; 144]);
    state.extend_from_slice(&[0; 72]);
    let digest: [u8; 32] = Sha256::digest(&state).into();
    let publication = cox::Publication {
        schema_version: 2,
        bump: Address::find_program_address(&[b"publication", pool.as_ref()], &program).1,
        pool: Pubkey::new_from_array(pool.to_bytes()),
        sequence,
        batch: sequence + 20,
        state_digest: digest,
        snapshot_digest: [5; 32],
        manifest_digest: [4; 32],
        state_preimage: state,
        prices: vec![
            cox::PriceWire {
                price_e8: 10,
                venue: 0,
                step: 0,
                candle_start: 100,
                trade_age_minutes: 0,
            },
            cox::PriceWire {
                price_e8: 20,
                venue: 0,
                step: 0,
                candle_start: 100,
                trade_age_minutes: 0,
            },
        ],
        committed_at: 100,
    };
    let mut bytes = Vec::new();
    publication.try_serialize(&mut bytes).unwrap();
    bytes.resize(8192, 0);
    (bytes, digest)
}

fn enable_history(f: &mut Fixture) -> Vec<u8> {
    let program = Address::new_from_array([1; 32]);
    let pool = Address::new_from_array([2; 32]);
    f.config.publication_history_prefix = Some("pool-2/history".into());
    f.config.publication_identity = Some(relative_publisher::publications::Identity {
        program: program.to_string(),
        pool: pool.to_string(),
        genesis_hash: relative_publisher::rpc::DEVNET_GENESIS.into(),
    });
    f.config.max_file_bytes = 32_768;
    fs::remove_file(f.config.state_directory.join("publications/0.json")).unwrap();
    let archive = relative_publisher::publications::Archive::new(
        f.config.state_directory.join("publications"),
        program,
        pool,
    );
    let (account, state_digest) = publication_fixture(program, pool, 0, [0; 32]);
    archive
        .preserve(program, archive.address(), &account, 123, 0, state_digest)
        .unwrap();
    fs::read(f.config.state_directory.join("publications/0.json")).unwrap()
}
#[tokio::test]
async fn publication_history_exports_exact_verified_bytes_at_api_compatible_object_name() {
    let mut f = Fixture::new();
    let bytes = enable_history(&mut f);
    let transport = Memory::default();
    let report = backup::backup(&f.config, &transport).await.unwrap();
    let object = format!("pool-2/history/0/{}.json", digest(&bytes));
    assert_eq!(
        transport.values.lock().unwrap().get(&object).unwrap().body,
        bytes
    );
    assert!(transport
        .values
        .lock()
        .unwrap()
        .contains_key(&format!("basic-2/native/objects/{}", digest(&bytes))));
    assert_eq!(
        backup::backup(&f.config, &transport)
            .await
            .unwrap()
            .manifest_sha256,
        report.manifest_sha256
    );
    let record: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(record["commitment"], "confirmed");
    assert_eq!(record["observedSlot"], 123);
    assert!(record.get("finalizedSlot").is_none());
    let mut values = transport.values.lock().unwrap();
    let value = values.get_mut(&object).unwrap();
    value.body = b"different".to_vec();
    value.metadata.bytes = value.body.len() as u64;
    value.metadata.sha256 = digest(&value.body);
    value.metadata.crc32c = backup::crc32c(&value.body);
    drop(values);
    assert_eq!(
        backup::backup(&f.config, &transport).await,
        Err(Error::Conflict)
    );
}
#[tokio::test]
async fn history_rejects_wrong_identity_sequence_provenance_and_account_integrity() {
    for mutation in 0..8 {
        let mut f = Fixture::new();
        let bytes = enable_history(&mut f);
        let mut record: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        match mutation {
            0 => record["identity"]["pool"] = Address::new_from_array([3; 32]).to_string().into(),
            1 => record["sequence"] = "1".into(),
            2 => record["commitment"] = "finalized".into(),
            3 => record["finalizedSlot"] = 123.into(),
            4 => {
                record["identity"]["program"] = Address::new_from_array([3; 32]).to_string().into()
            }
            5 => record["identity"]["genesisHash"] = "mainnet".into(),
            6 => record["observedSlot"] = (9_007_199_254_740_992_u64).into(),
            _ => record["accountSha256"] = "0".repeat(64).into(),
        }
        fs::write(
            f.config.state_directory.join("publications/0.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        let transport = Memory::default();
        assert_eq!(
            backup::backup(&f.config, &transport).await,
            Err(Error::Manifest)
        );
        assert!(!transport
            .values
            .lock()
            .unwrap()
            .keys()
            .any(|key| key.starts_with("pool-2/history/") || key.contains("/manifests/")));
        assert!(!f.config.markers_directory.exists());
    }
}
#[test]
fn history_configuration_requires_safe_disjoint_prefix_and_explicit_devnet_identity() {
    let mut f = Fixture::new();
    enable_history(&mut f);
    for prefix in [
        "../escape",
        "pool-2/history/",
        "basic-2/native",
        "basic-2/native/history",
        "basic-2",
    ] {
        let mut config = f.config.clone();
        config.publication_history_prefix = Some(prefix.into());
        assert_eq!(config.validate(), Err(Error::Configuration));
    }
    let mut config = f.config.clone();
    config.publication_identity = None;
    assert_eq!(config.validate(), Err(Error::Configuration));
    let mut config = f.config.clone();
    config.publication_history_prefix = None;
    assert_eq!(config.validate(), Err(Error::Configuration));
    let mut config = f.config.clone();
    config.publication_identity.as_mut().unwrap().genesis_hash = "mainnet".into();
    assert_eq!(config.validate(), Err(Error::Configuration));
    let mut legacy = serde_json::to_value(&f.config).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("publication_history_prefix");
    legacy
        .as_object_mut()
        .unwrap()
        .remove("publication_identity");
    serde_json::from_value::<Config>(legacy)
        .unwrap()
        .validate()
        .unwrap();
}

#[tokio::test]
async fn incremental_restart_reuses_verified_receipts_and_uploads_only_new_content() {
    let mut f = Fixture::new();
    f.config.incremental = true;
    let t = Memory::default();
    backup::backup(&f.config, &t).await.unwrap();
    let first = t.uploads.lock().unwrap().clone();
    assert!(first[0].ends_with(&digest(b"publication")));
    t.uploads.lock().unwrap().clear();
    backup::backup(&f.config, &t).await.unwrap();
    assert_eq!(t.uploads.lock().unwrap().len(), 1);
    fs::write(
        f.config
            .state_directory
            .join("prices")
            .join("a".repeat(64))
            .join("0/2000000.json"),
        b"new price",
    )
    .unwrap();
    t.uploads.lock().unwrap().clear();
    let report = backup::backup(&f.config, &t).await.unwrap();
    let uploads = t.uploads.lock().unwrap().clone();
    assert_eq!(uploads.len(), 2);
    assert!(uploads[0].ends_with(&digest(b"new price")));
    let restored = backup::restore(
        &f.config,
        &t,
        &report.manifest_sha256,
        &f.root.join("incremental-restored"),
    )
    .await
    .unwrap();
    assert_eq!(restored.entries.len(), 9);
}
#[tokio::test]
async fn retention_prunes_only_cloud_backed_old_prices_and_preserves_restorable_evidence() {
    let mut f = Fixture::new();
    f.config.incremental = true;
    f.config.retain_price_seconds = Some(129600);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        * 1000000;
    let p = f
        .config
        .state_directory
        .join("prices")
        .join("a".repeat(64))
        .join((now / 3600000000).to_string());
    fs::create_dir_all(&p).unwrap();
    fs::write(p.join(format!("{now}.json")), b"recent").unwrap();
    let t = Memory::default();
    let report = backup::backup(&f.config, &t).await.unwrap();
    assert!(!f
        .config
        .state_directory
        .join("prices")
        .join("a".repeat(64))
        .join("0/1000000.json")
        .exists());
    for name in [
        "checkpoint.json",
        "identity.json",
        "prices/latest.json",
        "prices/active-anchor.json",
        "publications/0.json",
    ] {
        assert!(f.config.state_directory.join(name).exists());
    }
    backup::restore(
        &f.config,
        &t,
        &report.manifest_sha256,
        &f.root.join("retention-restored"),
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read(
            f.root
                .join("retention-restored/prices")
                .join("a".repeat(64))
                .join("0/1000000.json")
        )
        .unwrap(),
        b"price"
    );
    assert!(p.join(format!("{now}.json")).exists());
}
#[tokio::test]
async fn failed_incremental_upload_never_prunes_or_acknowledges_corrupt_bytes() {
    let mut f = Fixture::new();
    f.config.incremental = true;
    f.config.retain_price_seconds = Some(129600);
    let t = Memory {
        corrupt_ack: true,
        ..Memory::default()
    };
    assert_eq!(backup::backup(&f.config, &t).await, Err(Error::Checksum));
    assert!(f
        .config
        .state_directory
        .join("prices")
        .join("a".repeat(64))
        .join("0/1000000.json")
        .exists());
    assert!(!t
        .uploads
        .lock()
        .unwrap()
        .iter()
        .any(|n| n.contains("/manifests/")));
    assert_eq!(
        f.config
            .markers_directory
            .read_dir()
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .count(),
        0
    );
}

struct Flaky {
    memory: Memory,
    remaining: Mutex<Option<usize>>,
}
impl Transport for Flaky {
    async fn create(&self, object: &str, body: &[u8], sha: &str) -> Result<Created, Error> {
        {
            let mut count = self.remaining.lock().unwrap();
            if let Some(n) = count.as_mut() {
                if *n == 0 {
                    *count = None;
                    return Err(Error::Network);
                }
                *n -= 1;
            }
        }
        self.memory.create(object, body, sha).await
    }
    async fn get(&self, object: &str, max: u64) -> Result<RemoteObject, Error> {
        self.memory.get(object, max).await
    }
}
#[tokio::test]
async fn interrupted_backup_reuses_acknowledged_progress_before_a_manifest_exists() {
    let mut f = Fixture::new();
    f.config.incremental = true;
    let t = Flaky {
        memory: Memory::default(),
        remaining: Mutex::new(Some(2)),
    };
    assert_eq!(backup::backup(&f.config, &t).await, Err(Error::Network));
    let verified = t.memory.uploads.lock().unwrap().clone();
    assert_eq!(verified.len(), 2);
    t.memory.uploads.lock().unwrap().clear();
    let report = backup::backup(&f.config, &t).await.unwrap();
    let retried = t.memory.uploads.lock().unwrap().clone();
    for object in verified {
        assert!(!retried.contains(&object));
    }
    backup::restore(
        &f.config,
        &t,
        &report.manifest_sha256,
        &f.root.join("resumed-restored"),
    )
    .await
    .unwrap();
}
#[test]
fn retention_cannot_remove_prices_inside_the_epoch_recovery_window() {
    let mut f = Fixture::new();
    f.config.incremental = true;
    f.config.retain_price_seconds = Some(86400);
    assert_eq!(f.config.validate(), Err(Error::Configuration));
    f.config.retain_price_seconds = Some(129600);
    assert_eq!(f.config.validate(), Ok(()));
    f.config.incremental = false;
    assert_eq!(f.config.validate(), Err(Error::Configuration));
}

#[tokio::test]
async fn publication_retention_preserves_cloud_history_and_the_local_predecessor_chain() {
    let mut f = Fixture::new();
    enable_history(&mut f);
    f.config.incremental = true;
    f.config.retain_publications = Some(2);
    let program = Address::new_from_array([1; 32]);
    let pool = Address::new_from_array([2; 32]);
    let archive = relative_publisher::publications::Archive::new(
        f.config.state_directory.join("publications"),
        program,
        pool,
    );
    let (_, mut previous) = publication_fixture(program, pool, 0, [0; 32]);
    for n in 1..4 {
        let (bytes, d) = publication_fixture(program, pool, n, previous);
        archive
            .preserve(program, archive.address(), &bytes, 123 + n, n, d)
            .unwrap();
        previous = d;
    }
    let t = Memory::default();
    let report = backup::backup(&f.config, &t).await.unwrap();
    assert!(!f
        .config
        .state_directory
        .join("publications/0.json")
        .exists());
    assert!(!f
        .config
        .state_directory
        .join("publications/1.json")
        .exists());
    assert!(f
        .config
        .state_directory
        .join("publications/2.json")
        .exists());
    assert!(f
        .config
        .state_directory
        .join("publications/3.json")
        .exists());
    assert_eq!(
        t.values
            .lock()
            .unwrap()
            .keys()
            .filter(|s| s.starts_with("pool-2/history/"))
            .count(),
        4
    );
    let (bytes, d) = publication_fixture(program, pool, 4, previous);
    archive
        .preserve(program, archive.address(), &bytes, 130, 4, d)
        .unwrap();
    backup::restore(
        &f.config,
        &t,
        &report.manifest_sha256,
        &f.root.join("full-publication-recovery"),
    )
    .await
    .unwrap();
    assert!(f
        .root
        .join("full-publication-recovery/publications/0.json")
        .exists());
}
