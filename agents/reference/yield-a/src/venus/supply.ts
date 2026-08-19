/**
 * Supply-side arithmetic. Pure, integer-only, no chain access.
 *
 * This agent annualises upward: it takes each market's `supplyRatePerBlock` at
 * 1e18, multiplies by the blocks-per-year its policy declares, and expresses
 * the result in basis points so the number it compares against its floor is the
 * number a human reads on the proof page.
 *
 * The reference model that judges it goes the other way. It converts the policy
 * floor down into a per-block rate mantissa and compares the raw readings,
 * never annualising anything. The two routes agree only when both are right,
 * which is the point: a factor-of-ten slip in one direction does not produce
 * the same slip in the other, so the disagreement surfaces instead of being
 * certified.
 *
 * The same split applies to how much a market holds. Here it is
 * `totalSupply * exchangeRate`; over there it is `cash + borrows - reserves`.
 * Those are the two sides of the exchange-rate identity, and reading both is
 * what turns "the supply cap has room" from an assertion into a reconciliation.
 *
 * Everything is `bigint`. Floating point would be convenient and wrong: the
 * amount derived here becomes the argument of an on-chain call, and a half-ulp
 * at 1e18 is a real gap between what the artifact claims and what the chain did.
 */

/** Fixed-point one. Rates, exchange rates and oracle scales all live here. */
export const MANTISSA = 10n ** 18n;

export const BASIS_POINTS = 10_000n;

export class SupplyScaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplyScaleError";
  }
}

/** The scale `getUnderlyingPrice` returns for a token with this many decimals. */
export function expectedPriceScale(underlyingDecimals: number): bigint {
  if (!Number.isInteger(underlyingDecimals) || underlyingDecimals < 0 || underlyingDecimals > 36) {
    throw new SupplyScaleError(`underlying decimals out of range: ${underlyingDecimals}`);
  }
  return 10n ** BigInt(36 - underlyingDecimals);
}

/**
 * Reject a price that cannot be right for the decimals it was read with.
 *
 * The guard for the decimal trap. Testnet USDT prices at 5e29 with 6 decimals,
 * which is fifty cents; read with the mainnet assumption of 18 it implies five
 * hundred billion dollars and would size a deployment to match. The band is
 * deliberately wide — it exists to catch a scale error, not to hold an opinion
 * about what a stablecoin is worth.
 */
