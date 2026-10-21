mod support;

use support::{Harness, COLLATERAL};

#[test]
fn test_collateral_uses_real_classic_spl_transfers() {
    let mut h = Harness::new();
    let alice = h.alice.insecure_clone();
    h.transfer(h.alice_token, h.bob_token, 1_234_567, &alice);
    assert_eq!(h.token_balance(h.alice_token), COLLATERAL - 1_234_567);
    assert_eq!(h.token_balance(h.bob_token), COLLATERAL + 1_234_567);
}

use anchor_lang::AccountSerialize;
use cox::{accounts as a, instruction as i, Publication, Request};
use cox_math::SCALE;
use solana_sdk::signature::Signer;
use support::{pda, protocol::PoolHarness, ORIGIN};

#[test]
fn full_trading_journey_real_custody_and_receipt_root() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    let deposit = p.deposit(false, 0, 100_000_000, 0, 20, true);
    assert_eq!(p.pool_state().pending, 100_000_000);
    assert_eq!(p.pool_state().active, 0);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.evaluate(0, true);
    p.evaluate(0, false);
    p.seal_evaluation();
    p.execute(0, true);
    p.withdraw(false, 1, false);
    p.redeem(false, 0, 1, 0, 20, false);
    assert_eq!(p.pool_state().active, 0);
    p.finalize();
    let alice = p.h.alice.pubkey();
    let position = p.materialize(alice);
    let units = 100_000_000u128 * SCALE as u128;
    assert_eq!(position.classes[0].units, units);
    assert_eq!(p.pool_state().active, 100_000_000);
    let batch = p.h.read::<cox::Batch>(pda(&[b"batch", p.pool.as_ref()]));
    let mut receipt_bytes = cox_math::digest("COX/RECEIPTS/V1", &[]).unwrap().to_vec();
    receipt_bytes.extend_from_slice(deposit.as_ref());
    receipt_bytes.push(0);
    receipt_bytes.extend_from_slice(&units.to_le_bytes());
    receipt_bytes.extend_from_slice(&0u64.to_le_bytes());
    assert_eq!(
        batch.receipt_root,
        cox_math::artifact_digest(&receipt_bytes)
    );
    let publication: Publication = p.h.read(pda(&[b"publication", p.pool.as_ref()]));
    assert_eq!(
        publication.state_digest,
        cox_math::artifact_digest(&publication.state_preimage)
    );
    assert_eq!(publication.state_digest, p.pool_state().state_digest);
    let state = p.pool_state();
    let mut encoded = Vec::new();
    let domain = b"COX/STATE/V1";
    encoded.extend_from_slice(&(domain.len() as u32).to_le_bytes());
    encoded.extend_from_slice(domain);
    encoded.extend_from_slice(cox::ID.as_ref());
    encoded.extend_from_slice(p.pool.as_ref());
    encoded.extend_from_slice(&state.sequence.to_le_bytes());
    encoded.extend_from_slice(&batch.batch_id.to_le_bytes());
    encoded.extend_from_slice(&batch.cutoff.to_le_bytes());
    encoded.extend_from_slice(&batch.predecessor_digest);
    encoded.extend_from_slice(&publication.manifest_digest);
    encoded.extend_from_slice(&batch.snapshot_digest);
    encoded.extend_from_slice(&state.benchmark.to_le_bytes());
    encoded.extend_from_slice(&(state.last_prices.len() as u32).to_le_bytes());
    for price in &state.last_prices {
        encoded.extend_from_slice(&price.to_le_bytes());
    }
    encoded.extend_from_slice(&(state.references.len() as u32).to_le_bytes());
    for reference in &state.references {
        encoded.extend_from_slice(&reference.to_le_bytes());
    }
    encoded.extend_from_slice(&(state.classes.len() as u32).to_le_bytes());
    for class in &state.classes {
        encoded.extend_from_slice(&0u64.to_le_bytes());
        encoded.extend_from_slice(&0u128.to_le_bytes());
        encoded.extend_from_slice(&class.backing.to_le_bytes());
        encoded.extend_from_slice(&class.units.to_le_bytes());
    }
    encoded.extend_from_slice(&batch.executed.to_le_bytes());
    encoded.extend_from_slice(&batch.rejected.to_le_bytes());
    for ledger in [state.active, state.pending, state.payable, state.residual] {
        encoded.extend_from_slice(&ledger.to_le_bytes());
    }
    encoded.extend_from_slice(&batch.receipt_root);
    assert_eq!(publication.state_preimage, encoded);
    p.h.time(ORIGIN + 61);
    p.switch(0, 1, units / 2, 0, 20, true);
    p.redeem(false, 0, units / 2 + 1, 0, 20, false);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.finish();
    let position = p.materialize(alice);
    assert_eq!(position.classes[0].units, units / 2);
    assert_eq!(position.classes[1].units, units / 2);
    p.h.time(ORIGIN + 121);
    p.redeem(false, 0, units / 2, 0, 20, true);
    p.redeem(false, 1, units / 2, 0, 20, true);
    p.h.time(ORIGIN + 180);
    p.publish(3, vec![100_000_000; 2]);
    p.finish();
    assert_eq!(p.pool_state().payable, 100_000_000);
    p.withdraw(false, 100_000_000, true);
    p.withdraw(false, 1, false);
    assert_eq!(p.h.token_balance(p.h.alice_token), COLLATERAL);
    assert_eq!(p.pool_state().active, 0);
    assert_eq!(p.pool_state().pending, 0);
    assert_eq!(p.pool_state().payable, 0);
}

