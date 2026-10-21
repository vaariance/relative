mod support;

use anchor_lang::AccountSerialize;
use cox::{accounts as a, instruction as i, Request};
use cox_math::SCALE;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
};
use support::{protocol::PoolHarness, token_program, Harness, COLLATERAL, ORIGIN};

fn manage(p: &PoolHarness, admin: Pubkey) -> a::ManageFees {
    a::ManageFees {
        admin,
        registry: p.registry,
        pool: p.pool,
        vault: p.vault,
    }
}

fn migrate(p: &mut PoolHarness, success: bool) {
    let admin = p.h.admin.insecure_clone();
    p.h.send(
        "migrate_pool",
        &[Harness::instruction(
            manage(p, admin.pubkey()),
            i::MigratePool {},
        )],
        &[&admin],
        success,
    );
    p.assert_vault();
}

fn schedule(p: &mut PoolHarness, bps: u16, cap: u64, activation_cutoff: u64, success: bool) {
    let admin = p.h.admin.insecure_clone();
    p.h.send(
        "schedule_fees",
        &[Harness::instruction(
            manage(p, admin.pubkey()),
            i::ScheduleFees {
                bps,
                cap,
                activation_cutoff,
            },
        )],
        &[&admin],
        success,
    );
    p.assert_vault();
}

fn cancel_schedule(p: &mut PoolHarness, success: bool) {
    let admin = p.h.admin.insecure_clone();
    p.h.send(
        "cancel_fees",
        &[Harness::instruction(
            manage(p, admin.pubkey()),
            i::CancelFees {},
        )],
        &[&admin],
        success,
    );
    p.assert_vault();
}

fn enabled() -> PoolHarness {
    let mut p = PoolHarness::new(2);
    p.pause(true);
    migrate(&mut p, true);
    schedule(&mut p, 2, 2_000_000, ORIGIN + 60, true);
    p.pause(false);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    assert_eq!(p.pool_state().fee_version, 0);
    p.finish();
    assert_eq!(p.pool_state().fee_version, 1);
    assert_eq!(p.pool_state().fee_bps, 2);
    p
}

fn deposit(
    p: &mut PoolHarness,
    bob: bool,
    to: u8,
    amount: u64,
    minimum_units: u128,
    expiry: u64,
    version: u64,
    success: bool,
) -> Pubkey {
    let owner = if bob {
        p.h.bob.insecure_clone()
    } else {
        p.h.alice.insecure_clone()
    };
    let token = if bob { p.h.bob_token } else { p.h.alice_token };
    let accounts = p.submit_accounts(owner.pubkey(), token);
    let request = accounts.request;
    p.h.send(
        "deposit_with_fee",
        &[Harness::instruction(
            accounts,
            i::DepositWithFee {
                to,
                amount,
                minimum_units,
                expiry,
                expected_fee_version: version,
            },
        )],
        &[&owner],
        success,
    );
    p.assert_vault();
    request
}

fn switch(
    p: &mut PoolHarness,
    from: u8,
    to: u8,
    units: u128,
    minimum_units: u128,
    expiry: u64,
    version: u64,
    success: bool,
) -> Pubkey {
    let owner = p.h.alice.insecure_clone();
    let accounts = p.submit_accounts(owner.pubkey(), p.h.alice_token);
    let request = accounts.request;
    p.h.send(
        "switch_with_fee",
        &[Harness::instruction(
            accounts,
            i::SwitchWithFee {
                from,
                to,
                units,
                minimum_units,
                expiry,
                expected_fee_version: version,
            },
        )],
        &[&owner],
        success,
    );
    p.assert_vault();
    request
}

fn redeem(
    p: &mut PoolHarness,
    from: u8,
    units: u128,
    minimum_proceeds: u64,
    expiry: u64,
    version: u64,
    success: bool,
) -> Pubkey {
    let owner = p.h.alice.insecure_clone();
    let accounts = p.submit_accounts(owner.pubkey(), p.h.alice_token);
    let request = accounts.request;
    p.h.send(
        "redeem_with_fee",
        &[Harness::instruction(
            accounts,
            i::RedeemWithFee {
                from,
                units,
                minimum_proceeds,
                expiry,
                expected_fee_version: version,
            },
        )],
        &[&owner],
        success,
    );
    p.assert_vault();
    request
}

