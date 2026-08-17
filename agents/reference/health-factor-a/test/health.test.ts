import { describe, expect, it } from "vitest";
import {
  MANTISSA,
  assertPlausiblePrice,
  assessHealth,
  expectedPriceScale,
  formatHealthFactor,
  planRepay,
  underlyingToUsd,
  usdToUnderlying,
} from "../src/venus/health.js";
import { USDT_PRICE_6DP, USDT_PRICE_18DP, usd } from "./fixtures.js";

const TARGET = (135n * MANTISSA) / 100n;

describe("assessHealth", () => {
  it("derives the ratio from liquidity when the account is solvent", () => {
    // #given $1,500 of liquidation-weighted collateral against $1,000 of borrows
    const positions = [
      { liquidationWeightedCollateralUsd: usd(1500), borrowUsd: usd(1000) },
    ];

    // #when assessed against the liquidity the Comptroller reports
    const assessment = assessHealth(positions, { liquidityUsd: usd(500), shortfallUsd: 0n, vaiDebtUsd: 0n });

    // #then the health factor is 1.50 and the account is not liquidatable
    expect(formatHealthFactor(assessment.healthFactorMantissa)).toBe("1.500000");
    expect(assessment.liquidatable).toBe(false);
  });

  it("derives the ratio from shortfall when the account is underwater", () => {
    // #given collateral below borrows, which the Comptroller reports as shortfall
    const positions = [{ liquidationWeightedCollateralUsd: usd(900), borrowUsd: usd(1000) }];

    // #when assessed
    const assessment = assessHealth(positions, { liquidityUsd: 0n, shortfallUsd: usd(100), vaiDebtUsd: 0n });

    // #then the health factor is below one and the account is flagged liquidatable
    expect(formatHealthFactor(assessment.healthFactorMantissa)).toBe("0.900000");
    expect(assessment.liquidatable).toBe(true);
  });

  it("reports no health factor at all when there is no debt", () => {
    // #given collateral and zero borrows
    const positions = [{ liquidationWeightedCollateralUsd: usd(5000), borrowUsd: 0n }];

    // #when assessed
    const assessment = assessHealth(positions, { liquidityUsd: usd(5000), shortfallUsd: 0n, vaiDebtUsd: 0n });

    // #then the ratio is null rather than a large number standing in for infinity
    expect(assessment.healthFactorMantissa).toBeNull();
    expect(formatHealthFactor(assessment.healthFactorMantissa)).toBe("infinite");
  });

  it("surfaces drift between the markets reconstruction and getAccountLiquidity", () => {
    // #given a markets sum that disagrees with the reported liquidity by 1%
    const positions = [{ liquidationWeightedCollateralUsd: usd(1515), borrowUsd: usd(1000) }];

    // #when assessed against a liquidity implying $1,500 of collateral
    const assessment = assessHealth(positions, { liquidityUsd: usd(500), shortfallUsd: 0n, vaiDebtUsd: 0n });

    // #then the drift is reported in basis points, which is how a bad decode shows up
    expect(assessment.weightedCollateralUsd).toBe(usd(1500));
    expect(assessment.reconstructedCollateralUsd).toBe(usd(1515));
    expect(assessment.reconstructionDriftBps).toBe(100);
  });

  it("charges VAI debt to the borrow side, where the Comptroller charges it", () => {
    // #given $10.4717 of collateral at a 0.80 threshold and no vToken borrows,
    //        but 3.343647904264645996 of VAI owed — the live position on chain 97
    const collateralUsd = 10_471_749_718_715_350_640n;
    const vaiDebtUsd = 3_343_647_904_264_645_996n;
    const positions = [
      { liquidationWeightedCollateralUsd: (collateralUsd * 80n) / 100n, borrowUsd: 0n },
    ];

    // #when assessed against the liquidity the Comptroller actually returns
    const assessment = assessHealth(positions, {
      liquidityUsd: 5_033_751_870_707_585_163n,
      shortfallUsd: 0n,
      vaiDebtUsd,
    });

    // #then the reconstruction closes, which it cannot do if VAI is left out
    expect(assessment.marketBorrowUsd).toBe(0n);
    expect(assessment.totalBorrowUsd).toBe(vaiDebtUsd);
    expect(assessment.reconstructionDriftBps).toBe(0);
  });

  it("misattributes VAI debt to collateral when the term is dropped", () => {
    // #given the same live position with the VAI term omitted
    const collateralUsd = 10_471_749_718_715_350_640n;
    const positions = [
      { liquidationWeightedCollateralUsd: (collateralUsd * 80n) / 100n, borrowUsd: 0n },
    ];

    // #when assessed as if VAI did not exist
    const assessment = assessHealth(positions, {
      liquidityUsd: 5_033_751_870_707_585_163n,
      shortfallUsd: 0n,
      vaiDebtUsd: 0n,
    });

    // #then the collateral figure is understated by the whole VAI debt, showing as 6,642 bps of drift
    expect(assessment.reconstructionDriftBps).toBe(6642);
  });

  it("sums borrows across every market the account entered", () => {
    // #given debt in two markets
    const positions = [
      { liquidationWeightedCollateralUsd: usd(4000), borrowUsd: usd(1000) },
      { liquidationWeightedCollateralUsd: 0n, borrowUsd: usd(1000) },
    ];

    // #when assessed
    const assessment = assessHealth(positions, { liquidityUsd: usd(2000), shortfallUsd: 0n, vaiDebtUsd: 0n });

    // #then the denominator is the total, not the first market's share
    expect(assessment.totalBorrowUsd).toBe(usd(2000));
    expect(formatHealthFactor(assessment.healthFactorMantissa)).toBe("2.000000");
  });
});

