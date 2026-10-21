mod support;

use anchor_lang::AccountSerialize;
use cox::{Batch, Pool, PriceWire, Request};
use cox_math::SCALE;
use solana_sdk::signature::Signer;
use support::{pda, protocol::PoolHarness, ORIGIN};

#[test]
fn scheduled_admission_allows_historical_empty_bootstrap_but_blocks_early_wallet_entry() {
    let opens=ORIGIN+14_400;
    let mut p=PoolHarness::new_adaptive_scheduled(2,opens,ORIGIN+120);
    assert_eq!(p.pool_state().trading_opens_at,opens);
    assert!(p.pool_state().initialized);
    assert_eq!(p.pool_state().last_batch,0);
    p.h.time(opens-1);
    p.deposit(false,0,100_000_000,0,15_000,false);
    assert_eq!(p.pool_state().pending,0);
    assert_eq!(p.pool_state().next_request_nonce,0);
    p.h.time(opens);
    p.deposit(false,0,100_000_000,0,15_000,true);
    let queued:Request=p.h.read(p.request(0));
    assert_eq!(queued.target_batch,14_401);
    p.publish_adaptive(14_400,vec![100_000_000;2],100*SCALE,true);
    p.finish();
    assert_eq!(p.pool_state().pending,100_000_000);
    p.h.time(opens+1);
    p.publish_adaptive(14_401,vec![100_000_000;2],100*SCALE,true);
    p.finish();
    assert_eq!(p.pool_state().active,100_000_000);
    assert_eq!(p.pool_state().pending,0);
}

#[test]
fn adaptive_idle_wakes_at_next_second_and_preserves_bounded_queue() {
    let mut p = PoolHarness::new_adaptive(2);
    assert_eq!(p.pool_state().schema_version, 4);
    p.h.time(ORIGIN + 14_400);
    p.deposit(false, 0, 100_000_000, 0, 14_500, true);
    let queued: Request = p.h.read(p.request(0));
    assert_eq!(queued.target_batch, 14_401);
    p.publish_adaptive(14_400, vec![121_000_000, 100_000_000], 110 * SCALE, true);
    p.finish();
    assert_eq!(p.pool_state().active, 0);
    assert_eq!(p.pool_state().pending, 100_000_000);
    p.h.time(ORIGIN + 14_401);
    p.publish_adaptive(14_401, vec![121_000_000, 100_000_000], 110 * SCALE, true);
    p.deposit(true, 1, 20_000_000, 0, 14_500, true);
    assert_eq!(p.batch_state().closed_queue_end, 1);
    p.finish();
    assert_eq!(p.pool_state().active, 100_000_000);
    assert_eq!(p.pool_state().pending, 20_000_000);
    assert_eq!(p.pool_state().benchmark, 110 * SCALE);
    assert_eq!(p.pool_state().references, vec![110 * SCALE, 90_909_090_909_091, 100 * SCALE]);
    p.h.time(ORIGIN + 14_402);
    p.publish_adaptive(14_402, vec![121_000_000, 100_000_000], 110 * SCALE, true);
    p.finish();
    assert_eq!(p.pool_state().active, 120_000_000);
    assert_eq!(p.pool_state().pending, 0);
    p.assert_owners(&[p.h.alice.pubkey(), p.h.bob.pubkey()]);
}

