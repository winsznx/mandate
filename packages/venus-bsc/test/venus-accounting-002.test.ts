import { describe, expect, it } from "vitest";
import { marketsWithDebt, type RawVenusObservation } from "../src/observation.js";
import {
  FIXTURE,
  FROZEN,
  MANTISSA,
  VUSDC,
  absolute,
  applyWeight,
  marketAt,
  oracleScaleFor,
  vTokenToUsdUnfloored,
} from "./fixtures.js";

/**
 * VENUS-ACCOUNTING-002
 *
 *   VAI debt contributes to the account at the Comptroller's par-dollar
 *   semantics: one VAI is charged as exactly one dollar, at 1e18.
 *
 * THIS IS OBSERVED IMPLEMENTATION BEHAVIOUR, NOT DOCUMENTED PROTOCOL SPEC.
 *
 * That distinction is the reason this file exists rather than a constant with a
 * link to the Venus docs. Nothing in Venus's published documentation states
 * that `getAccountLiquidity` charges VAI at par; the par rule was recovered by
 * subtracting a reconstructed collateral figure from the Comptroller's own
 * reported liquidity on a real account at a real block, and reading what price
 * the remainder implies. The answer came back at 1.0000000000000029 dollars,
 * which is par to fifteen significant digits and is not consistent with any
 * oracle route.
 *
 * A rule established that way is a rule that can change under a Comptroller
 * upgrade without any announcement, and it is bound to the pinned fixture for
 * exactly that reason. If Venus ever prices VAI through the oracle, this suite
 * goes red against the frozen block and someone has to look, rather than the
 * model silently continuing to charge par against a protocol that stopped.
 *
 * Frozen: chain 97, block 125,598,995. The account holds VAI debt and no vToken
 * borrow, so VAI is the entire debt side and the implied price is not diluted
 * by anything else.
 */

const observation: RawVenusObservation = FROZEN;

/** The provenance of the rule itself, restated where a reader will trip over it. */
const PAR_RULE_SOURCE = "OBSERVED_IMPLEMENTATION_BEHAVIOUR" as const;

/** The Comptroller weighs VAI at one dollar. Recovered from the fixture, not from docs. */
const VAI_PAR_PRICE_MANTISSA = MANTISSA;

const vaiOwed = BigInt(observation.vai.repayAmount);
const protocolLiquidity = BigInt(observation.accountLiquidity.liquidity);

/** The account's whole collateral side, priced independently of the protocol's verdict. */
function weightedCollateral(): bigint {
  const market = marketAt(observation, VUSDC);
  const usd = vTokenToUsdUnfloored(
    BigInt(market.vTokenBalance ?? "0"),
    BigInt(market.exchangeRateMantissa ?? "0"),
    BigInt(market.priceMantissa ?? "0"),
  );
  return applyWeight(usd, BigInt(market.liquidationThresholdMantissa ?? "0"));
}

describe("VENUS-ACCOUNTING-002", () => {
  it("is pinned to the fixture, because the rule it asserts is observed rather than specified", () => {
    // #given a rule recovered from a reading rather than read from a spec
    // #then the reading it was recovered from is named, so a future Comptroller
    // upgrade that changes the rule fails here instead of passing silently
    expect(PAR_RULE_SOURCE).toBe("OBSERVED_IMPLEMENTATION_BEHAVIOUR");
    expect(FIXTURE.provenance.chainId).toBe(97);
    expect(FIXTURE.provenance.blockNumber).toBe("125598995");
    expect(observation.blockHash).toBe(FIXTURE.provenance.blockHash);
  });

  it("has no oracle price to use for VAI, because VAI is not a market", () => {
    // #given the complete listed market set and the contract that reports the debt
    const controller = observation.vai.controller.toLowerCase();
    const addresses = observation.markets.flatMap((market) => [
      market.vToken.toLowerCase(),
      market.underlying?.toLowerCase() ?? "",
    ]);

    // #then the VAI controller is not among them, so no `getUnderlyingPrice`
    // call reaches VAI and no market weight discounts it. The price rule has to
    // come from somewhere other than the oracle, and this is that rule.
    expect(addresses).not.toContain(controller);
    expect(marketsWithDebt(observation)).toHaveLength(0);
    expect(vaiOwed).toBeGreaterThan(0n);
  });

  it("implies a VAI price of one dollar when solved against the Comptroller's own liquidity", () => {
    // #given the collateral side reconstructed independently, and the
    // protocol's own liquidity figure for the same account at the same block
    const collateral = weightedCollateral();

    // #when the residual is attributed entirely to VAI, which is the only debt
    const impliedPriceMantissa = ((collateral - protocolLiquidity) * MANTISSA) / vaiOwed;

    // #then it lands on par. The deviation is 2,951 wei out of 1e18, three
    // parts in a thousand trillion, which is the rounding of the two integer
    // divisions and not a different price.
    expect(impliedPriceMantissa).toBe(1_000_000_000_000_002_951n);
    expect(absolute(impliedPriceMantissa - VAI_PAR_PRICE_MANTISSA)).toBeLessThan(10_000n);
  });

  it("reproduces the protocol's liquidity to the wei once VAI is charged at par", () => {
    // #given collateral and VAI charged at 1e18
    const collateral = weightedCollateral();
    const vaiUsd = (vaiOwed * VAI_PAR_PRICE_MANTISSA) / MANTISSA;

    // #when the two are netted
    const ownLiquidity = collateral - vaiUsd;

    // #then it agrees with the Comptroller to within 9,870 wei of a dollar,
    // which is zero basis points. Nothing else about the position is free to
    // absorb an error, so this is a measurement of the VAI rule specifically.
    expect(absolute(ownLiquidity - protocolLiquidity)).toBe(9_870n);
    expect((absolute(ownLiquidity - protocolLiquidity) * 10_000n) / protocolLiquidity).toBe(0n);
  });

  it("rules out the oracle scale as VAI's price, by twelve orders of magnitude", () => {
    // #given the scale the oracle would have used for an 18-decimal token
    // #then par and the oracle scale coincide only at 18 decimals, and diverge
    // by 1e12 at the 6 decimals this chain's mock tokens actually carry. The
    // par rule is a statement about the Comptroller, not about the oracle.
    expect(observation.vai.decimals).toBe(18);
    expect(oracleScaleFor(18)).toBe(VAI_PAR_PRICE_MANTISSA);
    expect(oracleScaleFor(6) / oracleScaleFor(18)).toBe(10n ** 12n);
  });

  it("charges the repay amount, not the minted principal", () => {
    // #given the two figures the Comptroller exposes for VAI
    const principal = BigInt(observation.vai.mintedPrincipal);
    const collateral = weightedCollateral();

    // #when the par rule is applied to the principal instead
    const usingPrincipal = collateral - principal;

    // #then the result misses the protocol's liquidity by 1.34 dollars on a
    // 3.34 dollar debt. Par pricing is only correct on top of the right amount;
    // the two decisions are separate and both have to be right.
    expect(absolute(usingPrincipal - protocolLiquidity)).toBe(
      BigInt(FIXTURE.brokenView.principalUnderstatement) + 9_870n,
    );
    expect(vaiOwed).toBeGreaterThan(principal);
  });
});
