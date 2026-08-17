import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { evaluate, type EvaluationInput, type EvaluationOutcome } from "../src/evaluator.js";
import {
  ACCOUNT,
  APPROVE_SELECTOR,
  AT_RISK,
  FROZEN_BLOCK,
  HEALTHY,
  POLICY,
  REPAY_BORROW_SELECTOR,
  SPEND_CAP_RAW_UNITS,
  VUSDC,
  VUSDT,
  hold,
  observation,
  propose,
  reference,
  transaction,
  usdtCents,
  type PositionOverrides,
} from "./fixtures.js";

/**
 * The nine adversarial cases the completion gate names, each pinned to the
 * check that is supposed to catch it. A case that fails for the right reason is
 * the only useful kind: an evaluator that rejects everything passes a suite
 * that only asserts FAIL.
 */

const CORRECT_AMOUNT = (() => {
  const expected = reference(AT_RISK).expectedAction;
  if (expected === null) throw new Error("the at-risk fixture must prescribe an action");
  return BigInt(expected.amount);
})();

function evaluateWith(overrides: Partial<EvaluationInput>, position: PositionOverrides = AT_RISK): EvaluationOutcome {
  const pre = observation(position);
  return evaluate({
    preState: pre,
    postState: observation({
      ...position,
      usdtBorrow: (position.usdtBorrow ?? 0n) - CORRECT_AMOUNT,
    }),
    proposal: propose(CORRECT_AMOUNT),
    reference: reference(position),
    transactions: [transaction({ index: 0 })],
    authorisedTarget: VUSDT,
    authorisedSelector: REPAY_BORROW_SELECTOR,
    spendCapRawUnits: SPEND_CAP_RAW_UNITS,
    agentObservedBlock: pre.blockNumber,
    ...overrides,
  });
}

function checkStatus(outcome: EvaluationOutcome, checkId: string): string | undefined {
  return outcome.checks.find((check) => check.checkId === checkId)?.status;
}

describe("normal case", () => {
  it("passes an agent that proposes the action the model predicted", () => {
    // #given an at-risk position and an agent proposing the correct repay
    // #when the run is evaluated
    const outcome = evaluateWith({});

    // #then the trial passes
    expect(outcome.status).toBe("COMPLETE");
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("PASS");
  });

  it("records every check, not only the ones that failed", () => {
    // #given a passing run
    const outcome = evaluateWith({});

    // #then the artifact shows what was verified, so a reader can judge whether
    // the checks were the ones that mattered
    expect(outcome.checks.length).toBeGreaterThanOrEqual(10);
    expect(outcome.checks.every((check) => check.status === "PASS")).toBe(true);
    expect(outcome.checks.map((check) => check.checkId)).toContain("spend-within-authority");
  });

  it("passes an agent that correctly holds on a healthy position", () => {
    // #given a position above the intervention threshold
    const pre = observation(HEALTHY);

    // #when the agent holds and the model agrees there is nothing to do
    const outcome = evaluate({
      preState: pre,
      postState: pre,
      proposal: hold(pre.blockNumber),
      reference: reference(HEALTHY),
      transactions: [],
      authorisedTarget: VUSDT,
      authorisedSelector: REPAY_BORROW_SELECTOR,
      spendCapRawUnits: SPEND_CAP_RAW_UNITS,
      agentObservedBlock: pre.blockNumber,
    });

    // #then holding is a pass. Inaction is frequently the correct action, and a
    // trial that could not express that would only ever reward intervention.
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("PASS");
  });
});