describe("price scaling across underlying decimals", () => {
  it("scales by 1e(36 - decimals)", () => {
    // #given Venus's documented oracle scaling
    // #when computed for the two decimal widths USDT uses across chains
    // #then testnet's 6 dp scales at 1e30 and mainnet's 18 dp at 1e18
    expect(expectedPriceScale(6)).toBe(10n ** 30n);
    expect(expectedPriceScale(18)).toBe(10n ** 18n);
  });

  it("converts one dollar into the right base units at 6 and at 18 decimals", () => {
    // #given USDT priced at $0.50 on both chains, quoted at each chain's scale
    // #when a dollar of debt is converted to base units
    const sixDp = usdToUnderlying(usd(1), USDT_PRICE_6DP);
    const eighteenDp = usdToUnderlying(usd(1), USDT_PRICE_18DP);

    // #then both mean two USDT, but the raw integers differ by 1e12
    expect(sixDp).toBe(2_000_000n);
    expect(eighteenDp).toBe(2n * 10n ** 18n);
    expect(eighteenDp / sixDp).toBe(10n ** 12n);
  });

  it("round-trips an amount through USD without drift", () => {
    // #given 1,234.5 testnet USDT
    const amount = 1_234_500_000n;

    // #when converted to USD and back
    // #then the original amount returns
    expect(usdToUnderlying(underlyingToUsd(amount, USDT_PRICE_6DP), USDT_PRICE_6DP)).toBe(amount);
  });

  it("rejects a 6-decimal price read with the mainnet 18-decimal assumption", () => {
    // #given the testnet oracle's 5e29, which is $0.50 at 6 decimals
    // #when interpreted as an 18-decimal underlying
    // #then the guard refuses rather than sizing a repay 1e12 too large
    expect(() => assertPlausiblePrice(USDT_PRICE_6DP, 6)).not.toThrow();
    expect(() => assertPlausiblePrice(USDT_PRICE_6DP, 18)).toThrow(/implausible for 18 decimals/);
  });

  it("rejects a zero price rather than dividing by it", () => {
    // #given an oracle that returned nothing
    // #then the guard refuses
    expect(() => assertPlausiblePrice(0n, 6)).toThrow(/non-positive/);
  });

  it("rounds a repay up so the target is actually reached", () => {
    // #given a dollar amount that does not divide evenly into base units
    // #when converted
    // #then it rounds up rather than landing a unit short of the target
    expect(usdToUnderlying(1n, USDT_PRICE_6DP)).toBe(1n);
  });
});

