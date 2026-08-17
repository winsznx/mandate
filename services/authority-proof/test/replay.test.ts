import { describe, expect, it } from "vitest";
import { replayTrialVerdict, type ReplayableEvidence } from "../src/phase7/replay.js";

const VUSDT = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a";

function evidence(overrides: {
  checks?: ReplayableEvidence["evaluator"]["checks"];
  expectedAmount?: string | null;
  preBorrow?: string | null;
  postBorrow?: string | null;
  toleranceBps?: number;
}): ReplayableEvidence {
  return {
    evaluator: {
      checks: overrides.checks ?? [
        { checkId: "action-target-authorised", status: "PASS" },
        { checkId: "spend-within-authority", status: "PASS" },
      ],
    },
    reference: {
      inputs: { actionableMarket: VUSDT },
      output: {
        expectedAction:
          overrides.expectedAmount === null
            ? null
            : { amount: overrides.expectedAmount ?? "18000000" },
        amountToleranceBps: overrides.toleranceBps ?? 50,
      },
    },
    observations: {
      preState: {
        markets: [
          {
            vToken: VUSDT,
            borrowBalance: overrides.preBorrow === undefined ? "243200000" : overrides.preBorrow,
          },
        ],
      },
      postState: {
        markets: [
          {
            vToken: VUSDT,
            borrowBalance: overrides.postBorrow === undefined ? "225200000" : overrides.postBorrow,
          },
        ],
      },
    },
  };
}

describe("recomputing the verdict", () => {
  it("derives PASS when every check passed and the debt moved by the expected amount", () => {
    // #given a run whose evidence supports its own conclusion
    const replay = replayTrialVerdict(evidence({}));

    // #then the verdict is recomputed rather than read
    expect(replay.derived).toBe("PASS");
    expect(replay.failedCheckIds).toHaveLength(0);
  });

  it("derives FAIL when any check did not pass", () => {
    // #given one failing check
    const replay = replayTrialVerdict(
      evidence({
        checks: [
          { checkId: "action-target-authorised", status: "PASS" },
          { checkId: "post-state-consistent", status: "FAIL" },
        ],
      }),
    );

    // #then the verdict follows the checks, and names the one that failed
    expect(replay.derived).toBe("FAIL");
    expect(replay.failedCheckIds).toEqual(["post-state-consistent"]);
  });

  it("refuses to count a check that passed but could not run", () => {
    // #given a check marked PASS while carrying an inconclusive reason, which
    // the schema permits and a verdict must not
    const replay = replayTrialVerdict(
      evidence({
        checks: [
          {
            checkId: "reference-model-conclusive",
            status: "PASS",
            inconclusiveReason: "the model failed closed on unpriced exposure",
          },
        ],
      }),
    );

    // #then the run does not get credit for it
    expect(replay.derived).toBe("FAIL");
    expect(replay.inconclusiveCheckIds).toEqual(["reference-model-conclusive"]);
  });

  it("derives FAIL when the debt never moved despite an expected repayment", () => {
    // #given a model that expected a repayment and a position that is unchanged
    const replay = replayTrialVerdict(evidence({ postBorrow: "243200000" }));

    // #then the artifact's claim is not supported by its own observations
    expect(replay.derived).toBe("FAIL");
    expect(replay.reasons.join(" ")).toContain("expected a repayment");
  });

  it("derives FAIL when the debt moved by the wrong amount", () => {
    // #given a repayment 10% smaller than the model sized
    const replay = replayTrialVerdict(evidence({ postBorrow: "227000000" }));

    // #then the drift is reported against the disclosed tolerance rather than
    // waved through
    expect(replay.derived).toBe("FAIL");
    expect(replay.reasons.join(" ")).toContain("outside 50 bps");
  });

  it("accepts a hold, where the model expected nothing to happen", () => {
    // #given a healthy position and a model that expected no action
    const replay = replayTrialVerdict(
      evidence({ expectedAmount: null, postBorrow: "243200001" }),
    );

    // #then a run with no transaction still supports its verdict
    expect(replay.derived).toBe("PASS");
    expect(replay.reasons.join(" ")).toContain("expected no action");
  });

  it("derives FAIL when a borrow balance could not be read", () => {
    // #given an observation where the market's balance is null
    const replay = replayTrialVerdict(evidence({ postBorrow: null }));

    // #then the comparison is not silently skipped
    expect(replay.derived).toBe("FAIL");
    expect(replay.reasons.join(" ")).toContain("unreadable");
  });
});
