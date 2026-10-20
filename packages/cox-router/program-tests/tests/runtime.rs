#[path = "../../../cox/crates/program-tests/tests/support/mod.rs"]
mod support;

use anchor_lang::{AnchorSerialize, ToAccountMetas};
use anchor_lang::solana_program::{program_option::COption, program_pack::Pack};
use anchor_spl::token::spl_token;
use cox::Request;
use cox_router::{SwapAndDeposit, JUPITER, ROUTE, SWAP_AND_DEPOSIT};
use solana_sdk::{account::Account, instruction::{AccountMeta, Instruction}, pubkey::Pubkey, signature::Signer};
use support::{protocol::PoolHarness, Harness, ORIGIN};

fn set_token(p: &mut PoolHarness, key: Pubkey, owner: Pubkey, mint: Pubkey, amount: u64) {
    let mut data = vec![0; spl_token::state::Account::LEN];
    spl_token::state::Account::pack(spl_token::state::Account {
        mint, owner, amount, delegate: COption::None, state: spl_token::state::AccountState::Initialized,
        is_native: COption::None, delegated_amount: 0, close_authority: COption::None,
    }, &mut data).unwrap();
    p.h.svm.set_account(key, Account { lamports: 10_000_000, data, owner: spl_token::ID, executable: false, rent_epoch: 0 }).unwrap();
}

fn fixture(old_collateral: u64, minimum: u64, fee_version: u64, quoted_output: u64) -> (PoolHarness, Instruction, Pubkey, Pubkey, Pubkey, Pubkey) {
    let mut p = PoolHarness::new(2);
    let router = Pubkey::new_unique();
    p.h.svm.add_program(router, &std::fs::read(std::env::var("COX_ROUTER_SO").expect("COX_ROUTER_SO required")).unwrap());
    p.h.svm.add_program(JUPITER, &std::fs::read(std::env::var("COX_ROUTER_TEST_SWAP_SO").expect("COX_ROUTER_TEST_SWAP_SO required")).unwrap());
    let owner = p.h.alice.pubkey();
    let collateral = p.h.alice_token;
    let mint = p.h.mint;
    let input_mint = Pubkey::new_unique();
    let input = Pubkey::new_unique();
    let input_reserve = Pubkey::new_unique();
    let output_reserve = Pubkey::new_unique();
    let authority = Pubkey::find_program_address(&[b"reserve"], &JUPITER).0;
    set_token(&mut p, collateral, owner, mint, old_collateral);
    set_token(&mut p, input, owner, input_mint, 25);
    set_token(&mut p, input_reserve, authority, input_mint, 0);
    set_token(&mut p, output_reserve, authority, mint, 10_000.max(quoted_output + 13));
    let submit = p.submit_accounts(owner, collateral);
    let request = submit.request;
    let mut accounts = submit.to_account_metas(None);
    accounts.extend([AccountMeta::new(input, false), AccountMeta::new_readonly(JUPITER, false), AccountMeta::new_readonly(cox::ID, false)]);
    accounts.extend([
        AccountMeta::new_readonly(spl_token::ID, false), AccountMeta::new_readonly(owner, true),
        AccountMeta::new(input, false), AccountMeta::new(collateral, false),
        AccountMeta::new_readonly(JUPITER, false), AccountMeta::new_readonly(mint, false),
        AccountMeta::new_readonly(JUPITER, false), AccountMeta::new_readonly(Pubkey::find_program_address(&[b"__event_authority"], &JUPITER).0, false),
        AccountMeta::new_readonly(JUPITER, false), AccountMeta::new(input_reserve, false),
        AccountMeta::new(output_reserve, false), AccountMeta::new_readonly(authority, false),
    ]);
    let mut route_data = ROUTE.to_vec();
    route_data.extend(0_u32.to_le_bytes());
    route_data.extend(12_u64.to_le_bytes());
    route_data.extend(quoted_output.to_le_bytes());
    route_data.extend(50_u16.to_le_bytes());
    route_data.push(0);
    let args = SwapAndDeposit { target_class: 1, input_amount: 12, minimum_collateral: minimum, minimum_units: 1,
        expiry: 3, expected_fee_version: fee_version, route_data };
    let mut data = SWAP_AND_DEPOSIT.to_vec();
    args.serialize(&mut data).unwrap();
    (p, Instruction { program_id: router, accounts, data }, request, input, input_reserve, output_reserve)
}

