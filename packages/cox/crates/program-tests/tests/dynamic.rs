mod support;
use anchor_lang::AnchorSerialize;
use cox::{
    accounts as a, instruction as i, Instrument, Methodology, PriceWire, Request, UniverseCapture,
    UniverseVersion,
};
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::{Instruction, InstructionError},
    message::Message,
    pubkey::Pubkey,
    signature::Keypair,
    signature::Signer,
    system_program,
    transaction::{Transaction, TransactionError},
};
use support::{pda, protocol::PoolHarness, Harness, ORIGIN};

fn reject(
    instructions: Vec<Instruction>,
    signer: &Keypair,
    expected: cox::CoxError,
    p: &mut PoolHarness,
) {
    p.h.svm.expire_blockhash();
    let mut all = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
        ComputeBudgetInstruction::request_heap_frame(262_144),
    ];
    all.extend(instructions);
    let tx = Transaction::new(
        &[signer],
        Message::new(&all, Some(&signer.pubkey())),
        p.h.svm.latest_blockhash(),
    );
    assert!(bincode::serialize(&tx).unwrap().len() <= 1232);
    let failure = p.h.svm.send_transaction(tx).unwrap_err();
    match failure.err {
        TransactionError::InstructionError(_, InstructionError::Custom(code)) => {
            assert_eq!(code, u32::from(expected), "{:?}", failure.meta.logs)
        }
        other => panic!("unexpected rejection: {other:?}; {:?}", failure.meta.logs),
    }
}

fn genesis(p: &PoolHarness) -> UniverseVersion {
    let state = p.pool_state();
    let source: Methodology = p.h.read(p.methodology);
    let capture = UniverseCapture {
        price_universe_digest: [43; 32],
        timestamp: ORIGIN,
        benchmark: 100 * cox_math::SCALE,
        prices_e8: vec![100_000_000; 30],
        signed_payload_digest: [44; 32],
        trusted_storage_digest: [45; 32],
        predecessor_sequence: state.sequence,
        predecessor_state_digest: state.state_digest,
    };
    let mut value = UniverseVersion::draft(
        0,
        p.pool,
        p.h.runtime.pubkey(),
        source.digest,
        1,
        [0; 32],
        30,
        capture,
    )
    .unwrap();
    value.instruments = (0..30)
        .map(|index| Instrument {
            stable_id: format!("asset-{index}"),
            symbol: cox::IDS[index].into(),
            class_id: index as u16,
            epoch_id: index as u16,
            pyth_pro_feed_id: index as u32 + 1,
            pyth_core_feed_id: [index as u8 + 1; 32],
            token_mint: None,
            original_price_e8: 100_000_000,
            original_benchmark: 100 * cox_math::SCALE,
            original_timestamp: ORIGIN,
        })
        .collect();
    value.digest = value.canonical_digest().unwrap();
    value.sealed = true;
    value
}

fn upload(p: &mut PoolHarness, value: &UniverseVersion) -> Pubkey {
    let bytes = value.canonical_bytes().unwrap();
    let digest = cox_math::artifact_digest(&bytes);
    let key = pda(&[b"methodology", &digest]);
    let admin = p.h.admin.insecure_clone();
    let runtime = p.h.runtime.insecure_clone();
    let schedule = pda(&[b"universe-schedule", p.pool.as_ref(), &value.version.to_le_bytes()]);
    let register = if value.version == 1 {
        Harness::instruction(a::RegisterDynamicMethodology { admin: admin.pubkey(), registry: p.registry, methodology: key, system_program: system_program::ID },
            i::RegisterDynamicMethodology { digest, length: bytes.len() as u32, activation_batch: p.pool_state().last_batch })
    } else {
        Harness::instruction(a::RegisterScheduledMethodology { runtime: runtime.pubkey(), registry: p.registry, pool: p.pool, methodology: p.methodology, schedule, next_methodology: key, system_program: system_program::ID },
            i::RegisterScheduledMethodology { digest, length: bytes.len() as u32 })
    };
    let signer = if value.version == 1 { &admin } else { &runtime };
    p.h.send("register_dynamic_methodology", &[ComputeBudgetInstruction::request_heap_frame(262_144), register], &[signer], true);
    if bytes.len() + 512 > 8192 { grow(p, key, bytes.len() + 512); }
    for (index, chunk) in bytes.chunks(600).enumerate() {
        let upload = if value.version == 1 {
            Harness::instruction(a::ManageMethodology { admin: admin.pubkey(), registry: p.registry, methodology: key },
                i::UploadMethodology { offset: (index * 600) as u32, bytes: chunk.to_vec() })
        } else {
            Harness::instruction(a::ManageScheduledMethodology { runtime: runtime.pubkey(), registry: p.registry, pool: p.pool, methodology: p.methodology, schedule, next_methodology: key },
                i::UploadScheduledMethodology { offset: (index * 600) as u32, bytes: chunk.to_vec() })
        };
        p.h.send("upload_dynamic_methodology", &[ComputeBudgetInstruction::request_heap_frame(262_144), upload], &[signer], true);
    }
    let seal = if value.version == 1 {
        Harness::instruction(a::SealDynamicMethodology { runtime: runtime.pubkey(), registry: p.registry, pool: p.pool, methodology: p.methodology, next_methodology: key }, i::SealDynamicMethodology {})
    } else {
        Harness::instruction(a::ManageScheduledMethodology { runtime: runtime.pubkey(), registry: p.registry, pool: p.pool, methodology: p.methodology, schedule, next_methodology: key }, i::SealScheduledMethodology {})
    };
    p.h.send("seal_dynamic_methodology", &[ComputeBudgetInstruction::request_heap_frame(262_144), seal], &[&runtime], true);
    assert!(p.h.read::<Methodology>(key).sealed);
    key
}

fn migrate(p: &mut PoolHarness, next: Pubkey, success: bool) {
    let admin = p.h.admin.insecure_clone();
    p.h.send(
        "migrate_dynamic_pool",
        &[
            ComputeBudgetInstruction::request_heap_frame(262_144),
            Harness::instruction(
                a::MigrateDynamicPool {
                    admin: admin.pubkey(),
                    registry: p.registry,
                    pool: p.pool,
                    methodology: p.methodology,
                    next_methodology: next,
                    vault: p.vault,
                    test_vault: p.test_vault(),
                },
                i::MigrateDynamicPool {},
            ),
        ],
        &[&admin],
        success,
    );
    if success {
        p.methodology = next;
    }
}

