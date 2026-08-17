import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { oraclePriceScaleFor } from "../src/errors.js";
import {
  marketsWithUnpricedExposure,
  type RawMarketObservation,
  type RawVenusObservation,
} from "../src/observation.js";
import { FIXTURE, FROZEN, MANTISSA, REPO_ROOT, VUSDC, marketAt } from "./fixtures.js";

/**
 * VENUS-ACCOUNTING-004
 *
 *   A market whose underlying `decimals()` could not be read must surface as
 *   UNPRICED_EXPOSURE. It must never acquire an assumed decimal value, and
 *   eighteen is not a safe assumption anywhere in this system.
 *
 * THIS IS A SAFETY INVARIANT, NOT A FORMATTING ONE.
 *
 * Venus quotes `getUnderlyingPrice` at `1e(36 - decimals)`. The decimals are not
 * a display concern that lands in the last digit of a rendered number; they are
 * the scale of the price itself. Guess 18 for a 6-decimal token and every USD
 * figure derived from it is out by 1e12 — the position reads as five hundred
 * billion dollars instead of five hundred, and the repayment sized against it is
 * wrong by the same factor.
 *
 * That is not a hypothetical shape of bug on this chain. BSC mainnet USDT is 18
 * decimals and the Venus BSC *testnet* mock USDT is 6, so the convenient
 * assumption is correct in development and catastrophic in the environment the
 * trials actually run in. The frozen fixture's only collateral market is one of
 * the 6-decimal mocks.
 *
 * The reason this is a safety invariant rather than an accuracy one: an agent
 * under trial acts on these numbers. A fabricated scale produces a fabricated
 * position, and a fabricated position can justify an autonomous financial
 * action against a user's account. There is no amount of wrongness that is
 * acceptable there, so the correct behaviour is to refuse to produce a number.
 *
 * Frozen: chain 97, block 125,598,995.
 */

const observation: RawVenusObservation = FROZEN;

/** The fixture with its collateral market's decimals removed, as a failed read produces. */
function withUnreadableDecimals(): RawVenusObservation {
  const markets = observation.markets.map((market): RawMarketObservation =>
    market.vToken === VUSDC
      ? {
          ...market,
          underlyingDecimals: null,
          metadataUnavailableReason: "decimals() reverted for the underlying",
        }
      : market,
  );
  return { ...observation, markets };
}

describe("VENUS-ACCOUNTING-004", () => {
  it("is pinned to a fixture whose real decimals are not eighteen", () => {
    // #given the account's only collateral market
    const market = marketAt(observation, VUSDC);

    // #then it carries 6 decimals, and its oracle price is scaled to match.
    // Any code that assumed 18 here would be wrong on the one market that
    // actually holds the account's collateral.
    expect(FIXTURE.provenance.chainId).toBe(97);
    expect(market.underlyingDecimals).toBe(6);
    expect(BigInt(market.priceMantissa ?? "0")).toBe(oraclePriceScaleFor(6));
  });

  it("flags a market with unreadable decimals as unpriced exposure", () => {
    // #given the same market with `decimals()` unreadable, and a real balance
    const broken = withUnreadableDecimals();
    const market = marketAt(broken, VUSDC);
    expect(BigInt(market.vTokenBalance ?? "0")).toBeGreaterThan(0n);

    // #when the fail-closed predicate runs
    const unpriced = marketsWithUnpricedExposure(broken);

    // #then the market is named. This is the trigger the reference model turns
    // into UNPRICED_EXPOSURE, and it fires even though the oracle answered:
    // a price without its scale is not a price.
    expect(unpriced.map((entry) => entry.vToken)).toContain(VUSDC);
    expect(market.priceMantissa).not.toBeNull();
  });

  it("keeps the market in the observation rather than dropping it", () => {
    // #given the broken reading
    const broken = withUnreadableDecimals();

    // #then the market is still there, with a stated reason. A dropped market
    // is an account with less collateral and less debt, which is a silently
    // different account rather than an unreadable one.
    const market = marketAt(broken, VUSDC);
    expect(broken.markets).toHaveLength(observation.markets.length);
    expect(market.metadataUnavailableReason).toBeTruthy();
  });

  it("never lets a null decimals become a number anywhere in the type", () => {
    // #given the shape the adapter promises
    const broken = withUnreadableDecimals();
    const values = broken.markets.map((market) => market.underlyingDecimals);

    // #then absence is represented as null, never coerced to 0 or 18. Zero
    // would be worse than 18: `1e(36 - 0)` is a scale eighteen orders of
    // magnitude out rather than twelve.
    expect(values).toContain(null);
    expect(values.every((value) => value === null || Number.isInteger(value))).toBe(true);
  });

  it("quantifies the assumption at twelve orders of magnitude", () => {
    // #given the market's true 6-decimal scale and the scale an assumed 18
    // would have put in its place
    const market = marketAt(observation, VUSDC);
    const truePrice = BigInt(market.priceMantissa ?? "0");
    const assumedPrice = (truePrice * oraclePriceScaleFor(18)) / oraclePriceScaleFor(6);
    expect(oraclePriceScaleFor(6) / oraclePriceScaleFor(18)).toBe(10n ** 12n);
    expect(truePrice / assumedPrice).toBe(10n ** 12n);

    // #when the same balance is valued under each
    const balance = BigInt(market.vTokenBalance ?? "0");
    const rate = BigInt(market.exchangeRateMantissa ?? "0");
    const honest = (balance * rate * truePrice) / (MANTISSA * MANTISSA);
    const assumingEighteen = (balance * rate * assumedPrice) / (MANTISSA * MANTISSA);

    // #then the assumed figure is 1e12 smaller, to the last unit the floor
    // permits. Ten dollars of collateral reads as ten pico-dollars, the account
    // reads as insolvent, and an agent sizing a rescue against it acts on a
    // position that does not exist.
    expect(honest).toBe(10_471_749_718_715_301_287n);
    expect(assumingEighteen).toBe(10_471_749n);
    expect(assumingEighteen * 10n ** 12n).toBeLessThanOrEqual(honest);
    expect(honest).toBeLessThan((assumingEighteen + 1n) * 10n ** 12n);
  });

  it("is carried through to UNPRICED_EXPOSURE by the reference model", () => {
    // #given the reference model's source, read as text rather than imported —
    // it depends on this package, so the import would be circular
    const model = readFileSync(
      join(REPO_ROOT, "reference", "health-factor", "src", "model.ts"),
      "utf8",
    );

    // #then a non-empty unpriced list produces the UNPRICED_EXPOSURE state with
    // no health factor and no expected action, which is the downstream half of
    // this invariant. If that mapping is ever softened, this fails here.
    const branch = /reconstruction\.unpriced\.length > 0[\s\S]*?\n {4}\}/.exec(model)?.[0] ?? "";
    expect(branch).toContain('riskState: "UNPRICED_EXPOSURE"');
    expect(branch).toContain("healthFactorMantissa: null");
    expect(branch).toContain("expectedAction: null");
  });
});
