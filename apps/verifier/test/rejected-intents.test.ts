import { describe, expect, it } from "vitest";
import { stepRejectedIntents, type RejectedIntent } from "../src/steps-rejected.js";

/**
 * The refusals in MANDATE's finished proof never became transactions, so there
 * is no hash to fetch. These tests pin the only check that remains available:
 * the recorded account state must actually imply the mechanism claimed.
 */

const SPEND_CAP_REFUSAL: RejectedIntent = {
  label: "repay 6 USDT past the daily cap",
  validatorError: "ExceededSpendLimit",
  mechanism: "SPEND_CAP",
  amountRaw: "6000000",
  accountState: {
    callPermitted: true,
    keyRegistered: true,
    spendCapRaw: "25000000",
    spentInBucketRaw: "20000000",
    allowanceAtAttemptRaw: "155000000",
  },
};

describe("stepRejectedIntents", () => {
  it("passes when the account's own state implies the spend cap refused it", () => {
    // #given 20 already spent against a 25 cap, a 6 attempt, and an allowance
    // far larger than the amount
    // #when verified
    const step = stepRejectedIntents([SPEND_CAP_REFUSAL], true);

    // #then the claim is corroborated rather than taken on trust
    expect(step.status).toBe("PASS");
  });

  /**
   * The failure that most convincingly impersonates a spend-cap rejection. If
   * the allowance was smaller than the amount, the allowance stopped the call
   * and the demo proves a misconfiguration.
   */
  it("fails when the allowance, not the cap, was the binding constraint", () => {
    // #given an allowance below the attempted amount
    const intent: RejectedIntent = {
      ...SPEND_CAP_REFUSAL,
      accountState: { ...SPEND_CAP_REFUSAL.accountState, allowanceAtAttemptRaw: "1000000" },
    };

    // #when verified
    const step = stepRejectedIntents([intent], true);

    // #then the substitution is caught
    expect(step.status).toBe("FAIL");
    expect(step.reason).toContain("binding constraint");
  });

  it("fails when the attempt would have fit inside the cap", () => {
    // #given a claim that is arithmetically impossible
    const intent: RejectedIntent = {
      ...SPEND_CAP_REFUSAL,
      accountState: { ...SPEND_CAP_REFUSAL.accountState, spentInBucketRaw: "0" },
    };

    // #then the self-contradiction is reported
    expect(stepRejectedIntents([intent], true).status).toBe("FAIL");
  });

  it("skips when the allowance was not recorded, since it cannot be ruled out", () => {
    // #given a disclosure omitting the allowance
    const intent: RejectedIntent = {
      ...SPEND_CAP_REFUSAL,
      accountState: { ...SPEND_CAP_REFUSAL.accountState, allowanceAtAttemptRaw: undefined },
    };

    // #then the claim is unverifiable rather than accepted
    expect(stepRejectedIntents([intent], true).status).toBe("FAIL");
  });

  it("fails a spend-cap claim whose recorded error is a scope error", () => {
    const intent: RejectedIntent = { ...SPEND_CAP_REFUSAL, validatorError: "UnauthorizedCall" };
    expect(stepRejectedIntents([intent], true).status).toBe("FAIL");
  });

  it("passes an out-of-scope refusal the account agrees was not permitted", () => {
    const intent: RejectedIntent = {
      label: "repayBorrow on a vToken outside the permission set",
      validatorError: "UnauthorizedCall",
      mechanism: "OUT_OF_SCOPE_CALL",
      accountState: { callPermitted: false, keyRegistered: true },
    };
    expect(stepRejectedIntents([intent], true).status).toBe("PASS");
  });

  it("fails an out-of-scope claim the account says was permitted", () => {
    // #given a contradiction between the claim and the account's own view
    const intent: RejectedIntent = {
      label: "out of scope",
      validatorError: "UnauthorizedCall",
      mechanism: "OUT_OF_SCOPE_CALL",
      accountState: { callPermitted: true, keyRegistered: true },
    };
    expect(stepRejectedIntents([intent], true).status).toBe("FAIL");
  });

  it("skips rather than passing when no disclosure was supplied", () => {
    expect(stepRejectedIntents([], false).status).toBe("SKIP");
  });
});
