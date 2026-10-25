use crate::{backup, journal, preview, runtime};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inputs {
    runtime_config_path: PathBuf,
    output_dir: PathBuf,
    report_path: PathBuf,
    evaluation_timestamp_seconds: u64,
}

struct LocalObjects {
    root: PathBuf,
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn regular(path: &Path) -> Vec<u8> {
    let metadata = fs::symlink_metadata(path).unwrap();
    assert!(metadata.is_file() && !metadata.file_type().is_symlink());
    fs::read(path).unwrap()
}

fn local_path(path: &Path, root: &Path) {
    assert!(path.is_absolute() && path.starts_with(root));
    assert!(path
        .components()
        .all(|part| !matches!(part, Component::ParentDir)));
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        if let Ok(metadata) = fs::symlink_metadata(&current) {
            assert!(!metadata.file_type().is_symlink());
        }
    }
}

impl LocalObjects {
    fn path(&self, object: &str) -> Result<PathBuf, backup::Error> {
        if object.is_empty()
            || object.split('/').any(|part| {
                part.is_empty()
                    || part == "."
                    || part == ".."
                    || !part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            })
        {
            return Err(backup::Error::UnsafePath);
        }
        Ok(self.root.join(object))
    }
}

impl backup::Transport for LocalObjects {
    async fn create(
        &self,
        object: &str,
        bytes: &[u8],
        sha256: &str,
    ) -> Result<backup::Created, backup::Error> {
        if hash(bytes) != sha256 {
            return Err(backup::Error::Checksum);
        }
        let path = self.path(object)?;
        fs::create_dir_all(path.parent().ok_or(backup::Error::UnsafePath)?)
            .map_err(|_| backup::Error::Storage)?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Ok(backup::Created::Exists)
            }
            Err(_) => return Err(backup::Error::Storage),
        };
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| backup::Error::Storage)?;
        Ok(backup::Created::New(backup::RemoteMetadata {
            name: object.into(),
            generation: "1".into(),
            bytes: bytes.len() as u64,
            crc32c: backup::crc32c(bytes),
            sha256: sha256.into(),
        }))
    }

    async fn get(
        &self,
        object: &str,
        max_bytes: u64,
    ) -> Result<backup::RemoteObject, backup::Error> {
        let path = self.path(object)?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| backup::Error::Storage)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max_bytes {
            return Err(backup::Error::UnsafePath);
        }
        let body = fs::read(path).map_err(|_| backup::Error::Storage)?;
        Ok(backup::RemoteObject {
            metadata: backup::RemoteMetadata {
                name: object.into(),
                generation: "1".into(),
                bytes: body.len() as u64,
                crc32c: backup::crc32c(&body),
                sha256: hash(&body),
            },
            body,
        })
    }
}

