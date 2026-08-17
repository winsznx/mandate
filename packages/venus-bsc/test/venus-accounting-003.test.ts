import { describe, expect, it } from "vitest";
import type { RawVenusObservation } from "../src/observation.js";
import {
  FIXTURE,
  FROZEN,
  MANTISSA,
  VUSDC,
  absolute,
  applyWeight,
  formatMantissa,
  marketAt,
  vTokenToUsdFlooredFirst,
  vTokenToUsdUnfloored,
} from "./fixtures.js";

/**
 * VENUS-ACCOUNTING-003
 *
 *   A vToken balance must be priced without being floored to whole underlying
 *   units first. Multiply by the exchange rate and the oracle price, then
 *   divide once.
 *
 * Both orderings are integer arithmetic and both look correct. They differ
 * because `balance * exchangeRate / 1e18` truncates to a whole base unit before
 * the price is applied, and the discarded remainder is then multiplied by
 * nothing instead of by the price. On the frozen account that discards
 * 774,972,241,029 wei of a dollar — sub-micro-dollar, immaterial to the verdict,
 * and precisely the kind of unexplained residual that hides a real one.
 *
 * The right ordering is not a matter of taste here, and the fixture proves it.
 * The account's own liquidity reconstructed the correct way misses the
 * Comptroller's reported figure by 9,870 wei. Reconstructed through the floored
 * route it misses by 574,972,231,159 wei — fifty-eight million times further
 * off. One of those residuals is integer rounding and the other is a bug, and a
 * reconciliation that cannot tell them apart is not a reconciliation.
 *
 * The correct health factor at this fixture is 2.505467, at full precision
 * 2505467087095896325. Earlier notes in this repository documented the floored
 * value, which is 2.505466 and diverges in the seventh decimal place. This
 * suite pins the correct one.
 *
 * Frozen: chain 97, block 125,598,995.
 */

const observation: RawVenusObservation = FROZEN;

/** The full-precision answer. Not a rounded 2.505467; every digit is asserted. */
const CORRECT_HEALTH_FACTOR_MANTISSA = 2_505_467_087_095_896_325n;

/** What the floored-then-priced route produces on the same inputs. */
const FLOORED_HEALTH_FACTOR_MANTISSA = 2_505_466_915_136_330_757n;

const collateral = marketAt(observation, VUSDC);
const balance = BigInt(collateral.vTokenBalance ?? "0");
const exchangeRate = BigInt(collateral.exchangeRateMantissa ?? "0");
const price = BigInt(collateral.priceMantissa ?? "0");
const threshold = BigInt(collateral.liquidationThresholdMantissa ?? "0");
const vaiOwed = BigInt(observation.vai.repayAmount);
const protocolLiquidity = BigInt(observation.accountLiquidity.liquidity);

function healthFactor(weightedCollateralUsd: bigint): bigint {
  return (weightedCollateralUsd * MANTISSA) / vaiOwed;
}

describe("VENUS-ACCOUNTING-003", () => {
  it("is pinned to the fixture the two orderings are compared on", () => {
    // #given a frozen reading whose exchange rate does not divide evenly
    // #then it is the one this file's literals were computed from
    expect(FIXTURE.provenance.chainId).toBe(97);
    expect(FIXTURE.provenance.blockNumber).toBe("125598995");
    expect(balance).toBe(49_352_603_924n);
    expect(exchangeRate).toBe(212_182_314_328_159n);
    expect(collateral.underlyingDecimals).toBe(6);
    expect(price).toBe(10n ** 30n);
  });

  it("produces 2.505467 at full precision when priced in the correct order", () => {
    // #when the balance is valued directly and weighted
    const weighted = applyWeight(vTokenToUsdUnfloored(balance, exchangeRate, price), threshold);

    // #then the health factor is exact to the last wei, not to six places
    expect(healthFactor(weighted)).toBe(CORRECT_HEALTH_FACTOR_MANTISSA);
    expect(formatMantissa(healthFactor(weighted))).toBe("2.505467");
  });

  it("produces a different number when the underlying is floored first", () => {
    // #when the same inputs go through a materialised underlying amount
    const weighted = applyWeight(vTokenToUsdFlooredFirst(balance, exchangeRate, price), threshold);

    // #then the answer diverges in the seventh decimal place. This is the value
    // earlier notes documented, and it is the wrong one.
    expect(healthFactor(weighted)).toBe(FLOORED_HEALTH_FACTOR_MANTISSA);
    expect(formatMantissa(healthFactor(weighted))).toBe("2.505466");
    expect(healthFactor(weighted)).not.toBe(CORRECT_HEALTH_FACTOR_MANTISSA);
  });

  it("shows the floor discarding value rather than merely reordering it", () => {
    // #given the underlying amount the floored route materialises
    const underlying = (balance * exchangeRate) / MANTISSA;

    // #then it truncates, and the truncated part is real collateral that the
    // floored route then values at nothing
    expect(underlying).toBe(10_471_749n);
    expect(underlying * MANTISSA).toBeLessThan(balance * exchangeRate);
    expect(
      vTokenToUsdUnfloored(balance, exchangeRate, price) -
        vTokenToUsdFlooredFirst(balance, exchangeRate, price),
    ).toBe(718_715_301_287n);
  });

  it("settles the ordering against the Comptroller's own liquidity", () => {
    // #given both routes netted against the same VAI debt
    const correctLiquidity =
      applyWeight(vTokenToUsdUnfloored(balance, exchangeRate, price), threshold) - vaiOwed;
    const flooredLiquidity =
      applyWeight(vTokenToUsdFlooredFirst(balance, exchangeRate, price), threshold) - vaiOwed;

    // #when each is compared to the figure the protocol itself reported
    const correctDrift = absolute(correctLiquidity - protocolLiquidity);
    const flooredDrift = absolute(flooredLiquidity - protocolLiquidity);

    // #then the unfloored route is fifty-eight million times closer. The
    // ordering is not a preference; one of these reproduces the protocol and
    // the other does not.
    expect(correctDrift).toBe(9_870n);
    expect(flooredDrift).toBe(574_972_231_159n);
    expect(flooredDrift / correctDrift).toBeGreaterThan(58_000_000n);
  });

  it("keeps the error one-directional, always understating collateral", () => {
    // #given the two valuations
    const direct = vTokenToUsdUnfloored(balance, exchangeRate, price);
    const floored = vTokenToUsdFlooredFirst(balance, exchangeRate, price);

    // #then flooring can only lose value, never gain it, so the floored route
    // always reports a lower health factor than the truth. It errs toward
    // reporting more risk, which is why it survived undetected — and it is
    // still a disagreement with the protocol that has no reason to exist.
    expect(floored).toBeLessThan(direct);
    expect(FLOORED_HEALTH_FACTOR_MANTISSA).toBeLessThan(CORRECT_HEALTH_FACTOR_MANTISSA);
  });
});
