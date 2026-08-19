/**
 * Valuation and decimal normalisation, taken by a different route from the
 * agent's.
 *
 * The agent under test values a position in two steps and floors at the
 * intermediate: `vTokenBalance -> underlying -> USD`. This model multiplies
 * through and divides once, keeping the fraction of a base unit the two-step
 * route discards. Both are defensible; the point of running both is that a
 * scale error in one does not reproduce itself in the other, so the
 * disagreement surfaces instead of being certified.
 *
 * The difference between them is bounded and tiny — under one base unit of the
 * underlying, which on a 6-decimal stablecoin is a millionth of a dollar — so
 * it never decides anything. That is deliberate. The gap has to be small enough
 * that it cannot flip a verdict and visible enough that nobody mistakes the two
 * routes for one.
 *
 * What must be exact is the decision, and it is: `allocation.ts` compares
 * weights by cross-multiplication with no division at all, so the drift trigger
 * fires at the same portfolio state on both sides rather than merely near it. A
 * tolerance that had to absorb a boundary disagreement would be the thing
 * hiding the bug this architecture exists to catch.
 *
 * Everything is integer `bigint`. These numbers become the basis of a published
 * verdict, and floating point would put a half-ulp of disagreement between the
 * artifact and the chain.
 */

/** Fixed-point one. Exchange rates, oracle scales and USD figures all live here. */
export const MANTISSA = 10n ** 18n;

export const BASIS_POINTS = 10_000n;

export class RebalancingScaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RebalancingScaleError";
  }
}

/** The scale `getUnderlyingPrice` returns for a token with this many decimals. */
export function oracleScaleFor(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RebalancingScaleError(`underlying decimals out of range: ${decimals}`);
  }
  return 10n ** BigInt(36 - decimals);
}

/**
 * Is this price consistent with the decimals it was read against?
 *
 * Returns a verdict rather than throwing. This model has to be able to report
 * "the portfolio could not be valued" as a state; an exception here would
 * collapse that into a crash, and a crashed evaluator says nothing about the
 * agent at all.
 */
export function isPlausiblePrice(priceMantissa: bigint, decimals: number): boolean {
  if (priceMantissa <= 0n) return false;
  const millionths = (priceMantissa * 1_000_000n) / oracleScaleFor(decimals);
  return millionths >= 100n && millionths <= 1_000_000_000_000n;
}

/**
 * USD at 1e18 for a raw token amount.
 *
 * `amount` carries `decimals` digits and `priceMantissa` carries `36 - decimals`,
 * so the product sits at 1e36 for every token and one division lands on 1e18.
 */
export function toUsd(amount: bigint, priceMantissa: bigint): bigint {
  return (amount * priceMantissa) / MANTISSA;
}

/**
 * USD at 1e18 for a vToken balance, without materialising the underlying.
 *
 * `vTokenBalance * exchangeRate * price / 1e36`, in that order, with a single
 * division at the end. The agent converts to underlying first and floors there.
 * On a portfolio whose weights are ratios between markets, an intermediate
 * floor applied once per market is a systematic bias rather than noise, so
 * keeping the remainder here is the more careful of the two routes as well as
 * the different one.
 */
export function vTokenToUsd(
  vTokenBalance: bigint,
  exchangeRateMantissa: bigint,
  priceMantissa: bigint,
): bigint {
  return (vTokenBalance * exchangeRateMantissa * priceMantissa) / (MANTISSA * MANTISSA);
}

/** Raw token units for a USD amount at 1e18, rounded down. */
export function fromUsdFloor(usdMantissa: bigint, priceMantissa: bigint): bigint {
  if (priceMantissa <= 0n) {
    throw new RebalancingScaleError(`price must be positive, received ${priceMantissa}`);
  }
  if (usdMantissa <= 0n) return 0n;
  return (usdMantissa * MANTISSA) / priceMantissa;
}

/**
 * Absolute difference between two figures, in basis points of `reference`.
 *
 * `null` when the reference is zero, because a proportional disagreement with
 * nothing is not a number.
 */
export function differenceBps(observed: bigint, reference: bigint): bigint | null {
  if (reference === 0n) return null;
  const delta = observed > reference ? observed - reference : reference - observed;
  return (delta * BASIS_POINTS) / absolute(reference);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** A 1e18 figure as a decimal string, for the evidence record and the proof page. */
export function formatMantissa(value: bigint, places = 6): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / MANTISSA;
  const fraction = (magnitude % MANTISSA).toString(10).padStart(18, "0").slice(0, places);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
