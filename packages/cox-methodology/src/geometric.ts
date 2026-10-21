import { round } from "./index.ts";

const PRECISION = 1_000_000_000_000_000_000n;
const MAX_PRICE = (1n << 64n) - 1n;
const MAX_SIGNED = (1n << 127n) - 1n;
const MIN_SIGNED = -(1n << 127n);
export const MAX_GEOMETRIC_ASSETS = 256;

function checked(value: bigint): bigint {
  if (value < MIN_SIGNED || value > MAX_SIGNED) throw new Error("ArithmeticOverflow");
  return value;
}
const multiply = (a: bigint, b: bigint): bigint => checked(a * b);
function log2(price: bigint): bigint {
  let value = multiply(price, PRECISION);
  let result = 0n;
  while (value >= 2n * PRECISION) {
    value /= 2n;
    result = checked(result + PRECISION);
  }
  for (let bit = PRECISION / 2n; bit > 0n; bit /= 2n) {
    value = multiply(value, value) / PRECISION;
    if (value >= 2n * PRECISION) {
      value /= 2n;
      result = checked(result + bit);
    }
  }
  return result;
}
function sqrt(value: bigint): bigint {
  let low = 0n;
  let high = (value < 2n * PRECISION ? value : 2n * PRECISION) + 1n;
  while (high - low > 1n) {
    const mid = low + (high - low) / 2n;
    if (mid <= value / mid) low = mid;
    else high = mid;
  }
  return low;
}
function exp2Level(exponent: bigint, anchorLevel: bigint): bigint {
  const whole = exponent >= 0n ? exponent / PRECISION : -((-exponent + PRECISION - 1n) / PRECISION);
  let fraction = exponent - whole * PRECISION;
  let factor = PRECISION;
  let root = 2n * PRECISION;
  for (let bit = PRECISION / 2n; bit > 0n; bit /= 2n) {
    root = sqrt(multiply(root, PRECISION));
    if (fraction >= bit) {
      fraction -= bit;
      factor = multiply(factor, root) / PRECISION;
    }
  }
  const numerator = multiply(anchorLevel, factor);
  const magnitude = whole >= 0n ? whole : -whole;
  if (magnitude >= 127n) throw new Error("ArithmeticOverflow");
  const shift = 1n << magnitude;
  const result = whole >= 0n
    ? checked(multiply(numerator / PRECISION, shift) + round(multiply(numerator % PRECISION, shift), PRECISION))
    : round(numerator, multiply(PRECISION, shift));
  if (result <= 0n) throw new Error("InvalidBenchmark");
  return result;
}
export function geometricBenchmark(anchor: readonly bigint[], current: readonly bigint[], anchorLevel: bigint): bigint {
  if (anchor.length < 2 || anchor.length > MAX_GEOMETRIC_ASSETS || anchor.length !== current.length
      || anchorLevel <= 0n || anchorLevel > MAX_SIGNED
      || [...anchor, ...current].some(price => price <= 0n || price > MAX_PRICE)) throw new Error("InvalidReferenceInput");
  if (anchor.every((price, index) => current[index]! * anchor[0]! === price * current[0]!)) {
    const result = round(multiply(anchorLevel, current[0]!), anchor[0]!);
    if (result <= 0n) throw new Error("InvalidBenchmark");
    return result;
  }
  let total = 0n;
  for (let index = 0; index < anchor.length; index++) total = checked(total + log2(current[index]!) - log2(anchor[index]!));
  return exp2Level(round(total, BigInt(anchor.length)), anchorLevel);
}
