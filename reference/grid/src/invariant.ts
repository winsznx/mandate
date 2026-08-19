/**
 * The stableswap invariant, solved from first principles.
 *
 * This module exists to disagree with the pool. The agent under test asks
 * `get_dy` what a swap returns and takes the answer; this model never calls it.
 * It reads the pool's balances, its rate multipliers, its amplification and its
 * two fee parameters, solves the invariant D by Newton's method, solves for the
 * post-trade balance y of the output coin by Newton's method again, applies the
 * off-peg fee, and arrives at the same number by a completely different route.
 *
 * The two agree only when both are right, which is the point. A grid agent that
 * mispriced the pool and an evaluator that asked the pool the same question the
 * agent asked would agree with each other and certify the error.
 *
 * Reproduced exactly, wei for wei, against the deployed pool on chain 97 at
 * block 125936215:
 *
 *     get_dy(0, 1, 1e18)  chain 1158021437469978502   this module 1158021437469978502
 *     get_dy(1, 0, 1e18)  chain  863367093084179311   this module  863367093084179311
 *
 * Three details are load-bearing and each is a way the reconstruction goes
 * quietly wrong rather than loudly:
 *
 *   The invariant runs on rate-adjusted balances, `balance * rate / 1e18`. Both
 *   coins here are liquid-staking tokens whose redemption values have drifted
 *   16% apart, so a solver on raw balances prices a badly imbalanced pool as a
 *   balanced one and reports the entire spread as a trading opportunity.
 *
 *   `A()` returns the amplification already divided by `A_PRECISION`. The
 *   invariant needs it multiplied back. Feeding the returned figure in solves a
 *   curve a hundred times flatter, which understates slippage on every size.
 *
 *   The fee is not `fee()`. Stableswap-NG scales it by `offpeg_fee_multiplier`
 *   as the pool leaves balance, so the realised fee is strictly larger than the
 *   base whenever the multiplier exceeds the denominator. On this pool the
 *   multiplier is 2e10 against a 1e10 denominator, so ignoring it over-quotes
 *   every swap.
 *
 * Everything is integer `bigint`, matching the Vyper source's own arithmetic
 * including its truncating divisions. Floating point would be convenient and
 * would not reproduce the contract.
 */

export const PRECISION = 10n ** 18n;
export const FEE_DENOMINATOR = 10n ** 10n;
export const BASIS_POINTS = 10_000n;

export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantError";
  }
}

export interface PoolParameters {
  /** Rate-adjusted balances, in the invariant's own units. */
  readonly xp: readonly bigint[];
  /** `A() * A_PRECISION`. The raw amplification the invariant is defined against. */
  readonly amplification: bigint;
  readonly amplificationPrecision: bigint;
  readonly feeBase: bigint;
  readonly offpegFeeMultiplier: bigint;
}

/** Rate-adjust a coin balance into the units the invariant is defined on. */
export function toInvariantUnits(balance: bigint, storedRate: bigint): bigint {
  return (balance * storedRate) / PRECISION;
}

/** Convert an invariant-unit amount back into the coin's own units. */
export function fromInvariantUnits(amount: bigint, storedRate: bigint): bigint {
  if (storedRate <= 0n) {
    throw new InvariantError(`stored rate must be positive, received ${storedRate}`);
  }
  return (amount * PRECISION) / storedRate;
}

/**
 * The invariant D, by Newton's method.
 *
 * D is the pool's total value at the point where the two coins are balanced,
 * and it is the quantity every other answer is derived from. It converges in
 * well under the iteration budget for any pool that is not degenerate; the
 * budget exists so that a degenerate one fails loudly instead of hanging.
 *
 * The iteration is Curve's own, reproduced including its integer truncations.
 * An algebraically equivalent rearrangement would round differently and would
 * disagree with the contract in the last few wei, which is a disagreement with
 * no cause that would then have to be explained away every time it appeared.
 */
export function solveInvariant(xp: readonly bigint[], amplification: bigint, amplificationPrecision: bigint): bigint {
  const n = BigInt(xp.length);
  if (n < 2n) throw new InvariantError(`a pool needs at least two coins, received ${xp.length}`);

  let sum = 0n;
  for (const value of xp) {
    if (value <= 0n) throw new InvariantError("every rate-adjusted balance must be positive");
    sum += value;
  }
  if (sum === 0n) return 0n;

  const ann = amplification * n;
  let d = sum;

  for (let iteration = 0; iteration < 255; iteration += 1) {
    let dp = d;
    for (const value of xp) {
      dp = (dp * d) / value;
    }
    dp /= n ** n;

    const previous = d;
    d =
      (((ann * sum) / amplificationPrecision + dp * n) * d) /
      (((ann - amplificationPrecision) * d) / amplificationPrecision + (n + 1n) * dp);

    if (absolute(d - previous) <= 1n) return d;
  }

  throw new InvariantError("the invariant did not converge in 255 iterations");
}

/**
 * The output-coin balance that holds the invariant, given a new input balance.
 *
 * Newton again, on the quadratic that falls out of holding D fixed while one
 * balance moves. Solving for the balance rather than for the output directly is
 * what makes the answer exact: the output is then a difference of two integers
 * the contract also computes, rather than a quantity derived through a
 * rearrangement that rounds elsewhere.
 */
