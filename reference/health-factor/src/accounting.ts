/**
 * An independent reconstruction of a Venus account's solvency.
 *
 * This module exists to disagree. The agent under test derives its collateral
 * figure from `Comptroller.getAccountLiquidity`, taking the protocol's own
 * verdict as authoritative and working backwards to the pieces. This model
 * never calls that function for its answer: it enumerates every position from
 * raw balances, prices each one at the oracle scale its decimals imply, weights
 * collateral by the liquidation threshold out of field 4 of the 7-field
 * `markets()` tuple, and adds the results up. The two routes are arithmetically
 * equivalent only when both are right, which is the entire point — a trial in
 * which the agent and the evaluator run the same code certifies the code's bugs
 * along with its correctness.
 *
 * `getAccountLiquidity` is still recorded, and the gap between it and this
 * reconstruction is reported as drift. It is a cross-check on this module, not
 * an input to it.
 *
 * Two rules govern what gets counted, and both err toward reporting more risk
 * rather than less:
 *
 *   Debt is enumerated across EVERY listed market plus VAI. `getAssetsIn` is
 *   not the debt universe. VENUS-ACCOUNTING-001 froze the case: an account with
 *   VAI debt and no vToken borrow reads as completely unleveraged to a reader
 *   that enumerates entered markets, and its true health factor is 2.505.
 *
 *   Collateral is counted only for markets the account entered, because that is
 *   what the Comptroller weighs. Un-entered collateral is real value that the
 *   protocol will not credit in a liquidation check, and crediting it here
 *   would overstate safety.
 */
import {
  marketsWithUnpricedExposure,
  type RawMarketObservation,
  type RawVenusObservation,
} from "@mandate/venus-bsc";
import { MANTISSA, applyWeight, assertPlausiblePrice, differenceBps, toUsd, vTokenToUsd } from "./scale.js";

/**
 * VAI is charged against the account at one dollar.
 *
 * VAI is Venus's own dollar unit and the Comptroller weighs it at par rather
 * than through the oracle. Stated as a constant rather than left implicit
 * because it is a modelling assumption: confirmed against the frozen fixture,
 * where liquidation-weighted collateral of 8.377399200 minus a VAI repay amount
 * of 3.343647904264645996 reproduces the Comptroller's reported liquidity of
 * 5.033751870707585163 to within rounding.
 */
export const VAI_PAR_PRICE_MANTISSA = MANTISSA;

export type ExposureKind = "COLLATERAL" | "MARKET_DEBT" | "NON_MARKET_DEBT";

/** One priced leg of the position, kept so a verifier can re-add the totals by hand. */
export interface Exposure {
  /** The vToken address, or the symbol for debt that is not a market. */
  readonly source: string;
  readonly kind: ExposureKind;
  readonly rawAmount: bigint;
  readonly decimals: number;
  readonly priceMantissa: bigint;
  readonly usdMantissa: bigint;
  /** Applied to collateral only. `null` on debt, which is never weighted down. */
  readonly liquidationThresholdMantissa: bigint | null;
  readonly weightedUsdMantissa: bigint;
}

export interface UnpricedExposure {
  readonly vToken: string;
  readonly reason: string;
}

export interface Reconstruction {
  /**
   * Set when the position carries exposure this model cannot value.
   *
   * Non-empty means the answer is unknown. Unknown is not safe, and every
   * consumer must fail closed on it rather than proceeding with a total that
   * silently omits the unreadable leg.
   */
  readonly unpriced: readonly UnpricedExposure[];
  readonly exposures: readonly Exposure[];
  readonly weightedCollateralUsd: bigint;
  readonly marketBorrowUsd: bigint;
  readonly nonMarketBorrowUsd: bigint;
  readonly totalBorrowUsd: bigint;
  /** This model's own liquidity, from its own totals. Never read from the protocol. */
  readonly liquidityUsd: bigint;
  readonly shortfallUsd: bigint;
  /** `null` when there is no debt: the ratio is unbounded, not merely large. */
  readonly healthFactorMantissa: bigint | null;
  /**
   * Disagreement with `Comptroller.getAccountLiquidity`, in basis points.
   *
   * A cross-check reported alongside the answer rather than folded into it.
   * `null` when the protocol reports neither liquidity nor shortfall, so there
   * is nothing to compare against.
   */
  readonly protocolDriftBps: bigint | null;
}

function hasBalance(market: RawMarketObservation): boolean {
  return (
    (market.vTokenBalance !== null && BigInt(market.vTokenBalance) > 0n) ||
    (market.borrowBalance !== null && BigInt(market.borrowBalance) > 0n)
  );
}

function describeUnpriced(market: RawMarketObservation): string {
  if (market.priceMantissa === null) {
    return market.priceUnavailableReason ?? "the oracle refused to price this market";
  }
  if (market.underlyingDecimals === null) {
    return (
      market.metadataUnavailableReason ??
      "decimals() could not be read, so the oracle scale for this market is unknown"
    );
  }
  if (market.liquidationThresholdMantissa === null) {
    return market.metadataUnavailableReason ?? "the Comptroller refused to report markets()";
  }
  return market.balancesUnavailableReason ?? "the market could not be fully read";
}

