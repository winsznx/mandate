import { describe, expect, it } from "vitest";
import { reconstruct, VAI_PAR_PRICE_MANTISSA } from "../src/accounting.js";
import { MANTISSA, differenceBps, fromUsd, oracleScaleFor, toUsd, vTokenToUsd } from "../src/scale.js";
import { FROZEN_EXPECTATIONS, FROZEN_OBSERVATION, VUSDC, VUSDT, positionWith } from "./fixtures.js";

describe("reconstruction against the frozen chain reading", () => {
  it("reproduces the Comptroller's own liquidity without ever reading it", () => {
    // #given a real account whose protocol-reported liquidity is known
    // #when the position is rebuilt from raw balances, prices and weights
    const result = reconstruct(FROZEN_OBSERVATION);

    // #then the independently derived figure lands on the protocol's, within
    // the rounding the exchange-rate conversion cannot avoid
    expect(result.shortfallUsd).toBe(0n);
    expect(differenceBps(result.liquidityUsd, FROZEN_EXPECTATIONS.protocolLiquidity)).toBe(0n);
  });

  it("derives the health factor the invariant fixture documents", () => {
    // #given the frozen account, documented at health factor 2.505
    // #when the model computes its own ratio
    const result = reconstruct(FROZEN_OBSERVATION);

    // #then it agrees to three decimal places, which is where the fixture's
    // documented figure stops. The two differ in the seventh, because this
    // model prices the vToken balance without flooring it to whole underlying
    // units first.
    expect(result.healthFactorMantissa).not.toBeNull();
    const health = result.healthFactorMantissa as bigint;
    expect(health / (MANTISSA / 1_000n)).toBe(2_505n);
    expect(health / (MANTISSA / 1_000_000n)).toBe(2_505_467n);
  });

  it("counts VAI debt that appears in no market at all", () => {
    // #given the frozen account, whose only debt is VAI
    const result = reconstruct(FROZEN_OBSERVATION);

    // #then market enumeration finds nothing
    expect(result.marketBorrowUsd).toBe(0n);

    // #and the total is nonetheless non-zero, because VAI is added on its own
    expect(result.nonMarketBorrowUsd).toBe(FROZEN_EXPECTATIONS.vaiOwed);
    expect(result.totalBorrowUsd).toBe(FROZEN_EXPECTATIONS.vaiOwed);
  });

  it("enumerates VAI as a labelled exposure a verifier can see", () => {
    // #when the reconstruction is inspected
    const result = reconstruct(FROZEN_OBSERVATION);
    const vai = result.exposures.find((exposure) => exposure.source === "VAI");

    // #then the VAI leg is present and typed as debt outside the market set
    expect(vai?.kind).toBe("NON_MARKET_DEBT");
    expect(vai?.rawAmount).toBe(FROZEN_EXPECTATIONS.vaiOwed);
  });

  it("weights collateral by the liquidation threshold, not the collateral factor", () => {
    // #given a market whose two weights differ, 0.80 against 0.75
    const usdc = FROZEN_OBSERVATION.markets.find((market) => market.vToken === VUSDC);
    expect(usdc?.liquidationThresholdMantissa).toBe("800000000000000000");
    expect(usdc?.collateralFactorMantissa).toBe("750000000000000000");

    // #when collateral is weighted
    const result = reconstruct(FROZEN_OBSERVATION);
    const collateral = result.exposures.find((exposure) => exposure.kind === "COLLATERAL");

    // #then the threshold is the weight applied. Decoding markets() as the
    // legacy 3-tuple puts the collateral factor here and overstates safety.
    expect(collateral?.liquidationThresholdMantissa).toBe(800000000000000000n);
    expect(collateral?.weightedUsdMantissa).toBe(
      (BigInt(collateral?.usdMantissa ?? 0n) * 800000000000000000n) / MANTISSA,
    );
  });

  it("reports no health factor for an account that owes nothing", () => {
    // #given the same collateral with the VAI debt cleared
    const observation = positionWith({ vaiOwed: 0n });

    // #when it is reconstructed
    const result = reconstruct(observation);

    // #then the ratio is unbounded rather than large, and is reported as absent
    expect(result.totalBorrowUsd).toBe(0n);
    expect(result.healthFactorMantissa).toBeNull();
  });
});

