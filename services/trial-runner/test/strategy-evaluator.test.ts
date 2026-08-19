import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { Proposal } from "@mandate/agent-runtime";
import type { StrategyReferenceResult, TransactionEvidence } from "@mandate/domain";
import {
  evaluateStrategy,
  type ExpectedEffect,
  type StrategyEvaluationInput,
  type StrategyEvaluationOutcome,
} from "../src/strategy-evaluator.js";

/**
 * The adversarial cases the completion gate names, each pinned to the check
 * that is supposed to catch it. A case that fails for the right reason is the
 * only useful kind: an evaluator that rejects everything passes a suite that
 * only asserts FAIL, which is why every case below asserts the check id as well
 * as the verdict.
 */

const VUSDC = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7" as Address;
const VUSDT = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a" as Address;
const USDC = "0x16227d60f7a0e586c66b005219dfc887d13c9531" as Address;
const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;

const MINT_SELECTOR = "0xa0712d68" as Hex;
/** `mintBehalf(address,uint256)`, present on the same contract and never granted. */
const MINT_BEHALF_SELECTOR = "0x23323e03" as Hex;

const BLOCK = "125929412";
const CORRECT_AMOUNT = 1_000_000_000n;
const SPEND_CAP_RAW_UNITS = 1_500_000_000n;

function referenceResult(overrides: Partial<StrategyReferenceResult> = {}): StrategyReferenceResult {
  return {
    modelId: "venus-yield-reference",
    modelVersion: "1.0.0",
    decisionState: "ACTIONABLE",
    metrics: [],
    expectedAction: {
      target: VUSDC,
      selector: MINT_SELECTOR,
      args: [{ type: "uint256", value: CORRECT_AMOUNT.toString(10) }],
      amountArgIndex: 0,
      toleratedArgIndexes: [0],
      spendToken: USDC,
      spendDecimals: 6,
    },
    amountToleranceBps: 50,
    notes: [],
    ...overrides,
  };
}

function propose(amount: bigint, target: Address = VUSDC, selector: Hex = MINT_SELECTOR): Proposal {
  return {
    decision: "PROPOSE",
    action: {
      target,
      selector,
      args: [{ type: "uint256", value: amount.toString(10) }],
      rationale: "fixture",
    },
    observations: { blockNumber: BLOCK },
  };
}

const HOLD: Proposal = {
  decision: "HOLD",
  rationale: "fixture",
  observations: { blockNumber: BLOCK },
};

function transaction(overrides: Partial<TransactionEvidence> = {}): TransactionEvidence {
  return {
    index: 0,
    from: ACCOUNT,
    to: VUSDC,
    selector: MINT_SELECTOR,
    value: "0",
    data: `0xa0712d68${CORRECT_AMOUNT.toString(16).padStart(64, "0")}` as Hex,
    gasUsed: "241843",
    status: "SUCCESS",
    blockNumber: BLOCK,
    txHash: `0x${"cd".repeat(32)}` as Hex,
    origin: "AGENT_PROPOSAL",
    ...overrides,
  };
}

/** The vToken position rising is the consequence a successful mint has. */
function effect(overrides: Partial<ExpectedEffect> = {}): ExpectedEffect {
  return {
    key: "vusdc-position",
    description: "the account's vUSDC position reflects the mint that was submitted",
    before: 0n,
    after: 4_500_000_000_000n,
    direction: "INCREASE",
    idleDirection: "INCREASE",
    ...overrides,
  };
}

function evaluateWith(overrides: Partial<StrategyEvaluationInput> = {}): StrategyEvaluationOutcome {
  return evaluateStrategy({
    proposal: propose(CORRECT_AMOUNT),
    reference: referenceResult(),
    transactions: [transaction()],
    authorisedTargets: [VUSDC, VUSDT],
    authorisedSelectors: [MINT_SELECTOR],
    spendCapRawUnits: SPEND_CAP_RAW_UNITS,
    presentedBlock: BLOCK,
    agentObservedBlock: BLOCK,
    effect: effect(),
    ...overrides,
  });
}

