use crate::{add, mul, rounded_div, MathError, Reference, Result, SCALE};

const PRECISION: i128 = 1_000_000_000_000_000_000;
pub const MAX_GEOMETRIC_ASSETS: usize = 256;

fn validate(anchor: &[u64], current: &[u64], anchor_level: i128) -> Result<()> {
    if !(2..=MAX_GEOMETRIC_ASSETS).contains(&anchor.len())
        || anchor.len() != current.len()
        || anchor_level <= 0
        || anchor.iter().chain(current).any(|price| *price == 0)
    {
        return Err(MathError::InvalidReferenceInput);
    }
    Ok(())
}

fn log2(price: u64) -> Result<i128> {
    let mut value = mul(i128::from(price), PRECISION)?;
    let mut result = 0;
    while value >= 2 * PRECISION {
        value /= 2;
        result = add(result, PRECISION)?;
    }
    let mut bit = PRECISION / 2;
    while bit > 0 {
        value = mul(value, value)? / PRECISION;
        if value >= 2 * PRECISION {
            value /= 2;
            result = add(result, bit)?;
        }
        bit /= 2;
    }
    Ok(result)
}

fn sqrt(value: i128) -> i128 {
    let mut low = 0;
    let mut high = value.min(2 * PRECISION) + 1;
    while high - low > 1 {
        let mid = low + (high - low) / 2;
        if mid <= value / mid {
            low = mid;
        } else {
            high = mid;
        }
    }
    low
}

fn exp2_level(exponent: i128, anchor_level: i128) -> Result<i128> {
    let whole = exponent.div_euclid(PRECISION);
    let mut fraction = exponent.rem_euclid(PRECISION);
    let mut factor = PRECISION;
    let mut root = 2 * PRECISION;
    let mut bit = PRECISION / 2;
    while bit > 0 {
        root = sqrt(mul(root, PRECISION)?);
        if fraction >= bit {
            fraction -= bit;
            factor = mul(factor, root)? / PRECISION;
        }
        bit /= 2;
    }
    let numerator = mul(anchor_level, factor)?;
    let level = if whole >= 0 {
        let multiplier = 1_i128
            .checked_shl(u32::try_from(whole).map_err(|_| MathError::ArithmeticOverflow)?)
            .filter(|value| *value > 0)
            .ok_or(MathError::ArithmeticOverflow)?;
        add(
            mul(numerator / PRECISION, multiplier)?,
            rounded_div(mul(numerator % PRECISION, multiplier)?, PRECISION)?,
        )?
    } else {
        let divisor = 1_i128
            .checked_shl(u32::try_from(-whole).map_err(|_| MathError::ArithmeticOverflow)?)
            .filter(|value| *value > 0)
            .ok_or(MathError::ArithmeticOverflow)?;
        rounded_div(numerator, mul(PRECISION, divisor)?)?
    };
    if level <= 0 {
        return Err(MathError::InvalidBenchmark);
    }
    Ok(level)
}

pub fn geometric_level(anchor: &[u64], current: &[u64], anchor_level: i128) -> Result<i128> {
    validate(anchor, current, anchor_level)?;
    if anchor.iter().zip(current).all(|(a, c)| {
        u128::from(*c) * u128::from(anchor[0]) == u128::from(*a) * u128::from(current[0])
    }) {
        let level = rounded_div(
            mul(anchor_level, i128::from(current[0]))?,
            i128::from(anchor[0]),
        )?;
        return if level > 0 {
            Ok(level)
        } else {
            Err(MathError::InvalidBenchmark)
        };
    }
    let total = anchor.iter().zip(current).try_fold(0, |acc, (a, c)| {
        add(acc, log2(*c)? - log2(*a)?)
    })?;
    exp2_level(rounded_div(total, anchor.len() as i128)?, anchor_level)
}

pub fn fixed_basket_level(anchor: &[u64], current: &[u64], anchor_level: i128) -> Result<i128> {
    validate(anchor, current, anchor_level)?;
    let total = anchor.iter().zip(current).try_fold(0, |acc, (a, c)| {
        add(
            acc,
            rounded_div(mul(i128::from(*c), SCALE)?, i128::from(*a))?,
        )
    })?;
    let level = rounded_div(
        mul(anchor_level, total)?,
        mul(SCALE, anchor.len() as i128)?,
    )?;
    if level <= 0 {
        return Err(MathError::InvalidBenchmark);
    }
    Ok(level)
}

pub fn geometric_reference(
    previous: &[u64],
    current: &[u64],
    anchor: &[u64],
    anchor_level: i128,
) -> Result<Reference> {
    validate(anchor, previous, anchor_level)?;
    let benchmark = geometric_level(anchor, current, anchor_level)?;
    let previous_benchmark = geometric_level(anchor, previous, anchor_level)?;
    let benchmark_gross = rounded_div(mul(benchmark, SCALE)?, previous_benchmark)?;
    if benchmark_gross <= 0 {
        return Err(MathError::InvalidBenchmark);
    }
    let gross = current
        .iter()
        .zip(previous)
        .map(|(c, p)| rounded_div(mul(i128::from(*c), SCALE)?, i128::from(*p)))
        .collect::<Result<Vec<_>>>()?;
    let benchmark_ratio = rounded_div(mul(benchmark, SCALE)?, anchor_level)?;
    if benchmark_ratio <= 0 || gross.iter().any(|value| *value <= 0) {
        return Err(MathError::InvalidBenchmark);
    }
    let relative = current
        .iter()
        .zip(anchor)
        .map(|(c, a)| {
            let normalized = rounded_div(mul(i128::from(*c), SCALE)?, i128::from(*a))?;
            let value = rounded_div(mul(100 * SCALE, normalized)?, benchmark_ratio)?;
            if value <= 0 {
                return Err(MathError::InvalidBenchmark);
            }
            Ok(value)
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