#[test]
fn compiled_router_queues_full_output_and_preserves_prior_collateral() {
    for old in [0, 2_000] {
        let (mut p, ix, request, input, input_reserve, output_reserve) = fixture(old, 100, 0, 100);
        let owner = p.h.alice.insecure_clone();
        p.h.send("full_output_entry", &[ix], &[&owner], true);
        assert_eq!(p.h.token_balance(p.h.alice_token), old);
        assert_eq!(p.h.token_balance(input), 13);
        assert_eq!(p.h.token_balance(input_reserve), 12);
        assert_eq!(p.h.token_balance(output_reserve), 9_887);
        let state: Request = p.h.read(request);
        assert_eq!(state.amount, 113);
        assert_eq!(state.to, 1);
        assert_eq!(state.minimum_units, 1);
        assert_eq!(p.pool_state().pending, 113);
        p.assert_vault();
    }
}

#[test]
fn compiled_runtime_rolls_back_dex_and_queue_on_swap_output_or_deposit_failure() {
    for (minimum, version, quote) in [(100, 1, 100), (114, 0, 100), (100, 0, 999)] {
        let (mut p, ix, request, input, input_reserve, output_reserve) = fixture(2_000, minimum, version, quote);
        let before = p.pool_state();
        let owner = p.h.alice.insecure_clone();
        p.h.send("full_output_failure", &[ix], &[&owner], false);
        assert_eq!(p.h.token_balance(p.h.alice_token), 2_000);
        assert_eq!(p.h.token_balance(input), 25);
        assert_eq!(p.h.token_balance(input_reserve), 0);
        assert_eq!(p.h.token_balance(output_reserve), 10_000);
        assert!(p.h.svm.get_account(&request).is_none());
        assert_eq!(p.pool_state().pending, before.pending);
        assert_eq!(p.pool_state().next_request_nonce, before.next_request_nonce);
        p.assert_vault();
    }
}

#[test]
fn routed_entry_fills_directly_at_next_publication_with_one_deposit_fee() {
    let (mut p, ix, request, _, _, _) = fixture(2_000, 100_000_000, 1, 100_000_000);
    let admin = p.h.admin.insecure_clone();
    let management = (admin.pubkey(), p.registry, p.pool, p.vault);
    let accounts = || cox::accounts::ManageFees { admin: management.0, registry: management.1, pool: management.2, vault: management.3 };
    p.pause(true);
    p.h.send("migrate_pool", &[Harness::instruction(accounts(), cox::instruction::MigratePool {})], &[&admin], true);
    p.h.send("schedule_fees", &[Harness::instruction(accounts(), cox::instruction::ScheduleFees {
        bps: 2, cap: 2_000_000, activation_cutoff: ORIGIN + 60,
    })], &[&admin], true);
    p.pause(false);
    p.h.time(ORIGIN + 60);
    p.publish(1, vec![100_000_000; 2]);
    p.finish();
    p.h.time(ORIGIN + 61);
    let owner = p.h.alice.insecure_clone();
    p.h.send("routed_entry_with_fee", &[ix], &[&owner], true);
    let queued: Request = p.h.read(request);
    assert_eq!(queued.status, 0);
    assert_eq!(queued.amount, 100_000_013);
    assert_eq!(queued.target_batch, 2);
    assert_eq!(p.pool_state().fees, 0);
    p.h.time(ORIGIN + 120);
    p.publish(2, vec![100_000_000; 2]);
    p.finish();
    let receipt: Request = p.h.read(request);
    assert!(receipt.applied);
    assert!(receipt.bound_sequence <= p.pool_state().sequence);
    assert_eq!(receipt.receipt_status, 0);
    assert_eq!(receipt.gross, 100_000_013);
    assert_eq!(receipt.fee, 20_000);
    assert_eq!(p.pool_state().fees, 20_000);
    assert_eq!(p.pool_state().pending, 0);
    assert_eq!(p.pool_state().next_request_nonce, 1);
    let position = p.materialize(owner.pubkey());
    assert_eq!(position.classes[1].units, 99_980_013u128 * cox_math::SCALE as u128);
    assert_eq!(position.classes[2].units, 0);
    assert_eq!(p.h.token_balance(p.h.alice_token), 2_000);
    p.assert_vault();
}
