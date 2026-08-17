import { describe, expect, it } from "vitest";
import { encodeAbiParameters, toFunctionSelector } from "viem";
import type { Hex } from "viem";
import {
  attributeFromAccountView,
  judgeRejection,
  type AccountViewAtAttempt,
} from "../src/phase7/attribution.js";

/** The state of the account at the moment of the 6-unit breach attempt. */
function view(overrides: Partial<AccountViewAtAttempt> = {}): AccountViewAtAttempt {
  return {
    callPermitted: true,
    keyRegistered: true,
    spendLimitRaw: 25_000_000n,
    spentInBucketRaw: 20_000_000n,
    allowanceRaw: 155_000_000n,
    balanceRaw: 500_000_000n,
    amountRaw: 6_000_000n,
    ...overrides,
  };
}

const EXCEEDED_SPEND_LIMIT: Hex = `0x9054c912${encodeAbiParameters(
  [{ type: "address" }],
  ["0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c"],
).slice(2)}`;

const UNAUTHORIZED_CALL: Hex = "0xf78c1b53";

/** `Error(string)` carrying the message BEP20 returns when an allowance runs out. */
const ALLOWANCE_REVERT: Hex = `${toFunctionSelector("Error(string)")}${encodeAbiParameters(
  [{ type: "string" }],
  ["BEP20: transfer amount exceeds allowance"],
).slice(2)}` as Hex;

describe("predicting the mechanism from the account's own state", () => {
  it("names the spend cap when the call is permitted, funded and over the bucket total", () => {
    // #given 20 already spent against a cap of 25 and a 6-unit attempt
    const attribution = attributeFromAccountView(view());

    // #then the cap is the only ceiling left, and both the allowance and the
    // balance are ruled out by observation rather than by assumption
    expect(attribution.mechanism).toBe("SPEND_CAP");
    expect(attribution.allowanceRuledOut).toBe(true);
    expect(attribution.balanceRuledOut).toBe(true);
  });

  it("names the allowance when it would run out before the cap does", () => {
    // #given the misconfiguration: an allowance sized to the daily cap, so 5
    // remains after the first repayment
    const attribution = attributeFromAccountView(view({ allowanceRaw: 5_000_000n }));

    // #then the run says so rather than reporting a bounded mandate
    expect(attribution.mechanism).toBe("ALLOWANCE");
    expect(attribution.allowanceRuledOut).toBe(false);
  });

  it("names the permission set when the account itself says the call is out of scope", () => {
    // #given canExecute returning false
    const attribution = attributeFromAccountView(view({ callPermitted: false }));

    // #then no spend arithmetic is consulted, because the call never reaches it
    expect(attribution.mechanism).toBe("OUT_OF_SCOPE_CALL");
  });

  it("names the session when the key is gone", () => {
    // #given a revoked key
    // #then nothing the session submits can validate at all
    expect(attributeFromAccountView(view({ keyRegistered: false })).mechanism).toBe("SESSION_INVALID");
  });

  it("finds nothing to refuse a call that is inside every limit", () => {
    // #given an attempt that fits under the cap
    // #then the prediction is UNDETERMINED, which fails the rejection steps
    // rather than inventing a mechanism
    expect(attributeFromAccountView(view({ spentInBucketRaw: 0n })).mechanism).toBe("UNDETERMINED");
  });
});

describe("judging a rejection", () => {
  it("proves the cap breach when the revert and the account state agree", () => {
    // #given ExceededSpendLimit bytes recovered from the failed transaction
    const verdict = judgeRejection({
      expected: "SPEND_CAP",
      view: view(),
      revertData: EXCEEDED_SPEND_LIMIT,
    });

    // #then the step passes and names the error, not just the failure
    expect(verdict.proven).toBe(true);
    expect(verdict.decoded?.name).toBe("ExceededSpendLimit");
    expect(verdict.fromRevert).toBe("SPEND_CAP");
  });

  it("refuses to call an allowance failure a spend-cap rejection", () => {
    // #given a revert that is really the ERC-20 allowance running out
    const verdict = judgeRejection({
      expected: "SPEND_CAP",
      view: view({ allowanceRaw: 5_000_000n }),
      revertData: ALLOWANCE_REVERT,
    });

    // #then the observation beats any prediction and the step fails, because
    // this is the misconfiguration the whole demo is designed not to hide
    expect(verdict.proven).toBe(false);
    expect(verdict.fromRevert).toBe("ALLOWANCE");
    expect(verdict.decoded?.class).toBe("ALLOWANCE_INSUFFICIENT");
  });

  it("fails a cap step whose revert says the call was out of scope", () => {
    // #given UnauthorizedCall bytes where a spend-cap rejection was expected
    const verdict = judgeRejection({
      expected: "SPEND_CAP",
      view: view(),
      revertData: UNAUTHORIZED_CALL,
    });

    // #then the mismatch is reported rather than smoothed over; both are policy
    // rejections and they are not interchangeable evidence
    expect(verdict.proven).toBe(false);
    expect(verdict.observed).toContain("OUT_OF_SCOPE_CALL");
  });

  it("proves an out-of-scope rejection from UnauthorizedCall", () => {
    // #given a call the account's own view says is outside the permission set
    const verdict = judgeRejection({
      expected: "OUT_OF_SCOPE_CALL",
      view: view({ callPermitted: false }),
      revertData: UNAUTHORIZED_CALL,
    });

    // #then both directions agree
    expect(verdict.proven).toBe(true);
    expect(verdict.decoded?.name).toBe("UnauthorizedCall");
  });

  it("leaves a rejection unproven when no revert bytes could be recovered", () => {
    // #given a relayed failure whose revert data the chain never surfaced
    const verdict = judgeRejection({ expected: "SPEND_CAP", view: view() });

    // #then the prediction is recorded but the step does not pass on it. The
    // account view is strong evidence and it is still not the revert.
    expect(verdict.proven).toBe(false);
    expect(verdict.fromAccountView.mechanism).toBe("SPEND_CAP");
    expect(verdict.observed).toContain("no revert data");
  });
});
