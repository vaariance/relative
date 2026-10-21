pub mod geometric;

use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const SCALE: i128 = 1_000_000_000_000;
pub type Hash = [u8; 32];
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    ArithmeticOverflow,
    InvalidDenominator,
    InvalidReferenceInput,
    InvalidBenchmark,
    InvalidClassState,
    ZeroTransferDenominator,
    InvalidRequest,
    InvalidDestination,
    InvalidAmount,
    OverReservedUnits,
    DuplicateRequest,
    InsolventBatch,
    VaultMismatch,
    InsufficientPending,
    InsufficientPayable,
    InvalidPrice,
    InvalidSnapshot,
    InvalidFeeTerms,
}
impl std::fmt::Display for MathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for MathError {}
pub type Result<T> = std::result::Result<T, MathError>;
fn add(a: i128, b: i128) -> Result<i128> {
    a.checked_add(b).ok_or(MathError::ArithmeticOverflow)
}
fn mul(a: i128, b: i128) -> Result<i128> {
    a.checked_mul(b).ok_or(MathError::ArithmeticOverflow)
}
fn int(a: u128) -> Result<i128> {
    i128::try_from(a).map_err(|_| MathError::ArithmeticOverflow)
}
fn amount(a: i128) -> Result<u64> {
    u64::try_from(a).map_err(|_| MathError::ArithmeticOverflow)
}
fn units(a: i128) -> Result<u128> {
    u128::try_from(a).map_err(|_| MathError::ArithmeticOverflow)
}
fn sum(values: impl IntoIterator<Item = i128>) -> Result<i128> {
    values.into_iter().try_fold(0, add)
}
pub fn rounded_div(n: i128, d: i128) -> Result<i128> {
    if d <= 0 {
        return Err(MathError::InvalidDenominator);
    }
    let q = n / d;
    let r = (n % d).checked_abs().ok_or(MathError::ArithmeticOverflow)?;
    if r >= d - r {
        add(q, if n < 0 { -1 } else { 1 })
    } else {
        Ok(q)
    }
}
pub fn multiply(a: i128, b: i128) -> Result<i128> {
    rounded_div(mul(a, b)?, SCALE)
}
pub fn artifact_digest(bytes: &[u8]) -> Hash {
    Sha256::digest(bytes).into()
}
pub fn digest(domain: &str, bytes: &[u8]) -> Result<Hash> {
    let mut data = Vec::new();
    string_bytes(&mut data, domain)?;
    data.extend_from_slice(bytes);
    Ok(artifact_digest(&data))
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    pub gross: Vec<i128>,
    pub benchmark_gross: i128,
    pub benchmark: i128,
    pub relative: Vec<i128>,
    pub h: Vec<i128>,
}
pub fn reference(
    previous: &[u64],
    current: &[u64],
    origin: &[u64],
    previous_benchmark: i128,
) -> Result<Reference> {
    if !(2..=30).contains(&previous.len())
        || current.len() != previous.len()
        || origin.len() != previous.len()
        || previous_benchmark <= 0
        || previous
            .iter()
            .chain(current)
            .chain(origin)
            .any(|x| *x == 0)
    {
        return Err(MathError::InvalidReferenceInput);
    }
    let gross = current
        .iter()
        .zip(previous)
        .map(|(c, p)| rounded_div(mul(*c as i128, SCALE)?, *p as i128))
        .collect::<Result<Vec<_>>>()?;
    let benchmark_gross = rounded_div(sum(gross.iter().copied())?, gross.len() as i128)?;
    let benchmark = multiply(previous_benchmark, benchmark_gross)?;
    let w = rounded_div(mul(benchmark, SCALE)?, 100 * SCALE)?;
    if benchmark <= 0 || benchmark_gross <= 0 || w <= 0 {
        return Err(MathError::InvalidBenchmark);
    }
    let relative = current
        .iter()
        .zip(origin)
        .map(|(c, p)| {
            let a = rounded_div(mul(*c as i128, SCALE)?, *p as i128)?;
            rounded_div(mul(100 * SCALE, a)?, w)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut h = gross
        .iter()
        .map(|g| rounded_div(mul(*g, SCALE)?, benchmark_gross))
        .collect::<Result<Vec<_>>>()?;
    h.push(SCALE);
    Ok(Reference {
        gross,
        benchmark_gross,
        benchmark,
        relative,
        h,
    })
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Class {
    pub backing: u64,
    pub units: u128,
}
pub fn validate_classes(classes: &[Class]) -> Result<()> {
    if classes.is_empty()
        || classes.len() > 31
        || classes.iter().any(|c| c.units == 0 && c.backing != 0)
    {
        return Err(MathError::InvalidClassState);
    }
    for class in classes {
        mul(int(class.units)?, class.backing as i128)?;
    }
    let total = sum(classes.iter().map(|c| c.backing as i128))?;
    amount(total)?;
    mul(mul(total, total)?, SCALE)?;
    Ok(())
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revaluation {
    pub classes: Vec<Class>,
    pub residual: u64,
}
pub fn revalue(classes: &[Class], h: &[i128]) -> Result<Revaluation> {
    validate_classes(classes)?;
    if classes.len() != h.len() || h.iter().any(|x| *x < 0) {
        return Err(MathError::InvalidClassState);
    }
    let total = sum(classes.iter().map(|c| c.backing as i128))?;
    if total == 0 {
        return Ok(Revaluation {
            classes: classes.to_vec(),
            residual: 0,
        });
    }
    let scores = classes
        .iter()
        .zip(h)
        .map(|(c, h)| mul(c.backing as i128, *h))
        .collect::<Result<Vec<_>>>()?;
    let denominator = sum(scores.iter().copied())?;
    if denominator == 0 {
        return Err(MathError::ZeroTransferDenominator);
    }
    let result = classes
        .iter()
        .zip(scores)
        .map(|(c, s)| {
            Ok(Class {
                units: c.units,
                backing: amount(mul(total, s)? / denominator)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let residual = amount(total - sum(result.iter().map(|c| c.backing as i128))?)?;
    validate_classes(&result)?;
    Ok(Revaluation {
        classes: result,
        residual,
    })
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Operation {
    Deposit {
        to: usize,
        amount: u64,
        min_units: u128,
    },
    Redeem {
        from: usize,
        units: u128,
        min_proceeds: u64,
    },
    Switch {
        from: usize,
        to: usize,
        units: u128,
        min_units: u128,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub id: String,
    pub expiry: u64,
    pub operation: Operation,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Filled,
    ConditionFailed,
    Expired,
    ZeroValueClass,
}
pub const MAX_FEE_BPS: u16 = 100;
pub const MAX_FEE_CAP: u64 = 2_000_000;
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FeeTerms {
    pub version: u64,
    pub bps: u16,
    pub cap: u64,
}
impl FeeTerms {
    pub fn validate(&self) -> Result<()> {
        if self.bps > MAX_FEE_BPS || self.cap > MAX_FEE_CAP {
            return Err(MathError::InvalidFeeTerms);
        }
        Ok(())
    }
    pub fn fee(&self, gross: u64) -> Result<u64> {
        self.validate()?;
        amount((mul(gross as i128, self.bps as i128)? / 10_000).min(self.cap as i128))
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Receipt {
    pub id: String,
    pub outcome: Outcome,
    pub minted: u128,
    pub proceeds: u64,
    pub gross: u64,
    pub fee: u64,
    pub fee_version: u64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchResult {
    pub classes: Vec<Class>,
    pub payable: u64,
    pub refunds: u64,
    pub residual: u64,
    pub accepted_deposits: u64,
    pub fees: u64,
    pub receipts: Vec<Receipt>,
}
pub fn batch(
    classes: &[Class],
    requests: &[Request],
    publication_batch: u64,
) -> Result<BatchResult> {
    batch_with_fees(
        classes,
        requests,
        publication_batch,
        &vec![FeeTerms::default(); requests.len()],
    )
}
pub fn batch_with_fees(
    classes: &[Class],
    requests: &[Request],
    publication_batch: u64,
    fees: &[FeeTerms],
) -> Result<BatchResult> {
    validate_classes(classes)?;
    if requests.len() != fees.len() {
        return Err(MathError::InvalidFeeTerms);
    }
    for terms in fees {
        terms.validate()?;
    }
    let mut reserved = vec![0i128; classes.len()];
    let mut ids = HashSet::new();
    for request in requests {
        if request.id.is_empty() || !ids.insert(&request.id) {
            return Err(MathError::DuplicateRequest);
        }
        let (from, to, x, d) = match request.operation {
            Operation::Deposit {
                to,
                amount,
                min_units: _,
            } => (None, Some(to), 0, amount),
            Operation::Redeem {
                from,
                units,
                min_proceeds: _,
            } => (Some(from), None, int(units)?, 0),
            Operation::Switch {
                from,
                to,
                units,
                min_units: _,
            } => (Some(from), Some(to), int(units)?, 0),
        };
        if to.is_some_and(|i| i >= classes.len()) || (from.is_some() && from == to) {
            return Err(MathError::InvalidDestination);
        }
        if let Some(i) = from {
            if i >= classes.len() || x <= 0 {
                return Err(MathError::InvalidRequest);
            }
            reserved[i] = add(reserved[i], x)?;
            if reserved[i] > int(classes[i].units)? {
                return Err(MathError::OverReservedUnits);
            }
        } else if d == 0 {
            return Err(MathError::InvalidAmount);
        }
    }
    let mut delta = vec![0i128; classes.len()];
    let (mut accepted, mut payable, mut refunds) = (0i128, 0i128, 0i128);
    let mut receipts = Vec::with_capacity(requests.len());
    let mut total_fees = 0i128;
    for (request, terms) in requests.iter().zip(fees) {
        let (from, to, x, deposit, minimum) = match request.operation {
            Operation::Deposit {
                to,
                amount,
                min_units,
            } => (None, Some(to), 0, amount as i128, min_units),
            Operation::Redeem {
                from,
                units,
                min_proceeds,
            } => (Some(from), None, int(units)?, 0, min_proceeds as u128),
            Operation::Switch {
                from,
                to,
                units,
                min_units,
            } => (Some(from), Some(to), int(units)?, 0, min_units),
        };
        let mut outcome = if publication_batch > request.expiry {
            Outcome::Expired
        } else {
            Outcome::Filled
        };
        let mut proceeds = 0;
        let mut minted = 0;
        let mut gross = 0;
        let mut fee = 0;
        if outcome == Outcome::Filled {
            if let Some(i) = from {
                proceeds = mul(x, classes[i].backing as i128)? / int(classes[i].units)?;
            }
            gross = if from.is_none() { deposit } else { proceeds };
            fee = terms.fee(amount(gross)?)? as i128;
            let input = gross - fee;
            if from.is_some() {
                proceeds = input;
            }
            if let Some(i) = to {
                let c = &classes[i];
                if c.units > 0 && c.backing == 0 {
                    outcome = Outcome::ZeroValueClass;
                } else {
                    minted = if c.units == 0 {
                        mul(input, SCALE)?
                    } else {
                        mul(input, int(c.units)?)? / c.backing as i128
                    };
                }
            }
            let output = if to.is_none() { proceeds } else { minted };
            if outcome == Outcome::Filled
                && (units(output)? < minimum || (to.is_some() && output == 0))
            {
                outcome = Outcome::ConditionFailed;
            }
        }
        if outcome != Outcome::Filled {
            refunds = add(refunds, deposit)?;
            receipts.push(Receipt {
                id: request.id.clone(),
                outcome,
                minted: 0,
                proceeds: 0,
                gross: amount(gross)?,
                fee: 0,
                fee_version: terms.version,
            });
            continue;
        }
        if let Some(i) = from {
            delta[i] = add(delta[i], -x)?;
        } else {
            accepted = add(accepted, deposit)?;
        }
        if let Some(i) = to {
            delta[i] = add(delta[i], minted)?;
        } else {
            payable = add(payable, proceeds)?;
        }
        total_fees = add(total_fees, fee)?;
        receipts.push(Receipt {
            id: request.id.clone(),
            outcome,
            minted: units(minted)?,
            proceeds: amount(proceeds)?,
            gross: amount(gross)?,
            fee: amount(fee)?,
            fee_version: terms.version,
        });
    }
    let result = classes
        .iter()
        .zip(delta)
        .map(|(c, d)| {
            let u = add(int(c.units)?, d)?;
            if u < 0 {
                return Err(MathError::OverReservedUnits);
            }
            let backing = if c.units == 0 {
                u / SCALE
            } else {
                mul(u, c.backing as i128)? / int(c.units)?
            };
            Ok(Class {
                units: units(u)?,
                backing: amount(backing)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let before = sum(classes.iter().map(|c| c.backing as i128))?;
    let after = sum(result.iter().map(|c| c.backing as i128))?;
    let residual = add(before, accepted)?
        .checked_sub(payable)
        .and_then(|v| v.checked_sub(after))
        .and_then(|v| v.checked_sub(total_fees))
        .ok_or(MathError::ArithmeticOverflow)?;
    if residual < 0 {
        return Err(MathError::InsolventBatch);
    }
    validate_classes(&result)?;
    Ok(BatchResult {
        classes: result,
        payable: amount(payable)?,
        refunds: amount(refunds)?,
        residual: amount(residual)?,
        accepted_deposits: amount(accepted)?,
        fees: amount(total_fees)?,
        receipts,
    })
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ledger {
    pub vault: u64,
    pub active: u64,
    pub pending: u64,
    pub payable: u64,
    pub residual: u64,
}
impl Ledger {
    pub fn validate(&self) -> Result<()> {
        if sum([
            self.active as i128,
            self.pending as i128,
            self.payable as i128,
            self.residual as i128,
        ])? != self.vault as i128
        {
            return Err(MathError::VaultMismatch);
        }
        Ok(())
    }
    pub fn deposit(&self, value: u64) -> Result<Self> {
        self.validate()?;
        let result = Self {
            vault: self
                .vault
                .checked_add(value)
                .ok_or(MathError::ArithmeticOverflow)?,
            pending: self
                .pending
                .checked_add(value)
                .ok_or(MathError::ArithmeticOverflow)?,
            ..self.clone()
        };
        result.validate()?;
        Ok(result)
    }
    pub fn withdraw(&self, value: u64) -> Result<Self> {
        self.validate()?;
        let result = Self {
            vault: self
                .vault
                .checked_sub(value)
                .ok_or(MathError::VaultMismatch)?,
            payable: self
                .payable
                .checked_sub(value)
                .ok_or(MathError::InsufficientPayable)?,
            ..self.clone()
        };
        result.validate()?;
        Ok(result)
    }
    pub fn refund(&self, value: u64) -> Result<Self> {
        self.validate()?;
        let result = Self {
            vault: self
                .vault
                .checked_sub(value)
                .ok_or(MathError::VaultMismatch)?,
            pending: self
                .pending
                .checked_sub(value)
                .ok_or(MathError::InsufficientPending)?,
            ..self.clone()
        };
        result.validate()?;
        Ok(result)
    }
    pub fn apply_revaluation(&self, result: &Revaluation) -> Result<Self> {
        self.validate()?;
        let active = amount(sum(result.classes.iter().map(|c| c.backing as i128))?)?;
        if add(active as i128, result.residual as i128)? != self.active as i128 {
            return Err(MathError::VaultMismatch);
        }
        let ledger = Self {
            active,
            residual: self
                .residual
                .checked_add(result.residual)
                .ok_or(MathError::ArithmeticOverflow)?,
            ..self.clone()
        };
        ledger.validate()?;
        Ok(ledger)
    }
    pub fn apply_batch(&self, result: &BatchResult) -> Result<Self> {
        self.validate()?;
        let ledger = Self {
            active: amount(sum(result.classes.iter().map(|c| c.backing as i128))?)?,
            pending: self
                .pending
                .checked_sub(result.accepted_deposits)
                .ok_or(MathError::InsufficientPending)?,
            payable: self
                .payable
                .checked_add(result.payable)
                .ok_or(MathError::ArithmeticOverflow)?,
            residual: self
                .residual
                .checked_add(result.residual)
                .ok_or(MathError::ArithmeticOverflow)?,
            ..self.clone()
        };
        ledger.validate()?;
        Ok(ledger)
    }
}
fn string_bytes(out: &mut Vec<u8>, value: &str) -> Result<()> {
    out.extend_from_slice(
        &u32::try_from(value.len())
            .map_err(|_| MathError::ArithmeticOverflow)?
            .to_le_bytes(),
    );
    out.extend_from_slice(value.as_bytes());
    Ok(())
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Price {
    pub asset_id: String,
    pub venue: u8,
    pub step: u8,
    pub candle_start: u64,
    pub price_e8: u64,
    pub trade_age_minutes: u16,
}
pub fn price_bytes(price: &Price) -> Result<Vec<u8>> {
    if price.asset_id.is_empty()
        || price.asset_id.len() > 16
        || !price.asset_id.bytes().all(|b| b.is_ascii_uppercase())
        || price.price_e8 == 0
        || price.trade_age_minutes > 30
        || price.candle_start % 60 != 0
        || (price.step != 4 && price.trade_age_minutes != 0)
        || !matches!((price.venue, price.step), (0, 1) | (0, 4) | (1, 2) | (2, 3))
    {
        return Err(MathError::InvalidPrice);
    }
    let mut bytes = Vec::new();
    string_bytes(&mut bytes, "COX/PRICE/V1")?;
    string_bytes(&mut bytes, &price.asset_id)?;
    bytes.push(price.venue);
    bytes.push(price.step);
    bytes.extend_from_slice(&price.candle_start.to_le_bytes());
    bytes.extend_from_slice(&price.price_e8.to_le_bytes());
    bytes.extend_from_slice(&price.trade_age_minutes.to_le_bytes());
    Ok(bytes)
}
pub fn snapshot_bytes(cutoff: u64, prices: &[Price], roster: &[String]) -> Result<Vec<u8>> {
    if cutoff == 0
        || cutoff % 60 != 0
        || prices.len() != roster.len()
        || !(2..=30).contains(&roster.len())
        || roster.iter().collect::<HashSet<_>>().len() != roster.len()
    {
        return Err(MathError::InvalidSnapshot);
    }
    let mut bytes = Vec::new();
    string_bytes(&mut bytes, "COX/SNAPSHOT/V1")?;
    bytes.extend_from_slice(&cutoff.to_le_bytes());
    bytes.extend_from_slice(&(prices.len() as u32).to_le_bytes());
    for (p, id) in prices.iter().zip(roster) {
        if &p.asset_id != id
            || cutoff.checked_sub(60 + 60 * p.trade_age_minutes as u64) != Some(p.candle_start)
        {
            return Err(MathError::InvalidSnapshot);
        }
        bytes.extend_from_slice(&artifact_digest(&price_bytes(p)?));
    }
    Ok(bytes)
}