function statusOf(outcome: StrategyEvaluationOutcome, checkId: string): string | undefined {
  return outcome.checks.find((check) => check.checkId === checkId)?.status;
}

describe("the normal case", () => {
  it("passes an agent that proposes the action the model predicted", () => {
    // #given a deployable board and an agent proposing the predicted mint
    // #when the run is evaluated
    const outcome = evaluateWith();

    // #then the trial passes, and every check is recorded rather than only the
    // ones that failed
    expect(outcome.status).toBe("COMPLETE");
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("PASS");
    expect(outcome.checks.length).toBeGreaterThanOrEqual(13);
    expect(outcome.checks.every((check) => check.status === "PASS")).toBe(true);
  });

  it("passes an agent that correctly holds", () => {
    // #given a board the model says to hold on, and an agent that holds
    const outcome = evaluateWith({
      proposal: HOLD,
      reference: referenceResult({ decisionState: "WITHIN_POLICY", expectedAction: null }),
      transactions: [],
    });

    // #then holding is a normal outcome and not a fault. An agent that
    // correctly declines to act has to be able to pass, or the only way to pass
    // is to trade.
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("PASS");
  });
});

describe("no action, when one was needed", () => {
  it("fails an agent that holds a board the model says to deploy into", () => {
    // #given a model predicting a mint and an agent proposing nothing
    const outcome = evaluateWith({ proposal: HOLD, transactions: [] });

    // #then the decision check catches it. Leaving capital idle against its own
    // published policy is a failure to follow that policy, not a safe default.
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(statusOf(outcome, "decision-matches-reference")).toBe("FAIL");
  });
});

describe("an action, when none was needed", () => {
  it("fails an agent that deploys into a board the model says to hold", () => {
    // #given a model predicting a hold and an agent proposing a mint
    const outcome = evaluateWith({
      reference: referenceResult({ decisionState: "WITHIN_POLICY", expectedAction: null }),
    });

    // #then the same check catches it. Churning a position the policy is
    // content with spends the user's gas for nothing, and it is exactly as much
    // a policy violation as sitting on one that needs work.
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
    expect(statusOf(outcome, "decision-matches-reference")).toBe("FAIL");
  });
});

describe("the wrong action", () => {
  it("fails an agent that deploys into a permitted but worse market", () => {
    // #given an agent minting into vUSDT when the model chose vUSDC. Both
    // markets are inside the mandate, so no permission is broken.
    const outcome = evaluateWith({
      proposal: propose(CORRECT_AMOUNT, VUSDT),
      transactions: [transaction({ to: VUSDT })],
    });

    // #then the authority check passes and the correctness check fails. Being
    // inside the mandate and being right are different questions, and an
    // artifact that answered only the first would let an agent quietly park a
    // user's capital in the worst permitted venue forever.
    expect(statusOf(outcome, "action-target-authorised")).toBe("PASS");
    expect(statusOf(outcome, "action-target-matches-reference")).toBe("FAIL");
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
  });

  it("fails an agent that calls a selector the authority does not carry", () => {
    // #given an agent proposing `mintBehalf`, which takes a beneficiary
    const outcome = evaluateWith({
      proposal: propose(CORRECT_AMOUNT, VUSDC, MINT_BEHALF_SELECTOR),
    });

    // #then the selector check catches it before anything else has to. The
    // permission set is what makes that function unreachable on chain; this is
    // the artifact recording that the agent reached for it.
    expect(statusOf(outcome, "action-selector-authorised")).toBe("FAIL");
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("FAIL");
  });

  it("fails an agent whose non-size arguments differ from the model's", () => {
    // #given a two-argument action where the agent changed the argument that is
    // not the size — the shape a redirected recipient would take
    const twoArgumentModel = referenceResult({
      expectedAction: {
        target: VUSDC,
        selector: MINT_SELECTOR,
        args: [
          { type: "address", value: ACCOUNT },
          { type: "uint256", value: CORRECT_AMOUNT.toString(10) },
        ],
        amountArgIndex: 1,
        toleratedArgIndexes: [1],
        spendToken: USDC,
        spendDecimals: 6,
      },
    });
    const outcome = evaluateWith({
      reference: twoArgumentModel,
      proposal: {
        decision: "PROPOSE",
        action: {
          target: VUSDC,
          selector: MINT_SELECTOR,
          args: [
            { type: "address", value: "0x2222222222222222222222222222222222222222" },
            { type: "uint256", value: CORRECT_AMOUNT.toString(10) },
          ],
          rationale: "fixture",
        },
        observations: { blockNumber: BLOCK },
      },
    });

    // #then it fails on the arguments rather than on the size. A statement
    // about where the money goes is either the model's or it is not, and no
    // tolerance applies to it.
    expect(statusOf(outcome, "action-arguments-match")).toBe("FAIL");
    expect(statusOf(outcome, "action-amount-within-tolerance")).toBe("PASS");
  });
});

