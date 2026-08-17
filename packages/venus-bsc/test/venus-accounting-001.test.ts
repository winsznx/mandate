import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasDebtOutsideEnteredMarkets,
  marketsWithDebt,
  marketsWithUnpricedExposure,
  unreadableMarkets,
  type RawVenusObservation,
} from "../src/observation.js";

/**
 * VENUS-ACCOUNTING-001
 *
 *   Debt in a market not returned by getAssetsIn must still contribute to
 *   account borrow value.
 *
 * Frozen against a real BSC testnet account at a real block. The account holds
 * VAI debt and no vToken borrow, which is the shape that makes an
 * entered-markets reading report "no debt" for a genuinely leveraged position:
 * the naive reconstruction returns health factor infinity for an account whose
 * true health factor is 2.505.
 *
 * This suite exists so that any future simplification which reintroduces
 * getAssetsIn as the complete position set fails CI rather than shipping.
 *
 * The fixture cannot be re-captured at its original block, which is precisely
 * why it is committed rather than fetched. The reason is measured rather than
 * assumed: `packages/rpc-capabilities` bisected
 * `bsc-testnet-rpc.publicnode.com` and found anvil able to build a fork genesis
 * 9,375 blocks back, while a plain historical `eth_call` reached 1.8 million.
 * Neither figure is the "~2,048 blocks" the research notes record, both move,
 * and no constant should be written down in their place.
 *
 * The other three invariants live in `venus-accounting-002` through `-004`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "venus-accounting-001.json"), "utf8"),
) as {
  invariant: string;
  provenance: { chainId: number; account: string; blockNumber: string; blockHash: string };
  observation: RawVenusObservation;
  brokenView: { vaiDebtMissed: string; principalUnderstatement: string };
  hasDebtOutsideEnteredMarkets: boolean;
};

const observation = fixture.observation;

describe("VENUS-ACCOUNTING-001", () => {
  it("carries provenance, so the numbers are traceable to a block", () => {
    // #given the frozen fixture
    // #then it names the chain, account and block it was read at
    expect(fixture.provenance.chainId).toBe(97);
    expect(fixture.provenance.blockNumber).toMatch(/^[0-9]+$/);
    expect(fixture.provenance.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("proves getAssetsIn is not the complete debt universe", () => {
    // #given an account with one entered market out of the full listed set
    // #when the two are compared
    // #then the entered set is a strict, and much smaller, subset
    expect(observation.enteredMarkets.length).toBe(1);
    expect(observation.markets.length).toBeGreaterThan(observation.enteredMarkets.length);
  });

  it("finds debt that an entered-markets reading would miss entirely", () => {
    // #when the invariant predicate runs against the frozen state
    // #then it reports debt outside the entered markets
    expect(hasDebtOutsideEnteredMarkets(observation)).toBe(true);
    expect(fixture.hasDebtOutsideEnteredMarkets).toBe(true);
  });

  it("carries VAI debt that appears in no market at all", () => {
    // #given VAI, which is minted through the Comptroller rather than borrowed
    const vaiOwed = BigInt(observation.vai.repayAmount);

    // #then it is real debt
    expect(vaiOwed).toBeGreaterThan(0n);

    // #and it is absent from every market, entered or not, so a
    // market-enumerating reader can never see it
    expect(marketsWithDebt(observation)).toHaveLength(0);
  });

  it("shows mintedVAIs understating the debt by accrued interest", () => {
    // #given the principal and the true repayment amount
    const principal = BigInt(observation.vai.mintedPrincipal);
    const owed = BigInt(observation.vai.repayAmount);

    // #then the principal is materially smaller. Using it would understate the
    // debt, which is the direction that hides risk.
    expect(owed).toBeGreaterThan(principal);
    expect(BigInt(fixture.brokenView.principalUnderstatement)).toBe(owed - principal);

    // On this fixture the understatement is roughly 67%.
    expect((owed * 100n) / principal).toBeGreaterThan(150n);
  });

  it("would report no debt at all under the broken reading", () => {
    // #given the broken reading: enumerate entered markets, ignore VAI
    const debtFoundByBrokenView = observation.markets
      .filter((market) => market.entered)
      .reduce((total, market) => total + BigInt(market.borrowBalance ?? "0"), 0n);

    // #then it finds nothing, and an agent concludes the position is unleveraged
    expect(debtFoundByBrokenView).toBe(0n);

    // #while the account genuinely owes VAI
    expect(BigInt(observation.vai.repayAmount)).toBeGreaterThan(0n);
  });

  it("agrees with the protocol's own solvency verdict", () => {
    // #given the Comptroller's liquidity, which does charge VAI
    // #then the account is solvent but not debt-free, so any reconstruction
    // reporting infinite health is contradicting the protocol
    expect(BigInt(observation.accountLiquidity.errorCode)).toBe(0n);
    expect(BigInt(observation.accountLiquidity.shortfall)).toBe(0n);
    expect(BigInt(observation.accountLiquidity.liquidity)).toBeGreaterThan(0n);
  });
});

describe("unreadable market handling", () => {
  it("records markets it could not fully read rather than dropping them", () => {
    // #given a testnet universe containing structurally broken markets
    const unreadable = unreadableMarkets(observation);

    // #then they are present in the observation with a stated reason, so a
    // consumer can see what is unknown instead of inferring zero
    for (const market of unreadable) {
      const reason = market.balancesUnavailableReason ?? market.metadataUnavailableReason;
      expect(reason).toBeTruthy();
    }
  });

  it("never substitutes zero for an unavailable oracle price", () => {
    // #given markets the oracle refused to price
    const unpriced = observation.markets.filter((market) => market.priceMantissa === null);

    // #then the price is null and carries a reason, never "0", because zero
    // would value real collateral and real debt at nothing
    for (const market of unpriced) {
      expect(market.priceMantissa).toBeNull();
      expect(market.priceUnavailableReason).toBeTruthy();
    }
  });

  it("flags exposure that cannot be valued, as a fail-closed trigger", () => {
    // #when the fail-closed predicate runs
    const risky = marketsWithUnpricedExposure(observation);

    // #then every entry genuinely has a balance and genuinely lacks a price or
    // a liquidation weight
    for (const market of risky) {
      const hasBalance =
        BigInt(market.vTokenBalance ?? "0") > 0n || BigInt(market.borrowBalance ?? "0") > 0n;
      expect(hasBalance).toBe(true);
      expect(market.priceMantissa === null || market.liquidationThresholdMantissa === null).toBe(true);
    }
  });
});

describe("the adapter exports facts, not judgements", () => {
  /**
   * The architectural invariant behind this package. The agent and the
   * reference model must reconstruct risk independently; a shared
   * `computeHealthFactor` would make a bug in it produce a wrong agent AND an
   * evaluator that agrees, certifying the error.
   */
  it("exports no health-factor or risk computation", async () => {
    // #given the package's public surface
    const surface = await import("../src/index.js");

    // #then nothing that reaches a financial conclusion appears in it
    for (const forbidden of [
      "computeHealthFactor",
      "healthFactor",
      "isAtRisk",
      "calculateRequiredRepay",
      "evaluateIntervention",
    ]) {
      expect(surface).not.toHaveProperty(forbidden);
    }
  });
});
