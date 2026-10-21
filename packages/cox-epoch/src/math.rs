use crate::{Error, Result, BASKET_SIZE};

pub const SCALE: u128 = 1_000_000_000_000;
pub const FEE_BPS: u64 = 2;
pub const FEE_CAP: u64 = 200_000;
pub const COLLATERAL_DECIMALS: u8 = 6;
pub const MAX_REFERENCE: u128 = 1_000_000_000_000_000_000_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoundingPolicy {
    FloorEachPriceRatioThenRelativeReferenceV1,
    FloorEachPositiveReturnThenScoreV1,
    FloorPayoutWithEpochResidualV1,
}

pub fn fee(gross: u64) -> Result<u64> {
    if gross == 0 {
        return Err(Error::InvalidStake);
    }
    Ok(((gross as u128 * FEE_BPS as u128 / 10_000) as u64).min(FEE_CAP))
}

pub fn relative_reference(price: u128, origin_price: u128, benchmark: u128, origin_benchmark: u128) -> Result<u128> {
    for value in [price, origin_price, benchmark, origin_benchmark] {
        if value == 0 || value > MAX_REFERENCE {
            return Err(Error::InvalidReference);
        }
    }
    let asset_ratio = mul_div_floor(price, SCALE, origin_price)?;
    let benchmark_ratio = mul_div_floor(benchmark, SCALE, origin_benchmark)?;
    if benchmark_ratio == 0 {
        return Err(Error::InvalidReference);
    }
    let reference = mul_div_floor(asset_ratio, SCALE, benchmark_ratio)?;
    if reference == 0 || reference > MAX_REFERENCE {
        return Err(Error::InvalidReference);
    }
    Ok(reference)
}

pub fn score(entry: &[u128; BASKET_SIZE], close: &[u128; BASKET_SIZE], backed_index: usize) -> Result<u128> {
    if backed_index >= BASKET_SIZE {
        return Err(Error::InvalidBasket);
    }
    let mut positive_sum = 0u128;
    let mut backed_return = 0u128;
    for index in 0..BASKET_SIZE {
        if entry[index] == 0 || close[index] == 0 || entry[index] > MAX_REFERENCE || close[index] > MAX_REFERENCE {
            return Err(Error::InvalidReference);
        }
        let positive = if close[index] > entry[index] {
            mul_div_floor(close[index] - entry[index], SCALE, entry[index])?
        } else {
            0
        };
        positive_sum = positive_sum.checked_add(positive).ok_or(Error::Overflow)?;
        if index == backed_index {
            backed_return = positive;
        }
    }
    if positive_sum == 0 {
        return Ok(0);
    }
    mul_div_floor(backed_return, SCALE, positive_sum)
}

pub fn weight(net_stake: u64, score: u128) -> Result<u128> {
    if score > SCALE {
        return Err(Error::InvalidScore);
    }
    (net_stake as u128).checked_mul(score).ok_or(Error::Overflow)
}

pub fn payout(pot: u64, entry_weight: u128, total_weight: u128) -> Result<u64> {
    if total_weight == 0 || entry_weight > total_weight {
        return Err(Error::InvalidScore);
    }
    u64::try_from(mul_div_floor(pot as u128, entry_weight, total_weight)?).map_err(|_| Error::Overflow)
}

pub fn mul_div_floor(a: u128, b: u128, denominator: u128) -> Result<u128> {
    if denominator == 0 {
        return Err(Error::DivisionByZero);
    }
    if let Some(product) = a.checked_mul(b) {
        return Ok(product / denominator);
    }
    let mask = u64::MAX as u128;
    let a0 = a & mask;
    let a1 = a >> 64;
    let b0 = b & mask;
    let b1 = b >> 64;
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let middle = (p00 >> 64) + (p01 & mask) + (p10 & mask);
    let low = (p00 & mask) | ((middle & mask) << 64);
    let high = p11 + (p01 >> 64) + (p10 >> 64) + (middle >> 64);
    let mut remainder = 0u128;
    let mut quotient = 0u128;
    for index in (0..256).rev() {
        let bit = if index >= 128 { (high >> (index - 128)) & 1 } else { (low >> index) & 1 };
        let carry = remainder >> 127;
        remainder = (remainder << 1) | bit;
        if carry != 0 || remainder >= denominator {
            remainder = remainder.wrapping_sub(denominator);
            if index >= 128 {
                return Err(Error::Overflow);
            }
            quotient |= 1u128 << index;
        }
    }
    Ok(quotient)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_products_have_exact_floor_results() {
        assert_eq!(mul_div_floor(u128::MAX, u128::MAX, u128::MAX), Ok(u128::MAX));
        assert_eq!(mul_div_floor(u128::MAX, 2, 2), Ok(u128::MAX));
        assert_eq!(mul_div_floor(u128::MAX, u128::MAX - 1, u128::MAX), Ok(u128::MAX - 1));
        assert_eq!(mul_div_floor(u128::MAX, u128::MAX, 1), Err(Error::Overflow));
        assert_eq!(mul_div_floor(1, 2, 0), Err(Error::DivisionByZero));
        assert_eq!(mul_div_floor(5, 3, 2), Ok(7));
        assert_eq!(mul_div_floor(u128::MAX - 1, u128::MAX - 1, u128::MAX), Ok(u128::MAX - 2));
        assert_eq!(mul_div_floor(u128::MAX, 1_000, u128::MAX - 1), Ok(1_000));
        let mut state = 123_456_789u128;
        for _ in 0..10_000 {
            state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let divisor = (state >> 64).max(1);
            let factor = (state & (u64::MAX as u128)).max(1);
            assert_eq!(mul_div_floor(divisor, factor << 64, divisor), Ok(factor << 64));
        }
    }

    #[test]
    fn bounded_fixed_point_scores_handle_extremes_without_fraction_growth() {
        let entry = [1; BASKET_SIZE];
        let mut close = [MAX_REFERENCE; BASKET_SIZE];
        assert_eq!(score(&entry, &close, 0), Ok(SCALE / BASKET_SIZE as u128));
        close = [1; BASKET_SIZE];
        close[0] = MAX_REFERENCE;
        assert_eq!(score(&entry, &close, 0), Ok(SCALE));
        assert_eq!(payout(u64::MAX, u64::MAX as u128 * SCALE, u64::MAX as u128 * SCALE), Ok(u64::MAX));
    }
}
