/**
 * An independent reconstruction of how an account's capital is distributed
 * across the Venus markets, and how far that is from a published allocation.
 *
 * This module exists to disagree. The agent under test derives a market's
 * supplied total from `totalSupply * exchangeRateStored`, taking the vToken's
 * own accounting identity as given. This model never uses that product for its
 * answer: it adds up the market's balance sheet from `getCash`, `totalBorrows`
 * and `totalReserves`, which is the other side of the same identity and is what
 * the exchange rate is derived from in the first place. The vToken product is
 * still computed, and the gap between the two is published as drift. It is a
 * cross-check on this module, not an input to it.
 *
 * The two routes are arithmetically equal only when both are right. That is the
 * entire point — a trial in which the agent and the evaluator run the same code
 * certifies the code's bugs along with its correctness.
 *
 * Two rules govern what counts as available, and both err toward reporting less
 * capacity rather than more:
 *
 *   A market is available only when all three of `isListed`, `mintPaused` and
 *   `supplyCaps` were read. Testnet vBUSD is listed, priced, and rejects every
 *   `mint`; a reader that checks listing alone treats it as a place capital can
 *   be moved to.
 *
 *   A supply cap of zero closes a market. Venus writes zero on retired markets,
 *   and reading it as "no ceiling" opens exactly the markets the field exists to
 *   close.
 */
import type { RawSupplyMarketObservation, RawSupplyObservation } from "@mandate/venus-bsc";
import { BASIS_POINTS, differenceBps, isPlausiblePrice, toUsd, vTokenToUsd } from "./scale.js";

/** Why a market cannot be topped up. */
export type UnavailableReason =
  | "NOT_LISTED"
  | "MINT_PAUSED"
  | "AT_SUPPLY_CAP"
  | "IMPLAUSIBLE_PRICE"
  | "DECIMALS_DISAGREE";

export interface MarketReconstruction {
  readonly vToken: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly priceMantissa: bigint;
  /** `cash + borrows - reserves`. This model's own figure, from the balance sheet. */
  readonly suppliedUnderlyingRaw: bigint;
  /** `totalSupply * exchangeRate`, the agent's route. Recorded for the cross-check only. */
  readonly suppliedFromVTokenSupplyRaw: bigint;
  /** Disagreement between the two routes, in basis points. `null` when the market is empty. */
  readonly identityDriftBps: bigint | null;
  readonly supplyCapRaw: bigint;
  /** Underlying the market will still accept. Zero when the cap binds or is zero. */
  readonly headroomRaw: bigint;
  /** The account's own supplied position here, USD at 1e18. The quantity a weight is about. */
  readonly positionUsd: bigint;
  /** This market's underlying sitting undeployed in the wallet, USD at 1e18. */
  readonly idleUsd: bigint;
  readonly walletBalanceRaw: bigint;
  readonly allowanceRaw: bigint;
  /** Set when this market cannot take a top-up. `undefined` means it can. */
  readonly unavailable: UnavailableReason | undefined;
}

export interface AllocationReconstruction {
  /**
   * Markets carrying something this model could not read.
   *
   * Non-empty means every weight is unknown rather than one market being
   * missing. A weight is a share of a total, so a single unread balance moves
   * the denominator that every other market is measured against.
   */
  readonly unreadable: readonly { readonly vToken: string; readonly reason: string }[];
  readonly markets: readonly MarketReconstruction[];
  /** The account's supplied position across the configured markets, USD at 1e18. */
  readonly totalPositionUsd: bigint;
  /** Idle wallet capital across the configured markets' underlyings, USD at 1e18. */
  readonly totalIdleUsd: bigint;
  /** The denominator every target weight is a share of. */
  readonly portfolioUsd: bigint;
}

function describeUnreadable(market: RawSupplyMarketObservation): string {
  return (
    market.metadataUnavailableReason ??
    market.rateUnavailableReason ??
    market.balancesUnavailableReason ??
    market.priceUnavailableReason ??
    "the market could not be fully read"
  );
}

/**
 * Every reading a weight depends on, present.
 *
 * `supplyRatePerBlockMantissa` is not in this list: this model holds an
 * allocation and never ranks by yield, so a market whose rate reverted is still
 * a market whose weight is knowable. Demanding a reading the decision does not
 * use would make the model fail closed on states it can in fact judge, and a
 * needless `UNREADABLE_STATE` costs the agent a conclusive trial.
 */
function isFullyRead(market: RawSupplyMarketObservation): boolean {
  return (
    market.isListed !== null &&
    market.mintPaused !== null &&
    market.supplyCapRaw !== null &&
    market.exchangeRateMantissa !== null &&
    market.totalSupplyVTokens !== null &&
    market.cashRaw !== null &&
    market.totalBorrowsRaw !== null &&
    market.totalReservesRaw !== null &&
    market.vTokenBalance !== null &&
    market.walletUnderlyingBalance !== null &&
    market.walletAllowance !== null &&
    market.priceMantissa !== null
  );
}

/**
 * Underlying a market holds, from its balance sheet.
 *
 * `cash + borrows - reserves`. Reserves are the protocol's cut and are not owed
 * to suppliers, which is why they are subtracted rather than counted; a reader
 * that adds them overstates the market's size and understates its headroom.
 */
function suppliedFromBalanceSheet(cash: bigint, borrows: bigint, reserves: bigint): bigint {
  const total = cash + borrows - reserves;
  return total > 0n ? total : 0n;
}

