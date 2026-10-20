mod support;

use cox::{accounts as a, instruction as i, Position, Request, Retirement};
use cox_math::SCALE;
use solana_sdk::{pubkey::Pubkey, signature::Signer, system_program};
use support::{pda, protocol::PoolHarness, Harness, ORIGIN};

fn migrate(p: &mut PoolHarness) {
    p.pause(true);
    let admin = p.h.admin.insecure_clone();
    p.h.send("migrate_pool", &[Harness::instruction(a::MigratePool {
        admin: admin.pubkey(), registry: p.registry, pool: p.pool, vault: p.vault,
    }, i::MigratePool {})], &[&admin], true);
    p.pause(false);
}

fn begin(p: &mut PoolHarness, unauthorized: bool, success: bool) {
    let signer = if unauthorized { p.h.bob.insecure_clone() } else { p.h.admin.insecure_clone() };
    p.h.send("begin_retirement", &[Harness::instruction(a::BeginRetirement {
        admin: signer.pubkey(), registry: p.registry, pool: p.pool,
        retirement: pda(&[b"retirement", p.pool.as_ref()]), vault: p.vault,
        system_program: system_program::ID,
    }, i::BeginRetirement {})], &[&signer], success);
    p.assert_vault();
}

fn retire(p: &mut PoolHarness, owner: Pubkey, success: bool) {
    let operator = p.h.bob.insecure_clone();
    p.h.send("retire_position", &[Harness::instruction(a::RetirePosition {
        pool: p.pool, retirement: pda(&[b"retirement", p.pool.as_ref()]),
        position: p.position(owner), vault: p.vault,
    }, i::RetirePosition {})], &[&operator], success);
    p.assert_vault();
}

fn release(p: &mut PoolHarness, nonce: u64, success: bool) {
    let request: Request = p.h.read(p.request(nonce));
    let operator = p.h.bob.insecure_clone();
    p.h.send("retire_request", &[Harness::instruction(a::ManageRequest {
        authority: operator.pubkey(), registry: p.registry, pool: p.pool,
        request: p.request(nonce), position: p.position(request.owner), vault: p.vault,
    }, i::RetireRequest {})], &[&operator], success);
    p.assert_vault();
}

fn pay(p: &mut PoolHarness, owner: Pubkey, destination: Pubkey, success: bool) {
    let payer = p.h.bob.insecure_clone();
    p.h.send("pay_retirement", &[Harness::instruction(a::RetirementPayout {
        pool: p.pool, position: p.position(owner), vault: p.vault, user_token: destination,
        token_program: support::token_program(),
    }, i::PayRetirement {})], &[&payer], success);
    p.assert_vault();
}

#[test]
fn retirement_pays_owner_without_owner_signature_and_rejects_redirection_and_replay() {
    let mut p = PoolHarness::new(2);
    migrate(&mut p);
    let alice = p.h.alice.pubkey();
    let alice_token = p.h.alice_token;
    let bob_token = p.h.bob_token;
    p.deposit(false, 0, 5_000_000, 0, 100, true);
    p.h.time(ORIGIN + 60); p.publish(1, vec![100_000_000; 2]); p.finish();
    pay(&mut p, alice, alice_token, false);
    p.pause(true); begin(&mut p, false, true);
    pay(&mut p, alice, alice_token, false);
    retire(&mut p, alice, true);
    let before = p.h.token_balance(alice_token);
    pay(&mut p, alice, bob_token, false);
    assert_eq!(p.h.token_balance(alice_token), before);
    let position: Position = p.h.read(p.position(alice)); assert_eq!(position.payable, 5_000_000);
    p.h.time(ORIGIN + 60 * 100);
    pay(&mut p, alice, alice_token, true);
    assert_eq!(p.h.token_balance(alice_token), before + 5_000_000);
    let position: Position = p.h.read(p.position(alice)); assert_eq!(position.payable, 0);
    assert_eq!(p.pool_state().payable, 0);
    pay(&mut p, alice, alice_token, false);
}