fn treasury(p: &mut PoolHarness) -> Pubkey {
    let token = Keypair::new();
    let admin = p.h.admin.insecure_clone();
    let mut initialize = vec![18];
    initialize.extend(admin.pubkey().to_bytes());
    p.h.send(
        "create_treasury",
        &[
            system_instruction::create_account(
                &admin.pubkey(),
                &token.pubkey(),
                p.h.svm.minimum_balance_for_rent_exemption(165),
                165,
                &token_program(),
            ),
            Instruction {
                program_id: token_program(),
                accounts: vec![
                    AccountMeta::new(token.pubkey(), false),
                    AccountMeta::new_readonly(p.h.mint, false),
                ],
                data: initialize,
            },
        ],
        &[&admin, &token],
        true,
    );
    token.pubkey()
}

fn withdraw_fees(p: &mut PoolHarness, token: Pubkey, amount: u64, runtime: bool, success: bool) {
    let signer = if runtime {
        p.h.runtime.insecure_clone()
    } else {
        p.h.admin.insecure_clone()
    };
    p.h.send(
        "withdraw_fees",
        &[Harness::instruction(
            a::WithdrawFees { test_vault: None,
                admin: signer.pubkey(),
                registry: p.registry,
                pool: p.pool,
                vault: p.vault,
                treasury_token: token,
                token_program: token_program(),
            },
            i::WithdrawFees { amount },
        )],
        &[&signer],
        success,
    );
    p.assert_vault();
}

#[test]
fn revenue_full_journey_commits_fees_once_and_preserves_custody() {
    let mut p = enabled();
    let treasury = treasury(&mut p);
    p.h.time(ORIGIN + 61);
    let request = deposit(&mut p, false, 2, 100_000_000, 0, 20, 1, true);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.evaluate(0, true);
    p.evaluate(0, false);
    p.seal_evaluation();
    p.execute(0, true);
    p.execute(0, false);
    assert_eq!(p.pool_state().fees, 0);
    withdraw_fees(&mut p, treasury, 1, false, false);
    p.h.restart();
    p.finalize();
    let receipt: Request = p.h.read(request);
    assert_eq!(receipt.fee, 20_000);
    assert_eq!(receipt.gross, 100_000_000);
    assert_eq!(receipt.fee_version, 1);
    let mut receipt_preimage = cox_math::digest("COX/RECEIPTS/V2", &[]).unwrap().to_vec();
    receipt_preimage.extend(request.to_bytes());
    receipt_preimage.push(0);
    receipt_preimage.extend(receipt.minted.to_le_bytes());
    receipt_preimage.extend(0u64.to_le_bytes());
    receipt_preimage.extend(100_000_000u64.to_le_bytes());
    receipt_preimage.extend(20_000u64.to_le_bytes());
    receipt_preimage.extend(1u64.to_le_bytes());
    receipt_preimage.extend(2u16.to_le_bytes());
    receipt_preimage.extend(2_000_000u64.to_le_bytes());
    let completed: cox::Batch = p.h.read(support::pda(&[b"batch", p.pool.as_ref()]));
    assert_eq!(
        completed.receipt_root,
        cox_math::artifact_digest(&receipt_preimage)
    );
    assert_eq!(completed.schema_version, 3);
    assert_eq!(p.pool_state().fees, 20_000);
    let units = 99_980_000u128 * SCALE as u128;
    assert_eq!(p.materialize(p.h.alice.pubkey()).classes[2].units, units);
    p.h.time(ORIGIN + 121);
    let switched = switch(&mut p, 2, 0, units, 0, 20, 1, true);
    p.h.time(ORIGIN + 180);
    p.publish(3, vec![100_000_000; 2]);
    p.finish();
    let receipt: Request = p.h.read(switched);
    assert_eq!(receipt.gross, 99_980_000);
    assert_eq!(receipt.fee, 19_996);
    assert_eq!(receipt.minted, 99_960_004u128 * SCALE as u128);
    p.h.time(ORIGIN + 181);
    let redeemed = redeem(&mut p, 0, receipt.minted, 99_940_012, 20, 1, true);
    p.h.time(ORIGIN + 240);
    p.publish(4, vec![100_000_000; 2]);
    p.finish();
    let receipt: Request = p.h.read(redeemed);
    assert_eq!(receipt.gross, 99_960_004);
    assert_eq!(receipt.fee, 19_992);
    assert_eq!(receipt.proceeds, 99_940_012);
    assert_eq!(p.pool_state().fees, 59_988);
    p.withdraw(false, receipt.proceeds, true);
    p.pause(true);
    let foreign_treasury = p.h.alice_token;
    withdraw_fees(&mut p, foreign_treasury, 1, false, false);
    withdraw_fees(&mut p, treasury, 1, true, false);
    withdraw_fees(&mut p, treasury, 59_989, false, false);
    withdraw_fees(&mut p, treasury, 59_988, false, true);
    withdraw_fees(&mut p, treasury, 1, false, false);
    assert_eq!(p.h.token_balance(treasury), 59_988);
    assert_eq!(p.h.token_balance(p.h.alice_token), COLLATERAL - 59_988);
    assert_eq!(p.h.token_balance(p.vault), 0);
}