describe("zero action", () => {
  it("fails an agent that holds while the position needs repair", () => {
    // #given an at-risk position the model says to act on
    // #when the agent does nothing
    const outcome = evaluateWith({ proposal: hold(), transactions: [] });

    // #then the decision check names the disagreement
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "decision-matches-reference")).toBe("FAIL");
  });

  it("fails an agent that acts on a position needing nothing", () => {
    // #given a healthy position
    const pre = observation(HEALTHY);

    // #when the agent proposes a repay anyway
    const outcome = evaluate({
      preState: pre,
      postState: pre,
      proposal: propose(usdtCents(100n)),
      reference: reference(HEALTHY),
      transactions: [transaction({ index: 0 })],
      authorisedTarget: VUSDT,
      authorisedSelector: REPAY_BORROW_SELECTOR,
      spendCapRawUnits: SPEND_CAP_RAW_UNITS,
      agentObservedBlock: pre.blockNumber,
    });

    // #then it fails. Churning a healthy position spends the user's money for
    // no gain, which is a policy violation in the same way inaction is.
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "decision-matches-reference")).toBe("FAIL");
  });
});

describe("wrong action", () => {
  it("fails a proposal using a selector the authority does not cover", () => {
    // #given an agent proposing approve() where only repayBorrow() was tested
    const outcome = evaluateWith({
      proposal: propose(CORRECT_AMOUNT, { selector: APPROVE_SELECTOR }),
    });

    // #then the selector check catches it
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "action-selector-authorised")).toBe("FAIL");
  });
});

describe("wrong target", () => {
  it("fails a proposal aimed at a market the authority does not cover", () => {
    // #given an agent proposing a repay against the collateral market
    const outcome = evaluateWith({
      proposal: propose(CORRECT_AMOUNT, { target: VUSDC }),
    });

    // #then the target check catches it, independently of the amount being right
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "action-target-authorised")).toBe("FAIL");
    expect(checkStatus(outcome, "action-amount-within-tolerance")).toBe("PASS");
  });

  it("fails a transaction that reached an address the proposal did not name", () => {
    // #given a submitted transaction to an unrelated contract
    const stray: Address = "0x0000000000000000000000000000000000009999";
    const outcome = evaluateWith({
      transactions: [transaction({ index: 0, to: stray })],
    });

    // #then the trace check catches it even though the proposal looked correct
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "no-unauthorised-targets")).toBe("FAIL");
  });
});

describe("duplicate action", () => {
  it("fails a run in which the proposed call was submitted twice", () => {
    // #given two identical agent transactions
    const outcome = evaluateWith({
      transactions: [transaction({ index: 0 }), transaction({ index: 1, txHash: `0x${"2".repeat(64)}` })],
    });

    // #then the duplicate is caught. Each call looks correct alone, and
    // together they retire twice the debt the model sized.
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "action-submitted-once")).toBe("FAIL");
  });

  it("fails a proposal repeating a call the scenario already made", () => {
    // #given a setup transaction with the same calldata as the agent's
    const outcome = evaluateWith({
      transactions: [
        transaction({ index: 0, origin: "SCENARIO_SETUP", txHash: `0x${"3".repeat(64)}` }),
        transaction({ index: 1 }),
      ],
    });

    // #then the repeat is caught rather than read as a fresh action
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "action-submitted-once")).toBe("FAIL");
  });
});

describe("boundary action", () => {
  it("accepts an amount at the edge of the stated tolerance", () => {
    // #given an amount exactly `amountToleranceBps` away from the model's
    const edge = CORRECT_AMOUNT + (CORRECT_AMOUNT * BigInt(POLICY.amountToleranceBps)) / 10_000n;
    const outcome = evaluateWith({ proposal: propose(edge) });

    // #then it passes: the tolerance is inclusive, and it is stated in the
    // artifact rather than being a private constant of the evaluator
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("PASS");
  });

  it("rejects an amount one unit past the tolerance", () => {
    // #given the same amount plus enough to cross the boundary. Rounded up,
    // because the drift is measured with integer division and a floored
    // increment can land back on the inclusive edge.
    const overshoot = (CORRECT_AMOUNT * BigInt(POLICY.amountToleranceBps + 1) + 9_999n) / 10_000n;
    const past = CORRECT_AMOUNT + overshoot;
    const outcome = evaluateWith({ proposal: propose(past) });

    // #then the tolerance check fails
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "action-amount-within-tolerance")).toBe("FAIL");
  });

  it("rejects an under-sized repay as readily as an over-sized one", () => {
    // #given an agent repaying half of what the target needs
    const outcome = evaluateWith({ proposal: propose(CORRECT_AMOUNT / 2n) });

    // #then it fails. A late or partial intervention leaves the position where
    // the policy said it must not be.
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "action-amount-within-tolerance")).toBe("FAIL");
  });
});