#[test]
fn cancellation_owner_refund_and_expiry_release_once() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 0, 30_000_000, 0, 2, true);
    p.cancel(0, true, false);
    p.refund(0, false, false);
    p.cancel(0, false, true);
    p.refund(0, true, false);
    p.refund(0, false, true);
    p.refund(0, false, false);
    assert_eq!(p.h.token_balance(p.h.alice_token), COLLATERAL);
    p.deposit(false, 0, 20_000_000, 0, 1, true);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.cancel(1, false, false);
    p.finish();
    p.refund(1, false, true);
    let request: Request = p.h.read(p.request(1));
    assert_eq!(request.status, 6);
    assert_eq!(p.h.token_balance(p.h.alice_token), COLLATERAL);
}

#[test]
fn delayed_batch_preserves_fixed_values_pause_restart_and_future_deposit() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 0, 100_000_000, 0, 1, true);
    p.deposit(true, 1, 50_000_000, 0, 1, true);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.evaluate(0, true);
    p.evaluate(1, true);
    p.seal_evaluation();
    p.execute(0, true);
    p.h.time(ORIGIN + 125);
    p.deposit(false, 1, 10_000_000, 0, 20, true);
    assert_eq!(p.pool_state().pending, 160_000_000);
    p.try_publish(2, vec![200_000_000; 2], false);
    p.pause(true);
    p.execute(1, false);
    p.pause(false);
    p.h.restart();
    p.execute(1, true);
    p.finalize();
    assert_eq!(p.pool_state().last_batch, 1);
    assert_eq!(p.pool_state().pending, 10_000_000);
    assert_eq!(p.pool_state().active, 150_000_000);
    assert_eq!(
        p.materialize(p.h.alice.pubkey()).classes[0].units,
        100_000_000u128 * SCALE as u128
    );
    p.h.time(ORIGIN + 180);
    p.publish(3, vec![200_000_000; 2]);
    p.finish();
    assert_eq!(p.pool_state().pending, 0);
    assert_eq!(p.pool_state().active, 160_000_000);
}

#[test]
fn withdrawals_spend_only_committed_payables_during_later_batch() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 0, 100_000_000, 0, 20, true);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.finish();
    p.h.time(ORIGIN + 61);
    p.redeem(false, 0, 20_000_000u128 * SCALE as u128, 0, 20, true);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.finish();
    p.h.time(ORIGIN + 121);
    p.redeem(false, 0, 10_000_000u128 * SCALE as u128, 0, 20, true);
    p.h.time(ORIGIN + 180);
    p.publish(3, vec![100_000_000; 2]);
    p.evaluate(2, true);
    p.seal_evaluation();
    p.execute(2, true);
    p.withdraw(false, 20_000_000, true);
    p.withdraw(false, 1, false);
    p.deposit(true, 1, 5_000_000, 0, 20, true);
    p.finalize();
    assert_eq!(p.pool_state().payable, 10_000_000);
    assert_eq!(p.pool_state().pending, 5_000_000);
    p.withdraw(false, 10_000_000, true);
    assert_eq!(p.h.token_balance(p.h.alice_token), COLLATERAL - 70_000_000);
}