fn publish(p: &mut PoolHarness, value: &UniverseVersion, batch_id: u64) {
    let state = p.pool_state();
    let timestamp = ORIGIN + batch_id;
    let mut prices = vec![
        PriceWire {
            price_e8: 100_000_000,
            venue: 3,
            step: 0,
            candle_start: timestamp,
            trade_age_minutes: 0
        };
        value.instruments.len()
    ];
    let benchmark = if batch_id == 3 || batch_id == 63 { 103 } else { 100 } * cox_math::SCALE;
    if batch_id == 3 || batch_id == 63 {
        prices[0].price_e8 = 120_000_000; prices[1].price_e8 = 80_000_000;
        prices.last_mut().unwrap().price_e8 = 110_000_000;
    }
    let benchmark_gross = cox_math::rounded_div(benchmark * cox_math::SCALE, state.benchmark).unwrap();
    let mut h = vec![cox_math::SCALE; state.classes.len()];
    for (index, instrument) in value.instruments.iter().enumerate() {
        let gross = cox_math::rounded_div(prices[index].price_e8 as i128 * cox_math::SCALE, state.last_prices[index] as i128).unwrap();
        h[instrument.class_id as usize] = cox_math::rounded_div(gross * cox_math::SCALE, benchmark_gross).unwrap();
    }
    let expected = cox_math::revalue_dynamic(&state.classes.iter().map(|value| cox_math::Class { backing: value.backing, units: value.units }).collect::<Vec<_>>(), &h).unwrap();
    let snapshot = cox::dynamic_snapshot_digest(timestamp, benchmark, value, &prices).unwrap();
    let runtime = p.h.runtime.insecure_clone();
    let batch = pda(&[b"batch", p.pool.as_ref()]);
    p.h.send(
        "begin_dynamic_publication",
        &[
            ComputeBudgetInstruction::request_heap_frame(262_144),
            Harness::instruction(
                a::BeginDynamicPublication {
                    payer: runtime.pubkey(),
                    runtime: runtime.pubkey(),
                    registry: p.registry,
                    pool: p.pool,
                    methodology: p.methodology,
                    batch,
                    vault: p.vault,
                    system_program: system_program::ID,
                    test_vault: p.test_vault(),
                },
                i::BeginDynamicPublication {
                    batch_id,
                    sequence: state.sequence + 1,
                    predecessor: state.state_digest,
                    snapshot,
                    benchmark,
                },
            ),
        ],
        &[&runtime],
        true,
    );
    for (index, chunk) in prices.chunks(16).enumerate() {
        if batch_id == 3 && index + 1 == prices.len().div_ceil(16) {
            let before = p.h.svm.get_account(&batch).unwrap().data;
            let mut wrong = chunk.to_vec();
            wrong[0].price_e8 += 1;
            reject(
                vec![
                    Harness::instruction(
                        a::StageDynamicPublication {
                            runtime: runtime.pubkey(),
                            registry: p.registry,
                            pool: p.pool,
                            methodology: p.methodology,
                            batch,
                        },
                        i::AppendDynamicPrices {
                            offset: (index * 16) as u16,
                            prices: wrong,
                        },
                    ),
                    Harness::instruction(
                        a::StageDynamicPublication {
                            runtime: runtime.pubkey(),
                            registry: p.registry,
                            pool: p.pool,
                            methodology: p.methodology,
                            batch,
                        },
                        i::SealDynamicPublication {},
                    ),
                ],
                &runtime,
                cox::CoxError::InvalidSnapshotDigest,
                p,
            );
            assert_eq!(p.h.svm.get_account(&batch).unwrap().data, before);
        }
        p.h.send(
            "append_dynamic_prices",
            &[
                ComputeBudgetInstruction::request_heap_frame(262_144),
                Harness::instruction(
                    a::StageDynamicPublication {
                        runtime: runtime.pubkey(),
                        registry: p.registry,
                        pool: p.pool,
                        methodology: p.methodology,
                        batch,
                    },
                    i::AppendDynamicPrices {
                        offset: (index * 16) as u16,
                        prices: chunk.to_vec(),
                    },
                ),
            ],
            &[&runtime],
            true,
        );
    }
    p.h.send(
        "seal_dynamic_publication",
        &[
            ComputeBudgetInstruction::request_heap_frame(262_144),
            Harness::instruction(
                a::StageDynamicPublication {
                    runtime: runtime.pubkey(),
                    registry: p.registry,
                    pool: p.pool,
                    methodology: p.methodology,
                    batch,
                },
                i::SealDynamicPublication {},
            ),
        ],
        &[&runtime],
        true,
    );
    for (phase, count) in [(5, value.instruments.len()), (6, value.instruments.len() + 1)] {
        if p.batch_state().phase != phase { continue; }
        for offset in (0..count).step_by(16) {
            let accounts = a::StageDynamicPublication { runtime: runtime.pubkey(), registry: p.registry, pool: p.pool, methodology: p.methodology, batch };
            let instruction = if phase == 5 { Harness::instruction(accounts, i::PrepareDynamicRevaluation { offset: offset as u16, limit: 16 }) }
                else { Harness::instruction(accounts, i::FinishDynamicRevaluation { offset: offset as u16, limit: 16 }) };
            p.h.send("dynamic_revaluation_page", &[ComputeBudgetInstruction::request_heap_frame(262_144), instruction.clone()], &[&runtime], true);
            if offset == 0 {
                let before = p.h.svm.get_account(&batch).unwrap().data;
                reject(vec![instruction], &runtime, cox::CoxError::InvalidPrice, p);
                assert_eq!(p.h.svm.get_account(&batch).unwrap().data, before);
            }
        }
    }
    let prepared = p.batch_state();
    assert_eq!(prepared.fixed.iter().map(|value| (value.backing, value.units)).collect::<Vec<_>>(), expected.classes.iter().map(|value| (value.backing, value.units)).collect::<Vec<_>>());
    assert_eq!(prepared.transfer_residual, expected.residual);
    assert_eq!(p.pool_state().classes.iter().map(|value| (value.backing, value.units)).collect::<Vec<_>>(), state.classes.iter().map(|value| (value.backing, value.units)).collect::<Vec<_>>());
    p.finish();
}

#[test]
fn dynamic_inclusion_preserves_funded_classes_queued_requests_and_new_class_entry() {
    verify_inclusion(31);
}

#[test]
fn maximum_universe_255_assets_preserves_custody_and_last_class_lifecycle() {
    verify_inclusion(255);
}

fn grow(p: &mut PoolHarness, target: Pubkey, required: usize) {
    let runtime = p.h.runtime.insecure_clone();
    let mut size = p.h.svm.get_account(&target).unwrap().data.len();
    while size < required {
        let additional = (required - size).min(8192);
        p.h.send("grow_dynamic_account", &[ComputeBudgetInstruction::request_heap_frame(262_144), Harness::instruction(
            a::GrowDynamicAccount { payer: runtime.pubkey(), registry: p.registry, pool: p.pool, target, system_program: system_program::ID },
            i::GrowDynamicAccount { additional_bytes: additional as u32 },
        )], &[&runtime], true);
        size += additional;
    }
}