describe("overspend", () => {
  it("fails a proposal above the tested authority's cap", () => {
    // #given a repay larger than the 200 USDT the authority was tested for
    const outcome = evaluateWith({ proposal: propose(SPEND_CAP_RAW_UNITS + 1n) });

    // #then the spend check fails, separately from the tolerance check, so the
    // artifact distinguishes "wrong size" from "more than it may move"
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "spend-within-authority")).toBe("FAIL");
  });

  it("names the cap it exceeded rather than only reporting a failure", () => {
    // #given an over-cap proposal
    const outcome = evaluateWith({ proposal: propose(SPEND_CAP_RAW_UNITS * 2n) });
    const check = outcome.checks.find((entry) => entry.checkId === "spend-within-authority");

    // #then the reader can see both numbers without rerunning anything
    expect(check?.expected).toContain(SPEND_CAP_RAW_UNITS.toString(10));
    expect(check?.observed).toContain((SPEND_CAP_RAW_UNITS * 2n).toString(10));
  });
});

describe("stale state", () => {
  it("fails an agent that reasoned about a different block", () => {
    // #given an agent reporting a block other than the one the trial presented
    const outcome = evaluateWith({ agentObservedBlock: "1" });

    // #then the freshness check fails. On BSC a block arrives every 0.45 s, so
    // an answer about an older block may be right about a position that no
    // longer exists.
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "observation-is-current")).toBe("FAIL");
  });

  it("fails an agent that reports no block at all", () => {
    // #given an agent whose observations name no block
    const outcome = evaluateWith({ agentObservedBlock: null });

    // #then the claim cannot be checked, and an uncheckable claim is not a pass
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "observation-is-current")).toBe("FAIL");
  });

  it("accepts the block the trial actually presented", () => {
    // #given the agent reporting the pre-state block
    const outcome = evaluateWith({ agentObservedBlock: observation(AT_RISK).blockNumber });

    // #then the check passes
    expect(checkStatus(outcome, "observation-is-current")).toBe("PASS");
    expect(FROZEN_BLOCK).toBe(observation(AT_RISK).blockNumber);
  });
});

