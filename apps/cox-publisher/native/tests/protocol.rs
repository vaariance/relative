use relative_publisher::{
    benchmark::{Anchor, Asset, Batch, Benchmark, Error, FeedPrice, History, Observation},
    scheduler::{decide, Checkpoint, Decision, PendingTransaction, Pool, Work},
};
struct Memory {
    fail: bool,
}
impl History for Memory {
    fn append(&mut self, _: &Observation) -> Result<(), Error> {
        if self.fail {
            Err(Error::Persistence)
        } else {
            Ok(())
        }
    }
}
fn anchor() -> Anchor {
    Anchor {
        universe_digest: [7; 32],
        timestamp_us: 0,
        benchmark: 100_000_000_000_000,
        assets: (1..=2)
            .map(|id| Asset {
                id: id.to_string(),
                feed_id: id,
                origin_price_e8: 100,
            })
            .collect(),
    }
}
fn batch(at: u64, price: i64) -> Batch {
    Batch {
        timestamp_us: at,
        prices: vec![
            FeedPrice {
                feed_id: 1,
                price,
                exponent: -8,
                confidence: 1,
            },
            FeedPrice {
                feed_id: 2,
                price: 100,
                exponent: -8,
                confidence: 1,
            },
        ],
        signed_payload: vec![1],
    }
}
#[test]
fn quiet_benchmark_progress_and_restart_do_not_depend_on_publication() {
    let mut calculator = Benchmark::new(anchor(), Memory { fail: false }, None).unwrap();
    let first = calculator
        .observe(&batch(1_000_000, 121), |_| Ok(()))
        .unwrap();
    assert_eq!(first.benchmark, 110_000_000_000_000);
    let mut restored = Benchmark::new(anchor(), Memory { fail: false }, Some(first)).unwrap();
    assert_eq!(
        restored
            .observe(&batch(2_000_000, 100), |_| Ok(()))
            .unwrap()
            .benchmark,
        100_000_000_000_000
    );
    assert_eq!(
        restored.observe(&batch(1_000_000, 121), |_| Ok(())),
        Err(Error::TimeRegression)
    );
}
#[test]
fn storage_or_verification_failure_cannot_publish_a_new_preview() {
    let mut calculator = Benchmark::new(anchor(), Memory { fail: true }, None).unwrap();
    assert_eq!(
        calculator.observe(&batch(1, 121), |_| Ok(())),
        Err(Error::Persistence)
    );
    assert!(calculator.preview().is_none());
    assert_eq!(
        calculator.observe(&batch(1, 121), |_| Err(Error::Verification)),
        Err(Error::Verification)
    );
}
#[test]
fn idle_work_and_uncertain_transactions_obey_adaptive_contract() {
    let checkpoint = Checkpoint::default();
    assert_eq!(
        decide(10_000, &checkpoint, &[], 2).unwrap(),
        Decision::Idle { wake_ms: None }
    );
    let work = vec![
        Work::Entry {
            id: "b1".into(),
            pool: Pool::Basic,
            eligible_after_ms: 9000,
        },
        Work::Entry {
            id: "e1".into(),
            pool: Pool::Epoch,
            eligible_after_ms: 9000,
        },
        Work::Entry {
            id: "b2".into(),
            pool: Pool::Basic,
            eligible_after_ms: 9000,
        },
    ];
    let decision = decide(10_000, &checkpoint, &work, 2).unwrap();
    match decision {
        Decision::Publish { work, .. } => assert!(matches!(
            &work[..],
            [
                Work::Entry {
                    pool: Pool::Basic,
                    ..
                },
                Work::Entry {
                    pool: Pool::Epoch,
                    ..
                }
            ]
        )),
        _ => panic!(),
    }
    let mut pending = checkpoint.clone();
    pending.pending = Some(PendingTransaction {
        signature: "sig".into(),
        signed_bytes: vec![1],
        last_valid_block_height: 10,
    });
    assert_eq!(
        decide(11_000, &pending, &[], 2).unwrap(),
        Decision::Reconcile
    );
    let mut throttled = checkpoint;
    throttled.next_attempt_ms = 11_000;
    assert_eq!(
        decide(10_000, &throttled, &work, 2).unwrap(),
        Decision::Wait { wake_ms: 11_000 }
    );
}
#[test]
fn epoch_closing_uses_exact_timestamp_without_starving_entry_work() {
    let work = vec![
        Work::Close {
            id: "closing".into(),
            timestamp_ms: 9000,
        },
        Work::Entry {
            id: "basic".into(),
            pool: Pool::Basic,
            eligible_after_ms: 9000,
        },
    ];
    let checkpoint = Checkpoint::default();
    assert!(matches!(
        decide(10_000, &checkpoint, &work, 1).unwrap(),
        Decision::Publish {
            closing_ms: Some(9000),
            ..
        }
    ));
    let mut next = checkpoint;
    next.closing_next = false;
    assert!(matches!(
        decide(11_000, &next, &work, 1).unwrap(),
        Decision::Publish {
            closing_ms: None,
            ..
        }
    ));
    assert_eq!(
        decide(10_000, &next, &[work[0].clone(), work[0].clone()], 1),
        Err(relative_publisher::scheduler::Error::DuplicateWork)
    );
}
#[test]
fn thirty_asset_integer_benchmark_matches_geometric_identity() {
    let mut value = anchor();
    value.assets = (1..=30)
        .map(|id| Asset {
            id: id.to_string(),
            feed_id: id,
            origin_price_e8: 100,
        })
        .collect();
    let mut calculator = Benchmark::new(value, Memory { fail: false }, None).unwrap();
    let data = Batch {
        timestamp_us: 1000,
        prices: (1..=30)
            .map(|feed_id| FeedPrice {
                feed_id,
                price: 110,
                exponent: -8,
                confidence: 1,
            })
            .collect(),
        signed_payload: vec![1],
    };
    assert_eq!(
        calculator.observe(&data, |_| Ok(())).unwrap().benchmark,
        110_000_000_000_000
    );
}

