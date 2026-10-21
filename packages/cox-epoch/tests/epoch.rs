use cox_epoch::{math::{self, SCALE}, *};

fn key(value: u16) -> Key {
    let mut key = [0; 32];
    key[..2].copy_from_slice(&value.to_le_bytes());
    key
}

fn config() -> Config {
    Config { pool: key(1), admin: key(2), operator: key(3), collateral_mint: key(4), collateral_decimals: 6,
        methodology: key(5), origin_benchmark: 100 * SCALE, max_entry_price_age: 5, max_lots: 1_000 }
}

fn universe() -> Vec<Asset> {
    (0..31).map(|id| Asset { id, feed_id: key(id + 10), origin_price: 100 * SCALE }).collect()
}

fn epoch() -> Epoch { Epoch::create(config(), key(2), 0, 0, universe()).unwrap() }

fn basket() -> [AssetId; BASKET_SIZE] { core::array::from_fn(|index| index as AssetId) }

fn snapshot(sequence: u64, timestamp: u64, changes: &[(u16, u128)]) -> OperatorSnapshot {
    OperatorSnapshot { id: key((sequence + 100) as u16), methodology: key(5), sequence,
        oracle_timestamp: timestamp, benchmark: 100 * SCALE,
        prices: universe().into_iter().map(|asset| Price { asset_id: asset.id, feed_id: asset.feed_id,
            value: changes.iter().find(|(id, _)| *id == asset.id).map(|(_, value)| *value).unwrap_or(100 * SCALE) }).collect() }
}

fn queue(epoch: &mut Epoch, nonce: u64, backed: u16, gross: u64, now: u64) -> EntryLot {
    let balance = epoch.ledger().liabilities().unwrap() + gross;
    epoch.queue(key((nonce + 50) as u16), nonce, gross, basket(), backed, now, balance).unwrap()
}

fn execute(epoch: &mut Epoch, lot: &mut EntryLot, data: &OperatorSnapshot, now: u64) {
    epoch.execute(key(3), lot, data, now, epoch.ledger().liabilities().unwrap()).unwrap();
}

fn close(epoch: &mut Epoch, changes: &[(u16, u128)]) {
    epoch.begin_close(key(3), snapshot(100, EPOCH_SECONDS, changes), EPOCH_SECONDS,
        epoch.ledger().liabilities().unwrap()).unwrap();
}

#[test]
fn authorized_aligned_epoch_freezes_distinct_universe_and_six_decimal_collateral() {
    assert_eq!(Epoch::create(config(), key(99), 0, 0, universe()), Err(Error::Unauthorized));
    assert_eq!(Epoch::create(config(), key(2), 1, 0, universe()), Err(Error::InvalidEpoch));
    assert_eq!(Epoch::create(config(), key(2), 0, 1, universe()), Err(Error::InvalidEpoch));
    let mut invalid = config(); invalid.collateral_decimals = 9;
    assert_eq!(Epoch::create(invalid, key(2), 0, 0, universe()), Err(Error::InvalidEpoch));
    let mut invalid = universe(); invalid[1].feed_id = invalid[0].feed_id;
    assert_eq!(Epoch::create(config(), key(2), 0, 0, invalid), Err(Error::InvalidUniverse));
    let mut invalid = universe(); invalid[1].id = invalid[0].id;
    assert_eq!(Epoch::create(config(), key(2), 0, 0, invalid), Err(Error::InvalidUniverse));
    assert_eq!(epoch().universe().len(), 31);
}

#[test]
fn each_deposit_is_a_separate_locked_lot_and_fee_is_capped_at_twenty_cents() {
    assert_eq!(math::fee(10_000_000), Ok(2_000));
    assert_eq!(math::fee(1_000_000_000), Ok(200_000));
    assert_eq!(math::fee(u64::MAX), Ok(200_000));
    assert_eq!(math::fee(0), Err(Error::InvalidStake));
    let mut epoch = epoch();
    let mut first = queue(&mut epoch, 0, 0, 10_000_000, 1);
    let mut second = queue(&mut epoch, 1, 1, 20_000_000, 10);
    execute(&mut epoch, &mut first, &snapshot(1, 2, &[]), 2);
    execute(&mut epoch, &mut second, &snapshot(2, 11, &[(0, 110 * SCALE)]), 11);
    assert_ne!(first.execution(), second.execution());
    assert_eq!(first.fee(), 2_000);
    assert_eq!(second.fee(), 4_000);
    assert_eq!(epoch.ledger().held_fees, 6_000);
    assert_eq!(epoch.ledger().committed_fees, 0);
    assert_eq!(epoch.withdraw(first.owner(), &mut first, 30_000_000), Err(Error::WrongLotState));
    assert_eq!(epoch.refund(&mut first, 12, 30_000_000), Err(Error::WrongLotState));
}