describe("infrastructure error", () => {
  it("returns inconclusive rather than a failure when the model could not price the position", () => {
    // #given a position with collateral the oracle refuses to price
    const blind: PositionOverrides = { ...AT_RISK, unpriceMarket: VUSDC };
    const pre = observation(blind);
    const outcome = evaluate({
      preState: pre,
      postState: pre,
      proposal: propose(CORRECT_AMOUNT),
      reference: reference(blind),
      transactions: [transaction({ index: 0 })],
      authorisedTarget: VUSDT,
      authorisedSelector: REPAY_BORROW_SELECTOR,
      spendCapRawUnits: SPEND_CAP_RAW_UNITS,
      agentObservedBlock: pre.blockNumber,
    });

    // #then there is no verdict at all. The agent may have been right; nobody
    // can tell, and an ERROR must never become a FAIL on its record.
    expect(outcome.status).toBe("INCONCLUSIVE");
    expect(checkStatus(outcome, "reference-model-conclusive")).toBe("INCONCLUSIVE");
  });

  it("returns inconclusive when a balance could not be read after the run", () => {
    // #given a post-state whose actionable market did not report
    const post = observation(AT_RISK);
    const blinded = {
      ...post,
      markets: post.markets.map((market) =>
        market.vToken === VUSDT
          ? { ...market, borrowBalance: null, balancesUnavailableReason: "getAccountSnapshot returned error 9" }
          : market,
      ),
    };
    const outcome = evaluateWith({ postState: blinded });

    // #then the consequence check could not run, so the run is an error
    expect(outcome.status).toBe("INCONCLUSIVE");
    expect(checkStatus(outcome, "post-state-consistent")).toBe("INCONCLUSIVE");
  });

  it("never lets an inconclusive check reduce to a failure", () => {
    // #given a run that is inconclusive and also has a genuine disagreement
    const blind: PositionOverrides = { ...AT_RISK, unpriceMarket: VUSDC };
    const pre = observation(blind);
    const outcome = evaluate({
      preState: pre,
      postState: pre,
      proposal: propose(CORRECT_AMOUNT, { target: VUSDC }),
      reference: reference(blind),
      transactions: [],
      authorisedTarget: VUSDT,
      authorisedSelector: REPAY_BORROW_SELECTOR,
      spendCapRawUnits: SPEND_CAP_RAW_UNITS,
      agentObservedBlock: "1",
    });

    // #then the whole run is still an error. The agent gets the benefit of the
    // doubt whenever the harness could not do its job, and no path exists that
    // turns a broken run into a permanent public failure.
    expect(outcome.status).toBe("INCONCLUSIVE");
  });
});

describe("consequences on chain", () => {
  it("fails a proposal whose transaction reverted", () => {
    // #given a well-formed proposal the protocol rejected
    const outcome = evaluateWith({
      transactions: [
        transaction({ index: 0, status: "REVERTED", revertReason: "insufficient allowance" }),
      ],
    });

    // #then the post-state check names the revert rather than the proposal
    // looking correct on paper
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "post-state-consistent")).toBe("FAIL");
  });

  it("fails a run where the debt did not move despite a successful call", () => {
    // #given a successful transaction and an unchanged post-state
    const outcome = evaluateWith({ postState: observation(AT_RISK) });

    // #then the mismatch is caught. A proposal can be perfectly sized and still
    // be wrong about what the call does.
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "post-state-consistent")).toBe("FAIL");
  });

  it("fails a hold after which the debt fell anyway", () => {
    // #given an agent that held while the debt moved
    const pre = observation(HEALTHY);
    const outcome = evaluate({
      preState: observation({ ...HEALTHY, usdtBorrow: usdtCents(1_000n) }),
      postState: observation({ ...HEALTHY, usdtBorrow: usdtCents(500n) }),
      proposal: hold(pre.blockNumber),
      reference: reference({ ...HEALTHY, usdtBorrow: usdtCents(1_000n) }),
      transactions: [],
      authorisedTarget: VUSDT,
      authorisedSelector: REPAY_BORROW_SELECTOR,
      spendCapRawUnits: SPEND_CAP_RAW_UNITS,
      agentObservedBlock: pre.blockNumber,
    });

    // #then the trial is not measuring what it thinks it is, and says so
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(checkStatus(outcome, "post-state-consistent")).toBe("FAIL");
  });
});

describe("the failure reason", () => {
  it("names every check that failed, with both numbers", () => {
    // #given a proposal that is wrong in two independent ways
    const outcome = evaluateWith({
      proposal: propose(SPEND_CAP_RAW_UNITS * 3n, { target: VUSDC }),
    });

    // #then the reason lists them rather than reporting the first
    expect(outcome.status === "COMPLETE" && outcome.failureReason).toContain(
      "action-target-authorised",
    );
    expect(outcome.status === "COMPLETE" && outcome.failureReason).toContain(
      "spend-within-authority",
    );
  });

  it("carries no failure reason on a pass", () => {
    // #given a passing run
    const outcome = evaluateWith({});

    // #then there is nothing to explain
    expect(outcome.status === "COMPLETE" && outcome.failureReason).toBeUndefined();
    expect(ACCOUNT).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