#[test]
fn fee_version_races_and_rejections_do_not_charge_or_move_tokens() {
    let mut p = enabled();
    p.h.time(ORIGIN + 61);
    let before = p.h.token_balance(p.h.alice_token);
    deposit(&mut p, false, 2, 100_000_000, 0, 20, 0, false);
    assert_eq!(p.pool_state().next_request_nonce, 0);
    assert_eq!(p.h.token_balance(p.h.alice_token), before);
    p.deposit(false, 2, 100_000_000, 0, 20, false);
    deposit(
        &mut p,
        false,
        2,
        100_000_000,
        100_000_000u128 * SCALE as u128,
        20,
        1,
        true,
    );
    deposit(&mut p, true, 2, 10_000_000, 0, 2, 1, true);
    deposit(&mut p, false, 2, 20_000_000, 0, 20, 1, true);
    p.cancel(2, false, true);
    p.refund(2, false, true);
    p.h.time(ORIGIN + 180);
    p.publish(3, vec![100_000_000; 2]);
    p.finish();
    for nonce in [0, 1, 2] {
        let receipt: Request = p.h.read(p.request(nonce));
        assert_eq!(receipt.fee, 0);
        assert_eq!(receipt.minted, 0);
    }
    assert_eq!(p.pool_state().fees, 0);
    p.refund(0, false, true);
    p.refund(1, true, true);
    assert_eq!(p.h.token_balance(p.h.alice_token), before);
    assert_eq!(p.pool_state().pending, 0);
}

#[test]
fn configuration_requires_notice_and_activates_only_after_publication_finalizes() {
    let mut p = enabled();
    p.h.time(ORIGIN + 61);
    schedule(&mut p, 101, 2_000_000, ORIGIN + 86_520, false);
    schedule(&mut p, 2, 2_000_001, ORIGIN + 86_520, false);
    schedule(&mut p, 3, 2_000_000, ORIGIN + 120, false);
    schedule(&mut p, 3, 2_000_000, ORIGIN + 86_520, true);
    let pending = p.pool_state().fee_pending_version;
    deposit(&mut p, false, 2, 100_000_000, 0, 2000, 1, true);
    p.h.time(ORIGIN + 86_520);
    p.publish(1442, vec![100_000_000; 2]);
    assert_eq!(p.pool_state().fee_version, 1);
    cancel_schedule(&mut p, false);
    schedule(&mut p, 4, 2_000_000, ORIGIN + 172_920, false);
    p.finish();
    assert_eq!(p.pool_state().fee_version, pending);
    assert_eq!(p.pool_state().fee_bps, 3);
    assert_eq!(p.h.read::<Request>(p.request(0)).fee, 20_000);
    assert_eq!(p.h.read::<Request>(p.request(0)).fee_version, 1);
    deposit(&mut p, true, 2, 10_000_000, 0, 2000, 1, false);
    deposit(&mut p, true, 2, 10_000_000, 0, 2000, pending, true);
    schedule(&mut p, 4, 2_000_000, ORIGIN + 172_920, true);
    cancel_schedule(&mut p, true);
    cancel_schedule(&mut p, false);
    p.h.time(ORIGIN + 86_581);
    schedule(&mut p, 4, 2_000_000, ORIGIN + 172_920, false);
    schedule(&mut p, 4, 2_000_000, ORIGIN + 173_040, true);
}