#[test]
#[ignore = "requires captured devnet account fixture and local admin key"]
fn captured_live_pool_rehearsal_retires_and_automatically_pays_every_owner() {
    use anchor_lang::AccountDeserialize;
    use litesvm::LiteSVM;
    use solana_sdk::{account::Account, transaction::Transaction, signature::read_keypair_file};
    use std::str::FromStr;
    let fixture: serde_json::Value = serde_json::from_slice(&std::fs::read(std::env::var("RETIREMENT_FIXTURE").unwrap()).unwrap()).unwrap();
    let admin = read_keypair_file(std::env::var("RETIREMENT_ADMIN_KEY").unwrap()).unwrap();
    let mut svm = LiteSVM::new();
    svm.add_program(cox::ID, &std::fs::read(std::env::var("COX_PROGRAM_SO").unwrap()).unwrap());
    for item in fixture["accounts"].as_array().unwrap() {
        let hex = item["dataHex"].as_str().unwrap();
        let data = (0..hex.len()).step_by(2).map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap()).collect();
        svm.set_account(Pubkey::from_str(item["address"].as_str().unwrap()).unwrap(), Account {
            lamports: item["lamports"].as_u64().unwrap(), data,
            owner: Pubkey::from_str(item["owner"].as_str().unwrap()).unwrap(),
            executable: item["executable"].as_bool().unwrap(), rent_epoch: 0,
        }).unwrap();
    }
    svm.airdrop(&admin.pubkey(), 1_000_000_000).unwrap();
    let pool = Pubkey::from_str(fixture["pool"].as_str().unwrap()).unwrap();
    let vault = Pubkey::from_str(fixture["vault"].as_str().unwrap()).unwrap();
    let registry = Pubkey::from_str(fixture["registry"].as_str().unwrap()).unwrap();
    let before = cox::Pool::try_deserialize(&mut svm.get_account(&pool).unwrap().data.as_slice()).unwrap();
    let retirement = pda(&[b"retirement", pool.as_ref()]);
    let send = |svm: &mut LiteSVM, instructions: &[solana_sdk::instruction::Instruction]| {
        let transaction = Transaction::new_signed_with_payer(instructions, Some(&admin.pubkey()), &[&admin], svm.latest_blockhash());
        svm.send_transaction(transaction).unwrap(); svm.expire_blockhash();
    };
    send(&mut svm, &[Harness::instruction(a::Admin { admin: admin.pubkey(), registry }, i::Pause {})]);
    send(&mut svm, &[Harness::instruction(a::BeginRetirement {
        admin: admin.pubkey(), registry, pool, retirement, vault, system_program: system_program::ID,
    }, i::BeginRetirement {})]);
    let token_balance = |svm: &LiteSVM, key: Pubkey| u64::from_le_bytes(svm.get_account(&key).unwrap().data[64..72].try_into().unwrap());
    for owner in fixture["owners"].as_array().unwrap() {
        let position = Pubkey::from_str(owner["position"].as_str().unwrap()).unwrap();
        let destination = Pubkey::from_str(owner["destination"].as_str().unwrap()).unwrap();
        let amount: u64 = owner["amount"].as_str().unwrap().parse().unwrap();
        let account = Position::try_deserialize(&mut svm.get_account(&position).unwrap().data.as_slice()).unwrap();
        let mut instructions = Vec::new();
        if account.classes.iter().any(|class| class.units > 0) {
            instructions.push(Harness::instruction(a::RetirePosition { pool, retirement, position, vault }, i::RetirePosition {}));
        }
        instructions.push(Harness::instruction(a::RetirementPayout { pool, position, vault, user_token: destination,
            token_program: support::token_program() }, i::PayRetirement {}));
        let balance = token_balance(&svm, destination);
        send(&mut svm, &instructions);
        assert_eq!(token_balance(&svm, destination) - balance, amount);
        let account = Position::try_deserialize(&mut svm.get_account(&position).unwrap().data.as_slice()).unwrap();
        assert_eq!(account.payable, 0); assert_eq!(account.refundable, 0);
        assert!(account.classes.iter().all(|class| class.units == 0 && class.locked == 0));
    }
    let after = cox::Pool::try_deserialize(&mut svm.get_account(&pool).unwrap().data.as_slice()).unwrap();
    assert_eq!(after.sequence, before.sequence); assert_eq!(after.state_digest, before.state_digest);
    assert_eq!(after.active, 0); assert_eq!(after.payable, 0); assert_eq!(after.pending, 0);
    assert_eq!(after.fees, fixture["expectedFees"].as_str().unwrap().parse::<u64>().unwrap());
    assert_eq!(after.residual, fixture["expectedResidual"].as_str().unwrap().parse::<u64>().unwrap());
    assert_eq!(token_balance(&svm, vault), after.fees + after.residual);
}