#[test]
fn thirty_price_publication_packet_and_compute_measurement() {
    let start = std::time::Instant::now();
    let mut p = PoolHarness::new(30);
    p.h.time(ORIGIN + 1);
    for index in 0..64 {
        p.deposit(index % 2 == 1, (index % 31) as u8, 1_000_000, 0, 20, true);
    }
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 30]);
    p.finish();
    p.assert_owners(&[p.h.alice.pubkey(), p.h.bob.pubkey()]);
    let batch_key = pda(&[b"batch", p.pool.as_ref()]);
    let publication_key = pda(&[b"publication", p.pool.as_ref()]);
    let mut batch_bytes = Vec::new();
    p.h.read::<cox::Batch>(batch_key)
        .try_serialize(&mut batch_bytes)
        .unwrap();
    let mut publication_bytes = Vec::new();
    p.h.read::<Publication>(publication_key)
        .try_serialize(&mut publication_bytes)
        .unwrap();
    assert!(batch_bytes.len() <= 8192);
    assert!(publication_bytes.len() <= 8192);
    println!(
        "30-asset serialized bytes: batch={}, publication={}; LiteSVM reserved lamports={}",
        batch_bytes.len(),
        publication_bytes.len(),
        p.h.svm.get_account(&batch_key).unwrap().lamports
            + p.h.svm.get_account(&publication_key).unwrap().lamports
    );
    let publish =
        p.h.measurements
            .iter()
            .filter(|row| row.instruction == "publish")
            .collect::<Vec<_>>();
    assert_eq!(publish.len(), 2);
    for row in publish {
        assert!(row.transaction_bytes <= 1232);
        assert!(row.compute_units <= 1_400_000);
    }
    if let Ok(path) = std::env::var("COX_MEASUREMENTS_PATH") {
        p.h.write_measurements(std::path::Path::new(&path), 64, start.elapsed().as_micros());
    }
    if let Ok(path) = std::env::var("COX_ACCOUNT_FIXTURES_PATH") {
        p.materialize(p.h.alice.pubkey());
        p.h.write_accounts(
            std::path::Path::new(&path),
            &[
                ("registry", p.registry),
                ("methodology", p.methodology),
                ("pool", p.pool),
                ("position", p.position(p.h.alice.pubkey())),
                ("request", p.request(0)),
                ("batch", pda(&[b"batch", p.pool.as_ref()])),
                ("publication", pda(&[b"publication", p.pool.as_ref()])),
            ],
        );
    }
}

#[test]
fn ownership_account_substitution_and_insufficient_reservations_reject() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    let bob = p.h.bob.insecure_clone();
    let mut accounts = p.submit_accounts(bob.pubkey(), p.h.alice_token);
    p.h.send(
        "wrong_token_owner",
        &[Harness::instruction(
            accounts,
            i::Deposit {
                to: 0,
                amount: 1_000_000,
                minimum_units: 0,
                expiry: 20,
            },
        )],
        &[&bob],
        false,
    );
    accounts = p.submit_accounts(bob.pubkey(), p.h.bob_token);
    accounts.vault = p.h.bob_token;
    p.h.send(
        "wrong_vault",
        &[Harness::instruction(
            accounts,
            i::Deposit {
                to: 0,
                amount: 1_000_000,
                minimum_units: 0,
                expiry: 20,
            },
        )],
        &[&bob],
        false,
    );
    p.deposit(false, 0, 10_000_000, 0, 20, true);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.finish();
    p.h.time(ORIGIN + 61);
    p.redeem(false, 0, 6_000_000u128 * SCALE as u128, 0, 20, true);
    p.switch(0, 1, 5_000_000u128 * SCALE as u128, 0, 20, false);
    p.assert_vault();
}

#[test]
fn surplus_is_residual_and_shortfall_fails_closed() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 0, 10_000_000, 0, 20, true);
    let alice = p.h.alice.insecure_clone();
    p.h.transfer(p.h.alice_token, p.vault, 77, &alice);
    p.deposit(false, 0, 1_000_000, 0, 20, true);
    assert_eq!(p.pool_state().residual, 77);
    let mut vault = p.h.svm.get_account(&p.vault).unwrap();
    let balance = p.h.token_balance(p.vault);
    vault.data[64..72].copy_from_slice(&(balance - 1).to_le_bytes());
    p.h.svm.set_account(p.vault, vault).unwrap();
    let accounts = p.submit_accounts(alice.pubkey(), p.h.alice_token);
    p.h.send(
        "vault_shortfall",
        &[Harness::instruction(
            accounts,
            i::Deposit {
                to: 0,
                amount: 1,
                minimum_units: 0,
                expiry: 20,
            },
        )],
        &[&alice],
        false,
    );
    assert_eq!(p.h.token_balance(p.vault), balance - 1);
}