export function assertPlausiblePrice(priceMantissa: bigint, underlyingDecimals: number): void {
  if (priceMantissa <= 0n) {
    throw new SupplyScaleError(`oracle returned a non-positive price: ${priceMantissa}`);
  }
  const usdMillionths = (priceMantissa * 1_000_000n) / expectedPriceScale(underlyingDecimals);
  if (usdMillionths < 100n || usdMillionths > 1_000_000_000_000n) {
    throw new SupplyScaleError(
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
 * A per-block supply rate expressed as annual basis points.
 *
 * `blocksPerYear` is a policy input rather than a chain reading, and that is a
 * real limitation rather than an oversight. Venus's interest-rate model on
 * chain 97 sits behind a proxy that reverts on `blocksOrSecondsPerYear()`, so
 * there is nothing to read, and BSC's block interval is not fixed in any case.
 * The figure is therefore a stated convention, published in the agent card so a
 * reader can see which convention produced the number.
 *
 * Simple rather than compounded, deliberately. Compounding a per-block rate
 * over ten million blocks in integer arithmetic needs a fixed-point exponential
 * whose error is harder to reason about than the quantity it corrects, and the
 * comparison this feeds is between markets on the same chain, where the
 * convention cancels.
 */
export function annualBasisPoints(ratePerBlockMantissa: bigint, blocksPerYear: bigint): bigint {
  if (blocksPerYear <= 0n) {
    throw new SupplyScaleError(`blocksPerYear must be positive, received ${blocksPerYear}`);
  }
  return (ratePerBlockMantissa * blocksPerYear * BASIS_POINTS) / MANTISSA;
}

/**
 * Underlying held by a market, from its vToken supply and exchange rate.
 *
 * One of the two readings of the same quantity. `exchangeRateStored` is
 * `(cash + borrows - reserves) / totalSupply` by construction, so this route
 * and the balance-sheet route return the same figure whenever the market is
 * consistent, and a difference between them is a decode error rather than a
 * market event.
 */
export function suppliedUnderlying(totalSupplyVTokens: bigint, exchangeRateMantissa: bigint): bigint {
  return (totalSupplyVTokens * exchangeRateMantissa) / MANTISSA;
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
 * Down rather than up, unlike the repayment sizing in the health-factor agent.
 * Every USD figure this converts is a ceiling — a minimum deployment size, a
 * concentration limit — and rounding a ceiling up crosses it.
 */
export function usdToUnderlyingFloor(usdMantissa: bigint, priceMantissa: bigint): bigint {
  if (priceMantissa <= 0n) {
    throw new SupplyScaleError(`price must be positive, received ${priceMantissa}`);
  }
  if (usdMantissa <= 0n) return 0n;
  return (usdMantissa * MANTISSA) / priceMantissa;
}

/**
 * USD value of a vToken balance, taken through the underlying.
 *
 * Two steps, and floored at the intermediate, which is what a straightforward
 * implementation does and is therefore what this one does. The reference model
 * multiplies through and divides once instead, keeping the fraction of a base
 * unit this discards. The gap is a millionth of a dollar per market on a
 * 6-decimal token and sits many orders of magnitude inside the published
 * tolerance; it is left in place rather than papered over because the two
 * routes being visibly different is the property that matters.
 */
export function vTokenToUsd(
  vTokenBalance: bigint,
  exchangeRateMantissa: bigint,
  priceMantissa: bigint,
): bigint {
  return underlyingToUsd(suppliedUnderlying(vTokenBalance, exchangeRateMantissa), priceMantissa);
}

/**
 * The largest USD deployment into a market that leaves its share within a cap.
 *
 * The share is taken against the account's whole capital — supplied plus idle —
 * rather than against the supplied part alone. That denominator is the one that
 * does not move when the deployment happens, because supplying converts idle
 * capital into supplied capital and changes neither total.
 *
 * Measuring against the supplied part instead produces a rule that cannot be
 * satisfied: on an account with nothing supplied yet, any first deposit is the
 * whole of the supplied capital and therefore breaches every ceiling below
 * 10000 bps. A diversification policy that forbids ever starting is not a
 * conservative policy, it is a broken one.
 *
 * `null` means the ceiling constrains nothing, which is a different answer from
 * zero: a cap at or above 10000 bps permits any deployment, while a market
 * already at its share permits none.
 */
export function deploymentUnderCapUsd(
  marketUsd: bigint,
  totalCapitalUsd: bigint,
  capBps: bigint,
): bigint | null {
  if (capBps >= BASIS_POINTS) return null;
  const permitted = (capBps * totalCapitalUsd) / BASIS_POINTS;
  return permitted > marketUsd ? permitted - marketUsd : 0n;
}

/**
 * The share one market holds of a total, in basis points.
 *
 * `null` when the total is zero: a first deployment into an empty account has
 * no incumbent share to compare against, and reporting 0 or 10000 would both be
 * claims the arithmetic cannot support.
 */
export function shareBps(partUsd: bigint, totalUsd: bigint): bigint | null {
  if (totalUsd <= 0n) return null;
  return (partUsd * BASIS_POINTS) / totalUsd;
}

/** The smallest of a set of binding limits. Used to size a deployment down to what is permitted. */
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

/** A 1e18 USD figure as a decimal string. */
export function formatUsd(usdMantissa: bigint, places = 2): string {
  const whole = usdMantissa / MANTISSA;
  const fraction = (usdMantissa % MANTISSA).toString(10).padStart(18, "0").slice(0, places);
  return `${whole}.${fraction}`;
}
