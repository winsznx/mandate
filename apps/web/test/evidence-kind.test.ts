/**
 * The distinction the product rests on.
 *
 * `claims/ledger.json` records `rejection-produces-no-transaction` as
 * NOT_CLAIMED_AS_TRANSACTION, with the limitation "MANDATE must NOT claim to
 * show reverted transactions for blocked actions". These tests are that
 * limitation, executable: an intent the account refused before broadcast must
 * never acquire a transaction hash, must never produce an explorer link, and
 * must never be silently invented when the record does not say what refused it.
 */
import { describe, expect, it } from "vitest";
import {
  allowanceRuledOut,
  classifyExecutionRecord,
  decodedReason,
  explorerUrlFor,
  isExecuted,
  isRejectedIntent,
  partitionEvidence,
  spendArithmetic,
} from "../src/proof/evidence-kind";
import type { ProofEvidence, RejectionContext } from "../src/proof/evidence-kind";

const REPAY_TX = "0x55025a1f99122b979359274b3c41311e1892299f5af1c89d2e1dffdee4324c94";
const VUSDT = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a";
const OTHER_VTOKEN = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7";

/** The context the featured run supplies for its three refusal steps. */
const CONTEXT: RejectionContext = {
  validatorErrorByStep: {
    "cap-breach-attempt": "ExceededSpendLimit",
    "wrong-target-attempt": "UnauthorizedCall",
    "post-revoke-execution-fails": "KeyDoesNotExist",
  },
  mechanismByStep: {
    "cap-breach-attempt": "SPEND_CAP",
    "wrong-target-attempt": "OUT_OF_SCOPE_CALL",
    "post-revoke-execution-fails": "SESSION_INVALID",
  },
  accountStateByStep: {
    "cap-breach-attempt": {
      spendCapRaw: "25000000",
      spentInBucketRaw: "20000000",
      allowanceAtAttemptRaw: "155000000",
      keyRegistered: true,
      callPermitted: true,
    },
    "wrong-target-attempt": { callPermitted: false, keyRegistered: true },
    "post-revoke-execution-fails": { keyRegistered: false },
  },
};

describe("classifyExecutionRecord", () => {
  it("classifies a confirmed action as executed evidence and keeps its transaction", () => {
    const result = classifyExecutionRecord(
      {
        step: "execute-repay",
        label: "repay 20000000 raw USDT, inside the granted scope",
        status: "SUCCESS",
        target: VUSDT,
        selector: "0x0e752702",
        amountRaw: "20000000",
        txHash: REPAY_TX,
      },
      CONTEXT,
    );

    expect(result.kind).toBe("EXECUTED");
    if (result.kind !== "EXECUTED") return;
    expect(result.txHash).toBe(REPAY_TX);
    expect(result.outcome).toBe("CONFIRMED");
    expect(explorerUrlFor(result)).toBe(`https://testnet.bscscan.com/tx/${REPAY_TX}`);
  });

  it("classifies a refusal with no transaction as a rejected intent", () => {
    const result = classifyExecutionRecord(
      {
        step: "cap-breach-attempt",
        label: "repay 6000000 raw USDT, taking the bucket past its 25000000 cap",
        status: "REVERTED",
        target: VUSDT,
        selector: "0x0e752702",
        amountRaw: "6000000",
      },
      CONTEXT,
    );

    expect(result.kind).toBe("REJECTED_INTENT");
    if (result.kind !== "REJECTED_INTENT") return;
    expect(result.validatorError).toBe("ExceededSpendLimit");
    expect(result.mechanism).toBe("SPEND_CAP");
  });

  it("never produces an explorer link for a rejected intent", () => {
    const result = classifyExecutionRecord(
      {
        step: "wrong-target-attempt",
        label: "the granted selector on a vToken outside the permission set",
        status: "REVERTED",
        target: OTHER_VTOKEN,
        selector: "0x0e752702",
      },
      CONTEXT,
    );

    expect(result.kind).toBe("REJECTED_INTENT");
    expect(explorerUrlFor(result as ProofEvidence)).toBeUndefined();
  });

  it("gives a rejected intent no field a transaction hash could occupy", () => {
    const result = classifyExecutionRecord(
      {
        step: "post-revoke-execution-fails",
        label: "a previously permitted repayment, after revocation",
        status: "REVERTED",
        target: VUSDT,
        selector: "0x0e752702",
        amountRaw: "1",
      },
      CONTEXT,
    );

    expect(Object.keys(result)).not.toContain("txHash");
    expect(JSON.stringify(result)).not.toContain("0x55025a1f");
  });

  it("keeps a genuine reverted transaction on the executed side, because it has one", () => {
    const result = classifyExecutionRecord(
      {
        step: "some-onchain-revert",
        label: "a call that reached execution and reverted there",
        status: "REVERTED",
        target: VUSDT,
        selector: "0x0e752702",
        txHash: REPAY_TX,
      },
      CONTEXT,
    );

    expect(result.kind).toBe("EXECUTED");
    if (result.kind !== "EXECUTED") return;
    expect(result.outcome).toBe("REVERTED");
    expect(explorerUrlFor(result)).toContain(REPAY_TX);
  });

  it("refuses to invent a mechanism when the record does not state one", () => {
    const result = classifyExecutionRecord(
      {
        step: "an-unrecognised-step",
        label: "something the run log does not explain",
        status: "REVERTED",
        target: VUSDT,
        selector: "0x0e752702",
      },
      CONTEXT,
    );

    expect(result.kind).toBe("MALFORMED");
    if (result.kind !== "MALFORMED") return;
    expect(result.reason).toContain("states no validator error");
  });

  it("reports a success with no transaction as malformed rather than rendering it", () => {
    const result = classifyExecutionRecord(
      {
        step: "execute-repay",
        label: "a success the log gave no transaction for",
        status: "SUCCESS",
        target: VUSDT,
        selector: "0x0e752702",
      },
      CONTEXT,
    );

    expect(result.kind).toBe("MALFORMED");
  });
});

