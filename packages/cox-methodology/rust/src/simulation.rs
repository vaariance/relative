use num_bigint::{BigInt, BigUint};
use num_traits::{ToPrimitive, Zero};
use std::collections::{BTreeMap, BTreeSet};

pub const EPOCH_SECONDS: u64 = 14_400;
pub const FEE_CAP: u64 = 200_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fraction {
    pub numerator: BigUint,
    pub denominator: BigUint,
}
impl Fraction {
    fn new(numerator: BigUint, denominator: BigUint) -> Self {
        assert!(!denominator.is_zero());
        let (mut a, mut b) = (numerator.clone(), denominator.clone());
        while !b.is_zero() {
            (a, b) = (b.clone(), a % b);
        }
        Self {
            numerator: numerator / &a,
            denominator: denominator / a,
        }
    }
    fn zero() -> Self {
        Self::new(0u8.into(), 1u8.into())
    }
    fn add(&self, other: &Self) -> Self {
        Self::new(
            &self.numerator * &other.denominator + &other.numerator * &self.denominator,
            &self.denominator * &other.denominator,
        )
    }
}
#[derive(Clone, Debug)]
pub struct Entry {
    pub id: String,
    pub gross_stake: u64,
    pub executed_at: u64,
    pub backed_asset: String,
    pub basket: Vec<String>,
    pub references: BTreeMap<String, u128>,
}
pub struct Input {
    pub opens_at: u64,
    pub closes_at: u64,
    pub universe: BTreeSet<String>,
    pub entries: Vec<Entry>,
    pub closing_references: BTreeMap<String, u128>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub id: String,
    pub score: Fraction,
    pub payout: u64,
    pub refund: u64,
    pub committed_fee: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Settled,
    AllZeroRefund,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Result {
    pub outcome: Outcome,
    pub receipts: Vec<Receipt>,
    pub gross_stake: u64,
    pub available_pot: u64,
    pub committed_fees: u64,
    pub residual: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Boundary,
    Size,
    DuplicateEntry,
    EntryTime,
    Basket,
    Reference,
    Stake,
    PotOverflow,
    Sensitivity,
}
pub fn fee(gross: u64) -> std::result::Result<u64, Error> {
    if gross == 0 {
        return Err(Error::Stake);
    }
    Ok(((u128::from(gross) * 2 / 10_000).min(u128::from(FEE_CAP))) as u64)
}
fn reference(values: &BTreeMap<String, u128>, asset: &str) -> std::result::Result<u128, Error> {
    values
        .get(asset)
        .copied()
        .filter(|value| *value > 0 && *value <= i128::MAX as u128)
        .ok_or(Error::Reference)
}
pub fn simulate(input: &Input) -> std::result::Result<Result, Error> {
    if input.opens_at > MAX_SAFE_INTEGER
        || input.opens_at % EPOCH_SECONDS != 0
        || input.closes_at > MAX_SAFE_INTEGER
        || input.opens_at.checked_add(EPOCH_SECONDS) != Some(input.closes_at)
    {
        return Err(Error::Boundary);
    }
    if input.universe.len() < 30 || input.entries.is_empty() || input.entries.len() > 16 {
        return Err(Error::Size);
    }
    let (mut ids, mut gross, mut fees) = (BTreeSet::new(), 0u64, 0u64);
    let mut evaluated = Vec::new();
    let mut total = Fraction::zero();
    for entry in &input.entries {
        if entry.id.is_empty() || !ids.insert(&entry.id) {
            return Err(Error::DuplicateEntry);
        }
        if entry.executed_at < input.opens_at || entry.executed_at >= input.closes_at {
            return Err(Error::EntryTime);
        }
        if entry.basket.len() != 30
            || entry.basket.iter().collect::<BTreeSet<_>>().len() != 30
            || !entry.basket.contains(&entry.backed_asset)
            || entry
                .basket
                .iter()
                .any(|asset| !input.universe.contains(asset))
        {
            return Err(Error::Basket);
        }
        let held = fee(entry.gross_stake)?;
        gross = gross
            .checked_add(entry.gross_stake)
            .ok_or(Error::PotOverflow)?;
        fees = fees.checked_add(held).ok_or(Error::PotOverflow)?;
        let (mut sum, mut backed) = (Fraction::zero(), Fraction::zero());
        for asset in &entry.basket {
            let start = reference(&entry.references, asset)?;
            let end = reference(&input.closing_references, asset)?;
            let positive = Fraction::new(end.saturating_sub(start).into(), start.into());
            sum = sum.add(&positive);
            if asset == &entry.backed_asset {
                backed = positive;
            }
        }
        let score = if sum.numerator.is_zero() {
            Fraction::zero()
        } else {
            Fraction::new(
                &backed.numerator * &sum.denominator,
                &backed.denominator * &sum.numerator,
            )
        };
        let weight = Fraction::new(
            BigUint::from(entry.gross_stake - held) * &score.numerator,
            score.denominator.clone(),
        );
        total = total.add(&weight);
        evaluated.push((entry, held, score, weight));
    }
    if total.numerator.is_zero() {
        return Ok(Result {
            outcome: Outcome::AllZeroRefund,
            gross_stake: gross,
            available_pot: 0,
            committed_fees: 0,
            residual: 0,
            receipts: evaluated
                .into_iter()
                .map(|(entry, _, score, _)| Receipt {
                    id: entry.id.clone(),
                    score,
                    payout: 0,
                    refund: entry.gross_stake,
                    committed_fee: 0,
                })
                .collect(),
        });
    }
    let pot = gross - fees;
    let mut paid = 0u64;
    let mut receipts = Vec::new();
    for (entry, held, score, weight) in evaluated {
        let payout = (BigUint::from(pot) * weight.numerator * &total.denominator
            / (weight.denominator * &total.numerator))
            .to_u64()
            .ok_or(Error::PotOverflow)?;
        paid = paid.checked_add(payout).ok_or(Error::PotOverflow)?;
        receipts.push(Receipt {
            id: entry.id.clone(),
            score,
            payout,
            refund: 0,
            committed_fee: held,
        });
    }
    Ok(Result {
        outcome: Outcome::Settled,
        receipts,
        gross_stake: gross,
        available_pot: pot,
        committed_fees: fees,
        residual: pot.checked_sub(paid).ok_or(Error::PotOverflow)?,
    })
}
pub fn amplified_change(
    entry: u128,
    current: u128,
    sensitivity: u8,
    scale: u128,
) -> std::result::Result<BigInt, Error> {
    if entry == 0 || current == 0 || !(1..=100).contains(&sensitivity) || scale == 0 {
        return Err(Error::Sensitivity);
    }
    Ok((BigInt::from(current) - BigInt::from(entry))
        * BigInt::from(scale)
        * BigInt::from(sensitivity)
        / BigInt::from(entry))
}