fn verify_inclusion(count: usize) -> PoolHarness {
    let mut p = PoolHarness::new_adaptive(30);
    p.deposit(false, 0, 1_000_000, 1, 100, true);
    p.h.time(ORIGIN + 1);
    p.publish_adaptive(1, vec![100_000_000; 30], 100 * cox_math::SCALE, true);
    p.finish();
    let owner = p.h.alice.pubkey();
    let position_before = p.materialize(owner);
    let legacy_request = p.deposit(false, 1, 2_000_000, 1, 100, true);
    let old_request: Request = p.h.read(legacy_request);
    let end = 8 + old_request.try_to_vec().unwrap().len();
    let mut request_account = p.h.svm.get_account(&legacy_request).unwrap();
    request_account.data[end - 4..end].fill(255);
    p.h.svm
        .set_account(legacy_request, request_account)
        .unwrap();
    let before = p.pool_state();
    let initial = genesis(&p);
    let initial_key = upload(&mut p, &initial);
    migrate(&mut p, initial_key, false);
    p.pause(true);
    migrate(&mut p, initial_key, true);
    let migrated = p.pool_state();
    assert_eq!(migrated.schema_version, 5);
    assert_eq!(
        migrated
            .classes
            .iter()
            .map(|c| (c.backing, c.units))
            .collect::<Vec<_>>(),
        before
            .classes
            .iter()
            .map(|c| (c.backing, c.units))
            .collect::<Vec<_>>()
    );
    assert_eq!(migrated.state_digest, before.state_digest);
    assert_eq!(migrated.sequence, before.sequence);
    assert_eq!(migrated.pending, 2_000_000);

    let mut next = initial.clone();
    next.version = 2;
    next.predecessor_digest = initial.digest;
    next.expected_instruments = count as u16;
    next.capture.timestamp = ORIGIN + 2;
    next.capture.price_universe_digest = [46; 32];
    next.capture.signed_payload_digest = [47; 32];
    next.capture.trusted_storage_digest = [48; 32];
    next.capture.predecessor_sequence = migrated.sequence;
    next.capture.predecessor_state_digest = migrated.state_digest;
    next.capture.prices_e8.resize(count, 100_000_000);
    for index in 30..count {
        next.instruments.push(Instrument {
            stable_id: format!("asset-new-{index}"), symbol: format!("NEW{index}"), class_id: (index+1) as u16, epoch_id: index as u16,
            pyth_pro_feed_id: index as u32 + 1, pyth_core_feed_id: [index as u8 + 1; 32], token_mint: None,
            original_price_e8: 100_000_000, original_benchmark: 100 * cox_math::SCALE, original_timestamp: ORIGIN + 2,
        });
    }
    let admin = p.h.admin.insecure_clone();
    let schedule = pda(&[b"universe-schedule", p.pool.as_ref(), &next.version.to_le_bytes()]);
    p.h.send("schedule_universe", &[ComputeBudgetInstruction::request_heap_frame(262_144), Harness::instruction(
        a::ScheduleUniverse {asset_registry: None, admin: admin.pubkey(), registry: p.registry, pool: p.pool, methodology: p.methodology, schedule, system_program: system_program::ID },
        i::ScheduleUniverse { version: next.version, identities_digest: cox::instrument_identities_digest(&next.instruments).unwrap(), expected_instruments: count as u16, activation_timestamp: ORIGIN + 2, expires_at: ORIGIN + 100 },
    )], &[&admin], true);
    p.pause(false);
    p.h.time(ORIGIN + 2);
    publish(&mut p, &initial, 2);
    let boundary = p.pool_state();
    next.capture.predecessor_sequence = boundary.sequence;
    next.capture.predecessor_state_digest = boundary.state_digest;
    next.digest = next.canonical_digest().unwrap();
    let pool_key = p.pool;
    grow(&mut p, pool_key, 32768);
    let next_key = upload(&mut p, &next);
    let runtime = p.h.runtime.insecure_clone();
    p.h.send(
        "activate_universe",
        &[
            ComputeBudgetInstruction::request_heap_frame(262_144),
            Harness::instruction(
                a::ActivateUniverse {asset_registry: None, next_registry_version: None, previous_registry_version: None,
                    runtime: runtime.pubkey(),
                    registry: p.registry,
                    pool: p.pool,
                    methodology: p.methodology,
                    next_methodology: next_key,
                    schedule,
                    vault: p.vault,
                    test_vault: p.test_vault(),
                },
                i::ActivateUniverse {},
            ),
        ],
        &[&runtime],
        true,
    );
    p.methodology = next_key;
    let activated = p.pool_state();
    assert_eq!(
        activated.classes[..31]
            .iter()
            .map(|c| (c.backing, c.units))
            .collect::<Vec<_>>(),
        boundary
            .classes
            .iter()
            .map(|c| (c.backing, c.units))
            .collect::<Vec<_>>()
    );
    assert_eq!(activated.classes.len(), count + 1);
    assert_eq!(activated.classes[count].backing, 0);
    assert_eq!(activated.classes[count].units, 0);
    assert_eq!(activated.benchmark, before.benchmark);
    assert_eq!(activated.references[30], 100 * cox_math::SCALE);
    assert_eq!(activated.state_digest, boundary.state_digest);
    p.pause(false);
    for target in [pda(&[b"batch", p.pool.as_ref()]), pda(&[b"publication", p.pool.as_ref()])] {
        grow(&mut p, target, cox::dynamic_batch_space(count + 1));
    }
    grow(&mut p, pda(&[b"position", pool_key.as_ref(), owner.as_ref()]), cox::dynamic_position_space(count + 1));
    let signer = p.h.alice.insecure_clone();
    let accounts = p.submit_accounts(signer.pubkey(), p.h.alice_token);
    let new_request = accounts.request;
    p.h.send(
        "deposit_v2",
        &[
            ComputeBudgetInstruction::request_heap_frame(262_144),
            Harness::instruction(
                accounts,
                i::DepositV2 {
                    to: count as u16,
                    amount: 3_000_000,
                    minimum_units: 1,
                    expiry: 100,
                    expected_fee_version: activated.fee_version,
                },
            ),
        ],
        &[&signer],
        true,
    );
    p.h.time(ORIGIN + 3);
    publish(&mut p, &next, 3);
    for key in [legacy_request, new_request] {
        let receipt: Request = p.h.read(key);
        assert!(receipt.applied);
        assert_eq!(receipt.receipt_status, 0);
    }
    let position = p.materialize(owner);
    assert_eq!(position.classes[0].units, position_before.classes[0].units);
    assert_eq!(
        position.classes[1].units,
        2_000_000 * cox_math::SCALE as u128
    );
    assert_eq!(
        position.classes[count].units,
        3_000_000 * cox_math::SCALE as u128
    );
    assert_eq!(p.pool_state().classes[30].backing, 0);
    p.assert_owners(&[owner]);
    for class_id in [0u16, 1, count as u16] {
        let current = p.materialize(owner);
        let accounts = p.submit_accounts(signer.pubkey(), p.h.alice_token);
        p.h.send(
            "redeem_v2",
            &[
                ComputeBudgetInstruction::request_heap_frame(262_144),
                Harness::instruction(
                    accounts,
                    i::RedeemV2 {
                        from: class_id,
                        units: current.classes[class_id as usize].units,
                        minimum_proceeds: 1,
                        expiry: 100,
                        expected_fee_version: p.pool_state().fee_version,
                    },
                ),
            ],
            &[&signer],
            true,
        );
    }
    p.h.time(ORIGIN + 4);
    publish(&mut p, &next, 4);
    let position = p.materialize(owner);
    assert_eq!(position.payable, 5_999_997);
    assert_eq!(p.pool_state().residual, 3);
    assert!(position
        .classes
        .iter()
        .all(|class| class.units == 0 && class.locked == 0));
    p.withdraw(false, position.payable, true);
    assert_eq!(p.pool_state().active, 0);
    assert_eq!(p.pool_state().pending, 0);
    assert_eq!(p.pool_state().payable, 0);
    p.assert_owners(&[owner]);
    let state = p.pool_state();
    let pool_before = p.h.svm.get_account(&p.pool).unwrap().data;
    let registry_before = p.h.svm.get_account(&p.registry).unwrap().data;
    p.h.time(ORIGIN + 11);
    reject(
        vec![Harness::instruction(
            a::BeginDynamicPublication {
                payer: runtime.pubkey(),
                runtime: runtime.pubkey(),
                registry: p.registry,
                pool: p.pool,
                methodology: p.methodology,
                batch: pda(&[b"batch", p.pool.as_ref()]),
                vault: p.vault,
                system_program: system_program::ID,
                test_vault: p.test_vault(),
            },
            i::BeginDynamicPublication {
                batch_id: 5,
                sequence: state.sequence + 1,
                predecessor: state.state_digest,
                snapshot: [77; 32],
                benchmark: state.benchmark,
            },
        )],
        &runtime,
        cox::CoxError::CommitDeadlinePassed,
        &mut p,
    );
    assert_eq!(p.h.svm.get_account(&p.pool).unwrap().data, pool_before);
    assert_eq!(
        p.h.svm.get_account(&p.registry).unwrap().data,
        registry_before
    );
    if let Ok(directory) = std::env::var("COX_DYNAMIC_MEASUREMENTS_DIRECTORY") {
        std::fs::create_dir_all(&directory).unwrap();
        let artifact = std::fs::read(std::env::var("COX_PROGRAM_SO").unwrap()).unwrap();
        let records = p.h.measurements.iter().map(|measurement| serde_json::json!({ "instruction": measurement.instruction, "transactionBytes": measurement.transaction_bytes, "computeUnits": measurement.compute_units })).collect::<Vec<_>>();
        std::fs::write(format!("{directory}/{count}.json"), serde_json::to_vec_pretty(&serde_json::json!({ "underlyingAssets": count, "programSha256": cox_math::artifact_digest(&artifact).iter().map(|value| format!("{value:02x}")).collect::<String>(), "transactions": records })).unwrap()).unwrap();
    }
    p
}

