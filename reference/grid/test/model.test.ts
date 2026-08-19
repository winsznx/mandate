import { describe, expect, it } from "vitest";
import { StrategyReferenceResultSchema } from "@mandate/domain";
import type { RawStableswapObservation } from "@mandate/stableswap-bsc";
import { runReferenceModel, type ReferenceGridPolicy } from "../src/model.js";
import {
  AMPLIFICATION_PRECISION,
  CHAIN,
  EXCHANGE_SELECTOR,
  ONE,
  POOL,
  TEST_POLICY,
  WIDE_POLICY,
  WSTETH,
  MSTETH,
  balancesForShare,
  observation,
} from "./fixtures.js";

function run(input: RawStableswapObservation, policy: ReferenceGridPolicy = TEST_POLICY) {
  return runReferenceModel({
    observation: input,
    policy,
    exchangeSelector: EXCHANGE_SELECTOR,
    amplificationPrecision: AMPLIFICATION_PRECISION,
  });
}

/** Ten whole units of inventory split evenly by rate-adjusted value. */
const EVEN = balancesForShare(5_000, ONE * 10n);

function board(skewNumerator: bigint, share = 5_000): RawStableswapObservation {
  const balances = balancesForShare(share, ONE * 10n);
  return observation({
    skewNumerator,
    walletBalance0: balances.coin0,
    walletBalance1: balances.coin1,
  });
}

describe("the model prices the pool for itself", () => {
  it("reports a fair rate taken from the stored rates, not from a quote", () => {
    // #given the pool at its live balances
    const { position } = run(board(100n));

    // #then the ladder's centre is the ratio the rate multipliers imply. A
    // ladder anchored at 1:1 would drift permanently to one side of a pair whose
    // redemption values diverge, and buy the same coin forever.
    expect(position?.fairRateMantissa).toBe((CHAIN.storedRate0 * ONE) / CHAIN.storedRate1);
  });

  it("publishes its own quote beside the pool's, and the drift between them", () => {
    // #given the pool at its live balances, where the recorded quote is current
    const { result } = run(board(100n));
    const metrics = Object.fromEntries(result.metrics.map((entry) => [entry.key, entry.value]));

    // #then both numbers are in the artifact and they agree exactly. The
    // agreement is a reconciliation a reader can redo, not an assertion.
    expect(metrics["pool-quote"]).toBe(CHAIN.poolQuote0To1.toString(10));
    expect(metrics["reconstruction-drift"]).toBe("0");
  });

  it("keeps its verdict when the pool's own quote is replaced with nonsense", () => {
    // #given the same board with `get_dy` reporting an absurd figure
    const honest = board(150n, 5_000);
    const corrupted: RawStableswapObservation = {
      ...honest,
      poolQuotes: honest.poolQuotes.map((quote) => ({ ...quote, dy: "999999999999999999999" })),
    };

    // #then the decision and the sized action are identical, because neither
    // came from the reading that changed. This model never asks the pool what a
    // swap returns; the agent it judges does.
    expect(run(corrupted).result.expectedAction).toEqual(run(honest).result.expectedAction);
    expect(run(corrupted).result.decisionState).toBe(run(honest).result.decisionState);
  });
});

describe("the model predicts a trade", () => {
  it("names the four-argument exchange, with no address among its arguments", () => {
    // #given coin 0 made abundant and therefore cheap
    const { result } = run(board(150n));

    // #then the predicted call is the boundable variant, and every argument is
    // an integer. There is nothing in it to redirect.
    expect(result.decisionState).toBe("ACTIONABLE");
    expect(result.expectedAction?.target).toBe(POOL);
    expect(result.expectedAction?.selector).toBe(EXCHANGE_SELECTOR);
    expect(result.expectedAction?.args.map((argument) => argument.type)).toEqual([
      "int128",
      "int128",
      "uint256",
      "uint256",
    ]);
  });

  it("buys the cheap coin", () => {
    // #given coin 0 abundant and 62 bps below fair, which is rung 2
    const { result, position } = run(board(150n));

    // #then it predicts selling coin 1 for coin 0
    expect(position?.deviationBps).toBe(-62n);
    expect(result.expectedAction?.args[0]?.value).toBe("1");
    expect(result.expectedAction?.args[1]?.value).toBe("0");
    expect(result.expectedAction?.spendToken).toBe(MSTETH);
  });

  it("sells the dear coin", () => {
    // #given coin 0 made scarce and therefore expensive
    const { result, position } = run(board(50n));

    // #then it predicts the trade the other way
    expect(position?.deviationBps).toBeGreaterThan(0n);
    expect(result.expectedAction?.args[0]?.value).toBe("0");
    expect(result.expectedAction?.args[1]?.value).toBe("1");
    expect(result.expectedAction?.spendToken).toBe(WSTETH);
  });

  it("marks the tranche exact and the minimum output approximate", () => {
    // #given a predicted trade
    const { result } = run(board(150n));

    // #then the coin indices and the size must match the agent's exactly, and
    // only `min_dy` is compared within tolerance. Both sides read the tranche
    // off the same published policy, so a difference there is a different trade;
    // `min_dy` is each side's own reconstruction of the price, and demanding
    // they agree to the wei would fail the two independent routes this
    // architecture is built on.
    expect(result.expectedAction?.amountArgIndex).toBe(2);
    expect(result.expectedAction?.toleratedArgIndexes).toEqual([3]);
    expect(result.expectedAction?.args[2]?.value).toBe(TEST_POLICY.trancheRawUnits.toString(10));
  });

  it("sets the minimum output the published bound below its own quote", () => {
    // #given a predicted trade
    const { result } = run(board(150n));
    const minDy = BigInt(result.expectedAction?.args[3]?.value ?? "0");

    // #then it is non-zero and strictly under the tranche size, which for a
    // pair trading near parity is the shape a sane bound has. A prediction of
    // zero would be inside the mandate and would still hand the account to the
    // first searcher who noticed.
    expect(minDy).toBeGreaterThan(0n);
    expect(minDy).toBeLessThan(TEST_POLICY.trancheRawUnits * 2n);
  });

  it("emits a document the evidence schema accepts", () => {
    // #given any prediction
    const { result } = run(board(150n));

    // #then it parses against the published schema, so what the model says and
    // what the artifact carries cannot drift apart
    expect(StrategyReferenceResultSchema.safeParse(result).success).toBe(true);
  });
});

