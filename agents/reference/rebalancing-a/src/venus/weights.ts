/**
 * Weight arithmetic. Pure, integer-only, no chain access.
 *
 * This agent values a position in two steps and floors at the intermediate:
 * `vTokenBalance -> underlying -> USD`. It reads a market's supplied total as
 * `totalSupply * exchangeRateStored`, which is the vToken's own accounting
 * identity taken as given.
 *
 * The reference model that judges it does neither. It multiplies through and
 * divides once, keeping the fraction of a base unit this route discards, and it
 * reads each market's supplied total off the balance sheet as
 * `cash + totalBorrows - totalReserves`. Those are the two sides of the same
 * exchange-rate identity, and reading both is what turns "this market has room"
 * from an assertion into a reconciliation. The routes agree only when both are
 * right, which is the point of running two of them.
 *
 * The one place the two sides must agree exactly is the decision itself, so the
 * drift predicate below is cross-multiplied and does no division at all. A
 * boundary case then has one answer rather than two answers a rounding apart,
 * and a disagreement between the agent and the model is a bug someone has to
 * fix instead of noise a tolerance absorbs.
 *
 * Everything is `bigint`. Floating point would be convenient and wrong: the
 * amount derived here becomes the argument of an on-chain call, and a half-ulp
 * at 1e18 is a real gap between what the artifact claims and what the chain did.
 */

/** Fixed-point one. Exchange rates, oracle scales and USD figures all live here. */
export const MANTISSA = 10n ** 18n;

export const BASIS_POINTS = 10_000n;

export class WeightScaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeightScaleError";
  }
}

/** The scale `getUnderlyingPrice` returns for a token with this many decimals. */
export function expectedPriceScale(underlyingDecimals: number): bigint {
  if (!Number.isInteger(underlyingDecimals) || underlyingDecimals < 0 || underlyingDecimals > 36) {
    throw new WeightScaleError(`underlying decimals out of range: ${underlyingDecimals}`);
  }
  return 10n ** BigInt(36 - underlyingDecimals);
}

/**
 * Reject a price that cannot be right for the decimals it was read with.
 *
 * The guard for the decimal trap. Testnet USDT prices at 5e29 with 6 decimals,
 * which is fifty cents; read with the mainnet assumption of 18 it implies five
 * hundred billion dollars. In this category a single mispriced market does not
 * merely misrank one venue, it distorts the portfolio total that every weight
 * is measured against, so every other market's gap comes out wrong too. The
 * band is deliberately wide — it exists to catch a scale error, not to hold an
 * opinion about what a stablecoin is worth.
 */
export function assertPlausiblePrice(priceMantissa: bigint, underlyingDecimals: number): void {
  if (priceMantissa <= 0n) {
    throw new WeightScaleError(`oracle returned a non-positive price: ${priceMantissa}`);
  }
  const usdMillionths = (priceMantissa * 1_000_000n) / expectedPriceScale(underlyingDecimals);
  if (usdMillionths < 100n || usdMillionths > 1_000_000_000_000n) {
    throw new WeightScaleError(
      `oracle price ${priceMantissa} is implausible for ${underlyingDecimals} decimals ` +
        `(implies $${Number(usdMillionths) / 1_000_000}); check the configured decimals`,
    );
  }
}

/** Raw underlying units to USD at 1e18. */
export function underlyingToUsd(amount: bigint, priceMantissa: bigint): bigint {
  return (amount * priceMantissa) / MANTISSA;
}

/**
 * Underlying held by a market, from its vToken supply and exchange rate.
 *
 * One of the two readings of the same quantity, and the one the reference model
 * refuses to use for its answer. `exchangeRateStored` is
 * `(cash + borrows - reserves) / totalSupply` by construction, so this route and
 * the balance-sheet route return the same figure whenever the market is
 * consistent, and a difference between them is a decode error rather than a
 * market event.
 */
export function suppliedUnderlying(totalSupplyVTokens: bigint, exchangeRateMantissa: bigint): bigint {
  return (totalSupplyVTokens * exchangeRateMantissa) / MANTISSA;
}

/**
 * USD value of a vToken balance, taken through the underlying.
 *
 * Two steps, and floored at the intermediate, which is what a straightforward
 * implementation does and is therefore what this one does. The reference model
 * multiplies through and divides once instead. The gap is a millionth of a
 * dollar per market on a 6-decimal token and sits many orders of magnitude
 * inside the published tolerance; it is left in place rather than papered over
 * because the two routes being visibly different is the property that matters.
 */
export function vTokenToUsd(
  vTokenBalance: bigint,
  exchangeRateMantissa: bigint,
  priceMantissa: bigint,
): bigint {
  return underlyingToUsd(suppliedUnderlying(vTokenBalance, exchangeRateMantissa), priceMantissa);
}

