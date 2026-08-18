/**
 * Verifying a refusal that never became a transaction.
 *
 * There is no hash to fetch, so this step cannot confirm a rejection the way it
 * confirms an execution. What it can do is refuse to take the publisher's
 * conclusion on trust: the recorded account state must actually IMPLY the
 * mechanism claimed. A disclosure asserting "the spend cap stopped it" while
 * recording a cap the attempt fits inside is self-contradictory, and this is
 * where that shows up.
 *
 * The allowance check is the one that matters most. An exhausted ERC-20
 * allowance stops the same call and looks identical from the outside, so a
 * spend-cap claim is only credible if the allowance at the attempt covered the
 * amount. Without that figure the claim is unverifiable and the step skips.
 */
import type { Step } from "./steps.js";
import { fail, pass, skip } from "./steps.js";

export interface RejectedIntent {
  label: string;
  validatorError: string;
  mechanism: "SPEND_CAP" | "OUT_OF_SCOPE_CALL" | "SESSION_INVALID";
  amountRaw?: string | undefined;
  accountState: {
    callPermitted: boolean;
    keyRegistered: boolean;
    spendCapRaw?: string | undefined;
    spentInBucketRaw?: string | undefined;
    allowanceAtAttemptRaw?: string | undefined;
  };
}

/** Does the recorded state actually imply the mechanism the disclosure claims? */
function checkOne(intent: RejectedIntent): string | undefined {
  const { accountState: state, mechanism } = intent;

  if (mechanism === "SPEND_CAP") {
    if (!state.callPermitted) {
      return `${intent.label}: claims the spend cap refused it, but the account also says the call itself was not permitted, which would refuse it first`;
    }
    if (state.spendCapRaw === undefined || state.spentInBucketRaw === undefined || intent.amountRaw === undefined) {
      return `${intent.label}: claims the spend cap refused it but does not record the cap, the amount already spent and the amount attempted`;
    }
    const wouldReach = BigInt(state.spentInBucketRaw) + BigInt(intent.amountRaw);
    if (wouldReach <= BigInt(state.spendCapRaw)) {
      return `${intent.label}: claims the spend cap refused it, but ${state.spentInBucketRaw} + ${intent.amountRaw} is within the ${state.spendCapRaw} cap`;
    }
    if (state.allowanceAtAttemptRaw === undefined) {
      return `${intent.label}: claims the spend cap refused it but does not record the token allowance, so an exhausted allowance cannot be ruled out`;
    }
    if (BigInt(state.allowanceAtAttemptRaw) < BigInt(intent.amountRaw)) {
      return `${intent.label}: the allowance of ${state.allowanceAtAttemptRaw} was below the ${intent.amountRaw} attempted, so the allowance and not the spend cap was the binding constraint`;
    }
    if (intent.validatorError !== "ExceededSpendLimit" && intent.validatorError !== "NoSpendPermissions") {
      return `${intent.label}: claims the spend cap refused it but records ${intent.validatorError}`;
    }
    return undefined;
  }

  if (mechanism === "OUT_OF_SCOPE_CALL") {
    if (state.callPermitted) {
      return `${intent.label}: claims the call was out of scope, but the account says it was permitted`;
    }
    if (intent.validatorError !== "UnauthorizedCall" && intent.validatorError !== "CannotSelfExecute") {
      return `${intent.label}: claims the call was out of scope but records ${intent.validatorError}`;
    }
    return undefined;
  }

  if (state.keyRegistered) {
    return `${intent.label}: claims the session was invalid, but the account still held the key`;
  }
  return undefined;
}

export function stepRejectedIntents(intents: readonly RejectedIntent[], disclosed: boolean): Step {
  if (!disclosed) {
    return skip("rejected intents", "no disclosure was supplied, so no refused intents were named");
  }
  if (intents.length === 0) {
    return skip("rejected intents", "the disclosure records no refused intent");
  }

  const problems = intents.map(checkOne).filter((problem): problem is string => problem !== undefined);
  if (problems.length > 0) return fail("rejected intents", problems.join("; "));

  return pass(
    "rejected intents",
    `${intents.length} intent(s) refused by the account before broadcast, each corroborated by the account's own state at the attempt`,
    Object.fromEntries(intents.map((intent) => [intent.label, intent.validatorError])),
  );
}