/**
 * Rebuild the allocation picture from raw readings.
 *
 * Never throws on a market it cannot value. An exception would collapse the
 * difference between "this market is closed" and "this market could not be
 * assessed", and the caller has to record which of those happened.
 */
export function reconstruct(observation: RawSupplyObservation): AllocationReconstruction {
  const unreadable: { vToken: string; reason: string }[] = [];
  const markets: MarketReconstruction[] = [];
  let totalPositionUsd = 0n;
  let totalIdleUsd = 0n;

  for (const market of observation.markets) {
    if (!isFullyRead(market)) {
      unreadable.push({ vToken: market.vToken, reason: describeUnreadable(market) });
      continue;
    }

    const price = BigInt(market.priceMantissa ?? "0");
    const decimals = market.underlyingDecimals;
    const exchangeRate = BigInt(market.exchangeRateMantissa ?? "0");
    const totalSupplyVTokens = BigInt(market.totalSupplyVTokens ?? "0");
    const cap = BigInt(market.supplyCapRaw ?? "0");
    const vTokenBalance = BigInt(market.vTokenBalance ?? "0");
    const walletBalance = BigInt(market.walletUnderlyingBalance ?? "0");
    const allowance = BigInt(market.walletAllowance ?? "0");

    const supplied = suppliedFromBalanceSheet(
      BigInt(market.cashRaw ?? "0"),
      BigInt(market.totalBorrowsRaw ?? "0"),
      BigInt(market.totalReservesRaw ?? "0"),
    );
    const suppliedFromVTokenSupply = (totalSupplyVTokens * exchangeRate) / 10n ** 18n;

    const positionUsd = vTokenToUsd(vTokenBalance, exchangeRate, price);
    const idleUsd = toUsd(walletBalance, price);

    // Counted whatever the market's availability, because they describe the
    // account rather than the market. A dollar parked in a market that accepts
    // no more supply is still a dollar the published allocation has to account
    // for, and a denominator that skipped it would report a portfolio balanced
    // over the part of itself that happened to be reachable.
    totalPositionUsd += positionUsd;
    totalIdleUsd += idleUsd;

    markets.push({
      vToken: market.vToken,
      symbol: market.symbol,
      decimals,
      priceMantissa: price,
      suppliedUnderlyingRaw: supplied,
      suppliedFromVTokenSupplyRaw: suppliedFromVTokenSupply,
      identityDriftBps: differenceBps(suppliedFromVTokenSupply, supplied),
      supplyCapRaw: cap,
      headroomRaw: cap === 0n || supplied >= cap ? 0n : cap - supplied,
      positionUsd,
      idleUsd,
      walletBalanceRaw: walletBalance,
      allowanceRaw: allowance,
      unavailable: classify(market, price, decimals, cap, supplied),
    });
  }

  return {
    unreadable,
    markets,
    totalPositionUsd,
    totalIdleUsd,
    portfolioUsd: totalPositionUsd + totalIdleUsd,
  };
}

function classify(
  market: RawSupplyMarketObservation,
  price: bigint,
  decimals: number,
  cap: bigint,
  supplied: bigint,
): UnavailableReason | undefined {
  if (market.isListed !== true) return "NOT_LISTED";
  if (market.mintPaused !== false) return "MINT_PAUSED";
  if (
    market.reportedUnderlyingDecimals !== null &&
    market.reportedUnderlyingDecimals !== decimals
  ) {
    return "DECIMALS_DISAGREE";
  }
  if (!isPlausiblePrice(price, decimals)) return "IMPLAUSIBLE_PRICE";
  if (cap === 0n || supplied >= cap) return "AT_SUPPLY_CAP";
  return undefined;
}

/**
 * The dollars a market is short of its published weight. Negative when over.
 *
 * One division, and deliberately not the one the decision turns on. This figure
 * sizes the predicted top-up and prints in the evidence; whether an agent
 * should act at all is settled by `fallsShortOfWeight`, which divides by
 * nothing.
 */
export function shortfallUsd(
  targetWeightBps: bigint,
  portfolioUsd: bigint,
  positionUsd: bigint,
): bigint {
  return (targetWeightBps * portfolioUsd) / BASIS_POINTS - positionUsd;
}

/**
 * Has this market fallen at least a full drift trigger below its target weight?
 *
 * Written out here in full, and written out again independently in
 * `agents/reference/rebalancing-a/src/venus/weights.ts`. Neither imports the
 * other and neither is factored into a shared helper, because a shared
 * predicate is precisely the thing that would let one arithmetic slip make the
 * agent wrong and this model agree with it. VENUS-ACCOUNTING-001 is the frozen
 * case: one shared reconstruction, one missed debt class, and an evaluator that
 * confirmed the error.
 *
 * The comparison a reader expects is
 *
 *     targetWeightBps * portfolio / 10000 - position  >=  triggerBps * portfolio / 10000
 *
 * and both divisions are dropped by multiplying through by 10000:
 *
 *     targetWeightBps * portfolio - position * 10000  >=  triggerBps * portfolio
 *
 * With the divisions left in, the two implementations floor at different
 * moments and the trigger fires a base unit apart, so a portfolio sitting
 * exactly on the line would produce a trial failure that is a rounding artefact
 * rather than a behaviour. Exact on both sides means a boundary disagreement is
 * a bug, which is the only kind worth reporting.
 */
export function fallsShortOfWeight(
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
export function heldWeightBps(positionUsd: bigint, portfolioUsd: bigint): bigint | null {
  if (portfolioUsd <= 0n) return null;
  return (positionUsd * BASIS_POINTS) / portfolioUsd;
}