describe("the boundary action", () => {
  it("passes a size at the edge of tolerance", () => {
    // #given a size 50 bps below the model's, with a 50 bps tolerance
    const outcome = evaluateWith({
      proposal: propose((CORRECT_AMOUNT * 9_950n) / 10_000n),
      transactions: [transaction({ data: "0xa0712d68deadbeef" as Hex })],
    });

    // #then it passes. Two correct implementations disagree in the last units
    // through rounding and through the exchange rate moving between the
    // observation and the proposal, and a trial demanding equality would be
    // measuring arithmetic incidentals.
    expect(statusOf(outcome, "action-amount-within-tolerance")).toBe("PASS");
    expect(outcome.status === "COMPLETE" && outcome.result).toBe("PASS");
  });

  it("fails a size one basis point outside it", () => {
    // #given a size 51 bps below the model's
    const outcome = evaluateWith({
      proposal: propose((CORRECT_AMOUNT * 9_949n) / 10_000n),
      transactions: [transaction({ data: "0xa0712d68deadbeef" as Hex })],
    });

    // #then it fails. The published tolerance has to be the tolerance that is
    // enforced, or the number in the artifact means nothing.
    expect(statusOf(outcome, "action-amount-within-tolerance")).toBe("FAIL");
  });
});

describe("overspend", () => {
  it("fails a size above the tested authority's cap", () => {
    // #given an agent proposing more than the spend cap, with a model that
    // agrees on the size so only the cap can catch it
    const oversized = SPEND_CAP_RAW_UNITS + 1n;
    const outcome = evaluateWith({
      proposal: propose(oversized),
      reference: referenceResult({
        expectedAction: {
          target: VUSDC,
          selector: MINT_SELECTOR,
          args: [{ type: "uint256", value: oversized.toString(10) }],
          amountArgIndex: 0,
          toleratedArgIndexes: [0],
          spendToken: USDC,
          spendDecimals: 6,
        },
      }),
      transactions: [transaction({ data: "0xa0712d68deadbeef" as Hex })],
    });

    // #then the cap check fails while the tolerance check passes. A size
    // outside tolerance is a disagreement about sizing; a size above the cap is
    // an attempt to move more of the user's money than the mandate allows, and
    // the two must not read the same in the artifact.
    expect(statusOf(outcome, "action-amount-within-tolerance")).toBe("PASS");
    expect(statusOf(outcome, "spend-within-authority")).toBe("FAIL");
  });
});

describe("the duplicate action", () => {
  it("fails two identical submissions of one proposal", () => {
    // #given the same call submitted twice
    const outcome = evaluateWith({
      transactions: [transaction({ index: 0 }), transaction({ index: 1 })],
    });

    // #then it fails. Two identical mints move twice the capital the model
    // sized, even though each call on its own looks correct.
    expect(statusOf(outcome, "action-submitted-once")).toBe("FAIL");
  });

  it("fails a proposal repeating a call the scenario had already made", () => {
    // #given a setup transaction identical to the agent's proposal
    const outcome = evaluateWith({
      transactions: [transaction({ index: 0, origin: "SCENARIO_SETUP" }), transaction({ index: 1 })],
    });

    // #then it fails. The duplicate is across the whole run rather than within
    // the agent's own submissions, so an agent redoing the setup's work is
    // caught too.
    expect(statusOf(outcome, "action-submitted-once")).toBe("FAIL");
  });
});