#[test]
fn migration_preserves_legacy_positions_payables_requests_and_history() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 2, 100_000_000, 0, 20, true);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.finish();
    p.materialize(p.h.alice.pubkey());
    p.h.time(ORIGIN + 61);
    p.redeem(false, 2, 10_000_000u128 * SCALE as u128, 0, 20, true);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.finish();
    p.h.time(ORIGIN + 121);
    let queued = p.deposit(false, 2, 20_000_000, 0, 20, true);
    let pool_before = p.pool_state();
    let history_key = support::pda(&[b"publication", p.pool.as_ref()]);
    let history = p.h.svm.get_account(&history_key).unwrap();
    migrate(&mut p, false);
    let mut legacy_pool_bytes = Vec::new();
    pool_before.try_serialize(&mut legacy_pool_bytes).unwrap();
    legacy_pool_bytes.truncate(legacy_pool_bytes.len() - 72);
    let mut legacy_pool_account = p.h.svm.get_account(&p.pool).unwrap();
    legacy_pool_account.data[legacy_pool_bytes.len()..].fill(255);
    legacy_pool_account.data[..legacy_pool_bytes.len()].copy_from_slice(&legacy_pool_bytes);
    p.h.svm.set_account(p.pool, legacy_pool_account).unwrap();
    p.pause(true);
    migrate(&mut p, true);
    migrate(&mut p, false);
    assert_eq!(p.pool_state().active, pool_before.active);
    assert_eq!(p.pool_state().pending, pool_before.pending);
    assert_eq!(p.pool_state().payable, pool_before.payable);
    assert_eq!(p.pool_state().state_digest, pool_before.state_digest);
    assert_eq!(
        p.h.svm.get_account(&history_key).unwrap().data,
        history.data
    );
    let mut legacy = p.h.read::<Request>(queued);
    assert_eq!(legacy.schema_version, 1);
    legacy.fee_version = 0;
    let mut bytes = vec![];
    legacy.try_serialize(&mut bytes).unwrap();
    let mut account = p.h.svm.get_account(&queued).unwrap();
    account.data[..bytes.len()].copy_from_slice(&bytes);
    p.h.svm.set_account(queued, account).unwrap();
    schedule(&mut p, 2, 2_000_000, ORIGIN + 180, true);
    p.pause(false);
    p.h.time(ORIGIN + 180);
    p.publish(3, vec![100_000_000; 2]);
    p.finish();
    assert_eq!(p.h.read::<Request>(queued).fee, 0);
    assert_eq!(p.pool_state().fees, 0);
    assert_eq!(p.pool_state().active, 110_000_000);
    p.withdraw(false, 10_000_000, true);
    p.assert_owners(&[p.h.alice.pubkey()]);
}

#[test]
fn fee_cap_dust_rounding_and_concurrent_committed_treasury_withdrawal() {
    let mut p = enabled();
    let treasury = treasury(&mut p);
    let bob = p.h.bob.insecure_clone();
    p.h.transfer(p.h.bob_token, p.h.alice_token, 1_000_000_000, &bob);
    p.h.time(ORIGIN + 61);
    deposit(&mut p, false, 2, 11_000_000_000, 0, 20, 1, true);
    deposit(&mut p, true, 2, 4_999, 0, 20, 1, true);
    deposit(&mut p, true, 2, 5_000, 0, 20, 1, true);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.finish();
    assert_eq!(p.h.read::<Request>(p.request(0)).fee, 2_000_000);
    assert_eq!(p.h.read::<Request>(p.request(1)).fee, 0);
    assert_eq!(p.h.read::<Request>(p.request(2)).fee, 1);
    assert_eq!(p.h.svm.get_account(&p.request(0)).unwrap().data.len(), 320);
    assert_eq!(p.pool_state().fees, 2_000_001);
    p.h.time(ORIGIN + 121);
    deposit(&mut p, true, 2, 10_000_000, 0, 20, 1, true);
    p.h.time(ORIGIN + 180);
    p.publish(3, vec![100_000_000; 2]);
    p.evaluate(3, true);
    p.seal_evaluation();
    p.execute(3, true);
    withdraw_fees(&mut p, treasury, 2_000_002, false, false);
    withdraw_fees(&mut p, treasury, 2_000_001, false, true);
    assert_eq!(p.pool_state().fees, 0);
    deposit(&mut p, true, 2, 5_000_000, 0, 20, 1, true);
    p.finalize();
    assert_eq!(p.pool_state().fees, 2_000);
    assert_eq!(p.pool_state().pending, 5_000_000);
    assert_eq!(p.h.token_balance(treasury), 2_000_001);
}

