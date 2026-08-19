/**
 * Rate and decimal normalisation, taken the opposite way round from the agent.
 *
 * The agent under test annualises upward: it multiplies each market's
 * `supplyRatePerBlock` by its blocks-per-year convention, expresses the result
 * in basis points, and compares that against its floor. This model never
 * annualises. It converts the policy's floor downward into the smallest
 * per-block rate that satisfies it and compares the protocol's raw readings
 * against that.
 *
 * The two predicates are provably the same, which is the property worth having.
 * With `S = blocksPerYear * 10000`, `M = 1e18` and an integer floor `K`:
 *
 *     floor(rate * S / M) >= K   <=>   rate * S >= K * M   <=>   rate >= ceil(K * M / S)
 *
 * because `floor(x) >= K` is equivalent to `x >= K` for integer `K`. So the two
 * routes agree at the exact boundary rather than merely near it, and any
 * disagreement between them is a bug in one of the two rather than a rounding
 * artefact that has to be absorbed by a tolerance. A tolerance that swallowed
 * scale errors would be the thing hiding the bug this architecture exists to
 * catch.
 *
 * Everything is integer `bigint`. These numbers become the argument of an
 * on-chain call and the basis of a published verdict, and floating point would
 * put a half-ulp of disagreement between the artifact and the chain.
 */

/** Fixed-point one. Rates, exchange rates and oracle scales all live at this scale. */
export const MANTISSA = 10n ** 18n;

export const BASIS_POINTS = 10_000n;

export class YieldScaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YieldScaleError";
  }
}

/** The scale `getUnderlyingPrice` returns for a token with this many decimals. */
export function oracleScaleFor(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new YieldScaleError(`underlying decimals out of range: ${decimals}`);
  }
  return 10n ** BigInt(36 - decimals);
}

/**
 * Is this price consistent with the decimals it was read against?
 *
 * Returns a verdict rather than throwing. This model has to be able to report
 * "the position could not be valued" as a state; an exception here would
 * collapse that into a crash, and a crashed evaluator says nothing about the
 * agent at all.
 */
export function isPlausiblePrice(priceMantissa: bigint, decimals: number): boolean {
  if (priceMantissa <= 0n) return false;
  const millionths = (priceMantissa * 1_000_000n) / oracleScaleFor(decimals);
  return millionths >= 100n && millionths <= 1_000_000_000_000n;
}

/**
 * The smallest per-block rate that annualises to at least `annualBps`.
 *
 * The inverse of the agent's annualisation, and the only place this model
 * touches the blocks-per-year convention. Rounded up, so the returned rate is
 * the first one that clears the floor rather than the last one that misses it.
 */
export function rateFloorPerBlock(annualBps: bigint, blocksPerYear: bigint): bigint {
  if (blocksPerYear <= 0n) {
    throw new YieldScaleError(`blocksPerYear must be positive, received ${blocksPerYear}`);
  }
  if (annualBps <= 0n) return 0n;
  const denominator = blocksPerYear * BASIS_POINTS;
  return (annualBps * MANTISSA + denominator - 1n) / denominator;
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
 * Multiplying through and dividing once keeps the fraction of a base unit that
 * converting through the underlying first would floor away. The difference is a
 * millionth of a dollar on a 6-decimal token and is immaterial to any verdict;
 * it is done this way because an unexplained discrepancy in a reconciliation is
 * what hides a real one, and there is no reason for this one to exist.
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
    throw new YieldScaleError(`price must be positive, received ${priceMantissa}`);
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
  const whole = value / MANTISSA;
  const fraction = (value % MANTISSA).toString(10).padStart(18, "0").slice(0, places);
  return `${whole}.${fraction}`;
}
