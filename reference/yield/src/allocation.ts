/**
 * An independent reconstruction of where an account's supplied capital sits and
 * which markets would take more of it.
 *
 * This module exists to disagree. The agent under test derives a market's
 * supplied total from `totalSupply * exchangeRateStored`, taking the vToken's
 * own accounting identity as given. This model never uses that product for its
 * answer: it adds up the market's balance sheet from `getCash`, `totalBorrows`
 * and `totalReserves`, which is the other side of the same identity and is what
 * the exchange rate is derived from in the first place.
 *
 * The two routes are arithmetically equal only when both are right. That is the
 * entire point — a trial in which the agent and the evaluator run the same code
 * certifies the code's bugs along with its correctness. The vToken product is
 * still computed and the gap between the two is reported as drift. It is a
 * cross-check on this module, not an input to it.
 *
 * Two rules govern what counts as available, and both err toward reporting less
 * capacity rather than more:
 *
 *   A market is available only when all three of `isListed`, `mintPaused` and
 *   `supplyCaps` were read. Testnet vBUSD is listed, priced, and rejects every
 *   `mint`; a reader that checks listing alone ranks it first whenever its rate
 *   happens to be highest.
 *
 *   A supply cap of zero closes a market. Venus writes zero on retired markets,
 *   and reading it as "no ceiling" opens exactly the markets the field exists to
 *   close.
 */
import type { RawSupplyMarketObservation, RawSupplyObservation } from "@mandate/venus-bsc";
import { differenceBps, isPlausiblePrice, toUsd, vTokenToUsd } from "./scale.js";

/** Why a market cannot take part in the ranking. */
export type UnavailableReason =
  | "UNREADABLE"
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
  /** As read. Never annualised by this model. */
  readonly supplyRatePerBlockMantissa: bigint;
  /** `cash + borrows - reserves`. This model's own figure, from the balance sheet. */
  readonly suppliedUnderlyingRaw: bigint;
  /** `totalSupply * exchangeRate`, the agent's route. Recorded for the cross-check only. */
  readonly suppliedFromVTokenSupplyRaw: bigint;
  /** Disagreement between the two routes, in basis points. `null` when the market is empty. */
  readonly identityDriftBps: bigint | null;
  readonly supplyCapRaw: bigint;
  /** Underlying the market will still accept. Zero when the cap binds or is zero. */
  readonly headroomRaw: bigint;
  /** The account's own position here, in USD at 1e18. */
  readonly accountSuppliedUsd: bigint;
  readonly walletBalanceRaw: bigint;
  readonly allowanceRaw: bigint;
  /** Set when this market cannot be ranked. `undefined` means it can. */
  readonly unavailable: UnavailableReason | undefined;
}

export interface AllocationReconstruction {
  /**
   * Markets carrying something this model could not read.
   *
   * Non-empty means the ranking is unknown rather than merely narrower. A
   * market whose rate could not be read might be the best one, and answering
   * the question over the readable subset silently answers a different question.
   */
  readonly unreadable: readonly { readonly vToken: string; readonly reason: string }[];
  readonly markets: readonly MarketReconstruction[];
  /** The account's total supplied position across the configured markets, USD at 1e18. */
  readonly totalSuppliedUsd: bigint;
  /** Idle wallet capital across the configured markets' underlyings, USD at 1e18. */
  readonly totalIdleUsd: bigint;
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

function isFullyRead(market: RawSupplyMarketObservation): boolean {
  return (
    market.isListed !== null &&
    market.mintPaused !== null &&
    market.supplyCapRaw !== null &&
    market.supplyRatePerBlockMantissa !== null &&
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
 * difference between "this market is unattractive" and "this market could not
 * be assessed", and the caller has to record which of those happened.
 */
export function reconstruct(observation: RawSupplyObservation): AllocationReconstruction {
  const unreadable: { vToken: string; reason: string }[] = [];
  const markets: MarketReconstruction[] = [];
  let totalSuppliedUsd = 0n;
  let totalIdleUsd = 0n;

  for (const market of observation.markets) {
    if (!isFullyRead(market)) {
      unreadable.push({ vToken: market.vToken, reason: describeUnreadable(market) });
      continue;
    }

    const price = BigInt(market.priceMantissa ?? "0");
    const decimals = market.underlyingDecimals;
    const rate = BigInt(market.supplyRatePerBlockMantissa ?? "0");
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

    const unavailable = classify(market, price, decimals, cap, supplied);
    const headroom = cap === 0n || supplied >= cap ? 0n : cap - supplied;
    const accountSuppliedUsd = vTokenToUsd(vTokenBalance, exchangeRate, price);

    // Counted whatever the market's availability, because they describe the
    // account rather than the market. A concentration ceiling has to weigh
    // capital sitting in a market that has since closed to new supply.
    totalSuppliedUsd += accountSuppliedUsd;
    totalIdleUsd += toUsd(walletBalance, price);

    markets.push({
      vToken: market.vToken,
      symbol: market.symbol,
      decimals,
      priceMantissa: price,
      supplyRatePerBlockMantissa: rate,
      suppliedUnderlyingRaw: supplied,
      suppliedFromVTokenSupplyRaw: suppliedFromVTokenSupply,
      identityDriftBps: differenceBps(suppliedFromVTokenSupply, supplied),
      supplyCapRaw: cap,
      headroomRaw: headroom,
      accountSuppliedUsd,
      walletBalanceRaw: walletBalance,
      allowanceRaw: allowance,
      unavailable,
    });
  }

  return { unreadable, markets, totalSuppliedUsd, totalIdleUsd };
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
 * The largest deployment into a market that leaves its share within a ceiling.
 *
 * The share is taken against the account's whole capital, supplied plus idle.
 * That denominator is invariant under the action being sized: supplying moves
 * capital from the idle side to the supplied side and changes neither total, so
 * the constraint is a statement about the portfolio rather than about the order
 * the deposits happened to arrive in.
 *
 * Against the supplied part alone the rule would be unsatisfiable on an account
 * with nothing supplied yet, where any first deposit is 100% of the supplied
 * capital. A ceiling that forbids ever starting is not conservative, and a
 * model holding one would predict `hold` forever and fail every agent that ever
 * deployed anything.
 *
 * `null` means the ceiling constrains nothing, which is a different answer from
 * zero: a cap at or above 10000 bps permits any deployment, while a market
 * already at its share permits none, and rendering both as the same number
 * would make the unconstrained case indistinguishable from the fully
 * constrained one.
 */
export function ceilingUsd(
  marketUsd: bigint,
  totalCapitalUsd: bigint,
  capBps: bigint,
): bigint | null {
  if (capBps >= 10_000n) return null;
  const permitted = (capBps * totalCapitalUsd) / 10_000n;
  return permitted > marketUsd ? permitted - marketUsd : 0n;
}