#[test]
fn dynamic_runtime_rotation_keeps_historical_attestors_and_requires_authorized_successor_operator() {
    let mut p = verify_inclusion(31);
    let method: Methodology = p.h.read(p.methodology);
    let previous = cox::read_dynamic_manifest(&method).unwrap();
    let old_operator = p.h.runtime.insecure_clone();
    let next_operator = Keypair::new();
    p.h.svm.airdrop(&next_operator.pubkey(), 100_000_000_000).unwrap();
    let admin = p.h.admin.insecure_clone();
    p.h.send("rotate_runtime", &[Harness::instruction(a::Admin { admin: admin.pubkey(), registry: p.registry },
        i::RotateRuntime { new_runtime: next_operator.pubkey(), effective_batch: 13 })], &[&admin], true);
    p.h.time(ORIGIN + 12);
    publish(&mut p, &previous, 12);
    p.h.time(ORIGIN + 13);
    let state = p.pool_state();
    let begin = |p: &PoolHarness, runtime: Pubkey, batch_id: u64| Harness::instruction(a::BeginDynamicPublication {
        payer: runtime, runtime, registry: p.registry, pool: p.pool, methodology: p.methodology,
        batch: pda(&[b"batch", p.pool.as_ref()]), vault: p.vault, system_program: system_program::ID, test_vault: p.test_vault(),
    }, i::BeginDynamicPublication { batch_id, sequence: p.pool_state().sequence + 1, predecessor: p.pool_state().state_digest, snapshot: [9; 32], benchmark: p.pool_state().benchmark });
    reject(vec![begin(&p, old_operator.pubkey(), 13)], &old_operator, cox::CoxError::Unauthorized, &mut p);
    assert_eq!(p.pool_state().sequence, state.sequence);
    p.h.runtime = next_operator;
    publish(&mut p, &previous, 13);
    let registry: cox::Registry = p.h.read(p.registry);
    assert_eq!(registry.runtime, p.h.runtime.pubkey()); assert!(registry.pending_runtime.is_none());
    assert_eq!(cox::read_dynamic_manifest(&p.h.read::<Methodology>(p.methodology)).unwrap().operator, old_operator.pubkey());
    let mut next = previous.clone(); next.version += 1; next.predecessor_digest = previous.digest;
    next.operator = p.h.runtime.pubkey(); next.expected_instruments = 32;
    next.capture.timestamp = ORIGIN + 14; next.capture.prices_e8.push(100_000_000);
    next.instruments.push(Instrument { stable_id: "rotation-asset".into(), symbol: "ROTATE".into(), class_id: 32, epoch_id: 31, pyth_pro_feed_id: 32,
        pyth_core_feed_id: [32; 32], token_mint: None, original_price_e8: 100_000_000, original_benchmark: p.pool_state().benchmark, original_timestamp: ORIGIN + 14 });
    let schedule = pda(&[b"universe-schedule", p.pool.as_ref(), &next.version.to_le_bytes()]);
    p.h.send("schedule_universe", &[ComputeBudgetInstruction::request_heap_frame(262144), Harness::instruction(a::ScheduleUniverse {asset_registry: None,
        admin: admin.pubkey(), registry: p.registry, pool: p.pool, methodology: p.methodology, schedule, system_program: system_program::ID,
    }, i::ScheduleUniverse { version: next.version, identities_digest: cox::instrument_identities_digest(&next.instruments).unwrap(), expected_instruments: 32,
        activation_timestamp: ORIGIN + 14, expires_at: ORIGIN + 100 })], &[&admin], true);
    p.h.time(ORIGIN + 14); publish(&mut p, &previous, 14);
    next.capture.predecessor_sequence = p.pool_state().sequence; next.capture.predecessor_state_digest = p.pool_state().state_digest;
    let key = upload(&mut p, &next); let runtime = p.h.runtime.insecure_clone();
    p.h.send("activate_universe", &[ComputeBudgetInstruction::request_heap_frame(262144), Harness::instruction(a::ActivateUniverse {asset_registry: None, next_registry_version: None, previous_registry_version: None,
        runtime: runtime.pubkey(), registry: p.registry, pool: p.pool, methodology: p.methodology, next_methodology: key, vault: p.vault, schedule, test_vault: p.test_vault(),
    }, i::ActivateUniverse {})], &[&runtime], true);
    assert_eq!(p.pool_state().classes.len(), 33);
    assert_eq!(cox::read_dynamic_manifest(&p.h.read::<Methodology>(key)).unwrap().operator, runtime.pubkey());
}