#[test]
fn aggregate_capacity_rejects_every_incoming_trade_to_class() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 0, 100_000_000, 0, 20, true);
    p.deposit(true, 1, 100_000_000, 0, 20, true);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.finish();
    p.h.time(ORIGIN + 61);
    p.deposit(false, 0, 1_000_000, 0, 20, true);
    p.deposit(true, 0, 1_000_000, 0, 20, true);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100, 100_000_000]);
    let fixed = p.batch_state().fixed;
    assert!(fixed[0].backing > 0);
    let individual = 1_000_000u128 * fixed[0].units / fixed[0].backing as u128;
    assert!(fixed[0].units + individual <= cox::UNIT_LIMIT);
    assert!(fixed[0].units + 2 * individual > cox::UNIT_LIMIT);
    p.finish();
    for nonce in [2, 3] {
        let r: Request = p.h.read(p.request(nonce));
        assert_eq!(r.receipt_status, 4);
        assert_eq!(r.minted, 0);
    }
    assert_eq!(p.pool_state().classes[0].units, fixed[0].units);
    p.refund(2, false, true);
    p.refund(3, true, true);
    assert_eq!(p.pool_state().pending, 0);
}

#[test]
fn missed_minutes_reference_overflow_and_staleness_do_not_reprice() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 0, 10_000_000, 0, 20, true);
    p.h.time(ORIGIN + 180);
    p.publish(3, vec![100_000_000; 2]);
    p.finish();
    assert_eq!(p.pool_state().last_batch, 3);
    assert_eq!(p.pool_state().sequence, 1);
    p.h.time(ORIGIN + 240);
    p.publish(4, vec![u64::MAX, 1]);
    p.finish();
    let predecessor = p.pool_state().state_digest;
    p.h.time(ORIGIN + 300);
    p.try_publish(5, vec![1, u64::MAX], false);
    assert!(p.pool_state().stage.is_none());
    assert_eq!(p.pool_state().state_digest, predecessor);
    p.h.time(ORIGIN + 3600 + 240);
    p.deposit(false, 0, 1, 0, 100, false);
    p.withdraw(false, 1, false);
    assert_eq!(p.pool_state().state_digest, predecessor);
}

#[test]
fn refund_cannot_replay_while_another_deposit_remains_refundable() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 0, 1_000_000, u128::MAX, 20, true);
    p.deposit(false, 0, 2_000_000, u128::MAX, 20, true);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.finish();
    assert_eq!(p.materialize(p.h.alice.pubkey()).refundable, 3_000_000);
    p.refund(0, false, true);
    p.refund(0, false, false);
    assert_eq!(p.materialize(p.h.alice.pubkey()).refundable, 2_000_000);
    assert_eq!(p.pool_state().pending, 2_000_000);
    p.refund(1, false, true);
    assert_eq!(p.h.token_balance(p.h.alice_token), COLLATERAL);
}

#[test]
fn registry_bootstrap_requires_the_real_upgrade_authority() {
    let mut h = Harness::new();
    let admin = h.admin.insecure_clone();
    let attacker = h.alice.insecure_clone();
    h.send(
        "registry_bootstrap_attack",
        &[Harness::instruction(
            a::InitializeRegistry {
                admin: admin.pubkey(),
                upgrade_authority: attacker.pubkey(),
                program_account: cox::ID,
                program_data: h.program_data,
                registry: pda(&[b"registry"]),
                system_program: solana_sdk::system_program::ID,
            },
            i::InitializeRegistry {
                runtime: h.runtime.pubkey(),
            },
        )],
        &[&admin, &attacker],
        false,
    );
    assert!(h.svm.get_account(&pda(&[b"registry"])).is_none());
}