#[tokio::test]
#[ignore = "requires explicit isolated local-validator rehearsal state"]
async fn archive_restore_and_preview_from_local_rehearsal() {
    let inputs_path = PathBuf::from(
        std::env::var_os("RELATIVE_LOCAL_ARCHIVE_CONFIG").expect("explicit config required"),
    );
    let local_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap()
        .join(".cox/local-rehearsal");
    local_path(&inputs_path, &local_root);
    let inputs: Inputs = serde_json::from_slice(&regular(&inputs_path)).unwrap();
    for path in [
        &inputs.runtime_config_path,
        &inputs.output_dir,
        &inputs.report_path,
    ] {
        local_path(path, &local_root);
    }
    let runtime = runtime::Config::read(&inputs.runtime_config_path).unwrap();
    local_path(&runtime.state_directory, &local_root);
    assert_eq!(runtime.basic_pool_id, 0);
    runtime.verify_state_identity().unwrap();
    assert!(
        !inputs.output_dir.exists(),
        "use a fresh archive output directory"
    );
    fs::create_dir(&inputs.output_dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&inputs.output_dir, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let config = backup::Config {
        schema: "relative.backup/v2".into(),
        runtime_config_path: Some(inputs.runtime_config_path.clone()),
        bucket: "local-rehearsal-only".into(),
        prefix: "pool-0/native".into(),
        publication_history_prefix: Some("pool-0/history".into()),
        publication_identity: Some(runtime.publication_identity().unwrap()),
        state_directory: runtime.state_directory.clone(),
        markers_directory: inputs.output_dir.join("markers"),
        incremental: true,
        retain_price_seconds: None,
        retain_publications: None,
        max_file_bytes: 16 * 1024 * 1024,
        max_files: 200_000,
        max_total_bytes: 1024 * 1024 * 1024,
    };
    let objects = LocalObjects {
        root: inputs.output_dir.join("objects"),
    };
    let first = backup::backup(&config, &objects).await.unwrap();
    let second = backup::backup(&config, &objects).await.unwrap();
    assert_eq!(first, second);
    let destination = inputs.output_dir.join("restored");
    let manifest = backup::restore(&config, &objects, &first.manifest_sha256, &destination)
        .await
        .unwrap();
    let mut publication_count = 0;
    for entry in &manifest.entries {
        let source = regular(&runtime.state_directory.join(&entry.path));
        let restored = regular(&destination.join(&entry.path));
        assert_eq!(source, restored, "{}", entry.path);
        assert_eq!(hash(&restored), entry.sha256);
        if let Some(sequence) = entry
            .path
            .strip_prefix("publications/")
            .and_then(|p| p.strip_suffix(".json"))
        {
            let history = objects
                .path(&format!("pool-0/history/{sequence}/{}.json", entry.sha256))
                .unwrap();
            assert_eq!(regular(&history), restored);
            publication_count += 1;
        }
    }
    assert!(
        publication_count > 0,
        "actual native publication records are required"
    );
    runtime
        .verify_identity_bytes(&regular(&destination.join("identity.json")))
        .unwrap();

    let mut wrong_runtime = runtime.clone();
    wrong_runtime.key_version.push_str("-wrong-generation");
    let wrong_config_path = inputs.output_dir.join("wrong-runtime.json");
    journal::atomic_write(&wrong_config_path, &wrong_runtime).unwrap();
    let mut wrong_config = config.clone();
    wrong_config.runtime_config_path = Some(wrong_config_path);
    let rejected_destination = inputs.output_dir.join("wrong-generation");
    assert_eq!(
        backup::restore(
            &wrong_config,
            &objects,
            &first.manifest_sha256,
            &rejected_destination
        )
        .await
        .unwrap_err(),
        backup::Error::Conflict
    );
    assert!(!rejected_destination.exists());

    let identity = manifest
        .entries
        .iter()
        .find(|entry| entry.path == "identity.json")
        .unwrap();
    let identity_object = objects
        .path(&format!("pool-0/native/objects/{}", identity.sha256))
        .unwrap();
    let original = regular(&identity_object);
    let mut corrupt = original.clone();
    corrupt[0] ^= 1;
    fs::write(&identity_object, corrupt).unwrap();
    let corrupt_destination = inputs.output_dir.join("corrupt-restore");
    assert_eq!(
        backup::restore(
            &config,
            &objects,
            &first.manifest_sha256,
            &corrupt_destination
        )
        .await
        .unwrap_err(),
        backup::Error::Checksum
    );
    assert!(!corrupt_destination.exists());
    fs::write(&identity_object, original).unwrap();

    let history = journal::FileHistory {
        directory: runtime.state_directory.join("prices"),
    };
    let anchor = history
        .active_anchor()
        .unwrap()
        .unwrap_or(runtime.anchor.clone());
    let observation = history
        .latest_for_anchor(&anchor)
        .unwrap()
        .expect("actual signed history required");
    assert!(!observation.signed_payload.is_empty());
    assert_eq!(
        history
            .exact(&anchor.universe_digest, observation.timestamp_us)
            .unwrap(),
        Some(observation.clone())
    );
    let now_us = u128::from(inputs.evaluation_timestamp_seconds) * 1_000_000;
    assert!(
        u128::from(observation.timestamp_us) <= now_us,
        "future preview rejected"
    );
    let ledger: preview::Ledger =
        journal::read(&runtime.state_directory.join("preview-ledger.json"))
            .unwrap()
            .unwrap();
    let expected_identity = runtime.publication_identity().unwrap();
    assert_eq!(ledger.program, expected_identity.program);
    assert_eq!(ledger.pool, expected_identity.pool);
    let preview = preview::Record::derive(&anchor, &observation, &ledger).unwrap();
    assert!(preview.generation.is_some());
    preview::upload(&objects, "pool-0/preview", &preview)
        .await
        .unwrap();
    preview::upload(&objects, "pool-0/preview", &preview)
        .await
        .unwrap();
    assert_eq!(
        regular(
            &objects
                .path(&format!("pool-0/preview/{}.json", preview.timestamp))
                .unwrap()
        ),
        serde_json::to_vec(&preview).unwrap()
    );
    journal::atomic_write(&inputs.report_path, &serde_json::json!({
        "schema": "relative.local-rehearsal-archive/v1", "scope": "local-only; no GCS or network transport",
        "backup": first, "restoredFiles": manifest.entries.len(), "publicationHistoryRecords": publication_count,
        "byteIdenticalRestore": true, "idempotentCreateOnlyBackup": true,
        "wrongGenerationRestoreRejectedBeforeDestinationCreation": true,
        "tamperedObjectRejectedBeforeDestinationCreation": true,
        "previewTimestamp": preview.timestamp, "previewGeneration": preview.generation,
        "previewAssetCount": preview.assets.len(), "previewFromSignedLocalHistory": true,
        "sourceIdentitySha256": manifest.identity_sha256,
        "transportSolanaHttpCalls": 0, "transportCloudCalls": 0,
        "warning": "Local-validator publications and controlled signed test prices are not a live devnet or Pyth delivery result"
    })).unwrap();
}