#[test]
fn dynamic_fee_configuration_and_single_successful_fees_survive_migration() {
    let mut p = verify_inclusion(31);
    let universe = cox::read_dynamic_manifest(&p.h.read::<Methodology>(p.methodology)).unwrap();
    let admin = p.h.admin.insecure_clone();
    let manage = || a::ManageFees { admin: admin.pubkey(), registry: p.registry, pool: p.pool, vault: p.vault };
    p.h.send("schedule_fees", &[Harness::instruction(manage(), i::ScheduleFees { bps: 2, cap: 200000, activation_cutoff: ORIGIN + 12 })], &[&admin], true);
    p.h.time(ORIGIN + 12); publish(&mut p, &universe, 12);
    assert_eq!(p.pool_state().fee_version, 1);
    let owner = p.h.alice.insecure_clone(); let accounts = p.submit_accounts(owner.pubkey(), p.h.alice_token); let entry = accounts.request;
    p.h.send("deposit_v2", &[Harness::instruction(accounts, i::DepositV2 { to: 31, amount: 1000000, minimum_units: 1, expiry: 100, expected_fee_version: 1 })], &[&owner], true);
    p.h.time(ORIGIN + 13); publish(&mut p, &universe, 13);
    let request: Request = p.h.read(entry); assert_eq!(request.fee, 200); assert_eq!(request.minted, 999800 * cox_math::SCALE as u128);
    let position = p.materialize(owner.pubkey()); let accounts = p.submit_accounts(owner.pubkey(), p.h.alice_token); let exit = accounts.request;
    p.h.send("redeem_v2", &[Harness::instruction(accounts, i::RedeemV2 { from: 31, units: position.classes[31].units, minimum_proceeds: 1, expiry: 100, expected_fee_version: 1 })], &[&owner], true);
    p.h.time(ORIGIN + 14); publish(&mut p, &universe, 14);
    let request: Request = p.h.read(exit); assert_eq!(request.fee, 199); assert_eq!(request.proceeds, 999601);
    assert_eq!(p.pool_state().fees, 399); p.withdraw(false, 999601, true); p.assert_owners(&[owner.pubkey()]);
    let manage = a::ManageFees { admin: admin.pubkey(), registry: p.registry, pool: p.pool, vault: p.vault };
    p.h.send("schedule_fees", &[Harness::instruction(manage, i::ScheduleFees { bps: 2, cap: 150000, activation_cutoff: ORIGIN + 86414 })], &[&admin], true);
    let manage = a::ManageFees { admin: admin.pubkey(), registry: p.registry, pool: p.pool, vault: p.vault };
    p.h.send("cancel_fees", &[Harness::instruction(manage, i::CancelFees {})], &[&admin], true);
    assert!(!p.pool_state().fee_pending); assert_eq!(p.pool_state().fee_version, 1);
}

#[test]
fn dynamic_migration_preserves_locked_units_payables_pending_principal_and_refunds() {
    let mut p = PoolHarness::new_adaptive(30);
    let owner = p.h.alice.pubkey();
    p.deposit(false, 0, 2_000_000, 1, 100, true); p.h.time(ORIGIN + 1);
    p.publish_adaptive(1, vec![100_000_000; 30], 100 * cox_math::SCALE, true); p.finish();
    p.redeem(false, 0, 500_000 * cox_math::SCALE as u128, 1, 100, true); p.h.time(ORIGIN + 2);
    p.publish_adaptive(2, vec![100_000_000; 30], 100 * cox_math::SCALE, true); p.finish(); p.materialize(owner);
    let locked = p.redeem(false, 0, 100_000 * cox_math::SCALE as u128, 1, 100, true);
    let pending = p.deposit(false, 1, 1_000_000, 1, 100, true);
    let before = p.pool_state(); let position = p.materialize(owner);
    assert_eq!(position.payable, 500_000); assert_eq!(position.classes[0].locked, 100_000 * cox_math::SCALE as u128);
    let initial = genesis(&p); let key = upload(&mut p, &initial); p.pause(true); migrate(&mut p, key, true);
    let after = p.pool_state(); let migrated = p.materialize(owner);
    assert_eq!((after.active, after.pending, after.payable, after.residual, after.fees), (before.active, before.pending, before.payable, before.residual, before.fees));
    assert_eq!(migrated.try_to_vec().unwrap(), position.try_to_vec().unwrap());
    let locked_request: Request = p.h.read(locked); let pending_request: Request = p.h.read(pending);
    p.cancel(locked_request.nonce, false, true); p.cancel(pending_request.nonce, false, true);
    p.refund(pending_request.nonce, false, true); p.withdraw(false, 500_000, true);
    let position = p.materialize(owner);
    assert_eq!(position.classes[0].units, 1_500_000 * cox_math::SCALE as u128); assert_eq!(position.classes[0].locked, 0);
    assert_eq!(position.payable, 0); assert_eq!(position.refundable, 0); assert_eq!(p.pool_state().pending, 0); p.assert_owners(&[owner]);
}

fn recovery_stage(p: &mut PoolHarness, universe: &UniverseVersion, batch_id: u64, benchmark: i128) {
    p.h.time(ORIGIN + batch_id);
    let state = p.pool_state();
    let runtime = p.h.runtime.insecure_clone();
    let batch = pda(&[b"batch", p.pool.as_ref()]);
    let prices = vec![PriceWire { price_e8: 100_000_000, venue: 3, step: 0, candle_start: ORIGIN + batch_id, trade_age_minutes: 0 }; universe.instruments.len()];
    let snapshot = cox::dynamic_snapshot_digest(ORIGIN + batch_id, benchmark, universe, &prices).unwrap();
    p.h.send("recovery_begin", &[Harness::instruction(a::BeginDynamicPublication {
        payer: runtime.pubkey(), runtime: runtime.pubkey(), registry: p.registry, pool: p.pool, methodology: p.methodology,
        batch, vault: p.vault, system_program: system_program::ID, test_vault: p.test_vault(),
    }, i::BeginDynamicPublication { batch_id, sequence: state.sequence + 1, predecessor: state.state_digest, snapshot, benchmark })], &[&runtime], true);
    for (index, page) in prices.chunks(16).enumerate() {
        let accounts = a::StageDynamicPublication { runtime: runtime.pubkey(), registry: p.registry, pool: p.pool, methodology: p.methodology, batch };
        p.h.send("recovery_prices", &[Harness::instruction(accounts, i::AppendDynamicPrices { offset: (index * 16) as u16, prices: page.to_vec() })], &[&runtime], true);
    }
}

fn recovery_accounts(p: &PoolHarness) -> a::StageDynamicPublication {
    a::StageDynamicPublication { runtime: p.h.runtime.pubkey(), registry: p.registry, pool: p.pool, methodology: p.methodology, batch: pda(&[b"batch", p.pool.as_ref()]) }
}

fn assert_cancel_preserves_finances(p: &mut PoolHarness, request: Pubkey) {
    let admin = p.h.admin.insecure_clone();
    let runtime = p.h.runtime.insecure_clone();
    let cancel = |authority| Harness::instruction(a::CancelDynamicPreparation { admin: authority, registry: p.registry, pool: p.pool, batch: pda(&[b"batch", p.pool.as_ref()]) }, i::CancelDynamicPreparation {});
    let instruction = cancel(admin.pubkey());
    let unauthorized = cancel(runtime.pubkey());
    let before = p.pool_state();
    let stage = p.batch_state();
    let request_before = p.h.svm.get_account(&request).unwrap().data;
    let position = p.position(p.h.alice.pubkey());
    let position_before = p.h.svm.get_account(&position).unwrap().data;
    let vault_before = p.h.svm.get_account(&p.vault).unwrap().data;
    let registry_before: cox::Registry = p.h.read(p.registry);
    assert_eq!(registry_before.active_batches, 1);
    reject(vec![instruction.clone()], &admin, cox::CoxError::Paused, p);
    p.pause(true);
    p.h.send("non_admin_cannot_cancel", &[unauthorized], &[&runtime], false);
    p.h.send("cancel_dynamic_preparation", &[instruction], &[&admin], true);
    let after = p.pool_state();
    let registry: cox::Registry = p.h.read(p.registry);
    assert_eq!(registry.active_batches, 0);
    assert_eq!(registry.max_accepted_batch, registry_before.max_accepted_batch);
    assert!(after.stage.is_none());
    assert_eq!(after.stage_batch, stage.batch_id);
    assert_eq!(after.stage_closed_end, before.stage_closed_end);
    let mut expected = before;
    expected.stage = None;
    assert_eq!(after.try_to_vec().unwrap(), expected.try_to_vec().unwrap());
    let cancelled: cox::Batch = p.h.read(pda(&[b"batch", p.pool.as_ref()]));
    assert_eq!(cancelled.phase, 7);
    assert_eq!((cancelled.batch_id, cancelled.sequence, cancelled.snapshot_digest), (stage.batch_id, stage.sequence, stage.snapshot_digest));
    assert_eq!(p.h.svm.get_account(&request).unwrap().data, request_before);
    assert_eq!(p.h.svm.get_account(&position).unwrap().data, position_before);
    assert_eq!(p.h.svm.get_account(&p.vault).unwrap().data, vault_before);
    p.pause(false);
    let state = p.pool_state();
    reject(vec![Harness::instruction(a::BeginDynamicPublication {
        payer: runtime.pubkey(), runtime: runtime.pubkey(), registry: p.registry, pool: p.pool, methodology: p.methodology,
        batch: pda(&[b"batch", p.pool.as_ref()]), vault: p.vault, system_program: system_program::ID, test_vault: p.test_vault(),
    }, i::BeginDynamicPublication { batch_id: stage.batch_id, sequence: state.sequence + 1, predecessor: state.state_digest, snapshot: [99; 32], benchmark: state.benchmark })], &runtime, cox::CoxError::WrongPredecessor, p);
}