#[test]
fn permissionless_expiry_and_snapshot_deadlines() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 0, 1_000_000, 0, 1, true);
    p.h.time(ORIGIN + 116);
    p.try_publish(1, vec![100_000_000; 2], false);
    assert!(p.pool_state().stage.is_none());
    p.h.time(ORIGIN + 120);
    let bob = p.h.bob.insecure_clone();
    p.h.send(
        "expire",
        &[Harness::instruction(
            a::ManageRequest { test_vault: None,
                authority: bob.pubkey(),
                registry: p.registry,
                pool: p.pool,
                request: p.request(0),
                position: p.position(p.h.alice.pubkey()),
                vault: p.vault,
            },
            i::Expire {},
        )],
        &[&bob],
        true,
    );
    p.refund(0, false, true);
    assert_eq!(p.h.token_balance(p.h.alice_token), COLLATERAL);
    p.h.time(ORIGIN + 119);
    p.try_publish(2, vec![100_000_000; 2], false);
    assert!(p.pool_state().stage.is_none());
}

#[test]
fn wrong_mint_and_foreign_program_owned_pool_reject() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    let alice = p.h.alice.insecure_clone();
    let original = p.h.svm.get_account(&p.h.alice_token).unwrap();
    let mut changed = original.clone();
    changed.data[..32].copy_from_slice(solana_sdk::pubkey::Pubkey::new_unique().as_ref());
    p.h.svm.set_account(p.h.alice_token, changed).unwrap();
    p.h.send(
        "wrong_mint",
        &[Harness::instruction(
            p.submit_accounts(alice.pubkey(), p.h.alice_token),
            i::Deposit {
                to: 0,
                amount: 1_000_000,
                minimum_units: 0,
                expiry: 20,
            },
        )],
        &[&alice],
        false,
    );
    p.h.svm.set_account(p.h.alice_token, original).unwrap();
    let original = p.h.svm.get_account(&p.pool).unwrap();
    let mut changed = original.clone();
    changed.owner = solana_sdk::system_program::ID;
    p.h.svm.set_account(p.pool, changed).unwrap();
    let request = pda(&[b"request", p.pool.as_ref(), &0u64.to_le_bytes()]);
    p.h.send(
        "wrong_program_owner",
        &[Harness::instruction(
            a::Submit { test_vault: None,
                owner: alice.pubkey(),
                registry: p.registry,
                pool: p.pool,
                position: p.position(alice.pubkey()),
                request,
                vault: p.vault,
                user_token: p.h.alice_token,
                token_program: support::token_program(),
                system_program: solana_sdk::system_program::ID,
            },
            i::Deposit {
                to: 0,
                amount: 1_000_000,
                minimum_units: 0,
                expiry: 20,
            },
        )],
        &[&alice],
        false,
    );
    p.h.svm.set_account(p.pool, original).unwrap();
    p.assert_vault();
}

#[test]
fn future_unit_reservations_survive_current_batch_materialization() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 0, 100_000_000, 0, 20, true);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.finish();
    p.h.time(ORIGIN + 61);
    p.redeem(false, 0, 40_000_000u128 * SCALE as u128, 0, 20, true);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.evaluate(1, true);
    p.seal_evaluation();
    p.execute(1, true);
    p.h.time(ORIGIN + 121);
    p.redeem(false, 0, 30_000_000u128 * SCALE as u128, 0, 20, true);
    p.redeem(false, 0, 31_000_000u128 * SCALE as u128, 0, 20, false);
    p.finalize();
    let position = p.materialize(p.h.alice.pubkey());
    assert_eq!(position.classes[0].units, 60_000_000u128 * SCALE as u128);
    assert_eq!(position.classes[0].locked, 30_000_000u128 * SCALE as u128);
    p.h.time(ORIGIN + 180);
    p.publish(3, vec![100_000_000; 2]);
    p.finish();
    let position = p.materialize(p.h.alice.pubkey());
    assert_eq!(position.classes[0].units, 30_000_000u128 * SCALE as u128);
    assert_eq!(position.classes[0].locked, 0);
    assert_eq!(position.payable, 70_000_000);
    p.assert_owners(&[p.h.alice.pubkey()]);
}

