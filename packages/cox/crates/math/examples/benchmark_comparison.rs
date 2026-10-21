use cox_math::{
    geometric::{fixed_basket_level, geometric_level, geometric_reference},
    reference, revalue, Class, SCALE,
};
use serde_json::json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let anchor = [100_u64, 100];
    let cases = [
        ("common_gain", [110, 110]),
        ("opposing_ten_percent", [110, 90]),
        ("one_doubles", [200, 100]),
        ("doubling_and_halving", [200, 50]),
        ("one_halves", [50, 100]),
    ];
    let mut scenarios = Vec::new();
    for (name, current) in cases {
        let arithmetic = reference(&anchor, &current, &anchor, 100 * SCALE)?;
        let geometric = geometric_reference(&anchor, &current, &anchor, 100 * SCALE)?;
        let classes = vec![Class { backing: 100_000_000, units: SCALE as u128 }; 3];
        let marked = revalue(&classes, &geometric.h)?;
        scenarios.push(json!({
            "name": name,
            "prices": current,
            "arithmetic": arithmetic.benchmark.to_string(),
            "fixedBasket": fixed_basket_level(&anchor, &current, 100 * SCALE)?.to_string(),
            "geometric": geometric.benchmark.to_string(),
            "assetReferences": geometric.relative.iter().map(ToString::to_string).collect::<Vec<_>>(),
            "basicBacking": marked.classes.iter().map(|c| c.backing).collect::<Vec<_>>(),
            "basicResidual": marked.residual,
            "basicConserved": marked.classes.iter().map(|c| c.backing).sum::<u64>() + marked.residual == 300_000_000,
        }));
    }
    let middle = [110, 90];
    let arithmetic_middle = reference(&anchor, &middle, &anchor, 100 * SCALE)?;
    let arithmetic_end = reference(&middle, &anchor, &anchor, arithmetic_middle.benchmark)?;
    println!("{}", serde_json::to_string_pretty(&json!({
        "researchOnly": true,
        "scale": SCALE.to_string(),
        "anchorLevel": (100 * SCALE).to_string(),
        "rounding": "integer log2 and exp2 at 1e18 internal precision; half-away-from-zero output division",
        "scenarios": scenarios,
        "roundTrip": {
            "arithmeticWithMiddlePublication": arithmetic_end.benchmark.to_string(),
            "arithmeticWithoutMiddlePublication": (100 * SCALE).to_string(),
            "geometricWithMiddlePublication": geometric_level(&anchor, &anchor, 100 * SCALE)?.to_string(),
            "geometricWithoutMiddlePublication": geometric_level(&anchor, &anchor, 100 * SCALE)?.to_string(),
        },
        "limitations": [
            "Synthetic inputs do not establish economically safe methodology",
            "Constituent identities and oracle authentication are validated outside this arithmetic module",
            "No production program uses these candidate calculations",
            "Roster changes require an explicitly approved new anchor and continuity level",
            "Repeated pool revaluations can accumulate collateral rounding residuals"
        ]
    }))?);
    Ok(())
}