fn recovery_deposit(p: &mut PoolHarness) -> Pubkey {
    let owner = p.h.alice.insecure_clone();
    let accounts = p.submit_accounts(owner.pubkey(), p.h.alice_token);
    let request = accounts.request;
    p.h.send("recovery_deposit", &[Harness::instruction(accounts, i::DepositV2 { to: 31, amount: 1_000_000, minimum_units: 1, expiry: 100, expected_fee_version: p.pool_state().fee_version })], &[&owner], true);
    request
}

#[test]
fn paused_admin_can_cancel_price_preparation_after_math_failure_but_not_financial_evaluation() {
    let mut p = verify_inclusion(31);
    let universe = cox::read_dynamic_manifest(&p.h.read::<Methodology>(p.methodology)).unwrap();
    let request = recovery_deposit(&mut p);
    recovery_stage(&mut p, &universe, 12, 1);
    let runtime = p.h.runtime.insecure_clone();
    reject(vec![Harness::instruction(recovery_accounts(&p), i::SealDynamicPublication {})], &runtime, cox::CoxError::ArithmeticOverflow, &mut p);
    assert_eq!(p.batch_state().phase, 4);
    assert_cancel_preserves_finances(&mut p, request);
    recovery_stage(&mut p, &universe, 13, 100 * cox_math::SCALE);
    p.h.send("recovery_seal", &[Harness::instruction(recovery_accounts(&p), i::SealDynamicPublication {})], &[&runtime], true);
    assert_eq!(p.batch_state().phase, 0);
    p.pause(true);
    let admin = p.h.admin.insecure_clone();
    reject(vec![Harness::instruction(a::CancelDynamicPreparation { admin: admin.pubkey(), registry: p.registry, pool: p.pool, batch: pda(&[b"batch", p.pool.as_ref()]) }, i::CancelDynamicPreparation {})], &admin, cox::CoxError::BatchBusy, &mut p);
    p.pause(false);
    p.finish();
    assert_eq!(p.h.read::<Request>(request).minted, 1_000_000 * cox_math::SCALE as u128);
    assert_eq!(p.pool_state().pending, 0);
    assert_eq!(p.pool_state().sequence, 5);
    p.assert_owners(&[p.h.alice.pubkey()]);
}

#[test]
fn maximum_universe_preparation_cancellation_preserves_requests_through_both_math_phases() {
    let mut p = verify_inclusion(255);
    let universe = cox::read_dynamic_manifest(&p.h.read::<Methodology>(p.methodology)).unwrap();
    let request = recovery_deposit(&mut p);
    let runtime = p.h.runtime.insecure_clone();
    recovery_stage(&mut p, &universe, 12, 1);
    p.h.send("recovery_seal", &[Harness::instruction(recovery_accounts(&p), i::SealDynamicPublication {})], &[&runtime], true);
    assert_eq!(p.batch_state().phase, 5);
    reject(vec![Harness::instruction(recovery_accounts(&p), i::PrepareDynamicRevaluation { offset: 0, limit: 16 })], &runtime, cox::CoxError::ArithmeticOverflow, &mut p);
    assert_cancel_preserves_finances(&mut p, request);
    recovery_stage(&mut p, &universe, 13, 100 * cox_math::SCALE);
    p.h.send("recovery_seal", &[Harness::instruction(recovery_accounts(&p), i::SealDynamicPublication {})], &[&runtime], true);
    for offset in (0..255).step_by(16) {
        p.h.send("recovery_references", &[Harness::instruction(recovery_accounts(&p), i::PrepareDynamicRevaluation { offset, limit: 16 })], &[&runtime], true);
    }
    assert_eq!(p.batch_state().phase, 6);
    p.h.send("recovery_backings", &[Harness::instruction(recovery_accounts(&p), i::FinishDynamicRevaluation { offset: 0, limit: 16 })], &[&runtime], true);
    assert_cancel_preserves_finances(&mut p, request);
    p.h.time(ORIGIN + 14);
    publish(&mut p, &universe, 14);
    assert_eq!(p.h.read::<Request>(request).minted, 1_000_000 * cox_math::SCALE as u128);
    assert_eq!(p.pool_state().pending, 0);
    assert_eq!(p.pool_state().sequence, 5);
    p.assert_owners(&[p.h.alice.pubkey()]);
}

fn export_generation(p: &PoolHarness, phase: &str, registry: Option<Pubkey>, version: Option<Pubkey>, count: usize) {
    if count != 31 { return; }
    let Ok(directory)=std::env::var("COX_GENERATION_FIXTURES_DIR") else {return;};
    let directory=std::path::Path::new(&directory);std::fs::create_dir_all(directory).unwrap();
    let mut keys=vec![("pool",p.pool),("registry",p.registry),("methodology",p.methodology),("vault",p.vault)];
    if let Some(key)=registry {keys.push(("assetRegistry",key));}
    if let Some(key)=version {keys.push(("assetRegistryVersion",key));}
    p.h.write_accounts(&directory.join(format!("{phase}.json")),&keys);
}