#[test]
fn retirement_materializes_finalized_credits_preserves_obligations_and_unlocks_requests() {
    let mut p = PoolHarness::new(2);
    migrate(&mut p);
    let alice = p.h.alice.pubkey();
    let bob = p.h.bob.pubkey();
    p.deposit(false, 0, 9_000_000, 0, 100, true);
    p.deposit(true, 0, 3_000_000, 0, 100, true);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.finish();
    let lazy: Position = p.h.read(p.position(bob));
    assert!(lazy.staged);
    p.h.time(ORIGIN + 61);
    p.redeem(false, 0, 1_000_000 * SCALE as u128, 0, 100, true);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.finish();
    p.h.time(ORIGIN + 121);
    p.redeem(false, 0, 2_000_000 * SCALE as u128, 0, 100, true);
    p.deposit(false, 1, 2_000_000, 0, 100, true);
    p.pause(true);
    let before = p.pool_state();
    begin(&mut p, false, true);
    let frozen: Retirement = p.h.read(pda(&[b"retirement", p.pool.as_ref()]));
    assert_eq!(frozen.sequence, before.sequence);
    assert_eq!(frozen.state_digest, before.state_digest);
    assert_eq!(frozen.classes[0].backing, before.classes[0].backing);
    retire(&mut p, alice, false);
    release(&mut p, 3, true);
    release(&mut p, 3, false);
    release(&mut p, 4, true);
    retire(&mut p, bob, true);
    retire(&mut p, alice, true);
    retire(&mut p, alice, false);
    let retired = p.pool_state();
    assert_eq!(retired.active, 0);
    assert_eq!(retired.payable, 12_000_000);
    assert_eq!(retired.pending, 2_000_000);
    assert_eq!(retired.fees, before.fees);
    assert!(retired.classes.iter().all(|c| c.units == 0 && c.backing == 0));
    let alice_position: Position = p.h.read(p.position(alice));
    assert_eq!(alice_position.payable, 9_000_000);
    assert_eq!(alice_position.refundable, 2_000_000);
    p.h.time(ORIGIN + 60 * 1000);
    p.withdraw(false, 9_000_000, true);
    p.withdraw(true, 3_000_000, true);
    p.refund(4, false, true);
    p.refund(4, false, false);
    p.pause(false);
    p.deposit(false, 0, 1_000_000, 0, 2000, false);
    p.try_publish(1000, vec![200_000_000; 2], false);
    begin(&mut p, false, false);
    assert_eq!(p.pool_state().schema_version, 3);
}

#[test]
fn retirement_requires_admin_pause_and_completed_accepted_batch() {
    let mut p = PoolHarness::new(2);
    migrate(&mut p);
    begin(&mut p, false, false);
    p.pause(true);
    begin(&mut p, true, false);
    p.pause(false);
    p.deposit(false, 0, 1_000_000, 0, 100, true);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.pause(true);
    begin(&mut p, false, false);
    assert_eq!(p.pool_state().schema_version, 2);
    p.pause(false);
    p.finish();
    p.pause(true);
    begin(&mut p, false, true);
}