export function solveOutputBalance(
  inputIndex: number,
  outputIndex: number,
  newInputBalance: bigint,
  xp: readonly bigint[],
  amplification: bigint,
  amplificationPrecision: bigint,
  d: bigint,
): bigint {
  if (inputIndex === outputIndex) {
    throw new InvariantError("a swap needs two different coins");
  }
  const n = BigInt(xp.length);
  const ann = amplification * n;

  let c = d;
  let sum = 0n;
  for (let index = 0; index < xp.length; index += 1) {
    if (index === outputIndex) continue;
    const balance = index === inputIndex ? newInputBalance : xp[index];
    if (balance === undefined || balance <= 0n) {
      throw new InvariantError(`balance for coin ${index} must be positive`);
    }
    sum += balance;
    c = (c * d) / (balance * n);
  }
  c = (c * d * amplificationPrecision) / (ann * n);
  const b = sum + (d * amplificationPrecision) / ann;

  let y = d;
  for (let iteration = 0; iteration < 255; iteration += 1) {
    const previous = y;
    y = (y * y + c) / (2n * y + b - d);
    if (absolute(y - previous) <= 1n) return y;
  }

  throw new InvariantError("the output balance did not converge in 255 iterations");
}

/**
 * The fee this pool charges on a trade that leaves it at these balances.
 *
 * Stableswap-NG raises the fee as the pool moves off balance, so the base rate
 * is a floor rather than the answer. At a multiplier of 1e10 or below the
 * scaling is inert and the base rate is charged, which is why the guard is a
 * comparison rather than an assumption that the multiplier is always active.
 */
export function dynamicFee(
  midInput: bigint,
  midOutput: bigint,
  feeBase: bigint,
  offpegFeeMultiplier: bigint,
): bigint {
  if (offpegFeeMultiplier <= FEE_DENOMINATOR) return feeBase;
  const squaredSum = (midInput + midOutput) ** 2n;
  if (squaredSum === 0n) return feeBase;
  return (
    (offpegFeeMultiplier * feeBase) /
    (((offpegFeeMultiplier - FEE_DENOMINATOR) * 4n * midInput * midOutput) / squaredSum +
      FEE_DENOMINATOR)
  );
}

export interface SwapQuote {
  /** Output in the destination coin's own units, net of fee. */
  readonly dy: bigint;
  /** The fee charged, in invariant units. */
  readonly feeCharged: bigint;
  /** The invariant this quote was solved against. */
  readonly invariant: bigint;
}

/**
 * What a swap returns, derived rather than asked.
 *
 * The whole reason this module exists. Everything the pool's own `get_dy` would
 * have told us is reconstructed here from readings that are not `get_dy`, so
 * that the artifact records two independent answers to one question instead of
 * one answer twice.
 */
export function quoteSwap(
  parameters: PoolParameters,
  inputIndex: number,
  outputIndex: number,
  dxInInvariantUnits: bigint,
  outputStoredRate: bigint,
): SwapQuote {
  const { xp, amplification, amplificationPrecision, feeBase, offpegFeeMultiplier } = parameters;
  const invariant = solveInvariant(xp, amplification, amplificationPrecision);

  const inputBefore = xp[inputIndex];
  const outputBefore = xp[outputIndex];
  if (inputBefore === undefined || outputBefore === undefined) {
    throw new InvariantError(`coin index out of range: ${inputIndex}, ${outputIndex}`);
  }

  const inputAfter = inputBefore + dxInInvariantUnits;
  const outputAfter = solveOutputBalance(
    inputIndex,
    outputIndex,
    inputAfter,
    xp,
    amplification,
    amplificationPrecision,
    invariant,
  );

  // The contract subtracts one before the fee, so that rounding can never leave
  // the pool short. Reproduced rather than tidied away: dropping it makes every
  // quote one wei optimistic, which is a permanent unexplained disagreement
  // with the chain in exactly the direction that matters.
  const gross = outputBefore - outputAfter - 1n;
  const fee =
    (dynamicFee(
      (inputBefore + inputAfter) / 2n,
      (outputBefore + outputAfter) / 2n,
      feeBase,
      offpegFeeMultiplier,
    ) *
      gross) /
    FEE_DENOMINATOR;

  return {
    dy: fromInvariantUnits(gross - fee, outputStoredRate),
    feeCharged: fee,
    invariant,
  };
}

/**
 * Absolute difference between two figures, in basis points of `reference`.
 *
 * `null` when the reference is zero, because a proportional disagreement with
 * nothing is not a number.
 */
export function differenceBps(observed: bigint, reference: bigint): bigint | null {
  if (reference === 0n) return null;
  return (absolute(observed - reference) * BASIS_POINTS) / absolute(reference);
}

/** A signed difference in basis points of `reference`, keeping the direction. */
export function signedDifferenceBps(observed: bigint, reference: bigint): bigint | null {
  if (reference <= 0n) return null;
  return ((observed - reference) * BASIS_POINTS) / reference;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}