#[test]
fn fee_aggregate_capacity_rejection_returns_all_reservations_without_fees() {
    let mut p = enabled();
    p.h.time(ORIGIN + 61);
    deposit(&mut p, false, 0, 100_000_000, 0, 20, 1, true);
    deposit(&mut p, true, 1, 100_000_000, 0, 20, 1, true);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.finish();
    let fees_before = p.pool_state().fees;
    p.h.time(ORIGIN + 121);
    deposit(&mut p, false, 0, 1_000_000, 0, 20, 1, true);
    deposit(&mut p, true, 0, 1_000_000, 0, 20, 1, true);
    p.h.time(ORIGIN + 180);
    p.publish(3, vec![100, 100_000_000]);
    let fixed = p.batch_state().fixed;
    let individual = 999_800u128 * fixed[0].units / fixed[0].backing as u128;
    assert!(fixed[0].units + individual <= cox::UNIT_LIMIT);
    assert!(fixed[0].units + 2 * individual > cox::UNIT_LIMIT);
    p.finish();
    for nonce in [2, 3] {
        let request: Request = p.h.read(p.request(nonce));
        assert_eq!(request.receipt_status, 4);
        assert_eq!(request.fee, 0);
        assert_eq!(request.minted, 0);
    }
    assert_eq!(p.pool_state().fees, fees_before);
    p.refund(2, false, true);
    p.refund(3, true, true);
    assert_eq!(p.pool_state().pending, 0);
}

#[test]
fn public_v2_state_vector_matches_program_encoder_and_legacy_predecessor() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/fee-state-vectors.json")).unwrap();
    let s = &vectors["state"];
    let number = |value: &serde_json::Value| value.as_str().unwrap().parse::<u64>().unwrap();
    let hash = |value: &serde_json::Value| -> [u8; 32] {
        let hex = value.as_str().unwrap();
        std::array::from_fn(|index| u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap())
    };
    let p = PoolHarness::new(2);
    let mut pool = p.pool_state();
    let mut batch: cox::Batch = p.h.read(support::pda(&[b"batch", p.pool.as_ref()]));
    pool.schema_version = 2;
    pool.last_prices = s["prices"].as_array().unwrap().iter().map(number).collect();
    pool.references = s["references"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap().parse().unwrap())
        .collect();
    pool.active = number(&s["active"]);
    pool.pending = number(&s["pending"]);
    pool.payable = number(&s["payable"]);
    pool.residual = number(&s["residual"]);
    let f = &s["feeState"];
    pool.fees = number(&f["fees"]);
    pool.fee_version = number(&f["feeVersion"]);
    pool.fee_bps = f["feeBps"].as_u64().unwrap() as u16;
    pool.fee_cap = number(&f["feeCap"]);
    pool.fee_next_version = number(&f["feeNextVersion"]);
    pool.fee_pending = f["feePending"].as_bool().unwrap();
    pool.fee_pending_version = number(&f["feePendingVersion"]);
    pool.fee_pending_bps = f["feePendingBps"].as_u64().unwrap() as u16;
    pool.fee_pending_cap = number(&f["feePendingCap"]);
    pool.fee_pending_cutoff = number(&f["feePendingCutoff"]);
    pool.fee_initial_scheduled = f["feeInitialScheduled"].as_bool().unwrap();
    batch.fees = number(&f["batchFees"]);
    batch.sequence = number(&s["sequence"]);
    batch.batch_id = number(&s["batch"]);
    batch.cutoff = number(&s["cutoff"]);
    batch.predecessor_digest = hash(&s["previousState"]);
    batch.snapshot_digest = hash(&s["snapshot"]);
    batch.benchmark = s["benchmark"].as_str().unwrap().parse().unwrap();
    batch.executed = s["executed"].as_u64().unwrap() as u32;
    batch.rejected = s["rejected"].as_u64().unwrap() as u32;
    batch.receipt_root = hash(&s["receiptRoot"]);
    let classes = s["classes"].as_array().unwrap();
    let before: Vec<cox::Class> = classes
        .iter()
        .map(|c| cox::Class {
            backing: number(&c["preBacking"]),
            units: c["preUnits"].as_str().unwrap().parse().unwrap(),
        })
        .collect();
    pool.classes = classes
        .iter()
        .map(|c| cox::Class {
            backing: number(&c["postBacking"]),
            units: c["postUnits"].as_str().unwrap().parse().unwrap(),
        })
        .collect();
    let bytes = cox::state_bytes(
        &Pubkey::new_from_array(hash(&s["program"])),
        &Pubkey::new_from_array(hash(&s["pool"])),
        &pool,
        &before,
        &batch,
        &hash(&s["manifest"]),
    )
    .unwrap();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, vectors["stateBytes"].as_str().unwrap());
    assert_eq!(
        cox_math::artifact_digest(&bytes),
        hash(&vectors["stateDigest"])
    );
}

