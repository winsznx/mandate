/**
 * Saying which mechanism refused a call.
 *
 * A rejection nobody can attribute proves nothing, and the SDK's `FAILED` says
 * only that something went wrong. The distinction the whole proof turns on is
 * `ExceededSpendLimit` against an ERC-20 allowance failure: both stop the same
 * transaction, only one is the product working.
 *
 * So attribution is done twice, from two independent directions, and a step may
 * only pass when they agree.
 *
 *  1. The revert bytes, decoded. Direct evidence, but it depends on the relay or
 *     the RPC surfacing the inner revert, which is not guaranteed.
 *  2. The account's own views, read immediately before the attempt.
 *     `canExecute` says whether the call is inside the permission set, and
 *     `spendInfos` says how much of the bucket is left. If the call is permitted
 *     and the amount would take the bucket past its cap while the ERC-20
 *     allowance still covers it, the spend cap is the only mechanism left that
 *     can refuse — established by observation rather than by assumption.
 *
 * The second is what makes an allowance failure impossible to mistake for a cap
 * rejection, because the allowance is read and reported at the moment of the
 * attempt rather than inferred from the outcome.
 */
import { decodeRevert, isPolicyRejection, type DecodedRevert } from "@mandate/altana";
import type { Hex } from "viem";

export type RejectionMechanism =
  | "SPEND_CAP"
  | "OUT_OF_SCOPE_CALL"
  | "SESSION_INVALID"
  | "ALLOWANCE"
  | "INSUFFICIENT_BALANCE"
  | "UNDETERMINED";

export interface AccountViewAtAttempt {
  /** `canExecute(keyHash, target, data)` on the wallet. */
  callPermitted: boolean;
  /** Key still registered on the account. */
  keyRegistered: boolean;
  /** Enforced cap for the token, base units. */
  spendLimitRaw: bigint;
  /** Consumed inside the open bucket at the moment of the attempt. */
  spentInBucketRaw: bigint;
  /** The standing ERC-20 allowance the protocol would pull against. */
  allowanceRaw: bigint;
  /** The wallet's balance of the token being moved. */
  balanceRaw: bigint;
  /** What the attempt tries to move. */
  amountRaw: bigint;
}

export interface Attribution {
  mechanism: RejectionMechanism;
  /** Why, in the terms an operator or a judge can check against the numbers. */
  reasoning: string;
  /** True when the ERC-20 allowance could not have been what refused the call. */
  allowanceRuledOut: boolean;
  /** True when the wallet's balance could not have been what refused the call. */
  balanceRuledOut: boolean;
}

/**
 * What the account's own state says must happen, computed before the attempt.
 *
 * Deliberately a prediction rather than an explanation. Predicting the mechanism
 * and then observing the revert is a check; explaining a revert after the fact is
 * a story.
 */
export function attributeFromAccountView(view: AccountViewAtAttempt): Attribution {
  const allowanceRuledOut = view.allowanceRaw >= view.amountRaw;
  const balanceRuledOut = view.balanceRaw >= view.amountRaw;

  if (!view.keyRegistered) {
    return {
      mechanism: "SESSION_INVALID",
      reasoning: "the account holds no key with this hash, so nothing it submits can validate",
      allowanceRuledOut,
      balanceRuledOut,
    };
  }

  if (!view.callPermitted) {
    return {
      mechanism: "OUT_OF_SCOPE_CALL",
      reasoning: "the account's own canExecute says this target and selector are outside the permission set",
      allowanceRuledOut,
      balanceRuledOut,
    };
  }

  if (!allowanceRuledOut) {
    return {
      mechanism: "ALLOWANCE",
      reasoning: `the standing allowance is ${view.allowanceRaw} against an amount of ${view.amountRaw}, so the ERC-20 transferFrom fails before the spend cap is consulted`,
      allowanceRuledOut,
      balanceRuledOut,
    };
  }

  if (!balanceRuledOut) {
    return {
      mechanism: "INSUFFICIENT_BALANCE",
      reasoning: `the wallet holds ${view.balanceRaw} against an amount of ${view.amountRaw}`,
      allowanceRuledOut,
      balanceRuledOut,
    };
  }

  if (view.spentInBucketRaw + view.amountRaw > view.spendLimitRaw) {
    return {
      mechanism: "SPEND_CAP",
      reasoning: `${view.spentInBucketRaw} already spent in this bucket plus ${view.amountRaw} exceeds the enforced cap of ${view.spendLimitRaw}, and both the allowance and the balance cover the amount`,
      allowanceRuledOut,
      balanceRuledOut,
    };
  }

  return {
    mechanism: "UNDETERMINED",
    reasoning: "the call is permitted, funded and inside the cap, so nothing in the account should refuse it",
    allowanceRuledOut,
    balanceRuledOut,
  };
}

/** Map a decoded revert onto the same vocabulary the account view speaks. */
export function attributeFromRevert(decoded: DecodedRevert): RejectionMechanism {
  if (decoded.class === "ALLOWANCE_INSUFFICIENT") return "ALLOWANCE";
  if (decoded.class === "SESSION_INVALID") return "SESSION_INVALID";
  if (!isPolicyRejection(decoded)) return "UNDETERMINED";
  if (decoded.name === "ExceededSpendLimit") return "SPEND_CAP";
  if (decoded.name === "UnauthorizedCall" || decoded.name === "CannotSelfExecute") {
    return "OUT_OF_SCOPE_CALL";
  }
  if (decoded.name === "NoSpendPermissions") return "SPEND_CAP";
  return "UNDETERMINED";
}

export interface RejectionVerdict {
  /** True only when both directions name the expected mechanism. */
  proven: boolean;
  expected: RejectionMechanism;
  fromAccountView: Attribution;
  fromRevert?: RejectionMechanism;
  decoded?: DecodedRevert;
  /** What to record on the step. */
  observed: string;
}

/**
 * Decide whether a rejection is the one the step claims.
 *
 * Fails closed in both interesting directions. Revert bytes that decode to an
 * allowance failure fail the step outright even if the account view predicted a
 * cap rejection, because the observation beats the prediction and the run has
 * just discovered a misconfiguration. Revert bytes that could not be obtained
 * leave the step unproven rather than passing on the prediction alone: the
 * prediction is strong evidence, and it is still not the revert.
 */
export function judgeRejection(params: {
  expected: RejectionMechanism;
  view: AccountViewAtAttempt;
  revertData?: Hex;
}): RejectionVerdict {
  const fromAccountView = attributeFromAccountView(params.view);

  if (params.revertData === undefined || params.revertData === "0x") {
    return {
      proven: false,
      expected: params.expected,
      fromAccountView,
      observed: `no revert data was recoverable; the account's own state at the attempt says ${fromAccountView.mechanism} (${fromAccountView.reasoning})`,
    };
  }

  const decoded = decodeRevert(params.revertData);
  const fromRevert = attributeFromRevert(decoded);
  const agree = fromRevert === params.expected && fromAccountView.mechanism === params.expected;

  return {
    proven: agree,
    expected: params.expected,
    fromAccountView,
    fromRevert,
    decoded,
    observed: agree
      ? `${decoded.name ?? "revert"} ${decoded.selector ?? ""} — ${fromAccountView.reasoning}`.trim()
      : `expected ${params.expected}; revert says ${fromRevert} (${decoded.name ?? decoded.class}), account state says ${fromAccountView.mechanism}`,
  };
}