describe("planRepay", () => {
  const solvent = (collateral: number, borrow: number) =>
    assessHealth([{ liquidationWeightedCollateralUsd: usd(collateral), borrowUsd: usd(borrow) }], {
      liquidityUsd: usd(collateral - borrow),
      shortfallUsd: 0n,
      vaiDebtUsd: 0n,
    });

  it("proposes nothing when the position is already above the target", () => {
    // #given a health factor of 2.00 against a 1.35 target
    const assessment = solvent(2000, 1000);

    // #when a repay is planned
    const plan = planRepay({
      assessment,
      targetMantissa: TARGET,
      outstandingDebt: 2_000_000_000n,
      priceMantissa: USDT_PRICE_6DP,
    });

    // #then there is nothing to do
    expect(plan.amount).toBe(0n);
  });

  it("sizes the repay so the resulting health factor is the target", () => {
    // #given $1,200 of collateral against $1,000 of borrows, so HF is 1.20
    const assessment = solvent(1200, 1000);

    // #when planned to a 1.35 target with ample debt outstanding
    const plan = planRepay({
      assessment,
      targetMantissa: TARGET,
      outstandingDebt: 10_000_000_000n,
      priceMantissa: USDT_PRICE_6DP,
    });

    // #then repaying leaves collateral / remaining borrows at the target
    const repaidUsd = underlyingToUsd(plan.amount, USDT_PRICE_6DP);
    const resulting =
      (assessment.weightedCollateralUsd * MANTISSA) / (assessment.totalBorrowUsd - repaidUsd);
    expect(plan.cappedByDebt).toBe(false);
    expect(formatHealthFactor(resulting)).toBe("1.350000");
  });

  it("caps the repay at the account's own debt and says so", () => {
    // #given a position needing more repaid than the account owes in this market
    const assessment = solvent(1050, 1000);

    // #when planned against 10 USDT of debt
    const plan = planRepay({
      assessment,
      targetMantissa: TARGET,
      outstandingDebt: 10_000_000n,
      priceMantissa: USDT_PRICE_6DP,
    });

    // #then the debt binds, which Venus enforces independently anyway
    expect(plan.amount).toBe(10_000_000n);
    expect(plan.cappedByDebt).toBe(true);
  });

  it("proposes nothing when there is no debt to repay", () => {
    // #given an account with collateral and no borrows
    const assessment = assessHealth(
      [{ liquidationWeightedCollateralUsd: usd(5000), borrowUsd: 0n }],
      { liquidityUsd: usd(5000), shortfallUsd: 0n, vaiDebtUsd: 0n },
    );

    // #when a repay is planned
    const plan = planRepay({
      assessment,
      targetMantissa: TARGET,
      outstandingDebt: 0n,
      priceMantissa: USDT_PRICE_6DP,
    });

    // #then nothing is proposed
    expect(plan.amount).toBe(0n);
    expect(plan.requiredUsd).toBe(0n);
  });

  it("still plans a repay for an account already in shortfall", () => {
    // #given a liquidatable position at HF 0.90
    const assessment = assessHealth(
      [{ liquidationWeightedCollateralUsd: usd(900), borrowUsd: usd(1000) }],
      { liquidityUsd: 0n, shortfallUsd: usd(100), vaiDebtUsd: 0n },
    );

    // #when planned to the target
    const plan = planRepay({
      assessment,
      targetMantissa: TARGET,
      outstandingDebt: 10_000_000_000n,
      priceMantissa: USDT_PRICE_6DP,
    });

    // #then a repay is sized rather than the case being treated as hopeless
    expect(plan.amount).toBeGreaterThan(0n);
    expect(assessment.liquidatable).toBe(true);
  });

  it("refuses a non-positive target rather than dividing by zero", () => {
    // #given a misconfigured policy
    // #then planning refuses
    expect(() =>
      planRepay({
        assessment: solvent(1200, 1000),
        targetMantissa: 0n,
        outstandingDebt: 1n,
        priceMantissa: USDT_PRICE_6DP,
      }),
    ).toThrow(/target must be positive/);
  });
});
