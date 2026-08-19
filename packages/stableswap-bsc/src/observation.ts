/**
 * Raw stableswap observations.
 *
 * This package answers factual questions about pool state and nothing else. It
 * exports no `computePrice`, no `isCheap`, no `sizeTrade`. The agent and the
 * reference model both read from here and then reason independently, which is
 * the only reason a trial in this category means anything: if they shared one
 * pricing implementation, a bug in it would make the agent wrong and the
 * evaluator agree, and the trial would certify the error.
 *
 * The observation carries both sides of that split on purpose. `poolQuote` is
 * what the pool itself said a swap would return; `balances`, `storedRates`,
 * `amplification`, `fee` and `offpegFeeMultiplier` are everything a reader needs
 * to derive that number without asking. Recording both is what turns "the two
 * agree" from an assumption into a reconciliation a verifier can redo.
 */
import type { Address, Hex } from "viem";

export const STABLESWAP_OBSERVATION_SCHEMA_VERSION = "mandate.stableswap-observation/1" as const;

/** One coin's state, exactly as read. Nothing here is normalised or combined. */
export interface RawCoinObservation {
  readonly index: number;
  readonly token: Address;
  readonly symbol: string;
  /** The configured value the invariant scaling was derived from. */
  readonly decimals: number;
  /** What `decimals()` reported. `null` when the call reverted. */
  readonly reportedDecimals: number | null;
  /** The pool's own balance of this coin, before rate adjustment. */
  readonly poolBalance: string | null;
  /**
   * The rate multiplier at 1e18 that converts this coin to the invariant's units.
   *
   * Not decoration. Both coins here are liquid-staking tokens whose redemption
   * values drift apart, and the invariant runs on `balance * rate / 1e18`.
   * Treating the pool as balanced at its raw balances misprices it by the whole
   * rate spread, which on chain 97 is currently 16%.
   */
  readonly storedRate: string | null;
  /** The account's own holding, which is what the grid's inventory is read from. */
  readonly walletBalance: string | null;
  /** What the account has approved the pool to pull. Granted by the admin key, never a session. */
  readonly walletAllowance: string | null;
  readonly unavailableReason?: string;
}

/** One direction's quote, as the pool itself reported it. */
export interface RawPoolQuote {
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly dx: string;
  /** `null` when `get_dy` reverted, which a consumer must fail closed on. */
  readonly dy: string | null;
  readonly unavailableReason?: string;
}

export interface RawStableswapObservation {
  readonly schemaVersion: typeof STABLESWAP_OBSERVATION_SCHEMA_VERSION;
  readonly chainId: number;
  readonly account: Address;
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly pool: Address;
  /** `A()`, already divided by `A_PRECISION`. The invariant needs it multiplied back. */
  readonly amplification: string | null;
  readonly feeBase: string | null;
  readonly offpegFeeMultiplier: string | null;
  readonly virtualPrice: string | null;
  readonly coins: readonly RawCoinObservation[];
  /**
   * The pool's own quotes, one per direction, for a unit trade.
   *
   * Recorded so the agent's route and the reference model's route can be
   * compared against each other in the artifact rather than only their
   * conclusions. It is a cross-check on the reconstruction, never an input to it.
   */
  readonly poolQuotes: readonly RawPoolQuote[];
  readonly parametersUnavailableReason?: string;
}

/**
 * Is every reading needed to value this pool present?
 *
 * The fail-closed trigger for every consumer. A pool whose rates, balances or
 * amplification could not be read has an unknown price, and a grid that treats
 * unknown as "unchanged" holds a rung it should have filled or fills one it
 * should not have.
 */
export function isFullyRead(observation: RawStableswapObservation): boolean {
  if (
    observation.amplification === null ||
    observation.feeBase === null ||
    observation.offpegFeeMultiplier === null
  ) {
    return false;
  }
  return observation.coins.every(
    (coin) =>
      coin.poolBalance !== null &&
      coin.storedRate !== null &&
      coin.walletBalance !== null &&
      coin.walletAllowance !== null,
  );
}

/** Everything that could not be read, named, for the refusal a consumer has to state. */
export function unreadableReadings(observation: RawStableswapObservation): readonly string[] {
  const missing: string[] = [];
  if (observation.parametersUnavailableReason !== undefined) {
    missing.push(`pool parameters (${observation.parametersUnavailableReason})`);
  }
  if (observation.amplification === null) missing.push("A()");
  if (observation.feeBase === null) missing.push("fee()");
  if (observation.offpegFeeMultiplier === null) missing.push("offpeg_fee_multiplier()");
  for (const coin of observation.coins) {
    if (coin.unavailableReason !== undefined) {
      missing.push(`${coin.symbol} (${coin.unavailableReason})`);
      continue;
    }
    if (coin.poolBalance === null) missing.push(`${coin.symbol} balances()`);
    if (coin.storedRate === null) missing.push(`${coin.symbol} stored_rates()`);
    if (coin.walletBalance === null) missing.push(`${coin.symbol} balanceOf()`);
    if (coin.walletAllowance === null) missing.push(`${coin.symbol} allowance()`);
  }
  return missing;
}

/** Coins whose configured decimals disagree with what the token reports. */
export function coinsWithDecimalsDisagreement(
  observation: RawStableswapObservation,
): readonly RawCoinObservation[] {
  return observation.coins.filter(
    (coin) => coin.reportedDecimals !== null && coin.reportedDecimals !== coin.decimals,
  );
}
