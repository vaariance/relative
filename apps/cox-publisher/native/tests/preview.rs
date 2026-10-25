use cox_math::SCALE;
use relative_publisher::{
    backup::{self, Created, RemoteMetadata, RemoteObject, Transport},
    benchmark::{Anchor, Asset, Observation},
    preview::{upload, AssetOrigin, Error, Ledger, LedgerClass, Record, Universe},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Mutex};
#[path = "support/runtime.rs"]
mod runtime_fixture;
fn fixture() -> (Anchor, Observation, Ledger) {
    let anchor = Anchor {
        universe_digest: [1; 32],
        timestamp_us: 1_000_000,
        benchmark: 100 * SCALE,
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
    };
    let value = Observation {
        universe_digest: [1; 32],
        timestamp_us: 2_000_000,
        benchmark: 200 * SCALE,
        prices_e8: vec![400, 100],
        signed_payload: vec![1],
    };
    let ledger = Ledger {
        generation: None,
        universe: None,
        program: solana_address::Address::new_from_array([2; 32]).to_string(),
        pool: solana_address::Address::new_from_array([3; 32]).to_string(),
        methodology_digest: "a".repeat(64),
        sequence: 7,
        state_digest: "b".repeat(64),
        timestamp: 1,
        benchmark: 100 * SCALE,
        prices_e8: vec![100, 100],
        classes: vec![
            LedgerClass {
                backing: 1_000_000,
                units: 1_000_000 * SCALE as u128,
            },
            LedgerClass {
                backing: 1_000_000,
                units: 1_000_000 * SCALE as u128,
            },
            LedgerClass {
                backing: 0,
                units: 0,
            },
        ],
    };
    (anchor, value, ledger)
}
#[tokio::test]
async fn exporter_rejects_unbound_notification_spool_before_uploading_any_preview() {
    use relative_publisher::{journal, preview};
    let root = std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!(
            "preview-generation-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
    let state = root.join("new-generation");
    let runtime = runtime_fixture::config(state.clone(), 7);
    let runtime_path = root.join("runtime.json");
    journal::atomic_write(&runtime_path, &runtime).unwrap();
    journal::atomic_write(
        &state.join("identity.json"),
        &serde_json::json!({
            "identity": runtime.identity().unwrap(), "anchor": runtime.anchor,
        }),
    )
    .unwrap();
    let backup_path = root.join("backup.json");
    journal::atomic_write(&backup_path, &serde_json::json!({
        "schema": "relative.backup/v2", "runtime_config_path": runtime_path,
        "bucket": "unused-test-bucket", "prefix": "pool-7/native",
        "publication_history_prefix": "pool-7/history", "publication_identity": runtime.publication_identity().unwrap(),
        "state_directory": state, "markers_directory": root.join("markers"),
        "max_file_bytes": 16_777_216, "max_files": 100, "max_total_bytes": 33_554_432,
    })).unwrap();
    let old_notification = state.with_extension("chain-spool").join("old.json");
    journal::atomic_write(
        &old_notification,
        &serde_json::json!({"old":"notification"}),
    )
    .unwrap();
    assert_eq!(
        preview::run(&runtime_path, &backup_path).await,
        Err(Error::Invalid)
    );
    assert!(old_notification.exists());
    assert!(!state
        .with_extension("chain-spool")
        .join("identity.binding")
        .exists());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn references_and_backing_projection_follow_the_existing_protocol_without_treating_reference_as_nav(
) {
    let (a, v, l) = fixture();
    let r = Record::derive(&a, &v, &l).unwrap();
    assert_eq!(r.assets[0].reference, (200 * SCALE).to_string());
    assert_eq!(r.assets[1].reference, (50 * SCALE).to_string());
    let p = r.basic_projection.unwrap();
    assert_eq!(p.classes[0].backing, "1600000");
    assert_eq!(p.classes[1].backing, "400000");
    assert_eq!(p.sequence, "7");
    assert_eq!(p.state_digest, l.state_digest);
    assert_eq!(p.added_residual, "0");
    assert_eq!(r.status, "estimate");
    assert_eq!(r.timestamp, 2);
    assert_eq!(r.crypto_reference, (100 * SCALE).to_string());
}
#[test]
fn json_uses_integer_strings_and_stable_camel_case_fields_without_feed_credentials() {
    let (a, v, l) = fixture();
    let r = Record::derive(&a, &v, &l).unwrap();
    let s = serde_json::to_value(&r).unwrap();
    assert!(s["benchmark"].is_string());
    assert_eq!(s["assets"][0]["priceE8"], "400");
    assert_eq!(s["assets"][0]["classId"], 0);
    assert_eq!(s["scales"]["reference"], SCALE.to_string());
    assert!(s.get("signedPayload").is_none());
    assert!(s.get("apiKey").is_none());
    assert_eq!(serde_json::from_value::<Record>(s).unwrap(), r);
}
#[test]
fn invalid_observation_and_wrong_benchmark_never_export() {
    let (a, v, l) = fixture();
    for i in 0..4 {
        let mut bad = v.clone();
        match i {
            0 => bad.benchmark += 1,
            1 => bad.universe_digest[0] ^= 1,
            2 => bad.prices_e8.pop().map(|_| ()).unwrap(),
            _ => bad.timestamp_us += 1,
        };
        assert_eq!(Record::derive(&a, &bad, &l), Err(Error::Invalid));
    }
}
#[test]
fn newer_ledger_cannot_be_used_to_project_an_older_observation() {
    let (a, v, mut l) = fixture();
    l.timestamp = 3;
    let r = Record::derive(&a, &v, &l).unwrap();
    assert!(r.basic_projection.is_none());
    assert_eq!(r.assets[0].reference, (200 * SCALE).to_string());
}
#[test]
fn an_empty_class_cannot_receive_free_backing_from_price_changes() {
    let (a, v, mut l) = fixture();
    l.classes[0] = LedgerClass {
        backing: 0,
        units: 0,
    };
    let p = Record::derive(&a, &v, &l)
        .unwrap()
        .basic_projection
        .unwrap();
    assert_eq!(p.classes[0].backing, "0");
    assert_eq!(p.classes[0].units, "0");
    assert_eq!(p.classes[1].backing, "1000000");
}
#[derive(Default)]
struct Store(Mutex<BTreeMap<String, Vec<u8>>>);
fn metadata(name: &str, bytes: &[u8]) -> RemoteMetadata {
    RemoteMetadata {
        name: name.into(),
        generation: "1".into(),
        bytes: bytes.len() as u64,
        crc32c: backup::crc32c(bytes),
        sha256: hex::encode(Sha256::digest(bytes)),
    }
}
impl Transport for Store {
    async fn create(&self, name: &str, bytes: &[u8], _: &str) -> Result<Created, backup::Error> {
        let mut s = self.0.lock().unwrap();
        if s.contains_key(name) {
            return Ok(Created::Exists);
        }
        s.insert(name.into(), bytes.into());
        Ok(Created::New(metadata(name, bytes)))
    }
    async fn get(&self, name: &str, _: u64) -> Result<RemoteObject, backup::Error> {
        let s = self.0.lock().unwrap();
        let b = s.get(name).unwrap();
        Ok(RemoteObject {
            metadata: metadata(name, b),
            body: b.clone(),
        })
    }
}
#[tokio::test]
async fn upload_is_immutable_retryable_and_rejects_conflicting_same_second() {
    let (a, v, l) = fixture();
    let r = Record::derive(&a, &v, &l).unwrap();
    let s = Store::default();
    upload(&s, "pool-2/preview", &r).await.unwrap();
    upload(&s, "pool-2/preview", &r).await.unwrap();
    assert_eq!(s.0.lock().unwrap().len(), 1);
    assert!(s.0.lock().unwrap().contains_key("pool-2/preview/2.json"));
    let mut changed = r;
    changed.benchmark = "1".into();
    assert_eq!(
        upload(&s, "pool-2/preview", &changed).await,
        Err(Error::Conflict)
    );
}

#[test]
fn notification_metadata_is_optional_for_legacy_records_and_does_not_confirm_estimates() {
    let (anchor, value, ledger) = fixture();
    let mut record = Record::derive(&anchor, &value, &ledger).unwrap();
    let legacy = serde_json::to_value(&record).unwrap();
    assert!(legacy.get("chainChange").is_none());
    record.chain_change = Some(relative_publisher::changes::Notification {
        schema: "relative.chain-change/v1".into(),
        generation: "a".repeat(64),
        revision: "3".into(),
        observed_slot: 123,
        commitment: "confirmed".into(),
        stream_healthy: true,
    });
    let encoded = serde_json::to_value(&record).unwrap();
    assert_eq!(encoded["status"], "estimate");
    assert_eq!(encoded["chainChange"]["revision"], "3");
    assert_eq!(encoded["chainChange"]["commitment"], "confirmed");
    assert_eq!(serde_json::from_value::<Record>(encoded).unwrap(), record);
}

#[test]
fn expanded_preview_keeps_permanent_origins_and_crypto_at_class_thirty() {
    let (mut anchor, mut observation, mut ledger) = fixture();
    anchor.benchmark = 200 * SCALE;
    anchor.assets = (0..31)
        .map(|index| Asset {
            id: format!("A{index}"),
            feed_id: index + 1,
            origin_price_e8: 200,
        })
        .collect();
    observation.benchmark = 200 * SCALE;
    observation.prices_e8 = vec![200; 31];
    ledger.benchmark = 200 * SCALE;
    ledger.prices_e8 = vec![200; 31];
    ledger.classes = (0..32)
        .map(|_| LedgerClass {
            backing: 1_000_000,
            units: 1_000_000 * SCALE as u128,
        })
        .collect();
    ledger.universe = Some(Universe {
        crypto_class: 30,
        price_digest: anchor.universe_digest,
        origins: anchor
            .assets
            .iter()
            .enumerate()
            .map(|(index, asset)| AssetOrigin {
                asset_id: asset.id.clone(),
                class_id: if index < 30 { index as u16 } else { 31 },
                price_e8: if index < 30 { 100 } else { 200 },
                benchmark: if index < 30 { 100 * SCALE } else { 200 * SCALE },
            })
            .collect(),
    });
    let record = Record::derive(&anchor, &observation, &ledger).unwrap();
    assert_eq!(record.crypto_class, 30);
    assert_eq!(record.assets[30].class_id, 31);
    assert!(record
        .assets
        .iter()
        .all(|asset| asset.reference == (100 * SCALE).to_string()));
    let projection = record.basic_projection.unwrap();
    assert!(projection
        .classes
        .iter()
        .all(|class| class.backing == "1000000"));
    ledger.universe.as_mut().unwrap().origins[30].class_id = 30;
    assert_eq!(
        Record::derive(&anchor, &observation, &ledger),
        Err(Error::Invalid)
    );
}

#[test]
fn approved_activation_stops_old_universe_preview_names_before_new_roster_uses_them() {
    use relative_publisher::preview::PreviewCutoff;
    let (anchor, _, _) = fixture();
    let cutoff = PreviewCutoff {
        schema: "relative.inclusion-preview-cutoff/v1".into(),
        price_digest: anchor.universe_digest,
        cutoff_timestamp: 10,
    };
    assert_eq!(cutoff.limit(&anchor, 20).unwrap(), 10);
    assert_eq!(cutoff.limit(&anchor, 9).unwrap(), 9);
    let mut next = anchor.clone();
    next.universe_digest = [8; 32];
    assert_eq!(cutoff.limit(&next, 20).unwrap(), 20);
    let mut invalid = cutoff.clone();
    invalid.schema = "other".into();
    assert_eq!(invalid.limit(&anchor, 20), Err(Error::Invalid));
}

#[test]
fn fresh_crypto_zero_preview_projects_underlying_classes_one_through_thirty_one() {
    let (mut anchor, mut observation, mut ledger) = fixture();
    anchor.assets = (0..31)
        .map(|index| Asset {
            id: format!("A{index}"),
            feed_id: index + 1,
            origin_price_e8: 100,
        })
        .collect();
    observation.benchmark = 100 * SCALE;
    observation.prices_e8 = vec![100; 31];
    ledger.prices_e8 = vec![100; 31];
    ledger.classes = (0..32)
        .map(|_| LedgerClass {
            backing: 1_000_000,
            units: 1_000_000 * SCALE as u128,
        })
        .collect();
    ledger.universe = Some(Universe {
        crypto_class: 0,
        price_digest: anchor.universe_digest,
        origins: anchor
            .assets
            .iter()
            .enumerate()
            .map(|(index, asset)| AssetOrigin {
                asset_id: asset.id.clone(),
                class_id: (index + 1) as u16,
                price_e8: 100,
                benchmark: 100 * SCALE,
            })
            .collect(),
    });
    let record = Record::derive(&anchor, &observation, &ledger).unwrap();
    assert_eq!(record.crypto_class, 0);
    assert_eq!(record.assets[0].class_id, 1);
    assert_eq!(record.assets[30].class_id, 31);
    assert!(record
        .assets
        .iter()
        .all(|asset| asset.reference == (100 * SCALE).to_string()));
    assert!(record
        .basic_projection
        .unwrap()
        .classes
        .iter()
        .all(|class| class.backing == "1000000"));
    ledger.universe.as_mut().unwrap().origins[0].class_id = 0;
    assert_eq!(
        Record::derive(&anchor, &observation, &ledger),
        Err(Error::Invalid)
    );
}