#[test]
fn basket_nonce_amount_and_deposit_custody_are_checked_before_state_changes() {
    let mut epoch = epoch();
    let before = epoch.clone();
    let mut invalid = basket(); invalid[1] = invalid[0];
    assert_eq!(epoch.queue(key(50), 0, 10, invalid, 0, 1, 10), Err(Error::InvalidBasket));
    assert_eq!(epoch.queue(key(50), 0, 10, basket(), 30, 1, 10), Err(Error::InvalidBasket));
    assert_eq!(epoch.queue(key(50), 0, 0, basket(), 0, 1, 0), Err(Error::InvalidStake));
    assert_eq!(epoch.queue(key(50), 1, 10, basket(), 0, 1, 10), Err(Error::InvalidNonce));
    assert_eq!(epoch.queue(key(50), 0, 10, basket(), 0, 1, 9), Err(Error::Insolvent));
    assert_eq!(epoch, before);
    let mut bounded = config(); bounded.max_lots = 1;
    let mut epoch = Epoch::create(bounded, key(2), 0, 0, universe()).unwrap();
    queue(&mut epoch, 0, 0, 10, 1);
    assert_eq!(epoch.queue(key(50), 1, 10, basket(), 0, 1, 20), Err(Error::EntryLimit));
}

#[test]
fn entry_prices_require_configured_operator_and_strict_post_admission_time() {
    let mut epoch = epoch();
    let mut lot = queue(&mut epoch, 0, 0, 10_000_000, 1);
    assert_eq!(epoch.execute(key(99), &mut lot, &snapshot(1, 2, &[]), 2, 10_000_000), Err(Error::Unauthorized));
    for (data, now) in [(snapshot(1, 1, &[]), 2), (snapshot(1, 3, &[]), 2), (snapshot(1, 2, &[]), 8),
        (snapshot(1, EPOCH_SECONDS, &[]), EPOCH_SECONDS)] {
        assert!(matches!(epoch.execute(key(3), &mut lot, &data, now, 10_000_000), Err(Error::IneligibleSnapshot | Error::WrongPhase)));
    }
    let mut bad = snapshot(1, 2, &[]); bad.prices[1].feed_id = bad.prices[0].feed_id;
    assert_eq!(epoch.execute(key(3), &mut lot, &bad, 2, 10_000_000), Err(Error::InvalidSnapshot));
    let mut missing = snapshot(1, 2, &[]); missing.prices.remove(0);
    assert_eq!(epoch.execute(key(3), &mut lot, &missing, 2, 10_000_000), Err(Error::InvalidSnapshot));
    let mut wrong_method = snapshot(1, 2, &[]); wrong_method.methodology = key(99);
    assert_eq!(epoch.execute(key(3), &mut lot, &wrong_method, 2, 10_000_000), Err(Error::InvalidSnapshot));
    execute(&mut epoch, &mut lot, &snapshot(1, 2, &[]), 2);
    assert_eq!(epoch.execute(key(3), &mut lot, &snapshot(1, 2, &[]), 2, 10_000_000), Err(Error::WrongLotState));
}

#[test]
fn common_snapshot_can_execute_multiple_lots_but_same_sequence_cannot_change_prices() {
    let mut epoch = epoch();
    let mut first = queue(&mut epoch, 0, 0, 10_000_000, 1);
    let mut second = queue(&mut epoch, 1, 1, 10_000_000, 1);
    let data = snapshot(1, 2, &[]);
    execute(&mut epoch, &mut first, &data, 2);
    let changed = snapshot(1, 2, &[(0, 110 * SCALE)]);
    assert_eq!(epoch.execute(key(3), &mut second, &changed, 2, 20_000_000), Err(Error::InvalidSnapshot));
    execute(&mut epoch, &mut second, &data, 2);
    assert_eq!(first.execution(), second.execution());
}

