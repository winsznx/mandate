/**
 * Health-factor arithmetic. Pure, integer-only, no chain access.
 *
 * `getAccountLiquidity` returns the difference between liquidation-weighted
 * collateral and total borrows, not their ratio, so a health factor needs the
 * borrow total as well:
 *
 *     liquidity  > 0  ->  HF = (borrowUsd + liquidity) / borrowUsd
 *     shortfall  > 0  ->  HF = (borrowUsd - shortfall) / borrowUsd
 *
 * Everything is fixed point at 1e18 and computed in `bigint`. Floating point
 * would be convenient and wrong: the repay amount derived here becomes the
 * argument of an on-chain call, and a half-ulp of drift at 1e18 is a real
 * discrepancy between what the proof page shows and what the chain saw.
 *
 * The markets-derived reconstruction exists to catch a decode error rather than
 * to produce the answer. `getAccountLiquidity` is authoritative; recomputing
 * the same quantity from the 7-field `markets` decode and reporting the drift
 * is what makes a silent truncation to the 3-field form visible.
 */

export const MANTISSA = 10n ** 18n;

/** Venus scales `getUnderlyingPrice` by `1e(36 - underlyingDecimals)`. */
export function expectedPriceScale(underlyingDecimals: number): bigint {
  if (!Number.isInteger(underlyingDecimals) || underlyingDecimals < 0 || underlyingDecimals > 36) {
    throw new RangeError(`underlying decimals out of range: ${underlyingDecimals}`);
  }
  return 10n ** BigInt(36 - underlyingDecimals);
}

/**
 * Reject a price that cannot be right for the decimals it was read with.
 *
 * This is the guard for the decimal trap. Reading testnet USDT's `5e29` with
 * the mainnet assumption of 18 decimals implies a price of 500 billion dollars
 * and would size a repay twelve orders of magnitude too large. The band is
 * deliberately wide — it is here to catch a scale error, not to opine on what a
 * token is worth.
 */
