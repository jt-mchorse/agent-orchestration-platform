/**
 * Exact rational arithmetic for the eval scores (#163).
 *
 * Every input to a review score is an integer count (recommendation 0/1,
 * matched / reported / golden findings, summary lengths) and every weight is a
 * whole number of tenths, so a composite -- and a mean of composites -- is an
 * exact rational. Computing it in floats left an exact 0.65 at
 * 0.6499999999999999, below the `>= 0.65` band it belongs in; D-017 then
 * printed that error faithfully. Here the value is exact until one final,
 * correctly rounded conversion.
 */

export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function rational(n: number | bigint, d: number | bigint = 1): Rational {
  let nn = BigInt(n);
  let dd = BigInt(d);
  if (dd === 0n) throw new RangeError("zero denominator");
  if (dd < 0n) [nn, dd] = [-nn, -dd];
  const g = gcd(nn, dd) || 1n;
  return { n: nn / g, d: dd / g };
}

export function add(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function scale(a: Rational, num: number, den: number): Rational {
  return rational(a.n * BigInt(num), a.d * BigInt(den));
}

/**
 * The double nearest to `r` (ties to even), from one rounding step.
 *
 * `Number(n) / Number(d)` is correctly rounded only while both fit in 2**53. For
 * larger operands this takes a quotient with at least 64 significant bits, ORs
 * the remainder into its lowest bit (a sticky bit, so a value just above a
 * halfway point cannot round as if it were exactly halfway), and lets
 * `Number()` do the single rounding to 53 bits.
 */
export function toDouble(r: Rational): number {
  const { n, d } = r;
  if (n === 0n) return 0;
  const LIMIT = 2n ** 53n;
  const absN = n < 0n ? -n : n;
  if (absN <= LIMIT && d <= LIMIT) return Number(n) / Number(d);
  const neg = n < 0n;
  // Scale so the integer quotient carries >= 64 bits.
  let shift = 0n;
  while ((absN << shift) / d < 2n ** 64n) shift += 1n;
  const scaled = absN << shift;
  let q = scaled / d;
  if (scaled % d !== 0n) q |= 1n;
  const v = Number(q) / 2 ** Number(shift);
  return neg ? -v : v;
}
