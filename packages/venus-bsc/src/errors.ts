/**
 * Read failures, kept distinct from risk conclusions.
 *
 * A read that could not complete must never collapse into a number. An
 * observation missing a market is not an account with less debt, and an
 * unavailable oracle price is not a price of zero — both would understate risk
 * in exactly the direction that gets someone liquidated.
 */

export class VenusReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VenusReadError";
  }
}

/**
 * `vBNB` represents native BNB and has no ERC-20 underlying, so `underlying()`
 * reverts. Eighteen is the native decimal count, applied explicitly rather than
 * defaulted into.
 */
export const NATIVE_UNDERLYING_DECIMALS = 18;

/** Venus mantissa scale. Collateral factors and exchange rates are fixed-point at 1e18. */
export const MANTISSA_SCALE = 10n ** 18n;

/**
 * Oracle prices are scaled so that `price * amount / 1e18` yields USD at 1e18,
 * which means the scale itself depends on the token's decimals.
 *
 * A 6-decimal underlying therefore carries a price twelve orders of magnitude
 * larger than an 18-decimal one. Assuming 18 across the board does not produce
 * a slightly wrong valuation; it produces one off by 1e12.
 */
export function oraclePriceScaleFor(underlyingDecimals: number): bigint {
  return 10n ** BigInt(36 - underlyingDecimals);
}
