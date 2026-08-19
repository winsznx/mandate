/**
 * The grid ladder, and where an account currently sits on it.
 *
 * A grid is usually described as a standing set of open orders, which is why
 * the original scaffold for this category was blocked on durable-effect
 * accounting: orders outlive the session that placed them, and a trial cannot
 * evaluate state it cannot see. This ladder has no open orders. It is defined
 * entirely as a function from the pool's current price to a target inventory,
 * so the whole of the agent's durable state is the account's own two token
 * balances, which a trial reads directly at the fork block. Nothing survives
 * between sessions that the chain does not already say.
 *
 * The rungs sit either side of the pool's fair rate rather than a fixed price.
 * These are two liquid-staking tokens whose redemption values diverge over
 * time, so a ladder anchored at 1:1 would drift permanently to one side of the
 * market and buy the same coin forever. Fair is the ratio the pool's own rate
 * multipliers imply, which is the price at which the invariant considers the
 * pool balanced.
 *
 * Positions and targets are measured as a share of rate-adjusted inventory
 * rather than in units of either coin. A share is currency-neutral, so the
 * ladder does not have to pick one coin to denominate in and does not drift as
 * the rate spread widens.
 */

import { BASIS_POINTS } from "./invariant.js";

/**
 * Half of the basis-point scale, which is where a two-coin ladder centres.
 *
 * The scale itself is imported rather than restated, so the two modules cannot
 * drift onto different denominators.
 */
export const HALF = 5_000n;

export interface LadderPolicy {
  /** Price movement, in basis points off fair, that advances the ladder one rung. */
  readonly spacingBps: number;
  /** Rungs either side of fair. The ladder is clamped here rather than extended. */
  readonly levels: number;
  /** How far the target inventory share moves per rung, in basis points. */
  readonly inventoryStepBps: number;
}

export interface LadderPosition {
  /** The pool's price for coin 0 in coin 1, at 1e18. */
  readonly effectiveRateMantissa: bigint;
  /** The price the rate multipliers imply, at 1e18. The ladder's centre. */
  readonly fairRateMantissa: bigint;
  /** Signed. Negative means coin 0 is trading below fair. */
  readonly deviationBps: bigint;
  /** Signed, clamped to the policy's levels. Positive means hold more of coin 0. */
  readonly rung: bigint;
  /** The share of rate-adjusted inventory the ladder wants in coin 0, in basis points. */
  readonly targetShareBps: bigint;
  /** The share it actually holds. `null` when the account holds neither coin. */
  readonly actualShareBps: bigint | null;
}

/**
 * The price the pool's rate multipliers imply for coin 0 in coin 1.
 *
 * With both balances rate-adjusted into the invariant's units, a balanced pool
 * exchanges one invariant unit for one invariant unit. Undoing the adjustment
 * on both sides leaves `rate0 / rate1` as the fair exchange rate between the
 * coins themselves.
 */
export function fairRate(storedRate0: bigint, storedRate1: bigint): bigint {
  if (storedRate1 <= 0n) throw new Error(`stored rate must be positive, received ${storedRate1}`);
  return (storedRate0 * 10n ** 18n) / storedRate1;
}

/** Rate-adjust a wallet holding into the units shares are measured in. */
export function invariantUnits(balance: bigint, storedRate: bigint): bigint {
  return (balance * storedRate) / 10n ** 18n;
}

/**
 * The share of rate-adjusted inventory held in coin 0.
 *
 * `null` on an empty account. An account holding nothing has no share, and
 * reporting either 0 or 5000 would be a claim the arithmetic cannot support —
 * one of them would put the ladder permanently at its buy limit.
 */
export function inventoryShareBps(units0: bigint, units1: bigint): bigint | null {
  const total = units0 + units1;
  if (total <= 0n) return null;
  return (units0 * BASIS_POINTS) / total;
}

/**
 * Which rung the price sits on.
 *
 * Truncated toward zero, so a price inside the first band is on rung zero in
 * both directions and the ladder is symmetric about fair. Clamped at the
 * policy's level count rather than extended, because a ladder that keeps adding
 * rungs is a position that keeps growing, and the point of publishing a level
 * count is that it bounds the inventory the strategy will take on.
 */
export function rungFor(deviationBps: bigint, policy: LadderPolicy): bigint {
  const spacing = BigInt(policy.spacingBps);
  if (spacing <= 0n) throw new Error(`grid spacing must be positive, received ${policy.spacingBps}`);
  // Negative deviation means coin 0 is cheap, and a grid buys what is cheap, so
  // the sign is inverted here rather than at every call site.
  const raw = -(deviationBps / spacing);
  const limit = BigInt(policy.levels);
  if (raw > limit) return limit;
  if (raw < -limit) return -limit;
  return raw;
}

/** The inventory share the ladder wants at a given rung, clamped to the possible range. */
export function targetShareBps(rung: bigint, policy: LadderPolicy): bigint {
  const target = HALF + rung * BigInt(policy.inventoryStepBps);
  if (target > BASIS_POINTS) return BASIS_POINTS;
  if (target < 0n) return 0n;
  return target;
}

export interface LadderInput {
  readonly effectiveRateMantissa: bigint;
  readonly storedRate0: bigint;
  readonly storedRate1: bigint;
  readonly walletBalance0: bigint;
  readonly walletBalance1: bigint;
  readonly policy: LadderPolicy;
}

/** Locate an account on the ladder. */
export function locate(input: LadderInput): LadderPosition {
  const fair = fairRate(input.storedRate0, input.storedRate1);
  const deviationBps = ((input.effectiveRateMantissa - fair) * BASIS_POINTS) / fair;
  const rung = rungFor(deviationBps, input.policy);

  return {
    effectiveRateMantissa: input.effectiveRateMantissa,
    fairRateMantissa: fair,
    deviationBps,
    rung,
    targetShareBps: targetShareBps(rung, input.policy),
    actualShareBps: inventoryShareBps(
      invariantUnits(input.walletBalance0, input.storedRate0),
      invariantUnits(input.walletBalance1, input.storedRate1),
    ),
  };
}

export type LadderDirection = "BUY_COIN0" | "SELL_COIN0" | "HOLD";

/**
 * Which way the ladder wants to trade, if at all.
 *
 * The gap has to reach a whole rung before anything happens. Without that the
 * strategy would trade on every block against a price that never stops moving,
 * paying a fee each time to close a gap smaller than the fee — which is the
 * failure mode a grid is supposed to be immune to, arrived at by writing one.
 */
export function directionFor(position: LadderPosition, policy: LadderPolicy): LadderDirection {
  if (position.actualShareBps === null) return "HOLD";
  const gap = position.targetShareBps - position.actualShareBps;
  const step = BigInt(policy.inventoryStepBps);
  if (gap >= step) return "BUY_COIN0";
  if (-gap >= step) return "SELL_COIN0";
  return "HOLD";
}