#[test]
fn signed_pyth_payload_is_verified_and_all_truncations_fail_closed() {
    use ed25519_dalek::{Signer, SigningKey};
    use relative_publisher::pyth::{verify_payload, TrustedSigner};
    let key = SigningKey::from_bytes(&[9; 32]);
    let mut payload = Vec::new();
    payload.extend_from_slice(&2_479_346_549_u32.to_le_bytes());
    payload.extend_from_slice(&2_000_000_u64.to_le_bytes());
    payload.extend_from_slice(&[4, 2]);
    for feed in 1..=2_u32 {
        payload.extend_from_slice(&feed.to_le_bytes());
        payload.push(4);
        payload.push(0);
        payload.extend_from_slice(&100_i64.to_le_bytes());
        payload.push(4);
        payload.extend_from_slice(&(-8_i16).to_le_bytes());
        payload.push(5);
        payload.extend_from_slice(&1_i64.to_le_bytes());
        payload.extend_from_slice(&[12, 1]);
        payload.extend_from_slice(&2_000_000_u64.to_le_bytes());
    }
    let mut envelope = Vec::new();
    envelope.extend_from_slice(&2_182_742_457_u32.to_le_bytes());
    envelope.extend_from_slice(&key.sign(&payload).to_bytes());
    envelope.extend_from_slice(&key.verifying_key().to_bytes());
    envelope.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    envelope.extend_from_slice(&payload);
    let signers = [TrustedSigner {
        public_key: key.verifying_key().to_bytes(),
        expires_at_seconds: 100,
    }];
    let verified = verify_payload(&envelope, &signers, 2, 1_000_000).unwrap();
    assert_eq!(verified.timestamp_us, 2_000_000);
    assert_eq!(verified.prices.len(), 2);
    for end in 0..envelope.len() {
        assert_eq!(
            verify_payload(&envelope[..end], &signers, 2, 1_000_000),
            Err(Error::Verification)
        );
    }
    let mut altered = envelope.clone();
    *altered.last_mut().unwrap() ^= 1;
    assert_eq!(
        verify_payload(&altered, &signers, 2, 1_000_000),
        Err(Error::Verification)
    );
    assert_eq!(
        verify_payload(&envelope, &signers, 100, 1_000_000),
        Err(Error::Verification)
    );
}