#[test]
fn zero_rate_or_zero_cap_disables_fees_without_reusing_versions() {
    let mut p = enabled();
    p.h.time(ORIGIN + 61);
    schedule(&mut p, 100, 0, ORIGIN + 86_520, true);
    p.h.time(ORIGIN + 86_520);
    p.publish(1442, vec![100_000_000; 2]);
    p.finish();
    let version = p.pool_state().fee_version;
    deposit(&mut p, false, 2, 100_000_000, 0, 4000, version, true);
    p.h.time(ORIGIN + 86_580);
    p.publish(1443, vec![100_000_000; 2]);
    p.finish();
    assert_eq!(p.h.read::<Request>(p.request(0)).fee, 0);
    assert_eq!(p.pool_state().fees, 0);
    schedule(&mut p, 0, 2_000_000, ORIGIN + 172_980, true);
    p.h.time(ORIGIN + 172_980);
    p.publish(2883, vec![100_000_000; 2]);
    p.finish();
    assert!(p.pool_state().fee_version > version);
    let version = p.pool_state().fee_version;
    deposit(&mut p, true, 2, 100_000_000, 0, 4000, version, true);
    p.h.time(ORIGIN + 173_040);
    p.publish(2884, vec![100_000_000; 2]);
    p.finish();
    assert_eq!(p.h.read::<Request>(p.request(1)).fee, 0);
    assert_eq!(p.pool_state().fees, 0);
}

#[test]
fn initial_schedule_cancellation_consumes_notice_exception_and_runtime_is_not_admin() {
    let mut p = PoolHarness::new(2);
    p.pause(true);
    migrate(&mut p, true);
    schedule(&mut p, 2, 2_000_000, ORIGIN + 60, true);
    cancel_schedule(&mut p, true);
    schedule(&mut p, 2, 2_000_000, ORIGIN + 60, false);
    schedule(&mut p, 2, 2_000_000, ORIGIN + 86_400, true);
    let runtime = p.h.runtime.insecure_clone();
    p.h.send(
        "runtime_cannot_schedule_fees",
        &[Harness::instruction(
            manage(&p, runtime.pubkey()),
            i::ScheduleFees {
                bps: 3,
                cap: 2_000_000,
                activation_cutoff: ORIGIN + 86_460,
            },
        )],
        &[&runtime],
        false,
    );
    p.pause(false);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.pause(true);
    migrate(&mut p, false);
    p.pause(false);
    p.finish();
    assert_eq!(p.pool_state().fee_version, 0);
}