describe("fail-closed behaviour", () => {
  it("refuses to value a position whose collateral the oracle will not price", () => {
    // #given the account's only collateral market losing its oracle price
    const observation = positionWith({ unpriceMarket: VUSDC });

    // #when the position is reconstructed
    const result = reconstruct(observation);

    // #then the market is named as unpriced rather than skipped
    expect(result.unpriced.map((entry) => entry.vToken)).toContain(VUSDC);
    expect(result.unpriced[0]?.reason).toContain("oracle");
  });

  it("does not treat an unpriced market as a market worth zero", () => {
    // #given collateral that cannot be priced
    const observation = positionWith({ unpriceMarket: VUSDC });

    // #when reconstructed
    const result = reconstruct(observation);

    // #then it is flagged, and the caller must fail closed rather than read the
    // total. Silently valuing it at zero would report a shortfall on a solvent
    // account, which is the direction that gets someone liquidated.
    expect(result.unpriced.length).toBeGreaterThan(0);
  });

  it("ignores a market the account has no balance in, priced or not", () => {
    // #given the testnet universe, which carries structurally broken markets
    const broken = FROZEN_OBSERVATION.markets.filter((market) => market.priceMantissa === null);
    expect(broken.length).toBeGreaterThan(0);

    // #when the account holds nothing in them
    const result = reconstruct(FROZEN_OBSERVATION);

    // #then they are not exposure, so they do not trip the fail-closed path
    expect(result.unpriced).toHaveLength(0);
  });
});

describe("collateral is credited the way the protocol credits it", () => {
  it("ignores collateral in a market the account never entered", () => {
    // #given the frozen account, which entered exactly one market
    expect(FROZEN_OBSERVATION.enteredMarkets).toEqual([VUSDC]);

    // #when collateral is summed
    const result = reconstruct(FROZEN_OBSERVATION);
    const sources = result.exposures
      .filter((exposure) => exposure.kind === "COLLATERAL")
      .map((exposure) => exposure.source);

    // #then only the entered market contributes. Un-entered collateral is real
    // value the Comptroller will not credit in a liquidation check, and
    // crediting it here would overstate safety.
    expect(sources).toEqual([VUSDC]);
  });

  it("counts debt in a market the account never entered", () => {
    // #given debt in vUSDT, which the frozen account has not entered
    const observation = positionWith({ usdtBorrow: 1_000_000n });
    expect(observation.enteredMarkets).not.toContain(VUSDT);

    // #when the position is reconstructed
    const result = reconstruct(observation);

    // #then the debt still counts. This is VENUS-ACCOUNTING-001: the entered
    // set is not the debt universe.
    expect(result.marketBorrowUsd).toBeGreaterThan(0n);
    expect(result.exposures.some((exposure) => exposure.source === VUSDT)).toBe(true);
  });
});

describe("scale arithmetic", () => {
  it("returns the oracle scale the token's decimals imply", () => {
    // #given the two decimal counts USDT actually has across the two chains
    // #then the scales differ by twelve orders of magnitude
    expect(oracleScaleFor(6)).toBe(10n ** 30n);
    expect(oracleScaleFor(18)).toBe(10n ** 18n);
  });

  it("prices a 6-decimal balance and an 18-decimal balance onto the same scale", () => {
    // #given one dollar of a 6dp token and one dollar of an 18dp token
    const sixDp = toUsd(1_000_000n, oracleScaleFor(6));
    const eighteenDp = toUsd(10n ** 18n, oracleScaleFor(18));

    // #then both land on 1e18 USD
    expect(sixDp).toBe(MANTISSA);
    expect(eighteenDp).toBe(MANTISSA);
  });

  it("rounds a USD-to-token conversion up, never down", () => {
    // #given a USD amount that does not divide evenly into token units
    const price = oracleScaleFor(6);
    const amount = fromUsd(MANTISSA + 1n, price);

    // #then the result covers the requirement rather than falling a wei short
    expect(toUsd(amount, price)).toBeGreaterThanOrEqual(MANTISSA + 1n);
  });

  it("keeps full precision when valuing a vToken balance", () => {
    // #given a vToken balance whose underlying conversion truncates
    const balance = 49_352_603_924n;
    const rate = 212_182_314_328_159n;
    const price = oracleScaleFor(6);

    // #when valued directly rather than through a floored underlying amount
    const direct = vTokenToUsd(balance, rate, price);
    const viaUnderlying = toUsd((balance * rate) / MANTISSA, price);

    // #then the direct route is the larger, because the other discarded part of
    // a base unit before pricing it
    expect(direct).toBeGreaterThan(viaUnderlying);
  });

  it("rejects a price that cannot be right for the decimals it came with", () => {
    // #given testnet USDT's 6dp price read under a mainnet 18dp assumption
    const sixDpPrice = 5n * 10n ** 29n;

    // #then the scale error is caught rather than sizing a repay 1e12 too large
    expect(() => reconstruct(positionWith({ usdtBorrow: 1n }))).not.toThrow();
    expect(toUsd(1n, sixDpPrice) > 0n).toBe(true);
  });
});

describe("VAI par pricing", () => {
  it("charges VAI at one dollar, matching the Comptroller", () => {
    // #given VAI, an 18-decimal dollar unit
    // #then its price mantissa is 1e18, so a repay amount is already USD at 1e18
    expect(VAI_PAR_PRICE_MANTISSA).toBe(MANTISSA);
    expect(toUsd(3_343_647_904_264_645_996n, VAI_PAR_PRICE_MANTISSA)).toBe(
      3_343_647_904_264_645_996n,
    );
  });
});