#[test]
fn retirement_preserves_committed_fees_and_refunds_full_unexecuted_deposits() {
    let mut p = PoolHarness::new(2);
    migrate(&mut p);
    let admin = p.h.admin.insecure_clone();
    p.h.send("schedule_fees", &[Harness::instruction(a::ManageFees {
        admin: admin.pubkey(), registry: p.registry, pool: p.pool, vault: p.vault,
    }, i::ScheduleFees { bps: 2, cap: 2_000_000, activation_cutoff: ORIGIN + 60 })], &[&admin], true);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.finish();
    let alice = p.h.alice.insecure_clone();
    p.h.time(ORIGIN + 61);
    let accounts = p.submit_accounts(alice.pubkey(), p.h.alice_token);
    p.h.send("deposit_with_fee", &[Harness::instruction(accounts, i::DepositWithFee {
        to: 0, amount: 5_000_000, minimum_units: 0, expiry: 100, expected_fee_version: 1,
    })], &[&alice], true);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.finish();
    p.h.time(ORIGIN + 121);
    let accounts = p.submit_accounts(alice.pubkey(), p.h.alice_token);
    p.h.send("deposit_with_fee", &[Harness::instruction(accounts, i::DepositWithFee {
        to: 1, amount: 5_000_000, minimum_units: 0, expiry: 100, expected_fee_version: 1,
    })], &[&alice], true);
    p.pause(true);
    begin(&mut p, false, true);
    retire(&mut p, alice.pubkey(), true);
    release(&mut p, 1, true);
    let state = p.pool_state();
    assert_eq!(state.fees, 1_000);
    assert_eq!(state.payable, 4_999_000);
    assert_eq!(state.pending, 5_000_000);
    p.refund(1, false, true);
    p.withdraw(false, 4_999_000, true);
    assert_eq!(p.pool_state().fees, 1_000);
    assert_eq!(p.h.token_balance(p.vault), 1_000 + p.pool_state().residual);
    p.h.send("migrate_pool", &[Harness::instruction(a::MigratePool {
        admin: admin.pubkey(), registry: p.registry, pool: p.pool, vault: p.vault,
    }, i::MigratePool {})], &[&admin], false);
}

#[test]
fn retirement_uses_frozen_class_prices_independent_of_processing_order_and_restart() {
    for reverse in [false, true] {
        let mut p = PoolHarness::new(2);
        migrate(&mut p);
        let alice = p.h.alice.pubkey();
        let bob = p.h.bob.pubkey();
        p.deposit(false, 0, 1, 0, 100, true);
        p.deposit(true, 0, 2, 0, 100, true);
        p.deposit(false, 1, 3, 0, 100, true);
        p.h.time(ORIGIN + 60);
        p.publish(1, vec![100_000_000; 2]);
        p.finish();
        p.h.time(ORIGIN + 120);
        p.publish(2, vec![300_000_000, 100_000_000]);
        p.finish();
        assert_eq!(p.pool_state().classes[0].backing, 4);
        assert_eq!(p.pool_state().classes[1].backing, 1);
        p.pause(true);
        begin(&mut p, false, true);
        let owners = if reverse { [bob, alice] } else { [alice, bob] };
        retire(&mut p, owners[0], true);
        p.h.restart();
        retire(&mut p, owners[1], true);
        let alice_position: Position = p.h.read(p.position(alice));
        let bob_position: Position = p.h.read(p.position(bob));
        assert_eq!(alice_position.payable, 2);
        assert_eq!(bob_position.payable, 2);
        assert_eq!(p.pool_state().residual, 2);
        assert_eq!(p.pool_state().active, 0);
    }
}