export function assertPlausiblePrice(priceMantissa: bigint, underlyingDecimals: number): void {
  if (priceMantissa <= 0n) {
    throw new Error(`oracle returned a non-positive price: ${priceMantissa}`);
  }
  const scale = expectedPriceScale(underlyingDecimals);
  const usdMillionths = (priceMantissa * 1_000_000n) / scale;
  if (usdMillionths < 100n || usdMillionths > 1_000_000_000_000n) {
    throw new Error(
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
 * USD at 1e18 to raw underlying units, rounded up.
 *
 * Rounding up matters: the amount is chosen to lift the health factor to a
 * target, and rounding down leaves it a wei short of the target it claims to
 * have reached.
 */
export function usdToUnderlying(usdMantissa: bigint, priceMantissa: bigint): bigint {
  if (priceMantissa <= 0n) throw new Error(`price must be positive, received ${priceMantissa}`);
  const numerator = usdMantissa * MANTISSA;
  return (numerator + priceMantissa - 1n) / priceMantissa;
}

export interface MarketPosition {
  /** LT-weighted collateral this market contributes, USD at 1e18. */
  readonly liquidationWeightedCollateralUsd: bigint;
  readonly borrowUsd: bigint;
}

export interface AccountLiquidity {
  readonly liquidityUsd: bigint;
  readonly shortfallUsd: bigint;
  /**
   * VAI debt in USD at 1e18, principal plus accrued interest.
   *
   * The Comptroller charges this on the borrow side alongside the vToken
   * markets, but VAI is not a market and never appears in `getAssetsIn`.
   * Omitting it does not merely lose a term — it silently reattributes that
   * debt to the collateral side, because the collateral figure is derived by
   * adding the reported liquidity back onto the borrow total. Verified on
   * chain 97: an account with 2 VAI principal owes 3.343647904264645996.
   */
  readonly vaiDebtUsd: bigint;
}

export interface HealthAssessment {
  /** Every vToken market's borrow plus VAI, which is what the Comptroller weighs. */
  readonly totalBorrowUsd: bigint;
  readonly marketBorrowUsd: bigint;
  readonly vaiDebtUsd: bigint;
  /** Derived from `getAccountLiquidity`, which is the authoritative figure. */
  readonly weightedCollateralUsd: bigint;
  /** Independently summed from the 7-field `markets` decode. */
  readonly reconstructedCollateralUsd: bigint;
  /** Disagreement between the two, in basis points. `null` when there is no collateral to compare. */
  readonly reconstructionDriftBps: number | null;
  /** `null` means no debt, so the ratio is unbounded rather than large. */
  readonly healthFactorMantissa: bigint | null;
  readonly liquidatable: boolean;
}

export function assessHealth(
  positions: readonly MarketPosition[],
  liquidity: AccountLiquidity,
): HealthAssessment {
  const marketBorrowUsd = positions.reduce((sum, position) => sum + position.borrowUsd, 0n);
  const totalBorrowUsd = marketBorrowUsd + liquidity.vaiDebtUsd;
  const reconstructedCollateralUsd = positions.reduce(
    (sum, position) => sum + position.liquidationWeightedCollateralUsd,
    0n,
  );
  const weightedCollateralUsd = totalBorrowUsd + liquidity.liquidityUsd - liquidity.shortfallUsd;

  const reconstructionDriftBps =
    weightedCollateralUsd === 0n
      ? null
      : Number(
          (absolute(reconstructedCollateralUsd - weightedCollateralUsd) * 10_000n) /
            weightedCollateralUsd,
        );

  return {
    totalBorrowUsd,
    marketBorrowUsd,
    vaiDebtUsd: liquidity.vaiDebtUsd,
    weightedCollateralUsd,
    reconstructedCollateralUsd,
    reconstructionDriftBps,
    healthFactorMantissa:
      totalBorrowUsd === 0n ? null : (weightedCollateralUsd * MANTISSA) / totalBorrowUsd,
    liquidatable: liquidity.shortfallUsd > 0n,
  };
}

export interface RepayPlanInput {
  readonly assessment: HealthAssessment;
  /** Health factor the repay should restore the position to, at 1e18. */
  readonly targetMantissa: bigint;
  /** The account's own debt in this market, raw underlying units. */
  readonly outstandingDebt: bigint;
  readonly priceMantissa: bigint;
}

export interface RepayPlan {
  /** Raw underlying units to repay. Zero means no repay reaches the target usefully. */
  readonly amount: bigint;
  readonly requiredUsd: bigint;
  /** True when the account's own debt is the binding constraint rather than the target. */
  readonly cappedByDebt: boolean;
}

/**
 * How much debt to retire so the health factor reaches `target`.
 *
 * Repaying moves the denominator only. The collateral side is untouched
 * because the funds come from the wallet's own balance rather than from
 * withdrawn collateral, so with C fixed:
 *
 *     C / (B - r) >= target   ->   r >= B - C / target
 *
 * The result is then capped at the account's own debt, which Venus enforces
 * independently — `repayBorrow` above the caller's balance repays the balance
 * and no more. When the cap binds, the target is not reached and the caller is
 * told so rather than being left to infer it.
 */
export function planRepay(input: RepayPlanInput): RepayPlan {
  const { assessment, targetMantissa, outstandingDebt, priceMantissa } = input;
  if (targetMantissa <= 0n) throw new Error(`target must be positive, received ${targetMantissa}`);

  if (assessment.healthFactorMantissa === null || outstandingDebt === 0n) {
    return { amount: 0n, requiredUsd: 0n, cappedByDebt: false };
  }

  const permittedBorrowUsd = (assessment.weightedCollateralUsd * MANTISSA) / targetMantissa;
  const requiredUsd = assessment.totalBorrowUsd - permittedBorrowUsd;
  if (requiredUsd <= 0n) {
    return { amount: 0n, requiredUsd: 0n, cappedByDebt: false };
  }

  const wanted = usdToUnderlying(requiredUsd, priceMantissa);
  const amount = wanted > outstandingDebt ? outstandingDebt : wanted;
  return { amount, requiredUsd, cappedByDebt: wanted > outstandingDebt };
}

/** Health factor as a decimal string, for display and for the evidence record. */
export function formatHealthFactor(healthFactorMantissa: bigint | null): string {
  if (healthFactorMantissa === null) return "infinite";
  const whole = healthFactorMantissa / MANTISSA;
  const fraction = (healthFactorMantissa % MANTISSA).toString(10).padStart(18, "0").slice(0, 6);
  return `${whole}.${fraction}`;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}