#[test]
fn successful_settlement_fixes_total_weight_before_any_payout_and_conserves_vault() {
    let mut epoch = epoch();
    let mut first = queue(&mut epoch, 0, 0, 10_000_000, 1);
    let mut second = queue(&mut epoch, 1, 1, 10_000_000, 1);
    execute(&mut epoch, &mut first, &snapshot(1, 2, &[]), 2);
    execute(&mut epoch, &mut second, &snapshot(1, 2, &[]), 2);
    close(&mut epoch, &[(0, 110 * SCALE), (1, 120 * SCALE)]);
    assert_eq!(epoch.score_entry(&mut first, 20_000_000), Ok(SCALE / 3));
    assert_eq!(epoch.finalize_scores(20_000_000), Err(Error::ScoresIncomplete));
    assert_eq!(epoch.allocate(&mut first, 20_000_000), Err(Error::WrongPhase));
    assert_eq!(epoch.score_entry(&mut second, 20_000_000), Ok(2 * SCALE / 3));
    assert_eq!(epoch.score_entry(&mut second, 20_000_000), Err(Error::WrongLotState));
    epoch.finalize_scores(20_000_000).unwrap();
    assert_eq!(epoch.ledger().committed_fees, 0);
    assert_eq!(epoch.ledger().held_fees, 4_000);
    assert_eq!(epoch.allocate(&mut second, 20_000_000), Ok(13_330_666));
    assert_eq!(epoch.ledger().committed_fees, 0);
    assert_eq!(epoch.allocate(&mut first, 20_000_000), Ok(6_665_333));
    assert_eq!(epoch.phase(), Phase::Settled);
    assert_eq!(epoch.ledger().committed_fees, 4_000);
    assert_eq!(epoch.ledger().held_fees, 0);
    assert_eq!(epoch.ledger().residual, 1);
    assert!(first.execution().is_some());
    epoch.ledger().check(20_000_000).unwrap();
    assert_eq!(epoch.withdraw(key(99), &mut first, 20_000_000), Err(Error::Unauthorized));
    let first_amount = epoch.withdraw(first.owner(), &mut first, 20_000_000).unwrap();
    let balance = 20_000_000 - first_amount;
    let second_amount = epoch.withdraw(second.owner(), &mut second, balance).unwrap();
    assert_eq!(epoch.ledger().liabilities(), Ok(20_000_000 - first_amount - second_amount));
    assert_eq!(epoch.withdraw(first.owner(), &mut first, epoch.ledger().liabilities().unwrap()), Err(Error::WrongLotState));
}

#[test]
fn allocation_order_cannot_change_payouts_or_residual() {
    let mut initial = epoch();
    let mut first = queue(&mut initial, 0, 0, 10_000_000, 1);
    let mut second = queue(&mut initial, 1, 1, 20_000_000, 1);
    execute(&mut initial, &mut first, &snapshot(1, 2, &[]), 2);
    execute(&mut initial, &mut second, &snapshot(1, 2, &[]), 2);
    close(&mut initial, &[(0, 110 * SCALE), (1, 120 * SCALE)]);
    initial.score_entry(&mut first, 30_000_000).unwrap(); initial.score_entry(&mut second, 30_000_000).unwrap();
    initial.finalize_scores(30_000_000).unwrap();
    let mut reverse = initial.clone(); let mut reverse_first = first.clone(); let mut reverse_second = second.clone();
    let a = initial.allocate(&mut first, 30_000_000).unwrap(); let b = initial.allocate(&mut second, 30_000_000).unwrap();
    assert_eq!(reverse.allocate(&mut reverse_second, 30_000_000), Ok(b));
    assert_eq!(reverse.allocate(&mut reverse_first, 30_000_000), Ok(a));
    assert_eq!(initial.ledger(), reverse.ledger());
}

#[test]
fn an_early_claim_after_weight_finalization_cannot_change_remaining_allocations() {
    let mut epoch = epoch();
    let mut first = queue(&mut epoch, 0, 0, 10_000_000, 1);
    let mut second = queue(&mut epoch, 1, 1, 10_000_000, 1);
    execute(&mut epoch, &mut first, &snapshot(1, 2, &[]), 2);
    execute(&mut epoch, &mut second, &snapshot(1, 2, &[]), 2);
    close(&mut epoch, &[(0, 110 * SCALE), (1, 120 * SCALE)]);
    epoch.score_entry(&mut first, 20_000_000).unwrap(); epoch.score_entry(&mut second, 20_000_000).unwrap();
    epoch.finalize_scores(20_000_000).unwrap();
    assert_eq!(epoch.allocate(&mut first, 20_000_000), Ok(6_665_333));
    let paid = epoch.withdraw(first.owner(), &mut first, 20_000_000).unwrap();
    let remaining_balance = 20_000_000 - paid;
    assert_eq!(epoch.allocate(&mut second, remaining_balance), Ok(13_330_666));
    assert_eq!(epoch.ledger().residual, 1);
    epoch.ledger().check(remaining_balance).unwrap();
}

