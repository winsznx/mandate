import { describe, expect, it } from "vitest";
import { StrategyReferenceResultSchema } from "@mandate/domain";
import { reconstruct } from "../src/allocation.js";
import { runReferenceModel } from "../src/model.js";
import {
  EXCHANGE_RATE,
  MINT_SELECTOR,
  TEST_POLICY,
  UNCAPPED,
  USDC,
  USDC_PRICE_6DP,
  VUSDC,
  WIDE_POLICY,
  boundaryBoard,
  driftedBoard,
  insideBandBoard,
  market,
  observation,
  position,
  retiredBusd,
  starvedBoard,
  usdtMarket,
} from "./fixtures.js";
import type { RawSupplyObservation } from "@mandate/venus-bsc";
import type { ReferenceRebalancingPolicy } from "../src/model.js";

function run(input: RawSupplyObservation, policy: ReferenceRebalancingPolicy = TEST_POLICY) {
  return runReferenceModel({ observation: input, policy, mintSelector: MINT_SELECTOR }).result;
}

describe("the model predicts a top-up", () => {
  it("names the market furthest below its published weight", () => {
    // #given a $1000 book holding $700 of USDT against $100 of USDC, with $200
    // of USDC idle behind it
    const result = run(driftedBoard());

    // #then it predicts a mint into USDC for the whole idle balance, because
    // the $400 gap is larger than the cash available to close it
    expect(result.decisionState).toBe("ACTIONABLE");
    expect(result.expectedAction).toEqual({
      target: VUSDC,
      selector: MINT_SELECTOR,
      args: [{ type: "uint256", value: "200000000" }],
      amountArgIndex: 0,
      toleratedArgIndexes: [0],
      spendToken: USDC,
      spendDecimals: 6,
    });
  });

  it("names the token the spend comes out of, so a cap can be applied to it", () => {
    // #given any prediction
    const result = run(driftedBoard());

    // #then the spend token is the underlying rather than the vToken. A spend
    // cap counts what leaves the account, and what leaves is the underlying.
    expect(result.expectedAction?.spendToken).toBe(USDC);
  });

  it("weighs the portfolio in dollars rather than in token units", () => {
    // #given 1000 units supplied on each side plus 100 idle USDT: 1000 USDT is
    // $500 at fifty cents and 1000 USDC is $1000, so the book is two-thirds USDC
    const result = run(
      position({ supplied: 1_000_000_000n, idle: 100_000_000n }, { supplied: 1_000_000_000n, idle: 0n }),
    );

    // #then USDT is the under-weight side. A model counting tokens would see
    // parity here and predict a hold, and would then pass an agent that did
    // nothing about a portfolio a third away from its target.
    expect(result.expectedAction?.target).toBe("0xb7526572ffe56ab9d7489838bf2e18e3323b441a");
  });

  it("emits a document the evidence schema accepts", () => {
    // #given any prediction
    const result = run(driftedBoard());

    // #then it parses against the published schema, so what the model says and
    // what the artifact carries cannot drift apart
    expect(StrategyReferenceResultSchema.safeParse(result).success).toBe(true);
  });

  it("emits a schema-valid document on a hold as well as on an action", () => {
    // #given the two states that carry no action for different reasons
    const held = run(insideBandBoard());
    const blocked = run(starvedBoard());

    // #then both parse. The schema refuses an action on a non-ACTIONABLE state
    // and refuses a missing reason on a fail-closed one, so this is the check
    // that the state machine and the document agree.
    expect(StrategyReferenceResultSchema.safeParse(held).success).toBe(true);
    expect(StrategyReferenceResultSchema.safeParse(blocked).success).toBe(true);
  });

  it("publishes the quantities behind the decision, not only the decision", () => {
    // #given a prediction
    const result = run(driftedBoard());

    // #then a reader can re-add the allocation by hand from the artifact rather
    // than having to trust the conclusion
    const keys = result.metrics.filter((entry) => entry.scope === "USDC").map((entry) => entry.key);
    expect(keys).toContain("target-weight");
    expect(keys).toContain("held-weight");
    expect(keys).toContain("position-usd");
    expect(keys).toContain("weight-shortfall-usd");
    expect(result.metrics.map((entry) => entry.key)).toContain("portfolio-usd");
  });

  it("sizes the prediction down to the allowance", () => {
    // #given $200 of idle USDC against a $400 gap, with only 50 USDC approved
    const result = run(
      position(
        { supplied: 1_400_000_000n, idle: 0n },
        { supplied: 100_000_000n, idle: 200_000_000n, allowance: 50_000_000n },
      ),
    );

    expect(result.expectedAction?.args[0]?.value).toBe("50000000");
  });

  it("sizes the prediction down to the remaining supply cap", () => {
    // #given a market holding 10000 units under a cap that leaves room for 40
    const result = run(
      position(
        { supplied: 1_400_000_000n, idle: 0n },
        {
          supplied: 100_000_000n,
          idle: 200_000_000n,
          marketSupplied: 10_000_000_000n,
          supplyCapRaw: (10_040_000_000n).toString(10),
        },
      ),
    );

    expect(result.expectedAction?.args[0]?.value).toBe("40000000");
  });

  it("sizes the prediction down to the gap itself, never past it", () => {
    // #given a $10 gap with $15 of idle capital behind it
    const result = run(boundaryBoard());

    // #then it predicts $10 and not $15. Overshooting the target makes the
    // market over-weight, which is the error the agent exists to correct.
    expect(result.expectedAction?.args[0]?.value).toBe("10000000");
  });
});

