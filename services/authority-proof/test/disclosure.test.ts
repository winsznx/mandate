/**
 * The refusals are the claim, so the shape they are published in is checked
 * against the schema a third-party verifier actually parses, not against a copy
 * of it. A disclosure that reads well and does not validate proves nothing.
 */
import { describe, expect, it } from "vitest";
import { RejectedIntentEvidenceSchema } from "@mandate/verifier";
import type { AuthorityIR } from "@mandate/domain";
import type { ExecutionRecord } from "../src/phase7/manifest.js";
import { disclosureDocument } from "../src/phase7/runner.js";

const WALLET = "0xdc5071910e6ca6855d45f96ba28ee0a2e5629299" as const;
const VTOKEN = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a" as const;
const STRAY_MARKET = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7" as const;
const KEY_HASH = "0x83f6e8bd8d973545d95b7068298059012c8d635f00a43af74be75f34dcbde56c" as const;
const REPAY_BORROW = "0x0e752702";
const BORROW = "0xc5ebeaec";

const GRANTED_AUTHORITY = {
  version: 1,
  calls: [],
  spend: [],
} as unknown as AuthorityIR;

const CAP_BREACH: ExecutionRecord = {
  step: "cap-breach-attempt",
  label: "repay 6000000 raw USDT, taking the bucket past its 25000000 cap",
  target: VTOKEN,
  selector: REPAY_BORROW,
  amountRaw: "6000000",
  status: "REVERTED",
  attribution: {
    validatorError: "ExceededSpendLimit",
    mechanism: "SPEND_CAP",
    accountState: {
      callPermitted: true,
      keyRegistered: true,
      spendCapRaw: "25000000",
      spentInBucketRaw: "20000000",
      allowanceAtAttemptRaw: "155000000",
    },
  },
};

const OUT_OF_SCOPE: ExecutionRecord = {
  step: "wrong-target-attempt",
  label: "the granted selector on a vToken outside the permission set",
  target: STRAY_MARKET,
  selector: REPAY_BORROW,
  status: "REVERTED",
  attribution: {
    validatorError: "UnauthorizedCall",
    mechanism: "OUT_OF_SCOPE_CALL",
    accountState: {
      callPermitted: false,
      keyRegistered: true,
      spendCapRaw: "25000000",
      spentInBucketRaw: "20000000",
      allowanceAtAttemptRaw: "155000000",
    },
  },
};

/** The relay refuses the call before the account's validator ever runs. */
const POST_REVOKE_WITHOUT_ERROR: ExecutionRecord = {
  step: "post-revoke-execution-fails",
  label: "a previously permitted repayment, after revocation",
  target: VTOKEN,
  selector: REPAY_BORROW,
  amountRaw: "1",
  status: "REVERTED",
  attribution: {
    mechanism: "SESSION_INVALID",
    accountState: {
      callPermitted: false,
      keyRegistered: false,
      spendCapRaw: "0",
      spentInBucketRaw: "0",
      allowanceAtAttemptRaw: "155000000",
    },
  },
};

const CONFIRMED_REPAY: ExecutionRecord = {
  step: "execute-repay",
  label: "repay 20000000 raw USDT, inside the granted scope",
  target: VTOKEN,
  selector: REPAY_BORROW,
  amountRaw: "20000000",
  status: "SUCCESS",
  txHash: "0xbef4d17120c6f64562f3374a370ecbf4b2f14fb8ec2f2a2b5246707d845c8b03",
};

function disclose(executions: readonly ExecutionRecord[]): Record<string, unknown> {
  return disclosureDocument({
    grantedAuthority: GRANTED_AUTHORITY,
    wallet: WALLET,
    keyHash: KEY_HASH,
    executions,
  }) as unknown as Record<string, unknown>;
}

function rejectedIntentsOf(executions: readonly ExecutionRecord[]): Record<string, unknown>[] {
  return disclose(executions)["rejectedIntents"] as Record<string, unknown>[];
}

describe("the rejected intents in a mandate disclosure", () => {
  it("publishes a refusal that never became a transaction", () => {
    // #given a refusal the account made during validation, so it has no tx hash
    // #when the disclosure is built
    const intents = rejectedIntentsOf([CONFIRMED_REPAY, CAP_BREACH]);

    // #then it is listed. Filtering refusals through the records that HAVE a
    // hash is what dropped every one of them from the published document.
    expect(intents).toHaveLength(1);
    expect(intents[0]?.["label"]).toBe(CAP_BREACH.label);
  });

  it("emits the shape the verifier's schema requires", () => {
    // #given both kinds of refusal the run produces
    // #when each disclosed intent is parsed by the verifier's own schema
    const intents = rejectedIntentsOf([CAP_BREACH, OUT_OF_SCOPE]);

    // #then it validates, rather than only looking plausible
    expect(intents).toHaveLength(2);
    for (const intent of intents) {
      expect(RejectedIntentEvidenceSchema.safeParse(intent).success).toBe(true);
    }
  });

  it("carries the allowance at the attempt on a spend-cap refusal", () => {
    // #given a refusal claiming the daily cap stopped it
    const intent = rejectedIntentsOf([CAP_BREACH])[0];
    const state = intent?.["accountState"] as Record<string, unknown>;

    // #then the standing allowance is recorded. Without it an exhausted ERC-20
    // approval cannot be ruled out, and the cap claim is unverifiable.
    expect(state["allowanceAtAttemptRaw"]).toBe("155000000");
    expect(BigInt(state["allowanceAtAttemptRaw"] as string)).toBeGreaterThan(
      BigInt(intent?.["amountRaw"] as string),
    );
  });

  it("omits a refusal whose validator error was never observed", () => {
    // #given a refusal the relay made before the account's validator ran
    // #when the disclosure is built
    const intents = rejectedIntentsOf([CAP_BREACH, POST_REVOKE_WITHOUT_ERROR]);

    // #then only the attributed refusal is published. Naming an error nothing
    // raised would be worse than publishing one refusal fewer.
    expect(intents).toHaveLength(1);
    expect(intents[0]?.["label"]).toBe(CAP_BREACH.label);
  });

  it("still lists no blocked execution, because a refusal has no hash", () => {
    // #given the same refusals
    const document = disclose([CONFIRMED_REPAY, CAP_BREACH, OUT_OF_SCOPE]);

    // #then the pre-existing field stays empty for readers of the older shape,
    // and the successful call is still the only allowed execution
    expect(document["blockedExecutions"]).toEqual([]);
    expect(document["allowedExecutions"]).toHaveLength(1);
  });
});
