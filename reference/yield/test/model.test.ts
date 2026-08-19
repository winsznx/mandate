import { describe, expect, it } from "vitest";
import { StrategyReferenceResultSchema } from "@mandate/domain";
import { reconstruct } from "../src/allocation.js";
import { runReferenceModel } from "../src/model.js";
import { rateFloorPerBlock } from "../src/scale.js";
import {
  BLOCKS_PER_YEAR,
  CAPPED_POLICY,
  EXCHANGE_RATE,
  MINT_SELECTOR,
  TEST_POLICY,
  USDC,
  USDC_PRICE_6DP,
  USDT,
  UNCAPPED,
  VUSDC,
  VUSDT,
  market,
  observation,
  position,
  ratePerBlockForAnnualBps,
  retiredBusd,
} from "./fixtures.js";
import type { RawSupplyObservation } from "@mandate/venus-bsc";
import type { ReferenceYieldPolicy } from "../src/model.js";

function run(input: RawSupplyObservation, policy: ReferenceYieldPolicy = TEST_POLICY) {
  return runReferenceModel({ observation: input, policy, mintSelector: MINT_SELECTOR }).result;
}

describe("the model predicts a deployment", () => {
  it("names the market with the best raw per-block rate", () => {
    // #given USDC at 300 bps against USDT's 120, both with idle capital
    const result = run(
      position(
        { annualRateBps: 120, walletBalance: 1_000_000_000n },
        { annualRateBps: 300, walletBalance: 1_000_000_000n },
      ),
    );

    // #then it predicts a mint into USDC for the whole idle balance
    expect(result.decisionState).toBe("ACTIONABLE");
    expect(result.expectedAction).toEqual({
      target: VUSDC,
      selector: MINT_SELECTOR,
      args: [{ type: "uint256", value: "1000000000" }],
      amountArgIndex: 0,
      toleratedArgIndexes: [0],
      spendToken: USDC,
      spendDecimals: 6,
    });
  });

  it("names the token the spend comes out of, so a cap can be applied to it", () => {
    // #given a prediction on the USDT market
    const result = run(
      position({ annualRateBps: 300, walletBalance: 1_000_000_000n }, { annualRateBps: 0, walletBalance: 0n }),
    );

    // #then the spend token is the underlying rather than the vToken. A spend
    // cap counts what leaves the account, and what leaves is the underlying.
    expect(result.expectedAction?.spendToken).toBe(USDT);
  });

  it("emits a document the evidence schema accepts", () => {
    // #given any prediction
    const result = run(
      position({ annualRateBps: 0, walletBalance: 0n }, { annualRateBps: 300, walletBalance: 1_000_000_000n }),
    );

    // #then it parses against the published schema, so what the model says and
    // what the artifact carries cannot drift apart
    expect(StrategyReferenceResultSchema.safeParse(result).success).toBe(true);
  });

  it("publishes the metrics behind the decision, not only the decision", () => {
    // #given a prediction
    const result = run(
      position({ annualRateBps: 120, walletBalance: 1_000_000_000n }, { annualRateBps: 300, walletBalance: 1_000_000_000n }),
    );

    // #then a reader can re-add the ranking by hand from the artifact rather
    // than having to trust the conclusion
    const keys = result.metrics.filter((entry) => entry.scope === "USDC").map((entry) => entry.key);
    expect(keys).toContain("supply-rate-per-block");
    expect(keys).toContain("supply-headroom");
    expect(keys).toContain("wallet-idle");
  });
});

describe("the model predicts a hold", () => {
  it("holds when no market clears the floor, and says why", () => {
    // #given both markets at 80 bps gross, which is 55 bps net of the buffer
    const result = run(
      position(
        { annualRateBps: 80, walletBalance: 1_000_000_000n },
        { annualRateBps: 80, walletBalance: 1_000_000_000n },
      ),
    );

    // #then holding is the prediction, and it is `WITHIN_POLICY` rather than a
    // blocked state: nothing stopped the agent, the policy simply said no
    expect(result.decisionState).toBe("WITHIN_POLICY");
    expect(result.expectedAction).toBeNull();
  });

  it("separates having nothing to deploy from being unable to deploy it", () => {
    // #given an account with no idle balance anywhere, and one with idle
    // balance in a market that is paused
    const empty = run(position({ annualRateBps: 300, walletBalance: 0n }, { annualRateBps: 300, walletBalance: 0n }));
    const blocked = run(observation([retiredBusd(1_000n * 10n ** 18n)]));

    // #then the two states are distinguishable in the artifact. Both correctly
    // hold; only one of them describes an agent that wanted to act and could not.
    expect(empty.decisionState).toBe("NOTHING_TO_ALLOCATE");
    expect(blocked.decisionState).toBe("BLOCKED_BY_AUTHORITY");
  });

  it("holds when the deployable size is below the minimum size floor", () => {
    // #given a good rate but 5 USDC of idle balance against a $10 floor
    const result = run(
      position({ annualRateBps: 0, walletBalance: 0n }, { annualRateBps: 300, walletBalance: 5_000_000n }),
    );

    // #then it predicts a hold
    expect(result.decisionState).toBe("WITHIN_POLICY");
    expect(result.expectedAction).toBeNull();
  });
});