describe("the model predicts a hold", () => {
  it("separates having nothing to allocate from being unable to act", () => {
    // #given an empty account, and one out of band with no idle capital anywhere
    const empty = run(position({ supplied: 0n, idle: 0n }, { supplied: 0n, idle: 0n }));
    const starved = run(starvedBoard());

    // #then the two states are distinguishable in the artifact. Both correctly
    // hold; only one of them describes an agent that wanted to act and could not.
    expect(empty.decisionState).toBe("NOTHING_TO_ALLOCATE");
    expect(starved.decisionState).toBe("BLOCKED_BY_AUTHORITY");
  });

  it("names the withheld function when only a withdrawal would close the gap", () => {
    // #given $900 of USDT against $100 of USDC and no cash
    const result = run(starvedBoard());

    // #then the artifact says which action was missing rather than reporting a
    // hold with no reason. `redeemUnderlying` carries no address argument, so
    // it is bounded in reach; it is withheld because withdrawing collateral
    // moves a risk invariant no spend cap can express.
    expect(result.notes.join(" ")).toMatch(/redeemUnderlying\(uint256\)/);
    expect(result.expectedAction).toBeNull();
  });

  it("blocks rather than holding when the under-weight market takes no supply", () => {
    // #given a book 4000 bps out of balance whose under-weight side is paused,
    // with idle capital sitting ready for it
    const result = run(
      position(
        { supplied: 1_400_000_000n, idle: 0n },
        { supplied: 100_000_000n, idle: 200_000_000n, mintPaused: true },
      ),
    );

    // #then the state says the agent was stopped, not that the portfolio was fine
    expect(result.decisionState).toBe("BLOCKED_BY_AUTHORITY");
    expect(result.notes.join(" ")).toMatch(/MINT_PAUSED/);
  });

  it("holds within policy when the correction is below the minimum size floor", () => {
    // #given a $1000 book whose USDC leg is $20 short with only $5 of cash
    const result = run(
      position({ supplied: 1_030_000_000n, idle: 0n }, { supplied: 480_000_000n, idle: 5_000_000n }),
    );

    // #then it is `WITHIN_POLICY` and not `BLOCKED_BY_AUTHORITY`. Nothing
    // stopped the agent; its own published floor says the trade is not worth
    // making, and the artifact has to attribute the hold to the right cause.
    expect(result.decisionState).toBe("WITHIN_POLICY");
    expect(result.notes.join(" ")).toMatch(/USD floor this policy sets/);
  });

  it("holds a portfolio the wide band tolerates and the narrow one does not", () => {
    // #given the board sitting exactly 100 bps out
    const board = boundaryBoard();

    // #when the two published policies are applied to it
    const narrow = run(board, TEST_POLICY);
    const wide = run(board, WIDE_POLICY);

    // #then the model predicts opposite decisions, so an evaluator carrying one
    // policy cannot certify an agent that ran the other
    expect(narrow.decisionState).toBe("ACTIONABLE");
    expect(wide.decisionState).toBe("WITHIN_POLICY");
  });
});

