/**
 * Decimal and oracle-scale normalisation.
 *
 * Venus quotes `getUnderlyingPrice` at `1e(36 - underlyingDecimals)`, so the
 * price of a 6-decimal token is twelve orders of magnitude larger than the
 * price of an 18-decimal one. The BSC testnet mock USDT is 6 dp and BSC
 * mainnet USDT is 18 dp, which means an implementation that assumes 18
 * everywhere does not read slightly wrong on testnet — it reads $500 billion
 * for a $0.50 token and sizes a repayment to match.
 *
 * Everything here is integer `bigint`. Floating point would be convenient and
 * wrong: these numbers become the argument of an on-chain call and the basis of
 * a published verdict, and a half-ulp of drift at 1e18 is a real disagreement
 * between what the artifact claims and what the chain did.
 */

/** Fixed-point one. Collateral factors, thresholds and exchange rates all live at this scale. */
export const MANTISSA = 10n ** 18n;

export const BASIS_POINTS = 10_000n;

export class ReferenceScaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceScaleError";
  }
}

/** The scale `getUnderlyingPrice` returns for a token with this many decimals. */
export function oracleScaleFor(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new ReferenceScaleError(`underlying decimals out of range: ${decimals}`);
  }
  return 10n ** BigInt(36 - decimals);
}

/**
 * Reject a price that cannot be right for the decimals it was read with.
 *
 * The band is deliberately wide. It is here to catch a scale error of many
 * orders of magnitude, not to hold an opinion about what a token is worth.
 */
export function assertPlausiblePrice(priceMantissa: bigint, decimals: number): void {
  if (priceMantissa <= 0n) {
    throw new ReferenceScaleError(`oracle returned a non-positive price: ${priceMantissa}`);
  }
  const millionths = (priceMantissa * 1_000_000n) / oracleScaleFor(decimals);
  if (millionths < 100n || millionths > 1_000_000_000_000n) {
    throw new ReferenceScaleError(
      `oracle price ${priceMantissa} is implausible for ${decimals} decimals; check the configured decimals`,
    );
  }
}

/**
 * USD at 1e18 for a raw token amount.
 *
 * `amount` carries `decimals` digits and `priceMantissa` carries `36 - decimals`,
 * so the product is always at 1e36 regardless of the token, and one division by
 * 1e18 lands on 1e18.
 */
export function toUsd(amount: bigint, priceMantissa: bigint): bigint {
  return (amount * priceMantissa) / MANTISSA;
}

/**
 * USD at 1e18 for a vToken balance, without materialising the underlying amount.
 *
 * Converting through the underlying first would floor the intermediate to whole
 * base units, discarding up to one unit of value. On a 6-decimal token that is
 * a millionth of a dollar per market — immaterial to the verdict, but it is a
 * disagreement with the protocol's own figure that has no reason to exist, and
 * an unexplained discrepancy in a reconciliation is the thing that hides a real
 * one. Multiplying first and dividing once keeps the full precision.
 */
export function vTokenToUsd(
  vTokenBalance: bigint,
  exchangeRateMantissa: bigint,
  priceMantissa: bigint,
): bigint {
  return (vTokenBalance * exchangeRateMantissa * priceMantissa) / (MANTISSA * MANTISSA);
}

/** Raw token units for a USD amount at 1e18, rounded up. */
export function fromUsd(usdMantissa: bigint, priceMantissa: bigint): bigint {
  if (priceMantissa <= 0n) {
    throw new ReferenceScaleError(`price must be positive, received ${priceMantissa}`);
  }
  if (usdMantissa <= 0n) return 0n;
  // Rounded up: this amount is chosen to reach a target, and rounding down
  // leaves the position a wei short of the target the artifact claims it hit.
  return (usdMantissa * MANTISSA + priceMantissa - 1n) / priceMantissa;
}

/** Apply a 1e18 weight, such as a liquidation threshold, to a USD figure. */
export function applyWeight(usdMantissa: bigint, weightMantissa: bigint): bigint {
  return (usdMantissa * weightMantissa) / MANTISSA;
}

/**
 * Absolute difference between two figures, in basis points of `reference`.
 *
 * Both sides are taken in magnitude. The figures compared here are net
 * positions that are negative under shortfall, and a signed denominator would
 * report a large disagreement as a large negative one, which reads as agreement
 * to any threshold test written the obvious way.
 */
export function differenceBps(observed: bigint, reference: bigint): bigint | null {
  if (reference === 0n) return null;
  const delta = absolute(observed - reference);
  return (delta * BASIS_POINTS) / absolute(reference);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** A 1e18 ratio as a decimal string, for the evidence record and the proof page. */
export function formatMantissa(value: bigint | null, places = 6): string {
  if (value === null) return "infinite";
  const whole = value / MANTISSA;
  const fraction = (value % MANTISSA).toString(10).padStart(18, "0").slice(0, places);
  return `${whole}.${fraction}`;
}
