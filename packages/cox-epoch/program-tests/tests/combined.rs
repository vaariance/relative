#![allow(dead_code)]

#[path = "../../../cox/crates/program-tests/tests/support/mod.rs"]
mod basic_support;

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use basic_support::{protocol::PoolHarness, Harness, ORIGIN};
use cox::{accounts as ba, instruction as bi, Pool, PriceWire, Request};
use cox_epoch::{Asset, LotState, Price};
use relative_epoch::{accounts as ea, instruction as ei, EpochAccount, LotAccount};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction, instruction::Instruction, signature::Signer,
    system_program, transaction::Transaction,
};

const OPEN: u64 = 144_000;
const STAKE: u64 = 10_000_000;
fn epda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &relative_epoch::ID).0
}
fn eix<A: ToAccountMetas, I: InstructionData>(accounts: A, data: I) -> Instruction {
    Instruction {
        program_id: relative_epoch::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}
fn asset(id: u16) -> Asset {
    let mut feed_id = [0; 32];
    feed_id[..2].copy_from_slice(&(id + 1).to_le_bytes());
    Asset {
        id,
        feed_id,
        origin_price: 100_000_000,
    }
}
struct Combined {
    basic: PoolHarness,
    config: Pubkey,
    epoch: Pubkey,
    vault: Pubkey,
    test_vault: Pubkey,
    lot: Pubkey,
    snapshot: Pubkey,
}
impl Combined {
    fn new() -> Self {
        let mut basic = PoolHarness::new_adaptive(30);
        let bytes = std::fs::read(
            std::env::var("EPOCH_PROGRAM_SO").expect("select the compiled Epoch artifact"),
        )
        .unwrap();
        basic.h.svm.add_program(relative_epoch::ID, &bytes);
        let admin = basic.h.admin.insecure_clone();
        let operator = basic.h.runtime.pubkey();
        let config = epda(&[b"config", admin.pubkey().as_ref(), &0u64.to_le_bytes()]);
        let epoch = epda(&[b"epoch", config.as_ref(), &OPEN.to_le_bytes()]);
        let vault = epda(&[b"vault", epoch.as_ref()]);
        let test_vault = epda(&[b"test-vault", epoch.as_ref()]);
        let lot = epda(&[b"lot", epoch.as_ref(), &0u64.to_le_bytes()]);
        let snapshot = epda(&[b"snapshot", config.as_ref(), &1u64.to_le_bytes()]);
        basic.h.time(OPEN - 10);
        let method: cox::Methodology = basic.h.read(basic.methodology);
        basic.h.send(
            "epoch_initialize_config",
            &[
                ComputeBudgetInstruction::request_heap_frame(relative_epoch::REQUIRED_HEAP_BYTES),
                eix(
                    ea::InitializeConfig {
                        admin: admin.pubkey(),
                        mint: basic.h.mint,
                        config,
                        system_program: system_program::ID,
                    },
                    ei::InitializeConfig {
                        config_id: 0,
                        operator,
                        methodology: method.digest,
                        origin_benchmark: (100 * cox_math::SCALE) as u128,
                        max_entry_price_age: 3,
                        max_lots: 1000,
                    },
                ),
            ],
            &[&admin],
            true,
        );
        basic.h.send(
            "epoch_initialize",
            &[
                ComputeBudgetInstruction::request_heap_frame(relative_epoch::REQUIRED_HEAP_BYTES),
                eix(
                    ea::InitializeEpoch {
                        admin: admin.pubkey(),
                        config,
                        mint: basic.h.mint,
                        test_mint: basic.h.mint,
                        epoch,
                        vault,
                        test_vault,
                        token_program: basic_support::token_program(),
                        system_program: system_program::ID,
                    },
                    ei::InitializeEpoch { opens_at: OPEN },
                ),
            ],
            &[&admin],
            true,
        );
        let draft = || ea::ManageEpochDraft {
            admin: admin.pubkey(),
            config,
            epoch,
            system_program: system_program::ID,
        };
        while basic.h.svm.get_account(&epoch).unwrap().data.len() < relative_epoch::EPOCH_SPACE {
            let growth = (relative_epoch::EPOCH_SPACE
                - basic.h.svm.get_account(&epoch).unwrap().data.len())
            .min(relative_epoch::MAX_GROWTH);
            basic.h.send(
                "epoch_grow",
                &[
                    ComputeBudgetInstruction::request_heap_frame(
                        relative_epoch::REQUIRED_HEAP_BYTES,
                    ),
                    eix(
                        draft(),
                        ei::GrowEpoch {
                            additional_bytes: growth as u32,
                        },
                    ),
                ],
                &[&admin],
                true,
            );
        }
        for chunk in (0..30).map(asset).collect::<Vec<_>>().chunks(8) {
            basic.h.send(
                "epoch_append",
                &[
                    ComputeBudgetInstruction::request_heap_frame(
                        relative_epoch::REQUIRED_HEAP_BYTES,
                    ),
                    eix(
                        draft(),
                        ei::AppendUniverse {
                            assets: chunk.to_vec(),
                        },
                    ),
                ],
                &[&admin],
                true,
            );
        }
        basic.h.send(
            "epoch_seal",
            &[
                ComputeBudgetInstruction::request_heap_frame(relative_epoch::REQUIRED_HEAP_BYTES),
                eix(draft(), ei::SealEpoch {}),
            ],
            &[&admin],
            true,
        );
        basic.h.time(OPEN);
        basic.deposit(false, 0, STAKE, 0, OPEN - ORIGIN + 100, true);
        let owner = basic.h.alice.insecure_clone();
        basic.h.send(
            "epoch_queue",
            &[
                ComputeBudgetInstruction::request_heap_frame(relative_epoch::REQUIRED_HEAP_BYTES),
                eix(
                    ea::Queue {
                        owner: owner.pubkey(),
                        config,
                        epoch,
                        lot,
                        source: basic.h.alice_token,
                        vault,
                        test_vault,
                        token_program: basic_support::token_program(),
                        system_program: system_program::ID,
                    },
                    ei::Queue {
                        nonce: 0,
                        gross_stake: STAKE,
                        basket: std::array::from_fn(|index| index as u16),
                        backed_asset: 0,
                    },
                ),
            ],
            &[&owner],
            true,
        );
        basic.h.time(OPEN + 1);
        Self {
            basic,
            config,
            epoch,
            vault,
            test_vault,
            lot,
            snapshot,
        }
    }
    fn instructions(&self, fail: bool) -> Vec<Instruction> {
        let p = &self.basic;
        let operator = p.h.runtime.pubkey();
        let time = OPEN + 1;
        let benchmark = 110 * cox_math::SCALE;
        let prices = (0..30)
            .map(|id| PriceWire {
                price_e8: if id == 0 { 121_000_000 } else { 100_000_000 },
                venue: 3,
                step: 0,
                candle_start: time,
                trade_age_minutes: 0,
            })
            .collect::<Vec<_>>();
        let snapshot = cox_math::artifact_digest(
            &cox::adaptive_snapshot_bytes(time, benchmark, &p.roster, &prices).unwrap(),
        );
        let batch = basic_support::pda(&[b"batch", p.pool.as_ref()]);
        let process = || ba::Process {
            registry: p.registry,
            pool: p.pool,
            batch,
            request: p.request(0),
            position: p.position(p.h.alice.pubkey()),
            vault: p.vault,
            test_vault: None,
        };
        let seal = || {
            Harness::instruction(
                ba::BatchOnly {
                    registry: p.registry,
                    pool: p.pool,
                    batch,
                    vault: p.vault,
                    test_vault: None,
                },
                bi::SealEvaluation {},
            )
        };
        let state = p.pool_state();
        let mut instructions = vec![
            Harness::instruction(
                ba::Publish {
                    payer: operator,
                    runtime: operator,
                    registry: p.registry,
                    pool: p.pool,
                    methodology: p.methodology,
                    batch,
                    vault: p.vault,
                    system_program: system_program::ID,
                    test_vault: None,
                },
                bi::PublishAdaptive {
                    batch_id: time - ORIGIN,
                    sequence: state.sequence + 1,
                    predecessor: state.state_digest,
                    prices: prices.clone(),
                    snapshot,
                    archive_time: time,
                    benchmark,
                },
            ),
            Harness::instruction(process(), bi::Evaluate {}),
            seal(),
            Harness::instruction(process(), bi::Safety {}),
            seal(),
            Harness::instruction(process(), bi::Execute {}),
            Harness::instruction(
                ba::Finalize {
                    payer: operator,
                    registry: p.registry,
                    pool: p.pool,
                    batch,
                    methodology: p.methodology,
                    publication: basic_support::pda(&[b"publication", p.pool.as_ref()]),
                    vault: p.vault,
                    system_program: system_program::ID,
                    test_vault: None,
                },
                bi::Finalize {},
            ),
            eix(
                ea::InitializeSnapshot {
                    operator,
                    config: self.config,
                    snapshot: self.snapshot,
                    system_program: system_program::ID,
                },
                ei::PublishSnapshot {
                    sequence: 1,
                    oracle_timestamp: time,
                    benchmark: benchmark as u128,
                    prices: prices
                        .iter()
                        .enumerate()
                        .map(|(id, price)| Price {
                            asset_id: id as u16,
                            feed_id: asset(id as u16).feed_id,
                            value: price.price_e8 as u128,
                        })
                        .collect(),
                },
            ),
        ];
        let execute = || {
            eix(
                ea::Execute {
                    operator,
                    config: self.config,
                    epoch: self.epoch,
                    lot: self.lot,
                    vault: self.vault,
                    test_vault: self.test_vault,
                    snapshot: self.snapshot,
                },
                ei::Execute {},
            )
        };
        instructions.push(execute());
        if fail {
            instructions.push(execute());
        }
        instructions.push(eix(
            ea::CloseSnapshot {
                operator,
                config: self.config,
                snapshot: self.snapshot,
            },
            ei::CloseSnapshot {},
        ));
        instructions
    }
    fn run(&mut self, fail: bool) {
        self.run_instructions(self.instructions(fail), !fail);
    }
    fn run_instructions(&mut self, calls: Vec<Instruction>, success: bool) {
        let operator = self.basic.h.runtime.insecure_clone();
        let mut instructions = vec![
            ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
            ComputeBudgetInstruction::request_heap_frame(relative_epoch::REQUIRED_HEAP_BYTES),
        ];
        instructions.extend(calls);
        let tx = Transaction::new_signed_with_payer(
            &instructions,
            Some(&operator.pubkey()),
            &[&operator],
            self.basic.h.svm.latest_blockhash(),
        );
        let bytes = bincode::serialize(&tx).unwrap().len();
        let result = self.basic.h.svm.send_transaction(tx);
        assert_eq!(result.is_ok(), success, "{result:?}");
        if let Ok(meta) = result {
            assert!(meta.compute_units_consumed <= 1_400_000);
            eprintln!("cross-pool compiled execution: {bytes} legacy-encoded bytes, {} CU; legacy packet exceeds limit; V1 transport not exercised here",meta.compute_units_consumed);
        }
        self.basic.h.svm.expire_blockhash();
    }
    fn epoch_read<T: AccountDeserialize>(&self, address: Pubkey) -> T {
        let account = self.basic.h.svm.get_account(&address).unwrap();
        assert_eq!(account.owner, relative_epoch::ID);
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }
}
#[test]
fn one_compiled_operator_transaction_fills_basic_and_executes_epoch_with_identical_reference_inputs(
) {
    let mut h = Combined::new();
    let operator = h.basic.h.runtime.pubkey();
    let before = h.basic.h.svm.get_account(&operator).unwrap().lamports;
    h.run(false);
    let pool: Pool = h.basic.pool_state();
    assert_eq!(pool.active, STAKE);
    assert_eq!(pool.pending, 0);
    assert!(pool.stage.is_none());
    assert_eq!(pool.last_batch, OPEN + 1 - ORIGIN);
    assert_eq!(pool.benchmark, 110 * cox_math::SCALE);
    assert_eq!(
        pool.last_prices,
        (0..30)
            .map(|id| if id == 0 { 121_000_000 } else { 100_000_000 })
            .collect::<Vec<_>>()
    );
    let request: Request = h.basic.h.read(h.basic.request(0));
    assert!(request.applied);
    assert!(request.minted > 0);
    assert_eq!(request.fee, 0);
    let lot: LotAccount = h.epoch_read(h.lot);
    let state = lot.state.unwrap();
    assert_eq!(state.state(), &LotState::Executed);
    assert_eq!(state.execution().unwrap().timestamp, OPEN + 1);
    for (index, (reference, basic)) in state
        .execution()
        .unwrap()
        .references
        .iter()
        .zip(&pool.references)
        .enumerate()
    {
        assert_eq!(
            *reference,
            cox_epoch::math::relative_reference(
                pool.last_prices[index] as u128,
                100_000_000,
                pool.benchmark as u128,
                (100 * cox_math::SCALE) as u128
            )
            .unwrap()
        );
        let scaled = reference.checked_mul(100).unwrap();
        assert!(scaled.abs_diff(*basic as u128) <= 100);
    }
    let epoch: EpochAccount = h.epoch_read(h.epoch);
    let ledger = epoch.state.unwrap().ledger();
    assert_eq!(ledger.held_fees, 2_000);
    assert_eq!(ledger.active_net, STAKE - 2_000);
    assert_eq!(ledger.pending_gross, 0);
    ledger
        .check(h.basic.h.token_balance(h.vault) + h.basic.h.token_balance(h.test_vault))
        .unwrap();
    assert_eq!(h.basic.h.token_balance(h.vault), STAKE);
    h.basic.assert_vault();
    assert!(h
        .basic
        .h
        .svm
        .get_account(&h.snapshot)
        .is_none_or(|a| a.lamports == 0));
    assert_eq!(
        before - h.basic.h.svm.get_account(&operator).unwrap().lamports,
        5_000
    );
}
#[test]
fn epoch_failure_rolls_back_basic_publication_fill_and_both_pool_transitions() {
    let mut h = Combined::new();
    let keys = [
        h.basic.pool,
        h.basic.request(0),
        h.basic.position(h.basic.h.alice.pubkey()),
        h.basic.vault,
        basic_support::pda(&[b"batch", h.basic.pool.as_ref()]),
        basic_support::pda(&[b"publication", h.basic.pool.as_ref()]),
        h.epoch,
        h.lot,
        h.vault,
    ];
    let before = keys
        .iter()
        .map(|key| h.basic.h.svm.get_account(key).unwrap())
        .collect::<Vec<_>>();
    h.run(true);
    for (key, account) in keys.iter().zip(before) {
        assert_eq!(h.basic.h.svm.get_account(key).unwrap(), account);
    }
    assert!(h.basic.h.svm.get_account(&h.snapshot).is_none());
    assert!(h.basic.pool_state().stage.is_none());
    let lot: LotAccount = h.epoch_read(h.lot);
    assert_eq!(lot.state.unwrap().state(), &LotState::Pending);
    h.run(false);
    assert_eq!(h.basic.pool_state().pending, 0);
}

#[test]
fn later_basic_failure_rolls_back_epoch_execution_and_snapshot_rent_return() {
    let mut h = Combined::new();
    let keys = [h.basic.pool, h.epoch, h.lot, h.vault, h.test_vault];
    let before = keys
        .iter()
        .map(|key| h.basic.h.svm.get_account(key).unwrap())
        .collect::<Vec<_>>();
    let mut basic = h.instructions(false);
    let mut epoch = basic.split_off(7);
    basic[0].data[24] ^= 1;
    epoch.push(basic.remove(0));
    h.run_instructions(epoch, false);
    for (key, account) in keys.iter().zip(before) {
        assert_eq!(h.basic.h.svm.get_account(key).unwrap(), account);
    }
    assert!(h.basic.h.svm.get_account(&h.snapshot).is_none());
    h.run(false);
}