describe("the drift trigger is crossed at exactly the same portfolio state either way round", () => {
  /**
   * The sharpest form of the independence claim on this category.
   *
   * The agent writes the predicate out in
   * `agents/reference/rebalancing-a/src/venus/weights.ts`; this model writes it
   * out again in `src/allocation.ts`. Both cross-multiply and neither divides,
   * so the line falls between two adjacent readings rather than somewhere
   * inside the gap between them — which is what makes a disagreement between
   * the two a bug rather than a rounding artefact a tolerance would swallow.
   */
  it("acts on a portfolio exactly one trigger-width short of target", () => {
    // #given a $1000 book whose USDC leg is $10 short, which is exactly 100 bps
    const result = run(boundaryBoard());

    // #then the comparison is inclusive at the line, matching the agent's `>=`
    expect(result.decisionState).toBe("ACTIONABLE");
  });

  it("holds one base unit inside the band", () => {
    // #given the same board with one more base unit of USDC supplied
    const result = run(insideBandBoard());

    // #then it holds, and holds because the band says so rather than because
    // anything blocked it
    expect(result.decisionState).toBe("WITHIN_POLICY");
    expect(result.expectedAction).toBeNull();
  });
});

describe("the balance sheet is reconciled against the vToken supply", () => {
  it("reports no drift when the two routes agree", () => {
    // #given a market whose cash, borrows and vToken supply are consistent
    const reconstruction = reconstruct(driftedBoard());

    // #then the identity holds and the artifact says so
    expect(reconstruction.markets[0]?.identityDriftBps).toBe(0n);
  });

  it("reports drift rather than hiding it when they disagree", () => {
    // #given a market whose vToken supply implies twice the underlying its
    // balance sheet holds, which is what a wrong exchange-rate decode looks like
    const reconstruction = reconstruct(
      observation([
        market({
          vToken: VUSDC,
          underlying: USDC,
          symbol: "USDC",
          underlyingDecimals: 6,
          priceMantissa: USDC_PRICE_6DP,
          supplied: 100_000_000n,
          idle: 200_000_000n,
          marketSupplied: 10_000_000_000n,
          totalSupplyVTokens: (20_000_000_000n * 10n ** 18n) / EXCHANGE_RATE,
        }),
      ]),
    );

    // #then this model's own figure comes from the balance sheet and the
    // disagreement is published beside it. Drift is a cross-check on this
    // module, not an input to it.
    expect(reconstruction.markets[0]?.suppliedUnderlyingRaw).toBe(10_000_000_000n);
    expect(reconstruction.markets[0]?.identityDriftBps).toBe(10_000n);
  });

  it("publishes the drift as a metric so the artifact carries it", () => {
    // #given any prediction over a consistent board
    const result = run(driftedBoard());

    // #then the cross-check appears in the evidence rather than only in a test.
    // A reconciliation nobody can see is a reconciliation nobody performed.
    expect(result.metrics.map((entry) => entry.key)).toContain("exchange-rate-identity-drift");
  });
});