describe("the model predicts a hold", () => {
  it("holds inside the first rung", () => {
    // #given the pool at its live balances, 15 bps off fair against 25 bps rungs
    const { result, position } = run(board(100n));

    // #then holding is the prediction. The live state of this pool is a
    // legitimate hold, which is worth pinning: an agent that traded it would be
    // churning, and an evaluator that expected a trade would fail a correct agent.
    expect(position?.deviationBps).toBe(-15n);
    expect(result.decisionState).toBe("WITHIN_POLICY");
    expect(result.expectedAction).toBeNull();
  });

  it("holds when the account already holds what the ladder wants", () => {
    // #given rung 2, wanting 5500 bps in coin 0, and an account already there
    const { result } = run(board(150n, 5_500));

    expect(result.decisionState).toBe("WITHIN_POLICY");
    expect(result.expectedAction).toBeNull();
  });

  it("separates an empty account from a blocked one", () => {
    // #given an account holding neither coin, and one that holds them but has
    // approved nothing
    const empty = run(observation({ skewNumerator: 150n })).result;
    const unapproved = run(
      observation({
        skewNumerator: 150n,
        walletBalance0: EVEN.coin0,
        walletBalance1: EVEN.coin1,
        allowance0: 0n,
        allowance1: 0n,
      }),
    ).result;

    // #then both correctly hold and the artifact keeps the reasons apart. Only
    // one of them describes an agent that wanted to act and could not.
    expect(empty.decisionState).toBe("NOTHING_TO_ALLOCATE");
    expect(unapproved.decisionState).toBe("BLOCKED_BY_AUTHORITY");
  });

  it("crosses the rung boundary at exactly the published spacing", () => {
    // #given the two pool skews either side of the first rung
    const inside = run(board(105n)).position;
    const onIt = run(board(110n)).position;

    // #then the deviation moves from 20 bps to 25 bps and the rung moves with
    // it. A policy that says 25 bps rungs has to advance at 25 bps and not at 24.
    expect(inside?.deviationBps).toBe(-20n);
    expect(inside?.rung).toBe(0n);
    expect(onIt?.deviationBps).toBe(-25n);
    expect(onIt?.rung).toBe(1n);
  });
});

describe("failing closed", () => {
  it("reports UNREADABLE_STATE when a stored rate is missing", () => {
    // #given a pool whose rates could not be read
    const { result } = run(
      observation({
        walletBalance0: EVEN.coin0,
        walletBalance1: EVEN.coin1,
        coin0Overrides: { storedRate: null, unavailableReason: "stored_rates(): connection reset" },
      }),
    );

    // #then no price is reported and the reason names the reading. A curve
    // priced from a subset of its own inputs is the price of a different pool.
    expect(result.decisionState).toBe("UNREADABLE_STATE");
    expect(result.expectedAction).toBeNull();
    expect(result.failClosedReason).toMatch(/connection reset/);
  });

  it("reports UNREADABLE_STATE when the amplification is missing", () => {
    // #given a pool that did not answer `A()`
    const { result } = run(
      observation({
        walletBalance0: EVEN.coin0,
        walletBalance1: EVEN.coin1,
        overrides: { amplification: null },
      }),
    );

    expect(result.decisionState).toBe("UNREADABLE_STATE");
    expect(result.failClosedReason).toMatch(/A\(\)/);
  });

  it("reports UNREADABLE_STATE when a coin's decimals disagree", () => {
    // #given mstETH reporting 6 decimals against a configured 18
    const { result } = run(
      observation({
        walletBalance0: EVEN.coin0,
        walletBalance1: EVEN.coin1,
        reportedDecimals1: 6,
      }),
    );

    // #then it fails closed rather than solving a curve every term of which is
    // scaled by the value in dispute
    expect(result.decisionState).toBe("UNREADABLE_STATE");
    expect(result.failClosedReason).toMatch(/different decimals/);
  });
});

describe("the wide ladder predicts a different action on the same state", () => {
  it("holds a dislocation the tight ladder trades", () => {
    // #given the pool 62 bps below fair: rung 2 on a 25 bps ladder, rung 0 on a
    // 100 bps one
    const state = board(150n);

    // #then an evaluator carrying one policy cannot certify an agent that ran
    // the other, and the difference is the decision itself rather than a size
    expect(run(state, TEST_POLICY).result.decisionState).toBe("ACTIONABLE");
    expect(run(state, WIDE_POLICY).result.decisionState).toBe("WITHIN_POLICY");
  });

  it("sets a looser minimum output when both act", () => {
    // #given a dislocation wide enough for both ladders
    const state = board(200n);
    const tight = BigInt(run(state, TEST_POLICY).result.expectedAction?.args[3]?.value ?? "0");
    const wide = BigInt(run(state, WIDE_POLICY).result.expectedAction?.args[3]?.value ?? "0");

    // #then the wide ladder's bound is the looser of the two
    expect(wide).toBeGreaterThan(0n);
    expect(wide).toBeLessThan(tight);
  });
});
