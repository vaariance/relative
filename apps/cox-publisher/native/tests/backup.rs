use relative_publisher::backup::{
    self, Config, Created, Entry, Error, RemoteMetadata, RemoteObject, Transport,
};
use sha2::{Digest, Sha256};
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
                state_directory: state,
                markers_directory: root.join("markers"),
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
async fn immutable_file_mutation_between_capture_and_upload_fails_closed() {
    let f = Fixture::new();
    let path = f.config.state_directory.join("publications/0.json");
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