describe("failing closed", () => {
  it("reports UNREADABLE_STATE when any market could not be fully read", () => {
    // #given one unreadable market beside two perfectly good ones
    const result = run(
      observation([
        usdtMarket({ supplied: 1_400_000_000n, idle: 0n }),
        market({
          vToken: VUSDC,
          underlying: USDC,
          symbol: "USDC",
          underlyingDecimals: 6,
          priceMantissa: USDC_PRICE_6DP,
          supplied: 100_000_000n,
          idle: 200_000_000n,
          overrides: {
            vTokenBalance: null,
            balancesUnavailableReason: "vToken.balanceOf(): connection reset",
          },
        }),
        retiredBusd(),
      ]),
    );

    // #then no weights are reported and the reason names the failure. A weight
    // is a share of a total, so one unread balance moves the denominator every
    // other market is measured against.
    expect(result.decisionState).toBe("UNREADABLE_STATE");
    expect(result.expectedAction).toBeNull();
    expect(result.failClosedReason).toMatch(/connection reset/);
  });

  it("fails closed on a price that cannot be right for its decimals", () => {
    // #given a 6-decimal token quoted at the 18-decimal scale, which is the
    // exact shape of the testnet decimal trap
    const result = run(
      observation([
        usdtMarket({ supplied: 1_400_000_000n, idle: 0n }),
        market({
          vToken: VUSDC,
          underlying: USDC,
          symbol: "USDC",
          underlyingDecimals: 6,
          priceMantissa: 10n ** 18n,
          supplied: 100_000_000n,
          idle: 200_000_000n,
          supplyCapRaw: UNCAPPED,
        }),
      ]),
    );

    // #then the whole portfolio is unreadable rather than one market being
    // excluded. Weights share a denominator, so a market priced twelve orders
    // of magnitude out makes every other market's weight wrong while each one
    // still looks internally consistent.
    expect(result.decisionState).toBe("UNREADABLE_STATE");
    expect(result.failClosedReason).toMatch(/IMPLAUSIBLE_PRICE/);
  });

  it("fails closed when a token disagrees with its configured decimals", () => {
    // #given USDC configured at 6 decimals and reporting 18
    const result = run(
      observation([
        usdtMarket({ supplied: 1_400_000_000n, idle: 0n }),
        market({
          vToken: VUSDC,
          underlying: USDC,
          symbol: "USDC",
          underlyingDecimals: 6,
          reportedDecimals: 18,
          priceMantissa: USDC_PRICE_6DP,
          supplied: 100_000_000n,
          idle: 200_000_000n,
        }),
      ]),
    );

    expect(result.decisionState).toBe("UNREADABLE_STATE");
    expect(result.failClosedReason).toMatch(/DECIMALS_DISAGREE/);
  });

  it("treats a supply cap of zero as closed, not as unlimited", () => {
    // #given the retired BUSD market, whose cap Venus writes as zero
    const reconstruction = reconstruct(observation([retiredBusd(1_000n * 10n ** 18n)]));

    // #then it takes nothing. Reading zero as "no ceiling" opens exactly the
    // markets the field exists to close.
    expect(reconstruction.markets[0]?.headroomRaw).toBe(0n);
    expect(reconstruction.markets[0]?.unavailable).toBe("MINT_PAUSED");
  });

  it("counts idle capital in a market it cannot act on toward the portfolio total", () => {
    // #given the same book with and without 1000 BUSD sitting idle on the
    // retired market
    const without = reconstruct(driftedBoard()).portfolioUsd;
    const withBusd = reconstruct(
      position(
        { supplied: 1_400_000_000n, idle: 0n },
        { supplied: 100_000_000n, idle: 200_000_000n },
        1_000n * 10n ** 18n,
      ),
    ).portfolioUsd;

    // #then the BUSD widens the denominator every weight is a share of. A model
    // that skipped un-targeted markets would report a portfolio balanced over
    // the part of itself that happened to be reachable.
    expect(withBusd).toBeGreaterThan(without);
  });
});
