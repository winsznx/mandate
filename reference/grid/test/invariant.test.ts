import { describe, expect, it } from "vitest";
import {
  FEE_DENOMINATOR,
  InvariantError,
  dynamicFee,
  quoteSwap,
  solveInvariant,
  solveOutputBalance,
  toInvariantUnits,
  type PoolParameters,
} from "../src/invariant.js";
import { AMPLIFICATION_PRECISION, CHAIN, ONE } from "./fixtures.js";

/**
 * The claim this whole category rests on.
 *
 * The agent under test asks the pool what a swap returns. This model refuses to
 * ask and derives the answer from balances, rate multipliers, amplification and
 * both fee parameters. That is only worth doing if the derivation is exact:
 * a reconstruction that is approximately right would need a tolerance, and a
 * tolerance wide enough to absorb a modelling error is wide enough to absorb
 * the mispricing bug the model exists to catch.
 *
 * It is exact. Every figure below is a reading taken off the deployed pool
 * `0x157b06e4d9501071a401234f117edee913217833` on chain 97 at block 125936215,
 * and the reconstruction reproduces the contract's own `get_dy` wei for wei in
 * both directions.
 */

function parameters(overrides: Partial<PoolParameters> = {}): PoolParameters {
  return {
    xp: [
      toInvariantUnits(CHAIN.balance0, CHAIN.storedRate0),
      toInvariantUnits(CHAIN.balance1, CHAIN.storedRate1),
    ],
    // `A()` reports the amplification already divided by A_PRECISION.
    amplification: CHAIN.amplification * AMPLIFICATION_PRECISION,
    amplificationPrecision: AMPLIFICATION_PRECISION,
    feeBase: CHAIN.feeBase,
    offpegFeeMultiplier: CHAIN.offpegFeeMultiplier,
    ...overrides,
  };
}

describe("the reconstruction reproduces the deployed pool", () => {
  it("matches get_dy(0, 1, 1e18) to the wei", () => {
    // #given the pool's readings at block 125936215
    // #when the invariant is solved and the swap priced from them
    const quote = quoteSwap(
      parameters(),
      0,
      1,
      toInvariantUnits(ONE, CHAIN.storedRate0),
      CHAIN.storedRate1,
    );

    // #then the answer is the contract's own, exactly
    expect(quote.dy).toBe(CHAIN.poolQuote0To1);
  });

  it("matches get_dy(1, 0, 1e18) to the wei", () => {
    // #given the same readings, priced the other way round
    const quote = quoteSwap(
      parameters(),
      1,
      0,
      toInvariantUnits(ONE, CHAIN.storedRate1),
      CHAIN.storedRate0,
    );

    // #then both directions agree with the chain, so the match is a property of
    // the reconstruction rather than a coincidence in one direction
    expect(quote.dy).toBe(CHAIN.poolQuote1To0);
  });

  it("solves an invariant consistent with the pool's own virtual price", () => {
    // #given the invariant this model derives
    const invariant = solveInvariant(
      parameters().xp,
      CHAIN.amplification * AMPLIFICATION_PRECISION,
      AMPLIFICATION_PRECISION,
    );

    // #then `D / totalSupply` reproduces the pool's reported virtual price to
    // within a basis point. It is a second, independent cross-check on the same
    // number, taken from a reading the swap path never touches.
    const totalSupply = 23_803_728_612_527_343_637_253n;
    const derived = (invariant * ONE) / totalSupply;
    const drift = ((derived - CHAIN.virtualPrice) * 10_000n) / CHAIN.virtualPrice;
    expect(drift).toBe(0n);
  });
});

describe("the details that go quietly wrong", () => {
  it("prices a different pool when the balances are not rate-adjusted", () => {
    // #given the same pool solved on raw balances instead of rate-adjusted ones
    const naive = quoteSwap(
      parameters({ xp: [CHAIN.balance0, CHAIN.balance1] }),
      0,
      1,
      ONE,
      CHAIN.storedRate1,
    );

    // #then the answer is nowhere near the chain's. These two coins' redemption
    // values have drifted 16% apart, so a solver on raw balances reads a badly
    // imbalanced pool as a balanced one and reports the whole spread as an
    // opportunity.
    const drift = ((naive.dy - CHAIN.poolQuote0To1) * 10_000n) / CHAIN.poolQuote0To1;
    expect(drift < -1_000n || drift > 1_000n).toBe(true);
  });

  it("solves a flatter curve when A is not multiplied back by A_PRECISION", () => {
    // #given the amplification used as `A()` returns it
    const flattened = quoteSwap(
      parameters({ amplification: CHAIN.amplification }),
      0,
      1,
      toInvariantUnits(ONE, CHAIN.storedRate0),
      CHAIN.storedRate1,
    );

    // #then the quote differs from the chain's. The error is small on a pool
    // this balanced, which is precisely why it survives a casual check and has
    // to be pinned by a test.
    expect(flattened.dy).not.toBe(CHAIN.poolQuote0To1);
  });

  it("over-quotes the swap when the off-peg fee multiplier is ignored", () => {
    // #given the base fee charged flat, as older Curve pools do
    const flatFee = quoteSwap(
      parameters({ offpegFeeMultiplier: FEE_DENOMINATOR }),
      0,
      1,
      toInvariantUnits(ONE, CHAIN.storedRate0),
      CHAIN.storedRate1,
    );

    // #then the output is strictly larger than the chain's. Stableswap-NG scales
    // the fee up as the pool leaves balance, so ignoring the multiplier is
    // optimistic in exactly the direction that makes a trade look profitable
    // when it is not.
    expect(flatFee.dy).toBeGreaterThan(CHAIN.poolQuote0To1);
  });

  it("charges the base fee when the multiplier is inert", () => {
    // #given a multiplier at the denominator
    const fee = dynamicFee(1_000n, 1_000n, CHAIN.feeBase, FEE_DENOMINATOR);

    // #then the base rate is charged unchanged. The scaling is conditional on
    // the contract's own guard, and reproducing the guard rather than assuming
    // the multiplier is always active is what makes this correct on both
    // generations of pool.
    expect(fee).toBe(CHAIN.feeBase);
  });

  it("charges more than the base fee on an imbalanced pool", () => {
    // #given a pool far from balance, with the live multiplier
    const balancedFee = dynamicFee(1_000n, 1_000n, CHAIN.feeBase, CHAIN.offpegFeeMultiplier);
    const skewedFee = dynamicFee(1_800n, 200n, CHAIN.feeBase, CHAIN.offpegFeeMultiplier);

    // #then the fee rises with the imbalance
    expect(skewedFee).toBeGreaterThan(balancedFee);
    expect(balancedFee).toBe(CHAIN.feeBase);
  });
});

describe("failing loudly rather than returning a confident wrong answer", () => {
  it("refuses a pool with a zero balance", () => {
    // #given a pool one of whose balances is empty
    // #then the solver throws rather than dividing by it. A pool at zero on one
    // side has no finite price, and returning one would be worse than failing.
    expect(() => solveInvariant([0n, ONE], 10_000n, 100n)).toThrow(InvariantError);
  });

  it("refuses to swap a coin for itself", () => {
    // #given the same index on both sides
    // #then it throws rather than solving a degenerate case
    expect(() => solveOutputBalance(0, 0, ONE, [ONE, ONE], 10_000n, 100n, ONE * 2n)).toThrow(
      InvariantError,
    );
  });

  it("refuses a single-coin pool", () => {
    // #given fewer coins than a swap needs
    expect(() => solveInvariant([ONE], 10_000n, 100n)).toThrow(InvariantError);
  });
});