/**
 * How much more underlying a market will accept before it hits its cap.
 *
 * A cap of zero is a closed market rather than an unlimited one, which is how
 * Venus writes down a retired market, and getting that backwards opens exactly
 * the markets the cap exists to close.
 */
export function supplyHeadroom(supplyCapRaw: bigint, suppliedRaw: bigint): bigint {
  if (supplyCapRaw === 0n) return 0n;
  return supplyCapRaw > suppliedRaw ? supplyCapRaw - suppliedRaw : 0n;
}

/**
 * USD at 1e18 back to raw underlying units, rounded down.
 *
 * Down, because the USD figure this converts is a gap the mint is allowed to
 * close and not a target it must reach. Rounding up would propose one base unit
 * more than the deficit and leave the market fractionally over-weight, which is
 * the same error the agent exists to correct.
 */
export function usdToUnderlyingFloor(usdMantissa: bigint, priceMantissa: bigint): bigint {
  if (priceMantissa <= 0n) {
    throw new WeightScaleError(`price must be positive, received ${priceMantissa}`);
  }
  if (usdMantissa <= 0n) return 0n;
  return (usdMantissa * MANTISSA) / priceMantissa;
}

/**
 * The dollars a market is short of its published weight. Negative when over.
 *
 * One division, and it is deliberately not the one the decision turns on. This
 * figure sizes the mint and prints in the rationale; whether to act at all is
 * settled by `isUnderweightByTrigger`, which divides by nothing.
 */
export function weightGapUsd(
  targetWeightBps: bigint,
  portfolioUsd: bigint,
  positionUsd: bigint,
): bigint {
  return (targetWeightBps * portfolioUsd) / BASIS_POINTS - positionUsd;
}

/**
 * Is this market short of its target by at least the policy's drift trigger?
 *
 * Written out in full here, and written out again independently in
 * `reference/rebalancing/src/allocation.ts`. Neither imports the other and
 * neither is factored into a shared helper, because a shared predicate is
 * precisely the thing that would let one arithmetic slip make the agent wrong
 * and the model agree with it.
 *
 * The comparison a reader expects is
 *
 *     targetWeightBps * portfolio / 10000 - position  >=  triggerBps * portfolio / 10000
 *
 * and both divisions are dropped by multiplying through by 10000:
 *
 *     targetWeightBps * portfolio - position * 10000  >=  triggerBps * portfolio
 *
 * That is not a micro-optimisation. With the divisions in place the two sides
 * floor at different moments and the trigger fires one base unit apart on the
 * two implementations, so a state sitting exactly on the line would produce a
 * trial failure that is a rounding artefact rather than a behaviour. Exact on
 * both sides means a boundary disagreement is a bug, which is the only kind of
 * disagreement worth reporting.
 */
export function isUnderweightByTrigger(
  targetWeightBps: bigint,
  portfolioUsd: bigint,
  positionUsd: bigint,
  triggerBps: bigint,
): boolean {
  return targetWeightBps * portfolioUsd - positionUsd * BASIS_POINTS >= triggerBps * portfolioUsd;
}

/**
 * The share one market holds of the portfolio, in basis points.
 *
 * `null` when the portfolio is empty: a weight against nothing is not a number,
 * and reporting 0 or 10000 would both be claims the arithmetic cannot support.
 */
export function weightBps(positionUsd: bigint, portfolioUsd: bigint): bigint | null {
  if (portfolioUsd <= 0n) return null;
  return (positionUsd * BASIS_POINTS) / portfolioUsd;
}

/** The smallest of a set of binding limits. Used to size a top-up down to what is permitted. */
export function smallest(values: readonly bigint[]): bigint {
  let least: bigint | undefined;
  for (const value of values) {
    if (least === undefined || value < least) least = value;
  }
  return least ?? 0n;
}

/** Raw base units rendered as a decimal string, for the human-readable rationale. */
export function formatUnits(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString(10).padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? `${amount / scale}` : `${amount / scale}.${fraction}`;
}

/**
 * A 1e18 USD figure as a decimal string.
 *
 * Signed, because a weight gap is signed: a market above its target has a
 * negative one. Taking the magnitude first is what keeps `-5.50` from
 * rendering as `-5.-5`, since `bigint` division truncates toward zero and
 * leaves the remainder carrying the sign.
 */
export function formatUsd(usdMantissa: bigint, places = 2): string {
  const negative = usdMantissa < 0n;
  const magnitude = negative ? -usdMantissa : usdMantissa;
  const whole = magnitude / MANTISSA;
  const fraction = (magnitude % MANTISSA).toString(10).padStart(18, "0").slice(0, places);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
