use cox_math::SCALE;
use relative_publisher::{
    backup::{self, Created, RemoteMetadata, RemoteObject, Transport},
    benchmark::{Anchor, Asset, Observation},
    preview::{upload, Error, Ledger, LedgerClass, Record},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Mutex};
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