#[test]
fn reusable_accounts_bound_rent_reset_batches_and_preserve_lazy_balances() {
    let mut p = PoolHarness::new(2);
    let batch_key = pda(&[b"batch", p.pool.as_ref()]);
    let publication_key = pda(&[b"publication", p.pool.as_ref()]);
    let initial_batch = p.h.svm.get_account(&batch_key).unwrap();
    let initial_publication = p.h.svm.get_account(&publication_key).unwrap();
    assert_eq!(initial_batch.data.len(), 8192);
    assert_eq!(initial_publication.data.len(), 8192);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 0, 10_000_000, 0, 20, true);
    p.deposit(true, 1, 2_000_000, u128::MAX, 20, true);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    let accepted = p.h.svm.get_account(&batch_key).unwrap().data;
    p.try_publish(1, vec![100_000_000; 2], false);
    assert_eq!(accepted, p.h.svm.get_account(&batch_key).unwrap().data);
    p.finish();
    let completed: cox::Batch = p.h.read(batch_key);
    assert_eq!(completed.schema_version, 2);
    assert_eq!(completed.phase, 2);
    assert_eq!(completed.accepted_deposits, 10_000_000);
    assert_eq!(completed.executed, 1);
    assert_eq!(completed.rejected, 1);
    let alice: cox::Position = p.h.read(p.position(p.h.alice.pubkey()));
    assert!(alice.staged);
    for batch_id in 2..=4 {
        p.h.time(ORIGIN + batch_id * 60);
        p.try_publish_sequence(batch_id, vec![100_000_000; 2], Some(batch_id - 1), false);
        assert!(p.pool_state().stage.is_none());
        p.publish(batch_id, vec![100_000_000; 2]);
        let reset = p.batch_state();
        assert_eq!(p.batch(), batch_key);
        assert_eq!(reset.phase, 0);
        assert_eq!(reset.accepted_deposits, 0);
        assert_eq!(reset.new_payable, 0);
        assert_eq!(reset.executed, 0);
        assert_eq!(reset.rejected, 0);
        assert!(!reset.safety_changed);
        assert!(reset.burns.iter().all(|value| *value == 0));
        assert!(reset.mints.iter().all(|value| *value == 0));
        assert!(reset.incoming.iter().all(|value| *value == 0));
        assert!(reset.blocked.iter().all(|value| !value));
        assert_eq!(
            reset.receipt_root,
            cox_math::digest("COX/RECEIPTS/V1", &[]).unwrap()
        );
        assert_eq!(
            reset.staged_root,
            cox_math::digest("COX/STAGE/V1", &[]).unwrap()
        );
        p.finish();
        let publication: Publication = p.h.read(publication_key);
        assert_eq!(publication.schema_version, 2);
        assert_eq!(publication.sequence, batch_id);
        assert_eq!(publication.state_digest, p.pool_state().state_digest);
        assert_eq!(
            publication.state_digest,
            cox_math::artifact_digest(&publication.state_preimage)
        );
        for (key, original) in [
            (batch_key, &initial_batch),
            (publication_key, &initial_publication),
        ] {
            let account = p.h.svm.get_account(&key).unwrap();
            assert_eq!(account.lamports, original.lamports);
            assert_eq!(account.data.len(), original.data.len());
        }
        assert!(p
            .h
            .svm
            .get_account(&pda(&[b"batch", p.pool.as_ref(), &batch_id.to_le_bytes()]))
            .is_none());
        assert!(p
            .h
            .svm
            .get_account(&pda(&[
                b"publication",
                p.pool.as_ref(),
                &batch_id.to_le_bytes()
            ]))
            .is_none());
    }
    assert!(
        p.h.read::<cox::Position>(p.position(p.h.alice.pubkey()))
            .staged
    );
    assert_eq!(
        p.materialize(p.h.alice.pubkey()).classes[0].units,
        10_000_000u128 * SCALE as u128
    );
    p.h.time(ORIGIN + 241);
    p.redeem(false, 0, 10_000_000u128 * SCALE as u128, 0, 20, true);
    p.h.time(ORIGIN + 300);
    p.publish(5, vec![100_000_000; 2]);
    p.finish();
    assert_eq!(p.h.read::<cox::Batch>(batch_key).new_payable, 10_000_000);
    p.h.time(ORIGIN + 360);
    p.publish(6, vec![100_000_000; 2]);
    assert_eq!(p.batch_state().new_payable, 0);
    p.finish();
    p.withdraw(false, 10_000_000, true);
    p.refund(1, true, true);
    assert_eq!(p.h.token_balance(p.h.alice_token), COLLATERAL);
    assert_eq!(p.h.token_balance(p.h.bob_token), COLLATERAL);
    assert_eq!(p.pool_state().active, 0);
    assert_eq!(p.pool_state().pending, 0);
    assert_eq!(p.pool_state().payable, 0);
    p.assert_vault();
}