#[test]
fn all_zero_scores_refund_gross_principal_and_held_protocol_fees() {
    let mut epoch = epoch();
    let mut lot = queue(&mut epoch, 0, 0, 1_000_000_000, 1);
    execute(&mut epoch, &mut lot, &snapshot(1, 2, &[]), 2);
    close(&mut epoch, &[]);
    assert_eq!(epoch.score_entry(&mut lot, 1_000_000_000), Ok(0));
    epoch.finalize_scores(1_000_000_000).unwrap();
    assert_eq!(epoch.ledger().committed_fees, 0);
    assert_eq!(epoch.allocate(&mut lot, 1_000_000_000), Ok(1_000_000_000));
    assert_eq!(epoch.ledger().held_fees, 0);
    epoch.ledger().check(1_000_000_000).unwrap();
}

#[test]
fn unexecuted_deposits_are_refunded_at_closing_without_affecting_the_pot() {
    let mut epoch = epoch();
    let mut pending = queue(&mut epoch, 0, 0, 10_000_000, 1);
    let mut executed = queue(&mut epoch, 1, 1, 10_000_000, 1);
    execute(&mut epoch, &mut executed, &snapshot(1, 2, &[]), 2);
    assert_eq!(epoch.refund(&mut pending, EPOCH_SECONDS - 1, 20_000_000), Err(Error::WrongLotState));
    assert_eq!(epoch.refund(&mut pending, EPOCH_SECONDS, 20_000_000), Ok(10_000_000));
    close(&mut epoch, &[(1, 110 * SCALE)]);
    epoch.score_entry(&mut executed, 20_000_000).unwrap(); epoch.finalize_scores(20_000_000).unwrap();
    assert_eq!(epoch.allocate(&mut executed, 20_000_000), Ok(9_998_000));
    assert_eq!(epoch.ledger().committed_fees, 2_000);
    assert_eq!(epoch.ledger().claimable, 19_998_000);
    epoch.ledger().check(20_000_000).unwrap();
}

#[test]
fn delayed_close_requires_exact_timestamp_and_is_allowed_through_the_twenty_four_hour_deadline() {
    let mut epoch = epoch();
    let mut lot = queue(&mut epoch, 0, 0, 10_000_000, 1);
    execute(&mut epoch, &mut lot, &snapshot(1, 2, &[]), 2);
    assert_eq!(epoch.begin_close(key(3), snapshot(100, EPOCH_SECONDS + 1, &[]), EPOCH_SECONDS + 1, 10_000_000), Err(Error::IneligibleSnapshot));
    assert_eq!(epoch.begin_close(key(3), snapshot(100, EPOCH_SECONDS, &[]), EPOCH_SECONDS - 1, 10_000_000), Err(Error::IneligibleSnapshot));
    let mut missing = snapshot(100, EPOCH_SECONDS, &[]); missing.prices.pop();
    assert_eq!(epoch.begin_close(key(3), missing, EPOCH_SECONDS, 10_000_000), Err(Error::ClosingDataMissing));
    let deadline = EPOCH_SECONDS + CLOSING_GRACE_SECONDS;
    assert_eq!(epoch.void(deadline, 10_000_000), Err(Error::WrongPhase));
    epoch.begin_close(key(3), snapshot(100, EPOCH_SECONDS, &[]), deadline, 10_000_000).unwrap();
    assert_eq!(epoch.void(deadline + 1, 10_000_000), Err(Error::ClosingDataExists));
}

#[test]
fn void_without_data_refunds_executed_and_pending_lots_including_fees() {
    let mut epoch = epoch();
    let mut executed = queue(&mut epoch, 0, 0, 10_000_000, 1);
    let mut pending = queue(&mut epoch, 1, 1, 20_000_000, 1);
    execute(&mut epoch, &mut executed, &snapshot(1, 2, &[]), 2);
    let after_deadline = EPOCH_SECONDS + CLOSING_GRACE_SECONDS + 1;
    assert_eq!(epoch.begin_close(key(3), snapshot(100, EPOCH_SECONDS, &[]), after_deadline, 30_000_000), Err(Error::IneligibleSnapshot));
    epoch.void(after_deadline, 30_000_000).unwrap();
    assert_eq!(epoch.refund(&mut executed, after_deadline, 30_000_000), Ok(10_000_000));
    assert_eq!(epoch.refund(&mut pending, after_deadline, 30_000_000), Ok(20_000_000));
    assert_eq!(epoch.ledger().committed_fees, 0); assert_eq!(epoch.ledger().held_fees, 0);
    epoch.ledger().check(30_000_000).unwrap();
    assert_eq!(epoch.refund(&mut executed, after_deadline, 30_000_000), Err(Error::WrongLotState));
}