#[test]
fn exact_closing_archive_and_durable_signed_transaction_survive_restart() {
    use relative_publisher::journal::{atomic_write, read, FileHistory};
    let directory = std::env::temp_dir().join(format!(
        "relative-native-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut history = FileHistory {
        directory: directory.clone(),
    };
    let mut calculator = Benchmark::new(anchor(), history.clone(), None).unwrap();
    let first = calculator
        .observe(&batch(1_000_000, 121), |_| Ok(()))
        .unwrap();
    calculator
        .observe(&batch(2_000_000, 100), |_| Ok(()))
        .unwrap();
    assert_eq!(
        history.exact(&[7; 32], 1_000_000).unwrap(),
        Some(first.clone())
    );
    assert_eq!(history.exact(&[7; 32], 1_500_000).unwrap(), None);
    let mut conflict = first;
    conflict.benchmark += 1;
    assert_eq!(history.append(&conflict), Err(Error::Conflict));
    let state = Checkpoint {
        pending: Some(PendingTransaction {
            signature: "signature".into(),
            signed_bytes: vec![1, 2, 3],
            last_valid_block_height: 100,
        }),
        ..Checkpoint::default()
    };
    let path = directory.join("checkpoint.json");
    atomic_write(&path, &state).unwrap();
    assert_eq!(read::<Checkpoint>(&path).unwrap(), Some(state));
    std::fs::write(&path, b"corrupt").unwrap();
    assert_eq!(read::<Checkpoint>(&path), Err(Error::Persistence));
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn scheduled_preparation_uses_only_the_origin_reference_and_never_mixes_later_entries() {
    let work = vec![
        Work::Entry {
            id: "basic:bootstrap".into(),
            pool: Pool::Basic,
            eligible_after_ms: 9_999,
        },
        Work::Entry {
            id: "epoch:entry".into(),
            pool: Pool::Epoch,
            eligible_after_ms: 10_500,
        },
    ];
    let checkpoint = Checkpoint::default();
    match decide(20_000, &checkpoint, &work, 16).unwrap() {
        Decision::Publish {
            work, closing_ms, ..
        } => {
            assert_eq!(work.len(), 1);
            assert_eq!(closing_ms, Some(10_000));
        }
        _ => panic!("bootstrap must bind the historical origin"),
    }
    assert_eq!(
        decide(9_999, &checkpoint, &[work[0].clone()], 16).unwrap(),
        Decision::Idle {
            wake_ms: Some(10_000)
        }
    );
}

#[test]
fn closing_timestamp_cursor_cycles_exact_groups_without_skipping_old_work() {
    let work = vec![
        Work::Close {
            id: "old:a".into(),
            timestamp_ms: 8_000,
        },
        Work::Close {
            id: "old:b".into(),
            timestamp_ms: 8_000,
        },
        Work::Close {
            id: "middle".into(),
            timestamp_ms: 9_000,
        },
        Work::Close {
            id: "boundary".into(),
            timestamp_ms: 10_000,
        },
    ];
    let mut state = Checkpoint::default();
    for expected in [8_000, 9_000, 10_000, 8_000] {
        match decide(12_000, &state, &work, 8).unwrap() {
            Decision::Publish {
                work,
                closing_ms: Some(timestamp),
                ..
            } => {
                assert_eq!(timestamp, expected);
                assert!(work.iter().all(
                    |item| matches!(item,Work::Close{timestamp_ms,..} if *timestamp_ms == expected)
                ));
                assert_eq!(work.len(), if expected == 8_000 { 2 } else { 1 });
                state.last_closing_ms = Some(timestamp);
            }
            other => panic!("unexpected decision {other:?}"),
        }
    }
}
#[test]
fn legacy_checkpoint_defaults_to_oldest_due_closing_group() {
    let mut value = serde_json::to_value(Checkpoint::default()).unwrap();
    value.as_object_mut().unwrap().remove("last_closing_ms");
    let loaded: Checkpoint = serde_json::from_value(value).unwrap();
    assert_eq!(loaded.last_closing_ms, None);
}