describe("the floor is crossed at exactly the same reading either way round", () => {
  /**
   * The sharpest form of the independence claim on this category.
   *
   * The agent multiplies each rate up into annual basis points and compares
   * against an integer floor. This model divides the floor down into a
   * per-block rate and compares the raw readings. `floor(x) >= K` and
   * `x >= K` are the same statement for integer `K`, so the two routes cross
   * the line at the same reading rather than merely near it — which is what
   * makes a disagreement between them a bug rather than a rounding artefact.
   */
  const floorRate = rateFloorPerBlock(
    BigInt(TEST_POLICY.minNetSupplyRateBps + TEST_POLICY.gasCostBufferBps),
    BigInt(BLOCKS_PER_YEAR),
  );

  it("acts at the boundary reading", () => {
    // #given a market reporting exactly the floor rate
    const result = run(
      observation([
        market({
          vToken: VUSDC,
          underlying: USDC,
          symbol: "USDC",
          underlyingDecimals: 6,
          priceMantissa: USDC_PRICE_6DP,
          annualRateBps: 100,
          walletBalance: 1_000_000_000n,
        }),
      ]),
    );

    // #then the floor is inclusive, matching the agent's `>=`
    expect(ratePerBlockForAnnualBps(100)).toBe(floorRate);
    expect(result.decisionState).toBe("ACTIONABLE");
  });

  it("holds one unit below it", () => {
    // #given the same market one wei of rate lower
    const result = run(
      observation([
        market({
          vToken: VUSDC,
          underlying: USDC,
          symbol: "USDC",
          underlyingDecimals: 6,
          priceMantissa: USDC_PRICE_6DP,
          annualRateBps: 100,
          walletBalance: 1_000_000_000n,
          overrides: { supplyRatePerBlockMantissa: (floorRate - 1n).toString(10) },
        }),
      ]),
    );

    // #then it holds. One unit of a per-block rate is the smallest step the
    // protocol can report, and the boundary has to land between two adjacent
    // readings rather than somewhere inside the gap.
    expect(result.decisionState).toBe("WITHIN_POLICY");
  });
});

describe("markets that cannot take a deposit", () => {
  it("classifies a paused market rather than dropping it", () => {
    // #given the retired BUSD market, listed and priced and paying 5000 bps
    const reconstruction = reconstruct(observation([retiredBusd(1_000n * 10n ** 18n)]));

    // #then it is reconstructed with a stated reason. Dropping it would leave a
    // reader unable to tell an excluded market from one that was never read.
    expect(reconstruction.markets[0]?.unavailable).toBe("MINT_PAUSED");
  });

  it("treats a supply cap of zero as closed, not as unlimited", () => {
    // #given a market whose cap is zero
    const reconstruction = reconstruct(
      observation([
        market({
          vToken: VUSDC,
          underlying: USDC,
          symbol: "USDC",
          underlyingDecimals: 6,
          priceMantissa: USDC_PRICE_6DP,
          annualRateBps: 300,
          walletBalance: 1_000_000_000n,
          supplyCapRaw: "0",
        }),
      ]),
    );

    // #then it takes nothing. Venus writes zero on retired markets, and reading
    // it the other way opens exactly the markets the field exists to close.
    expect(reconstruction.markets[0]?.headroomRaw).toBe(0n);
    expect(reconstruction.markets[0]?.unavailable).toBe("AT_SUPPLY_CAP");
  });

  it("sizes the prediction down to the remaining cap", () => {
    // #given a market holding 200 units under a cap that leaves room for 400
    const result = run(
      observation([
        market({
          vToken: VUSDC,
          underlying: USDC,
          symbol: "USDC",
          underlyingDecimals: 6,
          priceMantissa: USDC_PRICE_6DP,
          annualRateBps: 300,
          walletBalance: 1_000_000_000n,
          suppliedUnderlying: 200_000_000n,
          supplyCapRaw: (600_000_000n).toString(10),
        }),
      ]),
    );

    // #then the predicted size is the headroom, not the balance
    expect(result.expectedAction?.args[0]?.value).toBe("400000000");
  });

  it("sizes the prediction down to the allowance", () => {
    // #given a wallet holding 1000 having approved 250
    const result = run(
      observation([
        market({
          vToken: VUSDC,
          underlying: USDC,
          symbol: "USDC",
          underlyingDecimals: 6,
          priceMantissa: USDC_PRICE_6DP,
          annualRateBps: 300,
          walletBalance: 1_000_000_000n,
          allowance: 250_000_000n,
        }),
      ]),
    );

    expect(result.expectedAction?.args[0]?.value).toBe("250000000");
  });
});

