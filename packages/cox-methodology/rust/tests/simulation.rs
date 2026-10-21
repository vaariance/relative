use num_bigint::BigUint;
use relative_methodology::simulation::*;
use std::collections::BTreeMap;

fn input() -> Input {
    let assets: Vec<_> = (0..31).map(|id| format!("asset{id}")).collect();
    let references: BTreeMap<_, _> = assets.iter().cloned().map(|id| (id, 100)).collect();
    let entries = ["a", "b"]
        .iter()
        .enumerate()
        .map(|(index, id)| Entry {
            id: id.to_string(),
            gross_stake: 10_000_000,
            executed_at: 1,
            backed_asset: assets[index].clone(),
            basket: assets[..30].to_vec(),
            references: references.clone(),
        })
        .collect();
    let mut closing = references;
    closing.insert("asset0".into(), 110);
    closing.insert("asset1".into(), 120);
    Input {
        opens_at: 0,
        closes_at: 14_400,
        universe: assets.into_iter().collect(),
        entries,
        closing_references: closing,
    }
}
#[test]
fn independent_typescript_vector_matches_exact_fractions_fees_and_residual() {
    let result = simulate(&input()).unwrap();
    assert_eq!(result.outcome, Outcome::Settled);
    assert_eq!(
        result
            .receipts
            .iter()
            .map(|r| (
                r.score.numerator.to_string(),
                r.score.denominator.to_string(),
                r.payout
            ))
            .collect::<Vec<_>>(),
        vec![
            ("1".into(), "3".into(), 6_665_333),
            ("2".into(), "3".into(), 13_330_666)
        ]
    );
    assert_eq!((result.committed_fees, result.residual), (4_000, 1));
    assert_eq!(
        result.receipts.iter().map(|r| r.payout).sum::<u64>()
            + result.residual
            + result.committed_fees,
        result.gross_stake
    );
    assert_eq!(fee(1_000_000_000), Ok(200_000));
    assert_eq!(fee(u64::MAX), Ok(200_000));
    assert_eq!(fee(1), Ok(0));
    assert_eq!(fee(0), Err(Error::Stake));
}
#[test]
fn frozen_baskets_and_lot_references_produce_distinct_scores_for_same_backed_asset() {
    let mut value = input();
    value.entries[1].backed_asset = "asset0".into();
    value.entries[1].basket.retain(|asset| asset != "asset1");
    value.entries[1].basket.push("asset30".into());
    let mut later = value.entries[0].clone();
    later.id = "later".into();
    later.executed_at = 10_000;
    later.references.insert("asset0".into(), 110);
    value.entries.push(later);
    let result = simulate(&value).unwrap();
    assert_eq!(result.receipts[1].score.numerator, BigUint::from(1u8));
    assert_eq!(result.receipts[1].score.denominator, BigUint::from(1u8));
    assert_eq!(result.receipts[2].payout, 0);
    value.entries[0].executed_at = value.closes_at;
    assert_eq!(simulate(&value), Err(Error::EntryTime));
}
#[test]
fn zero_and_tiny_moves_preserve_candidate_formula_and_full_refunds() {
    let mut value = input();
    value
        .closing_references
        .values_mut()
        .for_each(|price| *price = 100);
    let result = simulate(&value).unwrap();
    assert_eq!(result.outcome, Outcome::AllZeroRefund);
    assert_eq!(result.committed_fees, 0);
    assert_eq!(
        result.receipts.iter().map(|r| r.refund).sum::<u64>(),
        result.gross_stake
    );
    for entry in &mut value.entries {
        entry.backed_asset = "asset0".into();
        entry
            .references
            .values_mut()
            .for_each(|price| *price = 1_000_000_000_000);
    }
    value
        .closing_references
        .values_mut()
        .for_each(|price| *price = 1_000_000_000_000);
    value
        .closing_references
        .insert("asset0".into(), 1_000_000_000_001);
    let result = simulate(&value).unwrap();
    assert_eq!(result.outcome, Outcome::Settled);
    assert!(result
        .receipts
        .iter()
        .all(|receipt| receipt.payout < 10_000_000
            && receipt.score.numerator == receipt.score.denominator));
    assert_eq!(
        amplified_change(100_000, 100_150, 20, 1_000_000_000_000)
            .unwrap()
            .to_string(),
        "30000000000"
    );
    assert_eq!(
        amplified_change(100, 90, 10, 1_000_000_000_000)
            .unwrap()
            .to_string(),
        "-1000000000000"
    );
    assert_eq!(simulate(&value).unwrap(), result);
}
#[test]
fn invalid_baskets_references_duplicate_ids_and_overflow_fail_closed() {
    let mut value = input();
    value.entries[1].id = "a".into();
    assert_eq!(simulate(&value), Err(Error::DuplicateEntry));
    let mut value = input();
    value.entries[0].basket[1] = "asset0".into();
    assert_eq!(simulate(&value), Err(Error::Basket));
    let mut value = input();
    value.entries[0].references.insert("asset0".into(), 0);
    assert_eq!(simulate(&value), Err(Error::Reference));
    let mut value = input();
    value.entries[0].gross_stake = u64::MAX;
    assert_eq!(simulate(&value), Err(Error::PotOverflow));
}