fn fresh_generation(count: usize, export: bool) -> (PoolHarness, Pubkey) {
    let mut p = PoolHarness::new_adaptive(30);
    let admin = p.h.admin.insecure_clone(); let runtime = p.h.runtime.insecure_clone();
    let mut authority: cox::Registry = p.h.read(p.registry);
    authority.next_pool_id = 7;
    let mut account = p.h.svm.get_account(&p.registry).unwrap();
    account.data.fill(0);
    anchor_lang::AccountSerialize::try_serialize(&authority, &mut account.data.as_mut_slice()).unwrap();
    p.h.svm.set_account(p.registry, account).unwrap();
    let fresh_pool = pda(&[b"pool", &7u64.to_le_bytes()]);
    let mut universe = genesis(&p);
    universe.schema_version=2; universe.pool = fresh_pool; universe.capture.predecessor_sequence = 0; universe.capture.predecessor_state_digest = [0;32];
    universe.capture.prices_e8 = vec![100_000_000; count];
    universe.expected_instruments = count as u16;
    universe.instruments = (0..count).map(|index| Instrument {
        stable_id: format!("asset-{index}"), symbol: format!("ASSET{index}"),
        class_id: (index+1) as u16, epoch_id: index as u16,
        pyth_pro_feed_id: index as u32+1, pyth_core_feed_id: cox::dynamic_digest(&index.to_le_bytes()), token_mint: None,
        original_price_e8: 100_000_000, original_benchmark: 100*cox_math::SCALE, original_timestamp: ORIGIN,
    }).collect();
    universe.sealed = false; universe.seal_genesis().unwrap();
    let bytes = universe.canonical_bytes().unwrap();
    let methodology = pda(&[b"methodology", &universe.digest]);
    p.h.send("register_fresh_methodology", &[Harness::instruction(a::RegisterDynamicMethodology {
        admin: admin.pubkey(), registry: p.registry, methodology, system_program: system_program::ID,
    },i::RegisterDynamicMethodology {digest: universe.digest,length:bytes.len() as u32,activation_batch:0})], &[&admin],true);
    grow(&mut p,methodology,bytes.len()+512);
    for (index,bytes) in bytes.chunks(600).enumerate() {
        p.h.send("upload_fresh_methodology", &[ComputeBudgetInstruction::request_heap_frame(262144),Harness::instruction(a::ManageMethodology {admin:admin.pubkey(),registry:p.registry,methodology},
            i::UploadMethodology {offset:(index*600) as u32,bytes:bytes.to_vec()})],&[&admin],true);
    }
    p.h.send("seal_fresh_methodology", &[ComputeBudgetInstruction::request_heap_frame(262144),Harness::instruction(a::SealGenesisMethodology {
        runtime:runtime.pubkey(),registry:p.registry,methodology},i::SealGenesisMethodology {})], &[&runtime],true);
    p.pool = fresh_pool; p.methodology = methodology; p.vault = pda(&[b"vault",fresh_pool.as_ref()]);
    p.h.send("initialize_fresh_pool", &[ComputeBudgetInstruction::request_heap_frame(262144),Harness::instruction(a::InitializePool {
        admin:admin.pubkey(),registry:p.registry,methodology,pool:fresh_pool,mint:p.h.mint,vault:p.vault,
        token_program:support::token_program(),system_program:system_program::ID,test_vault:None,
    },i::InitializeDynamicPool {pool_id:7,trading_opens_at:ORIGIN+60})], &[&admin],true);
    grow(&mut p,fresh_pool,32768);
    p.h.send("prepare_fresh_pool", &[ComputeBudgetInstruction::request_heap_frame(262144),Harness::instruction(a::PrepareDynamicPool {
        admin:admin.pubkey(),registry:p.registry,pool:fresh_pool,methodology},i::PrepareDynamicPool {})],&[&admin],true);
    assert_eq!(cox::pool_lifecycle(&p.pool_state()).unwrap(),cox::InstanceLifecycle::Preparing);
    let batch=pda(&[b"batch",p.pool.as_ref()]);let publication=pda(&[b"publication",p.pool.as_ref()]);
    p.h.send("initialize_genesis_staging",&[Harness::instruction(a::InitializeDynamicStaging {payer:runtime.pubkey(),pool:p.pool,batch,publication,system_program:system_program::ID},i::InitializeDynamicStaging {})],&[&runtime],true);
    grow(&mut p,batch,cox::dynamic_batch_space(count+1));grow(&mut p,publication,cox::dynamic_batch_space(count+1));
    p.h.time(ORIGIN); publish(&mut p,&universe,0);
    assert!(p.pool_state().initialized);
    assert_eq!(p.pool_state().origin_prices.len(),count);
    assert!(p.pool_state().references.iter().all(|r|*r==100*cox_math::SCALE));
    let generation = [101;32]; let asset_registry = pda(&[b"asset-registry",&generation]);
    p.h.send("initialize_asset_registry",&[Harness::instruction(a::InitializeAssetRegistry {admin:admin.pubkey(),registry:p.registry,pool:p.pool,asset_registry,system_program:system_program::ID},i::InitializeAssetRegistry {generation})],&[&admin],true);
    let version = pda(&[b"asset-version",asset_registry.as_ref(),&universe.digest]);
    p.h.send("register_asset_version",&[ComputeBudgetInstruction::request_heap_frame(262144),Harness::instruction(a::RegisterAssetRegistryVersion {payer:admin.pubkey(),registry:p.registry,pool:p.pool,asset_registry,methodology,version,system_program:system_program::ID},i::RegisterAssetRegistryVersion {})],&[&admin],true);
    if export { export_generation(&p,"preparing",Some(asset_registry),Some(version),count); }
    p.h.send("activate_genesis_registry",&[Harness::instruction(a::ActivateAssetRegistryVersion {runtime:runtime.pubkey(),registry:p.registry,pool:p.pool,methodology,asset_registry,version,previous_version:None},i::ActivateAssetRegistryVersion {})],&[&runtime],true);
    p.h.time(ORIGIN+60);
    let owner=p.h.alice.insecure_clone();
    let before=p.pool_state();
    let custody=p.h.token_balance(p.vault);
    let accounts=p.submit_accounts(owner.pubkey(),p.h.alice_token);
    p.h.send("preparing_reject_deposit_after_opening",&[Harness::instruction(accounts,i::DepositV2 {to:31,amount:1_000_000,minimum_units:1,expiry:100,expected_fee_version:1})],&[&owner],false);
    assert_eq!(p.pool_state().next_request_nonce,before.next_request_nonce);
    assert_eq!(p.pool_state().pending,before.pending);
    assert_eq!(p.h.token_balance(p.vault),custody);
    p.h.send("activate_fresh_pool",&[Harness::instruction(a::ManagePoolLifecycle {admin:admin.pubkey(),registry:p.registry,pool:p.pool,asset_registry:Some(asset_registry)},i::SetPoolLifecycle {lifecycle:cox::InstanceLifecycle::Active})],&[&admin],true);
    assert_eq!(p.pool_state().crypto_class,0);
    assert_eq!(p.pool_state().fee_cap,200_000); assert_eq!(p.pool_state().fee_bps,2);
    assert_eq!(cox::pool_lifecycle(&p.pool_state()).unwrap(),cox::InstanceLifecycle::Active);
    if export { export_generation(&p,"active",Some(asset_registry),Some(version),count); }
    (p,asset_registry)
}

#[test]
fn fresh_31_asset_generation_bootstraps_without_migration_and_archive_preserves_refunds() {
    let (mut p,registry) = fresh_generation(31,true);
    let admin=p.h.admin.insecure_clone();
    let owner=p.h.alice.insecure_clone();
    let accounts=p.submit_accounts(owner.pubkey(),p.h.alice_token);
    p.h.send("fresh_deposit",&[Harness::instruction(accounts,i::DepositV2 {to:31,amount:1_000_000,minimum_units:1,expiry:100,expected_fee_version:1})],&[&owner],true);
    let custody=p.h.token_balance(p.vault);
    p.h.send("archive_instance",&[Harness::instruction(a::ManagePoolLifecycle {admin:admin.pubkey(),registry:p.registry,pool:p.pool,asset_registry:Some(registry)},i::SetPoolLifecycle {lifecycle:cox::InstanceLifecycle::Archived})],&[&admin],true);
    assert_eq!(p.h.token_balance(p.vault),custody);
    let r:cox::AssetRegistry=p.h.read(registry);
    export_generation(&p,"archived",Some(registry),Some(r.active_version),31);
    p.pause(true);p.pause(false);
    let accounts=p.submit_accounts(owner.pubkey(),p.h.alice_token);
    p.h.send("archived_reject_deposit",&[Harness::instruction(accounts,i::DepositV2 {to:31,amount:1_000_000,minimum_units:1,expiry:100,expected_fee_version:1})],&[&owner],false);
    p.h.send("cannot_reactivate_archived",&[Harness::instruction(a::ManagePoolLifecycle {admin:admin.pubkey(),registry:p.registry,pool:p.pool,asset_registry:Some(registry)},i::SetPoolLifecycle {lifecycle:cox::InstanceLifecycle::Active})],&[&admin],false);
    p.cancel(0,false,true);p.refund(0,false,true);
    assert_eq!(p.h.token_balance(p.vault),0);
}