describe("failing closed", () => {
  it("reports UNREADABLE_STATE when any market could not be fully read", () => {
    // #given one unreadable market beside a perfectly good one
    const result = run(
      observation([
        market({
          vToken: VUSDC,
          underlying: USDC,
          symbol: "USDC",
          underlyingDecimals: 6,
          priceMantissa: USDC_PRICE_6DP,
          annualRateBps: 300,
          walletBalance: 1_000_000_000n,
        }),
        market({
          vToken: VUSDT,
          underlying: USDT,
          symbol: "USDT",
          underlyingDecimals: 6,
          priceMantissa: 5n * 10n ** 29n,
          annualRateBps: 120,
          walletBalance: 1_000_000_000n,
          overrides: {
            supplyRatePerBlockMantissa: null,
            rateUnavailableReason: "supplyRatePerBlock(): connection reset",
          },
        }),
      ]),
    );

    // #then no ranking is reported and the reason names the market. The
    // unreadable one might have been the best, so ranking the rest answers a
    // different question from the one that was asked.
    expect(result.decisionState).toBe("UNREADABLE_STATE");
    expect(result.expectedAction).toBeNull();
    expect(result.failClosedReason).toMatch(/connection reset/);
  });

  it("excludes a market whose token disagrees with its configured decimals", () => {
    // #given USDC configured at 6 decimals and reporting 18
    const reconstruction = reconstruct(
      observation([
        market({
          vToken: VUSDC,
          underlying: USDC,
          symbol: "USDC",
          underlyingDecimals: 6,
          reportedDecimals: 18,
          priceMantissa: USDC_PRICE_6DP,
          annualRateBps: 300,
          walletBalance: 1_000_000_000n,
        }),
      ]),
    );

    // #then it is unavailable. The oracle scale is 1e(36 - decimals), so the
    // disagreement misprices the market by twelve orders of magnitude.
    expect(reconstruction.markets[0]?.unavailable).toBe("DECIMALS_DISAGREE");
  });

  it("excludes a market whose price cannot be right for its decimals", () => {
    // #given a 6-decimal token quoted at the 18-decimal scale
    const reconstruction = reconstruct(
      observation([
        market({
          vToken: VUSDC,
          underlying: USDC,
          symbol: "USDC",
          underlyingDecimals: 6,
          priceMantissa: 10n ** 18n,
          annualRateBps: 300,
          walletBalance: 1_000_000_000n,
        }),
      ]),
    );

    expect(reconstruction.markets[0]?.unavailable).toBe("IMPLAUSIBLE_PRICE");
  });
});

describe("the balance sheet is reconciled against the vToken supply", () => {
  it("reports no drift when the two routes agree", () => {
    // #given a market whose cash, borrows and vToken supply are consistent
    const reconstruction = reconstruct(
      position({ annualRateBps: 120, walletBalance: 0n }, { annualRateBps: 300, walletBalance: 0n }),
    );

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
          annualRateBps: 300,
          walletBalance: 1_000_000_000n,
          suppliedUnderlying: 1_000_000_000n,
          totalSupplyVTokens: (2_000_000_000n * 10n ** 18n) / EXCHANGE_RATE,
        }),
      ]),
    );

    // #then this model's own figure comes from the balance sheet and the
    // disagreement is published beside it. Drift is a cross-check on this
    // module, not an input to it.
    expect(reconstruction.markets[0]?.suppliedUnderlyingRaw).toBe(1_000_000_000n);
    expect(reconstruction.markets[0]?.identityDriftBps).toBe(10_000n);
  });
});

describe("the diversified policy predicts a different action on the same state", () => {
  it("stops the deployment at the concentration ceiling", () => {
    // #given $500 of idle USDT and $1000 of idle USDC, a $1500 book, under a
    // 6000 bps per-market ceiling
    const board = position(
      { annualRateBps: 120, walletBalance: 1_000_000_000n },
      { annualRateBps: 300, walletBalance: 1_000_000_000n },
    );

    // #when the two policies are applied to it
    const uncapped = run(board, TEST_POLICY);
    const capped = run(board, CAPPED_POLICY);

    // #then both pick USDC and size it differently, so an evaluator carrying
    // one policy cannot certify an agent that ran the other
    expect(uncapped.expectedAction?.args[0]?.value).toBe("1000000000");
    expect(capped.expectedAction?.args[0]?.value).toBe("900000000");
  });

  it("counts idle capital in the denominator, so a first deposit is possible", () => {
    // #given an account with everything idle and nothing supplied
    const board = observation([
      market({
        vToken: VUSDC,
        underlying: USDC,
        symbol: "USDC",
        underlyingDecimals: 6,
        priceMantissa: USDC_PRICE_6DP,
        annualRateBps: 300,
        walletBalance: 1_000_000_000n,
        supplyCapRaw: UNCAPPED,
      }),
    ]);

    // #then the ceiling still permits a deployment. Measured against supplied
    // capital alone, any first deposit would be 100% of the supplied book and
    // would breach every ceiling below 10000 bps — a policy that forbids ever
    // starting is broken rather than conservative.
    expect(run(board, CAPPED_POLICY).decisionState).toBe("ACTIONABLE");
    expect(run(board, CAPPED_POLICY).expectedAction?.args[0]?.value).toBe("600000000");
  });
});