describe("rejection evidence", () => {
  const capBreach = classifyExecutionRecord(
    {
      step: "cap-breach-attempt",
      label: "repay 6000000 raw USDT, taking the bucket past its 25000000 cap",
      status: "REVERTED",
      target: VUSDT,
      selector: "0x0e752702",
      amountRaw: "6000000",
    },
    CONTEXT,
  );

  it("shows the arithmetic a reader would do by hand", () => {
    expect(isRejectedIntent(capBreach as ProofEvidence)).toBe(true);
    if (capBreach.kind !== "REJECTED_INTENT") return;

    expect(spendArithmetic(capBreach)).toEqual({
      capRaw: "25000000",
      spentRaw: "20000000",
      requestedRaw: "6000000",
      wouldTotalRaw: "26000000",
      overByRaw: "1000000",
    });
  });

  it("rules the ERC-20 allowance out as the binding constraint", () => {
    if (capBreach.kind !== "REJECTED_INTENT") return;
    expect(allowanceRuledOut(capBreach)).toBe(true);
  });

  it("says nothing about the allowance when the record does not carry one", () => {
    const outOfScope = classifyExecutionRecord(
      {
        step: "wrong-target-attempt",
        label: "a selector outside the permission set",
        status: "REVERTED",
        target: VUSDT,
        selector: "0xc5ebeaec",
      },
      CONTEXT,
    );
    if (outOfScope.kind !== "REJECTED_INTENT") return;
    expect(allowanceRuledOut(outOfScope)).toBeUndefined();
    expect(spendArithmetic(outOfScope)).toBeUndefined();
  });

  it("explains each mechanism without describing it as a revert", () => {
    for (const mechanism of ["SPEND_CAP", "OUT_OF_SCOPE_CALL", "SESSION_INVALID"] as const) {
      const reason = decodedReason({
        kind: "REJECTED_INTENT",
        label: "x",
        target: VUSDT,
        selector: "0x0e752702",
        validatorError: "UnauthorizedCall",
        mechanism,
        accountState: {},
        provenance: "RUN_RECORD",
      });
      expect(reason).toContain("refused to produce a transaction");
      expect(reason.toLowerCase()).not.toContain("revert");
    }
  });
});

describe("partitionEvidence", () => {
  it("keeps the two kinds in separate collections and surfaces malformed records", () => {
    const records = [
      { step: "execute-repay", label: "a", status: "SUCCESS", target: VUSDT, selector: "0x0e752702", txHash: REPAY_TX },
      { step: "cap-breach-attempt", label: "b", status: "REVERTED", target: VUSDT, selector: "0x0e752702", amountRaw: "6000000" },
      { step: "unknown", label: "c", status: "REVERTED", target: VUSDT, selector: "0x0e752702" },
    ];

    const { executed, rejected, malformed } = partitionEvidence(
      records.map((record) => classifyExecutionRecord(record, CONTEXT)),
    );

    expect(executed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(malformed).toHaveLength(1);
    expect(executed.every(isExecuted)).toBe(true);
    expect(rejected.every(isRejectedIntent)).toBe(true);
    expect(rejected.flatMap((item) => Object.keys(item))).not.toContain("txHash");
  });
});
