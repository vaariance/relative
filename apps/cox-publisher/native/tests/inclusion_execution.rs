#[path = "support/inclusion.rs"]
mod support;
use relative_publisher::{
    benchmark::{Anchor, Asset, History, Observation},
    inclusion_execution::{self, Approved, Controller},
    journal,
    scheduler::{Pool, Work},
};
use std::time::{SystemTime, UNIX_EPOCH};
static DIRECTORY_SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn approved() -> Approved {
    let request = support::request_with_count(31);
    Approved {
        schema: "relative.inclusion-approved/v1".into(),
        preparation: request.preparation,
        policy: request.policy,
        previous_canonical: request.previous_canonical,
        schedule: request.schedule,
        capture_request: request.captured.request,
    }
}
fn directory() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "inclusion-controller-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        DIRECTORY_SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}
#[test]
fn valid_old_prefix_capture_accepts_independently_sorted_admission_bindings_but_rejects_wrong_approved_identities(
) {
    let value = approved();
    value.validate().unwrap();
    assert_ne!(
        value
            .capture_request
            .fullnext_assets
            .iter()
            .map(|asset| asset.id.as_str())
            .collect::<Vec<_>>(),
        value
            .preparation
            .request
            .next_bindings
            .iter()
            .map(|binding| binding.runtime_asset_id.as_str())
            .collect::<Vec<_>>()
    );
    let mut wrong = value.clone();
    wrong.capture_request.fullnext_assets[30].feed_id += 1;
    assert!(wrong.validate().is_err());
    let mut wrong = value.clone();
    let previous = cox::UniverseVersion::from_canonical(&value.previous_canonical).unwrap();
    use anchor_lang::{AccountDeserialize, AccountSerialize};
    let mut schedule =
        cox::UniverseSchedule::try_deserialize(&mut wrong.schedule.account_data.as_slice())
            .unwrap();
    schedule.identities_digest[0] ^= 1;
    wrong.schedule.account_data.clear();
    schedule
        .try_serialize(&mut wrong.schedule.account_data)
        .unwrap();
    assert!(wrong.validate().is_err());
    assert_eq!(previous.instruments.len(), 30);
}
#[test]
fn boundary_matrix_holds_new_entries_and_later_closes_but_preserves_accepted_maintenance_and_exact_boundary_close(
) {
    let directory = directory();
    let approved = approved();
    journal::atomic_write(&directory.join("inclusion-approved.json"), &approved).unwrap();
    let shared = Controller::open(&directory).unwrap();
    assert!(shared.lock().unwrap().refresh_file().unwrap());
    let boundary = approved.capture_request.activation_timestamp_us / 1000;
    let work = vec![
        Work::Entry {
            id: "basic:1".into(),
            pool: Pool::Basic,
            eligible_after_ms: 0,
        },
        Work::Entry {
            id: "epoch:1:0".into(),
            pool: Pool::Epoch,
            eligible_after_ms: 0,
        },
        Work::Maintenance {
            id: "basic:accepted-stage".into(),
            pool: Pool::Basic,
        },
        Work::Maintenance {
            id: "epoch:1:snapshot-stage".into(),
            pool: Pool::Epoch,
        },
        Work::Close {
            id: "epoch:1:close".into(),
            timestamp_ms: boundary,
        },
        Work::Close {
            id: "epoch:2:close".into(),
            timestamp_ms: boundary + 1000,
        },
    ];
    let mut before = work.clone();
    inclusion_execution::filter_work(&shared, boundary - 1, &mut before).unwrap();
    assert_eq!(before, work);
    let mut after = work.clone();
    inclusion_execution::filter_work(&shared, boundary, &mut after).unwrap();
    assert_eq!(
        after,
        vec![work[2].clone(), work[3].clone(), work[4].clone()]
    );
    assert_eq!(shared.lock().unwrap().wake_ms(boundary - 1), Some(boundary));
    let prior = cox::UniverseVersion::from_canonical(&approved.previous_canonical).unwrap();
    let expires = approved.schedule.decode(&prior).unwrap().expires_at;
    assert_eq!(
        shared.lock().unwrap().wake_ms(boundary),
        Some((boundary + 5_001).min((expires + 1) * 1000))
    );
    assert!(shared
        .lock()
        .unwrap()
        .expire_if_due((expires + 1) * 1000)
        .unwrap());
    let mut resumed = work.clone();
    inclusion_execution::filter_work(&shared, (expires + 1) * 1000, &mut resumed).unwrap();
    assert_eq!(resumed, work);
    std::fs::remove_dir_all(directory).unwrap();
}
#[test]
fn candidate_history_never_changes_active_anchor_or_latest_pointer() {
    let directory = directory();
    let mut history = journal::FileHistory {
        directory: directory.join("prices"),
    };
    let old = Anchor {
        universe_digest: [1; 32],
        timestamp_us: 1_000_000,
        benchmark: 100 * cox_math::SCALE,
        assets: vec![
            Asset {
                id: "A".into(),
                feed_id: 1,
                origin_price_e8: 100,
            },
            Asset {
                id: "B".into(),
                feed_id: 2,
                origin_price_e8: 100,
            },
        ],
    };
    history.activate(&old).unwrap();
    let old_value = Observation {
        universe_digest: old.universe_digest,
        timestamp_us: 1_000_000,
        benchmark: old.benchmark,
        prices_e8: vec![100, 100],
        signed_payload: vec![1],
    };
    history.append(&old_value).unwrap();
    let mut next = old.clone();
    next.universe_digest = [2; 32];
    next.timestamp_us = 2_000_000;
    let staged = Observation {
        universe_digest: next.universe_digest,
        timestamp_us: 3_000_000,
        benchmark: next.benchmark,
        prices_e8: vec![100, 100],
        signed_payload: vec![2],
    };
    history.stage_observation(&next, &staged).unwrap();
    assert_eq!(history.active_anchor().unwrap(), Some(old));
    assert_eq!(history.latest().unwrap(), Some(old_value));
    assert_eq!(history.latest_staged(&next).unwrap(), Some(staged));
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn invalid_admission_never_creates_hold_or_cutoff_and_no_approval_means_no_local_wakeup() {
    let directory = directory();
    let mut value = approved();
    value.policy.max_assets = 30;
    journal::atomic_write(&directory.join("inclusion-approved.json"), &value).unwrap();
    let shared = Controller::open(&directory).unwrap();
    assert!(!shared.lock().unwrap().take_dirty());
    assert!(shared.lock().unwrap().refresh_file().is_err());
    assert!(!directory.join("inclusion-preview-cutoff.json").exists());
    let mut work = vec![Work::Entry {
        id: "basic:1".into(),
        pool: Pool::Basic,
        eligible_after_ms: 0,
    }];
    let expected = work.clone();
    inclusion_execution::filter_work(&shared, u64::MAX, &mut work).unwrap();
    assert_eq!(work, expected);
    std::fs::remove_dir_all(directory).unwrap();
}
#[tokio::test]
async fn deterministic_successor_failure_records_reschedule_and_unblocks_current_market_without_rpc(
) {
    use anchor_lang::{AccountDeserialize, Discriminator};
    use relative_publisher::{
        chain::{BasicState, ChainState},
        rpc::Rpc,
        transactions::BasicAccounts,
    };
    use solana_address::Address;
    fn zero<T: AccountDeserialize + Discriminator>() -> T {
        let mut data = T::DISCRIMINATOR.to_vec();
        data.resize(20_000, 0);
        T::try_deserialize(&mut data.as_slice()).unwrap()
    }
    let request = support::request_with_count(31);
    let value = Approved {
        schema: "relative.inclusion-approved/v1".into(),
        preparation: request.preparation,
        policy: request.policy,
        previous_canonical: request.previous_canonical,
        schedule: request.schedule,
        capture_request: request.captured.request.clone(),
    };
    let directory = directory();
    journal::atomic_write(&directory.join("inclusion-approved.json"), &value).unwrap();
    let shared = Controller::open(&directory).unwrap();
    shared.lock().unwrap().refresh_file().unwrap();
    shared
        .lock()
        .unwrap()
        .accept_capture(request.captured)
        .unwrap();
    let state = ChainState {
        slot: 1,
        confirmed_timestamp_ms: 14_410_000,
        digest: [0; 32],
        discovery_incomplete: false,
        basic: BasicState {
            accounts: BasicAccounts::derive(Address::new_from_array([1; 32]), 2, [1; 32]),
            pool: zero(),
            registry: zero(),
            methodology: zero(),
            batch: None,
            requests: vec![],
        },
        epoch_config: zero(),
        epochs: vec![],
    };
    assert!(matches!(
        inclusion_execution::plan(
            &shared,
            &Rpc::direct_devnet("unused").unwrap(),
            &state,
            Address::default(),
            3_000,
            false
        )
        .await
        .unwrap(),
        inclusion_execution::Action::Waiting
    ));
    let mut work = vec![Work::Entry {
        id: "basic:1".into(),
        pool: Pool::Basic,
        eligible_after_ms: 0,
    }];
    let expected = work.clone();
    inclusion_execution::filter_work(&shared, 3_000, &mut work).unwrap();
    assert_eq!(work, expected);
    let cutoff: Option<Option<relative_publisher::preview::PreviewCutoff>> =
        journal::read(&directory.join("inclusion-preview-cutoff.json")).unwrap();
    assert!(matches!(cutoff, Some(None)));
    let state: serde_json::Value = journal::read(&directory.join("inclusion-execution.json"))
        .unwrap()
        .unwrap();
    assert_eq!(state["phase"], "RescheduleRequired");
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn missing_capture_has_exact_bounded_deadline_and_resumes_old_market_without_rpc() {
    let directory = directory();
    let value = approved();
    let boundary = value.capture_request.activation_timestamp_us / 1000;
    journal::atomic_write(&directory.join("inclusion-approved.json"), &value).unwrap();
    let shared = Controller::open(&directory).unwrap();
    shared.lock().unwrap().refresh_file().unwrap();
    assert_eq!(
        shared.lock().unwrap().wake_ms(boundary),
        Some(boundary + 5_001)
    );
    assert!(!shared
        .lock()
        .unwrap()
        .expire_if_due(boundary + 5_000)
        .unwrap());
    assert!(shared
        .lock()
        .unwrap()
        .expire_if_due(boundary + 5_001)
        .unwrap());
    let mut work = vec![Work::Entry {
        id: "basic:1".into(),
        pool: Pool::Basic,
        eligible_after_ms: 0,
    }];
    let expected = work.clone();
    inclusion_execution::filter_work(&shared, boundary + 5_001, &mut work).unwrap();
    assert_eq!(work, expected);
    let captured = support::request_with_count(31).captured;
    assert!(shared.lock().unwrap().accept_capture(captured).is_err());
    let state: serde_json::Value = journal::read(&directory.join("inclusion-execution.json"))
        .unwrap()
        .unwrap();
    assert_eq!(state["phase"], "RescheduleRequired");
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn bounded_journal_rejects_nonregular_symlinks_and_oversized_inputs() {
    let directory = directory();
    std::fs::create_dir_all(&directory).unwrap();
    assert!(journal::read::<serde_json::Value>(&directory).is_err());
    let file = directory.join("large.json");
    let output = std::fs::File::create(&file).unwrap();
    output.set_len(journal::MAX_JOURNAL_BYTES + 1).unwrap();
    assert!(journal::read::<serde_json::Value>(&file).is_err());
    #[cfg(unix)]
    {
        let target = directory.join("target.json");
        std::fs::write(&target, b"null").unwrap();
        let link = directory.join("link.json");
        std::os::unix::fs::symlink(target, &link).unwrap();
        assert!(journal::read::<Option<serde_json::Value>>(&link).is_err());
    }
    std::fs::remove_dir_all(directory).unwrap();
}