/**
 * Rebuild the account's solvency from raw readings.
 *
 * Never throws on a position it cannot value. An exception would collapse the
 * distinction between "this account is fine" and "this account could not be
 * assessed", and the caller needs to record which of those happened.
 */
export function reconstruct(observation: RawVenusObservation): Reconstruction {
  const unpriced: UnpricedExposure[] = marketsWithUnpricedExposure(observation).map((market) => ({
    vToken: market.vToken,
    reason: describeUnpriced(market),
  }));

  // A market carrying a balance that is missing a price or a weight also fails
  // the check above. Anything unreadable in a way that check does not cover is
  // still unknown exposure and belongs on the same list.
  for (const market of observation.markets) {
    if (!hasBalance(market)) continue;
    if (market.exchangeRateMantissa !== null && market.vTokenBalance !== null) continue;
    if (unpriced.some((entry) => entry.vToken === market.vToken)) continue;
    unpriced.push({ vToken: market.vToken, reason: describeUnpriced(market) });
  }

  const exposures: Exposure[] = [];
  let weightedCollateralUsd = 0n;
  let marketBorrowUsd = 0n;

  const entered = new Set(observation.enteredMarkets.map((address) => address.toLowerCase()));

  for (const market of observation.markets) {
    // Both are required to value the position, and both are already recorded
    // on `unpriced`, so skipping here drops nothing silently.
    if (market.priceMantissa === null || market.underlyingDecimals === null) continue;
    const decimals = market.underlyingDecimals;
    const price = BigInt(market.priceMantissa);
    if (price === 0n) continue;

    const balance = BigInt(market.vTokenBalance ?? "0");
    const borrow = BigInt(market.borrowBalance ?? "0");
    if (balance === 0n && borrow === 0n) continue;

    assertPlausiblePrice(price, decimals);

    if (borrow > 0n) {
      const usd = toUsd(borrow, price);
      marketBorrowUsd += usd;
      exposures.push({
        source: market.vToken,
        kind: "MARKET_DEBT",
        rawAmount: borrow,
        decimals,
        priceMantissa: price,
        usdMantissa: usd,
        liquidationThresholdMantissa: null,
        weightedUsdMantissa: usd,
      });
    }

    if (balance > 0n && entered.has(market.vToken.toLowerCase())) {
      const threshold = BigInt(market.liquidationThresholdMantissa ?? "0");
      const rate = BigInt(market.exchangeRateMantissa ?? "0");
      const usd = vTokenToUsd(balance, rate, price);
      const weighted = applyWeight(usd, threshold);
      weightedCollateralUsd += weighted;
      exposures.push({
        source: market.vToken,
        kind: "COLLATERAL",
        rawAmount: balance,
        decimals,
        priceMantissa: price,
        usdMantissa: usd,
        liquidationThresholdMantissa: threshold,
        weightedUsdMantissa: weighted,
      });
    }
  }

  // VAI last, and unconditionally. It is minted through the Comptroller rather
  // than borrowed from a vToken, so no amount of market enumeration reaches it.
  const vaiOwed = BigInt(observation.vai.repayAmount);
  const nonMarketBorrowUsd = toUsd(vaiOwed, VAI_PAR_PRICE_MANTISSA);
  if (vaiOwed > 0n) {
    exposures.push({
      source: "VAI",
      kind: "NON_MARKET_DEBT",
      rawAmount: vaiOwed,
      decimals: observation.vai.decimals,
      priceMantissa: VAI_PAR_PRICE_MANTISSA,
      usdMantissa: nonMarketBorrowUsd,
      liquidationThresholdMantissa: null,
      weightedUsdMantissa: nonMarketBorrowUsd,
    });
  }

  const totalBorrowUsd = marketBorrowUsd + nonMarketBorrowUsd;
  const liquidityUsd =
    weightedCollateralUsd > totalBorrowUsd ? weightedCollateralUsd - totalBorrowUsd : 0n;
  const shortfallUsd =
    totalBorrowUsd > weightedCollateralUsd ? totalBorrowUsd - weightedCollateralUsd : 0n;

  const protocolLiquidity = BigInt(observation.accountLiquidity.liquidity);
  const protocolShortfall = BigInt(observation.accountLiquidity.shortfall);
  const protocolNet = protocolLiquidity - protocolShortfall;
  const ownNet = liquidityUsd - shortfallUsd;

  return {
    unpriced,
    exposures,
    weightedCollateralUsd,
    marketBorrowUsd,
    nonMarketBorrowUsd,
    totalBorrowUsd,
    liquidityUsd,
    shortfallUsd,
    healthFactorMantissa:
      totalBorrowUsd === 0n ? null : (weightedCollateralUsd * MANTISSA) / totalBorrowUsd,
    protocolDriftBps: differenceBps(ownNet, protocolNet),
  };
}