#[test]
fn adaptive_benchmark_is_operator_attestation_and_revalues_every_committed_class() {
    let mut p = PoolHarness::new_adaptive(2);
    p.h.time(ORIGIN + 1);
    p.deposit(false, 0, 100_000_000, 0, 100, true);
    p.deposit(true, 1, 100_000_000, 0, 100, true);
    p.h.time(ORIGIN + 2);
    p.publish_adaptive(2, vec![100_000_000; 2], 100 * SCALE, true);
    p.finish();
    p.h.time(ORIGIN + 90);
    p.publish_adaptive(90, vec![121_000_000, 100_000_000], 110 * SCALE, true);
    let accepted: Batch = p.batch_state();
    assert_eq!(accepted.benchmark, 110 * SCALE);
    assert_eq!(accepted.fixed.iter().map(|class| class.backing).sum::<u64>() + accepted.transfer_residual, 200_000_000);
    assert!(accepted.fixed[0].backing > 100_000_000);
    assert!(accepted.fixed[1].backing < 100_000_000);
    p.finish();
    assert_eq!(p.pool_state().last_batch, 90);
    assert_eq!(p.pool_state().sequence, 2);
    assert_eq!(p.pool_state().benchmark, 110 * SCALE);
    let publication: cox::Publication = p.h.read(pda(&[b"publication", p.pool.as_ref()]));
    let domain = b"COX/STATE/ADAPTIVE/V1";
    assert_eq!(&publication.state_preimage[4..4 + domain.len()], domain);
    p.assert_owners(&[p.h.alice.pubkey(), p.h.bob.pubkey()]);
}

#[test]
fn adaptive_rejects_future_stale_replayed_and_legacy_publications() {
    let mut p = PoolHarness::new_adaptive(2);
    p.h.time(ORIGIN + 1);
    p.publish_adaptive(2, vec![100_000_000; 2], 100 * SCALE, false);
    p.h.time(ORIGIN + 8);
    p.publish_adaptive(2, vec![100_000_000; 2], 100 * SCALE, false);
    p.h.time(ORIGIN + 60);
    p.try_publish(1, vec![100_000_000; 2], false);
    p.publish_adaptive(60, vec![100_000_000; 2], 100 * SCALE, true);
    p.finish();
    p.publish_adaptive(60, vec![100_000_000; 2], 100 * SCALE, false);
    assert_eq!(p.pool_state().sequence, 1);
}

#[test]
fn adaptive_binds_full_roster_benchmark_and_runtime_authority() {
    let mut p = PoolHarness::new_adaptive(2);
    p.h.time(ORIGIN + 1);
    let prices = vec![PriceWire { price_e8: 100_000_000, venue: 3, step: 0, candle_start: ORIGIN + 1, trade_age_minutes: 0 }; 2];
    let snapshot = cox_math::artifact_digest(&cox::adaptive_snapshot_bytes(ORIGIN + 1, 100 * SCALE, &p.roster, &prices).unwrap());
    p.try_adaptive_wire(1, prices.clone(), 101 * SCALE, snapshot, None, false);
    p.try_adaptive_wire(1, prices[..1].to_vec(), 100 * SCALE, snapshot, None, false);
    let mut changed = prices.clone();
    changed[0].price_e8 += 1;
    p.try_adaptive_wire(1, changed, 100 * SCALE, snapshot, None, false);
    let mut stale = prices.clone();
    stale[0].candle_start -= 1;
    p.try_adaptive_wire(1, stale, 100 * SCALE, snapshot, None, false);
    let outsider = p.h.alice.insecure_clone();
    p.try_adaptive_wire(1, prices.clone(), 100 * SCALE, snapshot, Some(&outsider), false);
    p.try_adaptive_wire(1, prices, 100 * SCALE, snapshot, None, true);
    p.finish();
}

#[test]
fn adaptive_cannot_be_enabled_by_migrating_a_legacy_or_retired_pool() {
    let mut p = PoolHarness::new(2);
    p.h.time(ORIGIN + 1);
    p.publish_adaptive(1, vec![100_000_000; 2], 100 * SCALE, false);
    let mut state: Pool = p.pool_state();
    state.schema_version = 3;
    let mut account = p.h.svm.get_account(&p.pool).unwrap();
    state.try_serialize(&mut &mut account.data[..]).unwrap();
    p.h.svm.set_account(p.pool, account).unwrap();
    p.publish_adaptive(1, vec![100_000_000; 2], 100 * SCALE, false);
    assert_eq!(p.pool_state().schema_version, 3);
}