#[test]
fn wrong_epoch_and_pool_lots_cannot_be_processed() {
    let mut first = epoch();
    let mut lot = queue(&mut first, 0, 0, 10, 1);
    let mut alternate_config = config(); alternate_config.pool = key(99);
    let mut other = Epoch::create(alternate_config, key(2), 0, 0, universe()).unwrap();
    queue(&mut other, 0, 0, 10, 1);
    assert_eq!(other.execute(key(3), &mut lot, &snapshot(1, 2, &[]), 2, 10), Err(Error::WrongEntry));
}

#[test]
fn snapshots_with_zero_prices_wrong_feed_or_duplicate_asset_fail_without_mutation() {
    for change in 0..3 {
        let mut epoch = epoch();
        let mut lot = queue(&mut epoch, 0, 0, 10, 1);
        let before = epoch.clone(); let original = lot.clone();
        let mut data = snapshot(1, 2, &[]);
        if change == 0 { data.prices[0].value = 0; }
        if change == 1 { data.prices[0].feed_id = key(1000); }
        if change == 2 { data.prices[1].asset_id = 0; }
        assert_eq!(epoch.execute(key(3), &mut lot, &data, 2, 10), Err(Error::InvalidSnapshot));
        assert_eq!(epoch, before); assert_eq!(lot, original);
    }
}

#[test]
fn reference_and_score_use_the_declared_floor_policy() {
    assert_eq!(math::relative_reference(110 * SCALE, 100 * SCALE, 100 * SCALE, 100 * SCALE), Ok(11 * SCALE / 10));
    assert_eq!(math::relative_reference(110 * SCALE, 100 * SCALE, 110 * SCALE, 100 * SCALE), Ok(SCALE));
    let references = [math::MAX_REFERENCE; BASKET_SIZE];
    let mut close = references; close[0] += 1;
    assert_eq!(math::score(&references, &close, 0), Err(Error::InvalidReference));
    let references = [math::MAX_REFERENCE - 1; BASKET_SIZE];
    let mut close = references; close[0] += 1;
    assert_eq!(math::score(&references, &close, 0), Ok(0));
}

#[test]
fn mixed_scores_large_entries_and_reverse_allocation_preserve_all_custody_categories() {
    let mut epoch = epoch();
    let mut lots = Vec::new();
    for index in 0..120 {
        let mut lot = queue(&mut epoch, index, (index % 30) as u16, 1_000_000 + index * 7_919, 1);
        execute(&mut epoch, &mut lot, &snapshot(1, 2, &[]), 2);
        lots.push(lot);
    }
    let balance = epoch.ledger().liabilities().unwrap();
    let changes: Vec<(u16, u128)> = (0..30).map(|index| (index, (95 + index as u128) * SCALE)).collect();
    close(&mut epoch, &changes);
    for lot in &mut lots {
        let score = epoch.score_entry(lot, balance).unwrap();
        assert!(score <= SCALE);
    }
    epoch.finalize_scores(balance).unwrap();
    for lot in lots.iter_mut().rev() {
        epoch.allocate(lot, balance).unwrap();
        epoch.ledger().check(balance).unwrap();
    }
    assert_eq!(epoch.phase(), Phase::Settled);
    let committed = epoch.ledger().committed_fees;
    let residual = epoch.ledger().residual;
    let mut actual_balance = balance;
    for lot in &mut lots {
        let payout = epoch.withdraw(lot.owner(), lot, actual_balance).unwrap();
        actual_balance -= payout;
        epoch.ledger().check(actual_balance).unwrap();
    }
    assert_eq!(actual_balance, committed + residual);
}

#[test]
fn insolvency_fails_closed_and_overflowing_deposits_do_not_mutate_state() {
    let mut epoch = epoch();
    let mut lot = queue(&mut epoch, 0, 0, u64::MAX, 1);
    let before = epoch.clone();
    assert_eq!(epoch.queue(key(51), 1, 1, basket(), 0, 1, u64::MAX), Err(Error::Overflow));
    assert_eq!(epoch, before);
    assert_eq!(epoch.execute(key(3), &mut lot, &snapshot(1, 2, &[]), 2, u64::MAX - 1), Err(Error::Insolvent));
    assert_eq!(epoch, before);
    execute(&mut epoch, &mut lot, &snapshot(1, 2, &[]), 2);
    close(&mut epoch, &[(0, 110 * SCALE)]);
    epoch.score_entry(&mut lot, u64::MAX).unwrap(); epoch.finalize_scores(u64::MAX).unwrap();
    assert_eq!(epoch.allocate(&mut lot, u64::MAX), Ok(u64::MAX - math::FEE_CAP));
    epoch.ledger().check(u64::MAX).unwrap();
}