#[test]
fn fresh_255_asset_generation_uses_bounded_genesis_staging() {
    let (p,_) = fresh_generation(255,false);
    assert_eq!(p.pool_state().classes.len(),256);
    assert_eq!(p.pool_state().origin_prices.len(),255);
}

#[test]
fn shared_registry_activation_closes_intervals_atomically_and_requires_bound_registry() {
    let (mut p,asset_registry)=fresh_generation(31,false);
    let previous=cox::read_dynamic_manifest(&p.h.read::<Methodology>(p.methodology)).unwrap();
    let admin=p.h.admin.insecure_clone();let runtime=p.h.runtime.insecure_clone();
    let registry:cox::AssetRegistry=p.h.read(asset_registry);let previous_version=registry.active_version;
    let mut next=UniverseVersion::draft(0,p.pool,runtime.pubkey(),previous.source_methodology,2,previous.digest,32,
        UniverseCapture {timestamp:ORIGIN+61,prices_e8:vec![100_000_000;32],..previous.capture.clone()}).unwrap();
    next.schema_version=2;next.instruments=previous.instruments.clone();
    next.instruments.push(Instrument {stable_id:"new-asset".into(),symbol:"NEW".into(),class_id:32,epoch_id:31,pyth_pro_feed_id:32,
        pyth_core_feed_id:[88;32],token_mint:None,original_price_e8:100_000_000,original_benchmark:100*cox_math::SCALE,original_timestamp:ORIGIN+61});
    let schedule=pda(&[b"universe-schedule",p.pool.as_ref(),&2u64.to_le_bytes()]);
    let schedule_args=i::ScheduleUniverse {version:2,identities_digest:cox::instrument_identities_digest_for_schema(2,&next.instruments).unwrap(),expected_instruments:32,activation_timestamp:ORIGIN+61,expires_at:ORIGIN+100};
    p.h.send("bound_schedule_cannot_omit_registry",&[Harness::instruction(a::ScheduleUniverse {admin:admin.pubkey(),registry:p.registry,pool:p.pool,methodology:p.methodology,schedule,system_program:system_program::ID,asset_registry:None},i::ScheduleUniverse {version:2,identities_digest:cox::instrument_identities_digest_for_schema(2,&next.instruments).unwrap(),expected_instruments:32,activation_timestamp:ORIGIN+61,expires_at:ORIGIN+100})],&[&admin],false);
    p.h.send("bound_schedule",&[Harness::instruction(a::ScheduleUniverse {admin:admin.pubkey(),registry:p.registry,pool:p.pool,methodology:p.methodology,schedule,system_program:system_program::ID,asset_registry:Some(asset_registry)},schedule_args)],&[&admin],true);
    let r:cox::AssetRegistry=p.h.read(asset_registry);assert_eq!(r.pending_activation,ORIGIN+61);
    p.h.time(ORIGIN+61);publish(&mut p,&previous,61);
    let state=p.pool_state();next.capture.predecessor_sequence=state.sequence;next.capture.predecessor_state_digest=state.state_digest;
    next.digest=next.canonical_digest().unwrap();
    let methodology=upload(&mut p,&next);
    let version=pda(&[b"asset-version",asset_registry.as_ref(),&next.digest]);
    p.h.send("register_successor_version",&[Harness::instruction(a::RegisterAssetRegistryVersion {payer:runtime.pubkey(),registry:p.registry,pool:p.pool,asset_registry,methodology,version,system_program:system_program::ID},i::RegisterAssetRegistryVersion {})],&[&runtime],true);
    let before=p.h.svm.get_account(&p.pool).unwrap().data;
    p.h.send("activation_cannot_omit_registry",&[Harness::instruction(a::ActivateUniverse {runtime:runtime.pubkey(),registry:p.registry,pool:p.pool,methodology:p.methodology,next_methodology:methodology,vault:p.vault,schedule,test_vault:None,asset_registry:None,next_registry_version:None,previous_registry_version:None},i::ActivateUniverse {})],&[&runtime],false);
    assert_eq!(p.h.svm.get_account(&p.pool).unwrap().data,before);
    p.h.send("activate_shared_universe",&[Harness::instruction(a::ActivateUniverse {runtime:runtime.pubkey(),registry:p.registry,pool:p.pool,methodology:p.methodology,next_methodology:methodology,vault:p.vault,schedule,test_vault:None,asset_registry:Some(asset_registry),next_registry_version:Some(version),previous_registry_version:Some(previous_version)},i::ActivateUniverse {})],&[&runtime],true);
    let old:cox::AssetRegistryVersion=p.h.read(previous_version);let new:cox::AssetRegistryVersion=p.h.read(version);let r:cox::AssetRegistry=p.h.read(asset_registry);
    assert_eq!(old.effective_until,ORIGIN+61);assert_eq!(new.effective_from,ORIGIN+61);assert!(new.sealed);
    assert_eq!(r.active_version,version);assert_eq!(r.pending_activation,0);assert_eq!(p.pool_state().methodology,methodology);
    let u=cox::read_dynamic_manifest(&p.h.read::<Methodology>(methodology)).unwrap();assert!(u.instruments.starts_with(&previous.instruments));
}

#[test]
fn fresh_class_zero_is_crypto_and_first_underlying_is_class_one() {
    let (mut p,_)=fresh_generation(31,false);let owner=p.h.alice.insecure_clone();
    for to in [0,1] {
        let accounts=p.submit_accounts(owner.pubkey(),p.h.alice_token);
        p.h.send("fresh_class_deposit",&[Harness::instruction(accounts,i::DepositV2 {to,amount:1_000_000,minimum_units:1,expiry:100,expected_fee_version:1})],&[&owner],true);
    }
    let universe=cox::read_dynamic_manifest(&p.h.read::<Methodology>(p.methodology)).unwrap();
    assert_eq!(universe.crypto_class(),0);assert_eq!(universe.instruments[0].class_id,1);
    p.h.time(ORIGIN+61);publish(&mut p,&universe,61);
    let before=p.pool_state();assert!(before.classes[0].units>0 && before.classes[1].units>0);
    p.h.time(ORIGIN+63);publish(&mut p,&universe,63);
    let after=p.pool_state();assert_eq!(after.references[0],100*cox_math::SCALE);
    assert!(after.references[1]>100*cox_math::SCALE);
    assert!(after.classes[1].backing>after.classes[0].backing);
    assert_eq!(after.classes[0].units,before.classes[0].units);
    assert_eq!(after.classes[1].units,before.classes[1].units);
}