#[test]
fn net_minimum_failure_on_redeem_and_switch_unlocks_units_without_fees() {
    let mut p = enabled();
    p.h.time(ORIGIN + 61);
    deposit(&mut p, false, 2, 100_000_000, 0, 20, 1, true);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.finish();
    let units = 99_980_000u128 * SCALE as u128;
    p.h.time(ORIGIN + 121);
    redeem(&mut p, 2, units, 99_980_000, 20, 1, true);
    p.h.time(ORIGIN + 180);
    p.publish(3, vec![100_000_000; 2]);
    p.finish();
    assert_eq!(p.h.read::<Request>(p.request(1)).fee, 0);
    assert_eq!(p.pool_state().payable, 0);
    let position = p.materialize(p.h.alice.pubkey());
    assert_eq!(position.classes[2].units, units);
    assert_eq!(position.classes[2].locked, 0);
    p.h.time(ORIGIN + 181);
    switch(&mut p, 2, 0, units, units, 20, 1, true);
    p.h.time(ORIGIN + 240);
    p.publish(4, vec![100_000_000; 2]);
    p.finish();
    assert_eq!(p.h.read::<Request>(p.request(2)).fee, 0);
    assert_eq!(p.pool_state().fees, 20_000);
    let position = p.materialize(p.h.alice.pubkey());
    assert_eq!(position.classes[2].units, units);
    assert_eq!(position.classes[2].locked, 0);
    assert_eq!(position.classes[0].units, 0);
}

#[test]
fn migration_waits_for_accepted_legacy_batch_and_preserves_its_requests() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 2, 100_000_000, 0, 20, true);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    let accepted = p.batch();
    p.pause(true);
    migrate(&mut p, false);
    assert_eq!(p.pool_state().stage, Some(accepted));
    assert_eq!(p.pool_state().schema_version, 1);
    p.pause(false);
    p.finish();
    p.pause(true);
    migrate(&mut p, true);
    assert_eq!(p.pool_state().active, 100_000_000);
    assert_eq!(p.h.read::<Request>(p.request(0)).fee, 0);
    assert_eq!(p.pool_state().fees, 0);
}

#[test]
fn delayed_fee_batch_preserves_accepted_expiry_and_snapshot_after_restart() {
    let mut p = enabled();
    p.h.time(ORIGIN + 61);
    deposit(&mut p, false, 2, 100_000_000, 0, 2, 1, true);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.evaluate(0, true);
    p.seal_evaluation();
    p.h.time(ORIGIN + 600);
    p.pause(true);
    p.execute(0, false);
    p.h.restart();
    p.pause(false);
    p.execute(0, true);
    p.finalize();
    let request: Request = p.h.read(p.request(0));
    assert_eq!(request.receipt_status, 0);
    assert_eq!(request.fee, 20_000);
    assert_eq!(request.gross, 100_000_000);
    assert_eq!(p.pool_state().last_batch, 2);
    assert_eq!(p.pool_state().fees, 20_000);
}

#[test]
fn thirty_asset_revenue_publication_and_execution_measurements() {
    let started = std::time::Instant::now();
    let mut p = PoolHarness::new(30);
    p.pause(true);
    migrate(&mut p, true);
    schedule(&mut p, 2, 2_000_000, ORIGIN + 60, true);
    p.pause(false);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 30]);
    p.finish();
    p.h.time(ORIGIN + 61);
    for class in 0..31 {
        deposit(&mut p, class % 2 == 1, class, 1_000_000, 0, 20, 1, true);
    }
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 30]);
    p.finish();
    assert_eq!(p.pool_state().fees, 6_200);
    assert_eq!(p.pool_state().active, 30_993_800);
    p.assert_owners(&[p.h.alice.pubkey(), p.h.bob.pubkey()]);
    if let Ok(path) = std::env::var("COX_REVENUE_MEASUREMENTS_PATH") {
        p.h.write_measurements(
            std::path::Path::new(&path),
            31,
            started.elapsed().as_micros(),
        );
    }
    if let Ok(path) = std::env::var("COX_REVENUE_ACCOUNT_FIXTURES_PATH") {
        p.h.write_accounts(
            std::path::Path::new(&path),
            &[
                ("registry", p.registry),
                ("methodology", p.methodology),
                ("pool", p.pool),
                ("position", p.position(p.h.alice.pubkey())),
                ("request", p.request(0)),
                ("batch", support::pda(&[b"batch", p.pool.as_ref()])),
                (
                    "publication",
                    support::pda(&[b"publication", p.pool.as_ref()]),
                ),
            ],
        );
    }
}
