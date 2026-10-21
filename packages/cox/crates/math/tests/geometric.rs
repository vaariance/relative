use cox_math::{geometric::{fixed_basket_level, geometric_level, geometric_reference}, reference, revalue, Class, MathError, SCALE};

#[test]
fn geometric_candidates_support_expanded_universe_without_changing_legacy_limits() {
    for count in [32, 256] {
        let anchor = vec![1_000_000_u64; count];
        let current: Vec<_> = (0..count).map(|i| 900_000 + 1000 * i as u64).collect();
        let level = geometric_level(&anchor, &current, 100 * SCALE).unwrap();
        let oracle = (current.iter().map(|p| (*p as f64 / 1_000_000.0).ln()).sum::<f64>() / count as f64).exp();
        assert!((level as f64 / (100 * SCALE) as f64 - oracle).abs() < 1e-11);
        let mut reversed = current.clone();
        reversed.reverse();
        assert_eq!(level, geometric_level(&anchor, &reversed, 100 * SCALE).unwrap());
        assert!(fixed_basket_level(&anchor, &current, 100 * SCALE).unwrap() >= level);
        assert_eq!(reference(&anchor, &current, &anchor, 100 * SCALE), Err(MathError::InvalidReferenceInput));
    }
}

#[test]
fn anchored_levels_match_independent_examples() {
    for (current, expected) in [([110, 110], 110_000_000_000_000), ([110, 90], 99_498_743_710_662), ([200, 100], 141_421_356_237_310), ([200, 50], 100 * SCALE), ([50, 100], 70_710_678_118_655)] {
        let actual = geometric_level(&[100, 100], &current, 100 * SCALE).unwrap();
        assert!((actual - expected).abs() <= 2, "{current:?}: {actual} != {expected}");
    }
    assert_eq!(fixed_basket_level(&[100, 100], &[200, 50], 100 * SCALE), Ok(125 * SCALE));
}

#[test]
fn intermediate_publications_do_not_change_anchored_endpoint() {
    let anchor = [100, 100];
    let middle = [110, 90];
    let arithmetic_mid = reference(&anchor, &middle, &anchor, 100 * SCALE).unwrap();
    let arithmetic_end = reference(&middle, &anchor, &anchor, arithmetic_mid.benchmark).unwrap();
    let direct = geometric_reference(&anchor, &anchor, &anchor, 100 * SCALE).unwrap();
    let via_middle = geometric_reference(&middle, &anchor, &anchor, 100 * SCALE).unwrap();
    assert_eq!(direct.benchmark, via_middle.benchmark);
    assert_eq!(direct.relative, via_middle.relative);
    assert_eq!(direct.benchmark, 100 * SCALE);
    assert_eq!(arithmetic_end.benchmark, 101_010_101_010_100);
    assert_ne!(direct.h, via_middle.h);
}

#[test]
fn intermediate_basic_revaluations_preserve_value_with_explicit_rounding_residual() {
    let classes = vec![Class {backing: 100_000_000, units: SCALE as u128}; 3];
    let anchor = [100, 100];
    let middle = [200, 50];
    let step = geometric_reference(&anchor, &middle, &anchor, 100 * SCALE).unwrap();
    let first = revalue(&classes, &step.h).unwrap();
    let final_step = geometric_reference(&middle, &anchor, &anchor, 100 * SCALE).unwrap();
    let second = revalue(&first.classes, &final_step.h).unwrap();
    let direct_step = geometric_reference(&anchor, &anchor, &anchor, 100 * SCALE).unwrap();
    let direct = revalue(&classes, &direct_step.h).unwrap();
    let sum = second.classes.iter().map(|c| c.backing).sum::<u64>();
    assert_eq!(sum + first.residual + second.residual, 300_000_000);
    for (chained, once) in second.classes.iter().zip(&direct.classes) {
        assert!(chained.backing.abs_diff(once.backing) <= 3);
    }
}

#[test]
fn all_positive_equal_returns_preserve_basic_shares_and_relative_references() {
    let result = geometric_reference(&[100, 200], &[110, 220], &[100, 200], 100 * SCALE).unwrap();
    assert_eq!(result.benchmark, 110 * SCALE);
    assert_eq!(result.relative, vec![100 * SCALE; 2]);
    assert_eq!(result.h, vec![SCALE; 3]);
    let classes = vec![Class {backing: 1000, units: 1000}; 3];
    assert_eq!(revalue(&classes, &result.h).unwrap().classes, classes);
}

#[test]
fn full_roster_revaluation_conserves_every_collateral_unit() {
    let anchor = vec![1_000_000; 30];
    for sample in 1..=100_u64 {
        let current: Vec<_> = (0..30).map(|i| 200_000 + ((i * 137_991 + sample * 91_333) % 2_000_000)).collect();
        let result = geometric_reference(&anchor, &current, &anchor, 100 * SCALE).unwrap();
        let classes: Vec<_> = (0..31).map(|i| Class {backing: 1_000_000 + i * 10_000, units: SCALE as u128}).collect();
        let before: u64 = classes.iter().map(|c| c.backing).sum();
        let after = revalue(&classes, &result.h).unwrap();
        assert_eq!(before, after.classes.iter().map(|c| c.backing).sum::<u64>() + after.residual);
        assert!(after.classes.iter().zip(&classes).all(|(a,b)| a.units == b.units));
        let oracle = (current.iter().map(|c| (*c as f64 / 1_000_000.0).ln()).sum::<f64>() / 30.0).exp();
        let observed = result.benchmark as f64 / (100 * SCALE) as f64;
        assert!((observed - oracle).abs() < 1e-11);
    }
}

