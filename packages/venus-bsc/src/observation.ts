/**
 * Raw Venus observations.
 *
 * This package answers factual questions about chain state and nothing else. It
 * deliberately exports no `computeHealthFactor`, no `isAtRisk`, no
 * `calculateRequiredRepay`. The agent and the reference model both read from
 * here and then reason independently, which is the only reason a trial means
 * anything: if they shared one accounting implementation, a bug in it would
 * make the agent wrong and the evaluator agree, and the trial would certify the
 * error.
 *
 * That is not hypothetical. An earlier shared implementation derived an
 * account's debt universe from `getAssetsIn`, which omits VAI. It reported an
 * account at health factor 2.505 as having no debt at all. See
 * VENUS-ACCOUNTING-001 in `fixtures/`.
 *
 * The observation below is therefore a record of what the chain said, with the
 * provenance of each reading attached, and no derived risk numbers whatsoever.
 */
import type { Address, Hex } from "viem";

export const VENUS_OBSERVATION_SCHEMA_VERSION = "mandate.venus-observation/1" as const;

/** One market's state, exactly as read. Nothing here is normalised or combined. */
export interface RawMarketObservation {
  readonly vToken: Address;
  readonly underlying: Address | null;
  /**
   * Read from the underlying token. `vBNB` has no underlying, so this is the native 18.
   *
   * `null` when `decimals()` could not be read. That makes the market
   * unpriceable rather than 18-decimal: the oracle scale is
   * `1e(36 - decimals)`, so guessing wrong is an error of twelve orders of
   * magnitude, not a rounding difference.
   */
  readonly underlyingDecimals: number | null;
  /**
   * Market metadata, or `null` when the Comptroller refused to return it.
   *
   * `getAllMarkets` lists markets whose `markets()` call reverts on the Diamond.
   * Recording them as unlisted with zero weights would silently drop real
   * collateral and real debt, so the absence is represented rather than
   * defaulted.
   */
  readonly isListed: boolean | null;
  /** Weights borrowing power. NOT the liquidation threshold; the two differ. */
  readonly collateralFactorMantissa: string | null;
  /** Weights liquidation risk. Read from field 4 of the 7-field `markets()` tuple. */
  readonly liquidationThresholdMantissa: string | null;
  readonly metadataUnavailableReason?: string;
  /**
   * Balances, or `null` when the vToken refused to report them.
   *
   * A market that cannot be read is not a market with no position. Consumers
   * must treat a null balance on a listed market as unknown risk and fail
   * closed, never as zero.
   */
  readonly vTokenBalance: string | null;
  readonly exchangeRateMantissa: string | null;
  /** Principal plus accrued interest, from `borrowBalanceStored`. */
  readonly borrowBalance: string | null;
  readonly balancesUnavailableReason?: string;
  /**
   * Oracle price at the Venus scale of `1e(36 - underlyingDecimals)`.
   *
   * `null` when the oracle refused to price the market. Several testnet markets
   * revert with `invalid resilient oracle price`, and substituting zero would
   * value real collateral at nothing and real debt at nothing — understating
   * risk in the direction that gets an account liquidated. A consumer that
   * finds a null price on a market carrying a balance must fail closed rather
   * than skip it.
   */
  readonly priceMantissa: string | null;
  readonly priceUnavailableReason?: string;
  /** True when the account called `enterMarkets` for this market. */
  readonly entered: boolean;
}

/**
 * VAI debt, which is not a market.
 *
 * VAI is minted through the Comptroller rather than borrowed from a vToken, so
 * it has no entry in `getAllMarkets` and never appears in `getAssetsIn`. It is
 * nonetheless charged against the account by `getAccountLiquidity`. Recording
 * it as its own field rather than as a market is what stops it being lost.
 */
export interface RawVaiObservation {
  readonly controller: Address;
  /** `Comptroller.mintedVAIs`. Principal only. Understates what is owed. */
  readonly mintedPrincipal: string;
  /**
   * `VAIController.getVAIRepayAmount`. Principal plus accrued interest.
   *
   * This is the figure that must be used. On the frozen fixture it is 67%
   * larger than the principal. It is not callable on the Comptroller Diamond,
   * which reverts `Diamond: Function does not exist`.
   */
  readonly repayAmount: string;
  /** VAI is a dollar-denominated unit, so this is 18 on both chains. */
  readonly decimals: number;
}

