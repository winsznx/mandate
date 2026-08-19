/**
 * Grid arithmetic. Pure, integer-only, no chain access.
 *
 * This agent's price comes from the pool: it asks `get_dy` what a probe trade
 * returns and divides. The reference model that judges it refuses to ask and
 * solves the invariant from balances, rate multipliers, amplification and both
 * fee parameters. The two routes agree only when both are right, which is the
 * point — a grid agent that mispriced the pool and a judge that asked the pool
 * the same question the agent asked would agree with each other and certify the
 * error.
 *
 * Everything is `bigint`. The `min_dy` derived here becomes an on-chain
 * argument and is the only thing standing between the session and a searcher,
 * so a half-ulp of drift between what the artifact claims and what the chain
 * saw is not acceptable.
 */

export const MANTISSA = 10n ** 18n;
export const BASIS_POINTS = 10_000n;
export const HALF_SHARE_BPS = 5_000n;

export class GridArithmeticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GridArithmeticError";
  }
}

/**
 * The price the pool's rate multipliers imply for coin 0 in coin 1.
 *
 * The ladder's centre. Anchoring at 1:1 instead would be wrong for this pair
 * and wrong in a way that never corrects: these are two liquid-staking tokens
 * whose redemption values drift apart, so a fixed anchor slides permanently to
 * one side of the market and the grid buys the same coin forever.
 */
export function fairRate(storedRate0: bigint, storedRate1: bigint): bigint {
  if (storedRate1 <= 0n) {
    throw new GridArithmeticError(`stored rate must be positive, received ${storedRate1}`);
  }
  return (storedRate0 * MANTISSA) / storedRate1;
}

/** The price the pool actually offers, from its own quote for a probe trade. */
export function effectiveRate(probeDy: bigint, probeSize: bigint): bigint {
  if (probeSize <= 0n) {
    throw new GridArithmeticError(`probe size must be positive, received ${probeSize}`);
  }
  return (probeDy * MANTISSA) / probeSize;
}

/** Signed distance from fair, in basis points. Negative means coin 0 is cheap. */
export function deviationBps(effective: bigint, fair: bigint): bigint {
  if (fair <= 0n) throw new GridArithmeticError(`fair rate must be positive, received ${fair}`);
  return ((effective - fair) * BASIS_POINTS) / fair;
}

/** Rate-adjust a wallet holding into the units inventory shares are measured in. */
export function toInventoryUnits(balance: bigint, storedRate: bigint): bigint {
  return (balance * storedRate) / MANTISSA;
}

/**
 * The share of rate-adjusted inventory held in coin 0, in basis points.
 *
 * `null` on an empty account. An account holding nothing has no share, and
 * reporting 0 would put the ladder permanently at its buy limit.
 */
export function inventoryShareBps(units0: bigint, units1: bigint): bigint | null {
  const total = units0 + units1;
  if (total <= 0n) return null;
  return (units0 * BASIS_POINTS) / total;
}

/**
 * Which rung the price sits on, signed and clamped.
 *
 * Truncated toward zero, so a price inside the first band is on rung zero in
 * both directions and the ladder is symmetric about fair. Clamped at the
 * published level count rather than extended: a ladder that keeps adding rungs
 * is a position that keeps growing, and the level count is the published bound
 * on how much inventory the strategy will take on.
 */
export function rungFor(deviation: bigint, spacingBps: number, levels: number): bigint {
  if (spacingBps <= 0) {
    throw new GridArithmeticError(`grid spacing must be positive, received ${spacingBps}`);
  }
  // A grid buys what is cheap, and cheap coin 0 is a negative deviation, so the
  // sign is inverted once here rather than at every call site.
  const raw = -(deviation / BigInt(spacingBps));
  const limit = BigInt(levels);
  if (raw > limit) return limit;
  if (raw < -limit) return -limit;
  return raw;
}

/** The inventory share the ladder wants at a rung, clamped to what is possible. */
export function targetShareBps(rung: bigint, inventoryStepBps: number): bigint {
  const target = HALF_SHARE_BPS + rung * BigInt(inventoryStepBps);
  if (target > BASIS_POINTS) return BASIS_POINTS;
  if (target < 0n) return 0n;
  return target;
}

/** A minimum output `maxSlippageBps` below a quote. */
export function minimumOutput(quotedDy: bigint, maxSlippageBps: number): bigint {
  if (maxSlippageBps < 0 || maxSlippageBps >= 10_000) {
    throw new GridArithmeticError(`slippage must be in [0, 10000), received ${maxSlippageBps}`);
  }
  return (quotedDy * (BASIS_POINTS - BigInt(maxSlippageBps))) / BASIS_POINTS;
}

/** A 1e18 ratio as a decimal string, for the rationale and the evidence record. */
export function formatMantissa(value: bigint, places = 6): string {
  const whole = value / MANTISSA;
  const fraction = (value % MANTISSA).toString(10).padStart(18, "0").slice(0, places);
  return `${whole}.${fraction}`;
}