#[test]
fn changing_anchor_requires_an_explicit_continuity_level() {
    let old_anchor = [100, 100];
    let current = [200, 100];
    let old_level = geometric_level(&old_anchor, &current, 100 * SCALE).unwrap();
    let next_anchor = [200, 100, 50];
    assert_eq!(geometric_level(&next_anchor, &next_anchor, old_level), Ok(old_level));
}

#[test]
fn rejects_zero_mismatched_and_unsupported_inputs() {
    for (anchor, current) in [(vec![1], vec![1]), (vec![1,1], vec![1]), (vec![1,0], vec![1,1]), (vec![1,1], vec![0,1]), (vec![1;257], vec![1;257])] {
        assert_eq!(geometric_level(&anchor, &current, 100 * SCALE), Err(MathError::InvalidReferenceInput));
    }
    assert_eq!(geometric_level(&[1,1], &[1,1], 0), Err(MathError::InvalidReferenceInput));
    assert_eq!(geometric_level(&[1,1], &[2,2], i128::MAX), Err(MathError::ArithmeticOverflow));
    assert_eq!(geometric_level(&[u64::MAX;2], &[1;2], 1), Err(MathError::InvalidBenchmark));
}

#[test]
fn reciprocal_extremes_and_asset_order_are_consistent() {
    let anchor = [1, u64::MAX];
    let current = [u64::MAX, 1];
    assert_eq!(geometric_level(&anchor, &current, 100 * SCALE), Ok(100 * SCALE));
    let values = [7, 19, 1001, 100_000];
    let next = [100, 20, 7, 200_000];
    let mut reversed_values = values;
    reversed_values.reverse();
    let mut reversed_next = next;
    reversed_next.reverse();
    assert_eq!(geometric_level(&values, &next, 100 * SCALE), geometric_level(&reversed_values, &reversed_next, 100 * SCALE));
}

#[test]
fn seeded_full_u64_price_ranges_match_90_digit_decimal_reference() {
    let expected: [i128; 96] = [
        6,
        15771847045,
        412473893788,
        5625220879268,
        575003274016343,
        1057657897948228,
        160579846063,
        11188996986503445,
        3547538006774,
        93156792086841,
        30794532230404,
        623528064350016334,
        42654119244,
        7418808078448,
        4806020430996956,
        61066377176698236,
        52153081044,
        3091578301913159,
        41878859987539,
        11025204083530294,
        33221546405250916,
        8459984221915,
        2410334286240460,
        10671346417190630,
        3730915992452782,
        1954877901078816,
        113395472432352869,
        69519669913393,
        3501217700324439,
        5650243230,
        3628063321391941188,
        7826617717063853727,
        26749263443016,
        321740363161739,
        4152058854189,
        6320988820489835992,
        8247880483715,
        7976216870498847,
        72279298210110402,
        5598290076184653117,
        62885123948,
        2901320673,
        47677387504081,
        346800784867990,
        15796079768580,
        5354111491773,
        186311304960428,
        10113621823621,
        38265018964222,
        4930765512534702,
        7149684376220965,
        3216195013117,
        38069216821162,
        30604113106993,
        29520406811377,
        1881654386297392,
        955423245361,
        1118855186829742,
        26393153590238629782,
        72327200,
        18394644245,
        60299963411,
        17696975904850,
        30197663327093396,
        324635690003025,
        1563869582672,
        350486133313671,
        129178183106,
        12059645394894,
        8716715044897,
        123092583169139,
        5975335694303434,
        138334490953138,
        3274720724688,
        22483750822727639,
        503978613945938,
        14195012248645547308,
        160532187983,
        22379426813962638,
        9742777442457,
        46015425395017,
        72468779124,
        110685081554562,
        377503454081780,
        437015283185776,
        30954265940866,
        10008349336007,
        4034122092508320519,
        359134126,
        1786692949518880,
        8083689152,
        1976790245647,
        5270338611130622613,
        4654671975651220,
        2622309700141,
        7855374964066
    ];
    let mut state = 0x824910017_u64;
    let mut next_price = || {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let exponent = 1 + state % 19;
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        1 + state % 10_u64.pow(exponent as u32)
    };
    for (sample, expected) in expected.into_iter().enumerate() {
        let n = 2 + sample % 29;
        let anchor: Vec<_> = (0..n).map(|_| next_price()).collect();
        let current: Vec<_> = (0..n).map(|_| next_price()).collect();
        let actual = geometric_level(&anchor, &current, 100 * SCALE).unwrap();
        let tolerance = 2.max(expected / 100_000_000_000_000);
        assert!((actual - expected).abs() <= tolerance, "sample {sample}: {actual} != {expected}, tolerance {tolerance}");
    }
}

#[test]
fn thirty_near_neutral_assets_remain_monotone_at_output_precision() {
    let anchor = vec![1_000_000_000_000_u64; 30];
    let mut current = anchor.clone();
    let mut last = 100 * SCALE;
    for i in 0..30 {
        current[i] += 1;
        let next = geometric_level(&anchor, &current, 100 * SCALE).unwrap();
        assert!(next >= last);
        assert!(next <= 100 * SCALE + 100);
        last = next;
    }
    assert_eq!(last, 100 * SCALE + 100);
}