/** `Comptroller.getAccountLiquidity`, the protocol's own verdict. */
export interface RawAccountLiquidity {
  readonly errorCode: string;
  readonly liquidity: string;
  readonly shortfall: string;
}

export interface RawVenusObservation {
  readonly schemaVersion: typeof VENUS_OBSERVATION_SCHEMA_VERSION;
  readonly chainId: number;
  readonly account: Address;
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly comptroller: Address;

  /**
   * Every listed market, from `getAllMarkets`.
   *
   * The complete universe, not the entered subset. A reader that enumerates
   * only `getAssetsIn` misses any market the account holds a position in
   * without having entered it, and misses VAI entirely.
   */
  readonly markets: readonly RawMarketObservation[];

  /**
   * The raw `getAssetsIn` result, preserved verbatim.
   *
   * Kept so a verifier can see precisely what the incomplete view would have
   * been, and so the regression test can assert the two differ.
   */
  readonly enteredMarkets: readonly Address[];

  readonly vai: RawVaiObservation;
  readonly accountLiquidity: RawAccountLiquidity;

  /** Implementation behind the vToken delegator at read time, for the profile pin. */
  readonly vTokenImplementations: Readonly<Record<Address, Address>>;
}

/**
 * Markets carrying a non-zero borrow.
 *
 * A factual filter over recorded balances, not a risk judgement: it says which
 * markets have debt, never whether that debt is dangerous.
 */
export function marketsWithDebt(
  observation: RawVenusObservation,
): readonly RawMarketObservation[] {
  return observation.markets.filter(
    (market) => market.borrowBalance !== null && BigInt(market.borrowBalance) > 0n,
  );
}

/** Markets carrying a non-zero vToken balance. */
export function marketsWithCollateral(
  observation: RawVenusObservation,
): readonly RawMarketObservation[] {
  return observation.markets.filter(
    (market) => market.vTokenBalance !== null && BigInt(market.vTokenBalance) > 0n,
  );
}

/**
 * Markets the observation could not fully read.
 *
 * Any consumer deriving a risk number must consult this first. An unreadable
 * market is unknown exposure, and treating unknown as zero is how an account
 * with debt reads as safe.
 */
export function unreadableMarkets(
  observation: RawVenusObservation,
): readonly RawMarketObservation[] {
  return observation.markets.filter(
    (market) =>
      market.balancesUnavailableReason !== undefined ||
      market.metadataUnavailableReason !== undefined,
  );
}

/**
 * Markets that carry exposure the observation cannot price or weight.
 *
 * This is the fail-closed trigger: there is a balance, but something needed to
 * value it is missing.
 */
export function marketsWithUnpricedExposure(
  observation: RawVenusObservation,
): readonly RawMarketObservation[] {
  return observation.markets.filter((market) => {
    const hasBalance =
      (market.vTokenBalance !== null && BigInt(market.vTokenBalance) > 0n) ||
      (market.borrowBalance !== null && BigInt(market.borrowBalance) > 0n);
    if (!hasBalance) return false;
    // Decimals set the oracle scale, so an unknown decimals value makes the
    // price unusable even when the oracle answered.
    return (
      market.priceMantissa === null ||
      market.liquidationThresholdMantissa === null ||
      market.underlyingDecimals === null
    );
  });
}

/**
 * Does the account owe anything outside the markets `getAssetsIn` returned?
 *
 * The predicate behind VENUS-ACCOUNTING-001. It exists so the invariant can be
 * asserted directly rather than inferred from a health factor that happens to
 * come out wrong.
 */
export function hasDebtOutsideEnteredMarkets(observation: RawVenusObservation): boolean {
  if (BigInt(observation.vai.repayAmount) > 0n) return true;

  const entered = new Set(observation.enteredMarkets.map((address) => address.toLowerCase()));
  return marketsWithDebt(observation).some(
    (market) => !entered.has(market.vToken.toLowerCase()),
  );
}