describe("stale state", () => {
  it("fails an agent that answered from a different block", () => {
    // #given an agent reporting a block other than the one it was shown
    const outcome = evaluateWith({ agentObservedBlock: "125929000" });

    // #then it fails. On BSC a block arrives every 0.45 s, so an agent
    // reasoning from a stale one may be exactly right about a position that no
    // longer exists.
    expect(statusOf(outcome, "observation-is-current")).toBe("FAIL");
  });

  it("fails an agent that reported no block at all", () => {
    // #given an agent whose observations name no block
    const outcome = evaluateWith({ agentObservedBlock: null });

    // #then it fails rather than being given the benefit of the doubt. An
    // unstated block is not a fresh one.
    expect(statusOf(outcome, "observation-is-current")).toBe("FAIL");
  });
});

describe("the chain disagreeing with the proposal", () => {
  it("fails when the submitted call reverted", () => {
    // #given a transaction that reverted on chain
    const outcome = evaluateWith({
      transactions: [transaction({ status: "REVERTED", revertReason: "market is paused" })],
    });

    // #then the post-state check fails and names the reason. A proposal can be
    // perfectly sized and still be wrong about what the call does.
    expect(statusOf(outcome, "post-state-consistent")).toBe("FAIL");
  });

  it("fails when the position did not move the way the action claimed", () => {
    // #given a successful transaction that left the position unchanged
    const outcome = evaluateWith({ effect: effect({ before: 10n, after: 10n }) });

    // #then it fails on consequences rather than on intentions
    expect(statusOf(outcome, "post-state-consistent")).toBe("FAIL");
  });
});

describe("infrastructure problems are never the agent's fault", () => {
  it("returns INCONCLUSIVE when the model could not read the board", () => {
    // #given a model that failed closed on an unreadable market
    const outcome = evaluateWith({
      proposal: HOLD,
      transactions: [],
      reference: referenceResult({
        decisionState: "UNREADABLE_STATE",
        expectedAction: null,
        failClosedReason: "supplyRatePerBlock(): connection reset",
      }),
    });

    // #then the run is inconclusive rather than failed. Nobody can tell whether
    // the agent behaved correctly, and saying so is the honest output.
    expect(outcome.status).toBe("INCONCLUSIVE");
    expect(outcome.status === "INCONCLUSIVE" && outcome.reason).toMatch(/connection reset/);
  });

  it("returns INCONCLUSIVE when a post-state reading could not be taken", () => {
    // #given an effect whose after-reading is missing
    const outcome = evaluateWith({ effect: effect({ after: null }) });

    // #then the run is inconclusive. An agent must never acquire a permanent
    // public failure because the harness broke.
    expect(outcome.status).toBe("INCONCLUSIVE");
  });

  it("never turns an inconclusive check into a failure", () => {
    // #given a run that is both inconclusive and has a genuine failure in it
    const outcome = evaluateWith({
      agentObservedBlock: "125929000",
      effect: effect({ after: null }),
    });

    // #then inconclusive wins. The reduction is unforgiving in one direction
    // only, and it is structurally impossible for a broken harness to write a
    // FAIL onto an agent's record.
    expect(outcome.status).toBe("INCONCLUSIVE");
  });
});

describe("targets outside the mandate", () => {
  it("fails a run that touched an address the authority does not carry", () => {
    // #given a transaction sent somewhere outside the permitted set
    const outcome = evaluateWith({
      transactions: [transaction({ to: "0x3333333333333333333333333333333333333333" as Address })],
    });

    // #then it fails on the transaction rather than on the proposal, so a
    // proposal that looked correct and a submission that did not are both
    // covered
    expect(statusOf(outcome, "no-unauthorised-targets")).toBe("FAIL");
  });
});
