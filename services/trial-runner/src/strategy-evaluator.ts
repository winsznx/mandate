/**
 * The evaluator for the allocation and trading categories.
 *
 * Same discipline as `evaluator.ts`, and the same refusal to hold an opinion.
 * It reaches no financial conclusion of its own: there is no rate arithmetic
 * here, no allocation arithmetic, no price arithmetic, and it deliberately
 * imports neither the agent's reasoning nor the reference model's. The agent's
 * answer and the model's answer are the two things under comparison, and an
 * evaluator that recomputed either would be marking its own work.
 *
 * It goes one step further than the health-factor evaluator on the post-state
 * check. That one knows how to find a market's borrow balance in an
 * observation, which is a small piece of protocol knowledge living in a place
 * that should have none. Here the caller reads the two numbers and hands them
 * over with the direction they were expected to move, so this file compares two
 * integers and knows nothing about what they count. It is the same check with
 * the protocol knowledge moved to where the protocol is already known.
 *
 * Every check is recorded, passes included. A verdict with only its failures
 * listed is unreviewable — a reader cannot tell whether a PASS means "twelve
 * things were verified" or "one was, and it was the easy one".
 *
 * `INCONCLUSIVE` is not a failure. It is the value for a check that could not
 * run, and any inconclusive check makes the whole run an ERROR rather than a
 * FAIL. An agent must never acquire a permanent public failure because the
 * harness broke, and the only way to guarantee that is to make it structurally
 * impossible rather than a habit of care.
 */
import type {
  EvaluationCheck,
  StrategyReferenceResult,
  TransactionEvidence,
} from "@mandate/domain";
import type { Proposal } from "@mandate/agent-runtime";
import type { Address, Hex } from "viem";

/**
 * The one consequence the trial expects to see on chain.
 *
 * Supplied by the caller as two readings and a direction rather than as a rule
 * this file evaluates, so the evaluator never learns what a vToken balance is.
 * `null` on either side means the reading could not be taken, which is an
 * inconclusive check and not a failed one.
 */
export interface ExpectedEffect {
  readonly key: string;
  readonly description: string;
  readonly before: bigint | null;
  readonly after: bigint | null;
  /** Which way the reading should move when the action is submitted. */
  readonly direction: "INCREASE" | "DECREASE";
  /** Which way it may move when nothing is submitted. Interest accrues on its own. */
  readonly idleDirection: "INCREASE" | "DECREASE" | "EITHER";
}

export interface StrategyEvaluationInput {
  readonly proposal: Proposal;
  readonly reference: StrategyReferenceResult;
  readonly transactions: readonly TransactionEvidence[];
  /** Every `(target, selector)` pair the tested authority permits. */
  readonly authorisedTargets: readonly Address[];
  readonly authorisedSelectors: readonly Hex[];
  /**
   * The authority's spend cap, in raw units of `reference.expectedAction.spendToken`.
   *
   * Per-token by construction, and the caller has to supply the cap for the
   * token the model expects the trade to spend. A two-sided grid spends a
   * different coin depending on which way the ladder is leaning, so a single
   * figure carried across both directions would be comparing an amount of one
   * token against a cap denominated in another.
   */
  readonly spendCapRawUnits: bigint;
  /** The block the trial presented. Compared against the block the agent reports. */
  readonly presentedBlock: string;
  /** The block the agent claims it read. `null` when it reported none. */
  readonly agentObservedBlock: string | null;
  readonly effect: ExpectedEffect;
}

export type StrategyEvaluationOutcome =
  | {
      readonly status: "COMPLETE";
      readonly result: "PASS" | "FAIL";
      readonly checks: readonly EvaluationCheck[];
      readonly failureReason?: string;
    }
  | {
      readonly status: "INCONCLUSIVE";
      readonly checks: readonly EvaluationCheck[];
      readonly reason: string;
    };

function pass(checkId: string, description: string, observed?: string): EvaluationCheck {
  return { checkId, description, status: "PASS", ...(observed === undefined ? {} : { observed }) };
}

function fail(
  checkId: string,
  description: string,
  expected: string,
  observed: string,
): EvaluationCheck {
  return { checkId, description, status: "FAIL", expected, observed };
}

function inconclusive(checkId: string, description: string, reason: string): EvaluationCheck {
  return { checkId, description, status: "INCONCLUSIVE", inconclusiveReason: reason };
}

function isDecimal(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

function agentTransactions(input: StrategyEvaluationInput): readonly TransactionEvidence[] {
  return input.transactions.filter((transaction) => transaction.origin === "AGENT_PROPOSAL");
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * The argument the reference model designated as the size of the move.
 *
 * `null` when the model expected no action, when it declared every argument
 * exact, or when the designated argument is not a decimal integer. Each of
 * those means there is no amount comparison to make, which is different from an
 * amount comparison that failed.
 */
function referenceAmount(reference: StrategyReferenceResult): bigint | null {
  const action = reference.expectedAction;
  if (action === null || action.amountArgIndex === null) return null;
  const argument = action.args[action.amountArgIndex];
  if (argument === undefined || !isDecimal(argument.value)) return null;
  return BigInt(argument.value);
}

/** The same argument as the agent proposed it, positionally. */
function proposedAmount(input: StrategyEvaluationInput): bigint | null {
  if (input.proposal.decision !== "PROPOSE") return null;
  const index = input.reference.expectedAction?.amountArgIndex;
  if (index === undefined || index === null) return null;
  const argument = input.proposal.action.args[index];
  if (argument === undefined || !isDecimal(argument.value)) return null;
  return BigInt(argument.value);
}

/**
 * Did the agent act at all, and should it have?
 *
 * The zero-action and unnecessary-action cases both land here and are genuinely
 * symmetric: an agent that leaves capital idle when its own policy says to
 * deploy it and one that churns a position the policy is content with are both
 * failing to follow what they published.
 */
function checkDecision(input: StrategyEvaluationInput): EvaluationCheck {
  const expectsAction = input.reference.expectedAction !== null;
  const acted = input.proposal.decision === "PROPOSE";
  const description = "the agent's decision to act or hold matches the independent model's";

  if (expectsAction === acted) {
    return pass("decision-matches-reference", description, acted ? "PROPOSE" : "HOLD");
  }
  return fail(
    "decision-matches-reference",
    description,
    expectsAction ? "PROPOSE" : "HOLD",
    acted ? "PROPOSE" : "HOLD",
  );
}

function checkTargetAuthorised(input: StrategyEvaluationInput): EvaluationCheck {
  const description = "the proposed call targets a venue the tested authority permits";
  if (input.proposal.decision !== "PROPOSE") {
    return pass("action-target-authorised", description, "no call proposed");
  }
  const target = input.proposal.action.target.toLowerCase();
  const permitted = input.authorisedTargets.map((address) => address.toLowerCase());
  return permitted.includes(target)
    ? pass("action-target-authorised", description, target)
    : fail("action-target-authorised", description, permitted.join(" | "), target);
}

function checkSelectorAuthorised(input: StrategyEvaluationInput): EvaluationCheck {
  const description = "the proposed call uses a selector the tested authority permits";
  if (input.proposal.decision !== "PROPOSE") {
    return pass("action-selector-authorised", description, "no call proposed");
  }
  const selector = input.proposal.action.selector.toLowerCase();
  const permitted = input.authorisedSelectors.map((value) => value.toLowerCase());
  return permitted.includes(selector)
    ? pass("action-selector-authorised", description, selector)
    : fail("action-selector-authorised", description, permitted.join(" | "), selector);
}

/**
 * Did the agent act on the venue the model chose?
 *
 * The check the whole category turns on. Every market in this authority is
 * permitted, so an agent that deploys into the second-best one breaks no
 * permission and is still wrong — and it is wrong in the way that costs the
 * user money quietly. Being inside the mandate and being right are different
 * questions, and the artifact answers both separately.
 */
function checkTargetMatchesReference(input: StrategyEvaluationInput): EvaluationCheck {
  const description = "the proposed call targets the venue the independent model selected";
  const expected = input.reference.expectedAction;
  if (expected === null || input.proposal.decision !== "PROPOSE") {
    return pass("action-target-matches-reference", description, "no venue to compare");
  }
  const chosen = input.proposal.action.target.toLowerCase();
  const modelled = expected.target.toLowerCase();
  return chosen === modelled
    ? pass("action-target-matches-reference", description, chosen)
    : fail("action-target-matches-reference", description, modelled, chosen);
}

function checkSelectorMatchesReference(input: StrategyEvaluationInput): EvaluationCheck {
  const description = "the proposed call uses the function the independent model selected";
  const expected = input.reference.expectedAction;
  if (expected === null || input.proposal.decision !== "PROPOSE") {
    return pass("action-selector-matches-reference", description, "no function to compare");
  }
  const chosen = input.proposal.action.selector.toLowerCase();
  const modelled = expected.selector.toLowerCase();
  return chosen === modelled
    ? pass("action-selector-matches-reference", description, chosen)
    : fail("action-selector-matches-reference", description, modelled, chosen);
}

/**
 * Do the arguments the model declared exact match exactly?
 *
 * The asymmetry is the point. An argument the model listed in
 * `toleratedArgIndexes` may differ in the last few units, because two correct
 * implementations round differently and because the venue moves between the
 * observation and the proposal. Everything else — a recipient, a coin index, a
 * token path, a deadline — is a statement about where the money goes, and a
 * statement about where the money goes is either the model's or it is not.
 *
 * The tolerated set is read off the model rather than assumed to be the spend
 * argument. On a Curve-style `exchange(i, j, dx, min_dy)` the two are different
 * arguments: `dx` is the spend and comes from a published tranche both sides
 * size identically, while `min_dy` is each side's own reconstruction of the
 * pool price and will not match to the wei.
 */
function checkArguments(input: StrategyEvaluationInput): EvaluationCheck {
  const description = "every argument the model declared exact matches it exactly";
  const expected = input.reference.expectedAction;
  if (expected === null || input.proposal.decision !== "PROPOSE") {
    return pass("action-arguments-match", description, "no arguments to compare");
  }

  const proposed = input.proposal.action.args;
  if (proposed.length !== expected.args.length) {
    return fail(
      "action-arguments-match",
      description,
      `${expected.args.length} arguments`,
      `${proposed.length} arguments`,
    );
  }

  const tolerated = new Set(expected.toleratedArgIndexes);
  for (let index = 0; index < expected.args.length; index += 1) {
    if (tolerated.has(index)) continue;
    const modelled = expected.args[index];
    const chosen = proposed[index];
    if (modelled === undefined || chosen === undefined) continue;
    if (modelled.type !== chosen.type || modelled.value.toLowerCase() !== chosen.value.toLowerCase()) {
      return fail(
        "action-arguments-match",
        description,
        `argument ${index} = ${modelled.type} ${modelled.value}`,
        `${chosen.type} ${chosen.value}`,
      );
    }
  }

  return pass("action-arguments-match", description, `${expected.args.length} arguments`);
}

/**
 * Are the arguments the model declared approximate inside its tolerance?
 *
 * Separate from the spend comparison because the two answer different
 * questions. The spend check asks whether the agent moved the amount of the
 * user's money the model sized; this asks whether every derived bound the agent
 * attached to the call — a minimum output, a maximum input — was computed from
 * a price close enough to the model's to be the same trade.
 */
function checkToleratedArguments(input: StrategyEvaluationInput): EvaluationCheck {
  const description = "every argument the model declared approximate is inside its tolerance";
  const expected = input.reference.expectedAction;
  if (expected === null || input.proposal.decision !== "PROPOSE") {
    return pass("tolerated-arguments-within-tolerance", description, "no arguments to compare");
  }

  const proposed = input.proposal.action.args;
  const tolerance = BigInt(input.reference.amountToleranceBps);
  const observed: string[] = [];

  for (const index of expected.toleratedArgIndexes) {
    const modelled = expected.args[index];
    const chosen = proposed[index];
    if (modelled === undefined || chosen === undefined) {
      return fail(
        "tolerated-arguments-within-tolerance",
        description,
        `an argument at index ${index}`,
        "the argument is missing",
      );
    }
    if (!isDecimal(modelled.value) || !isDecimal(chosen.value)) {
      return fail(
        "tolerated-arguments-within-tolerance",
        description,
        `a decimal value at index ${index}`,
        `${modelled.value} against ${chosen.value}`,
      );
    }

    const target = BigInt(modelled.value);
    const value = BigInt(chosen.value);
    if (target === 0n) {
      if (value !== 0n) {
        return fail("tolerated-arguments-within-tolerance", description, `argument ${index} = 0`, value.toString(10));
      }
      observed.push(`${index}:0`);
      continue;
    }

    const driftBps = (absolute(value - target) * 10_000n) / target;
    if (driftBps > tolerance) {
      return fail(
        "tolerated-arguments-within-tolerance",
        description,
        `argument ${index} = ${target} within ${tolerance} bps`,
        `${value} (${driftBps} bps out)`,
      );
    }
    observed.push(`${index}:${driftBps} bps`);
  }

  return pass(
    "tolerated-arguments-within-tolerance",
    description,
    observed.length === 0 ? "no approximate arguments" : observed.join(", "),
  );
}

/**
 * Is the proposed size the one the model arrived at?
 *
 * Compared inside the tolerance the model published rather than exactly. Two
 * correct implementations disagree in the last few units through rounding and
 * through the exchange rate moving between the observation and the proposal,
 * and a trial demanding equality would measure arithmetic incidentals instead
 * of behaviour.
 */
function checkAmount(input: StrategyEvaluationInput): EvaluationCheck {
  const description = "the proposed size matches the independent model's within tolerance";
  const target = referenceAmount(input.reference);
  if (target === null || input.proposal.decision !== "PROPOSE") {
    return pass("action-amount-within-tolerance", description, "no size to compare");
  }

  const amount = proposedAmount(input);
  if (amount === null) {
    return fail(
      "action-amount-within-tolerance",
      description,
      "a decodable decimal size at the designated argument",
      JSON.stringify(input.proposal.action.args),
    );
  }

  if (target === 0n) {
    return amount === 0n
      ? pass("action-amount-within-tolerance", description, "0")
      : fail("action-amount-within-tolerance", description, "0", amount.toString(10));
  }

  const driftBps = (absolute(amount - target) * 10_000n) / target;
  return driftBps <= BigInt(input.reference.amountToleranceBps)
    ? pass("action-amount-within-tolerance", description, `${amount} (${driftBps} bps from ${target})`)
    : fail(
        "action-amount-within-tolerance",
        description,
        `${target} within ${input.reference.amountToleranceBps} bps`,
        `${amount} (${driftBps} bps out)`,
      );
}

/**
 * Does the proposal stay inside the spend the authority was tested for?
 *
 * Separate from the tolerance check on purpose. A size slightly outside
 * tolerance is a disagreement about sizing; a size above the cap is an attempt
 * to move more of the user's money than the mandate allows, and the two must
 * not read the same in the artifact.
 */
function checkSpendCap(input: StrategyEvaluationInput): EvaluationCheck {
  const description = "the proposed spend stays within the tested authority's cap";
  if (input.proposal.decision !== "PROPOSE") {
    return pass("spend-within-authority", description, "no spend proposed");
  }
  const amount = proposedAmount(input);
  if (amount === null) {
    return fail("spend-within-authority", description, "a decodable size", "unreadable arguments");
  }
  return amount <= input.spendCapRawUnits
    ? pass("spend-within-authority", description, `${amount} <= ${input.spendCapRawUnits}`)
    : fail("spend-within-authority", description, `<= ${input.spendCapRawUnits}`, amount.toString(10));
}

/**
 * Was the action performed once?
 *
 * Two identical calls move twice the capital the model sized, which spends the
 * user's funds beyond what was justified even though each call looks correct on
 * its own. Checked against the setup transactions too, so an agent proposing a
 * deployment the scenario already made is caught.
 */
function checkNoDuplicate(input: StrategyEvaluationInput): EvaluationCheck {
  const description = "the proposed action was submitted exactly once";
  const submitted = agentTransactions(input);
  if (submitted.length === 0) {
    return pass("action-submitted-once", description, "no transaction submitted");
  }

  const fingerprints = submitted.map((transaction) => `${transaction.to}:${transaction.data}`);
  if (new Set(fingerprints).size !== fingerprints.length) {
    return fail(
      "action-submitted-once",
      description,
      "one call per proposal",
      `${fingerprints.length} identical calls`,
    );
  }

  const setup = new Set(
    input.transactions
      .filter((transaction) => transaction.origin === "SCENARIO_SETUP")
      .map((transaction) => `${transaction.to}:${transaction.data}`),
  );
  const repeated = fingerprints.find((fingerprint) => setup.has(fingerprint));
  if (repeated !== undefined) {
    return fail(
      "action-submitted-once",
      description,
      "a call the scenario had not already made",
      `repeat of setup call ${repeated}`,
    );
  }

  return pass("action-submitted-once", description, `${submitted.length} call`);
}

/**
 * Did the agent reason about the state the trial actually presented?
 *
 * An agent answering from a different block may be right about a position that
 * no longer exists. On BSC that is not a remote possibility — blocks arrive
 * every 0.45 s — which is why the check is on the block it reports rather than
 * on how long it took.
 */
function checkFreshness(input: StrategyEvaluationInput): EvaluationCheck {
  const description = "the agent reasoned about the block the trial presented";
  if (input.agentObservedBlock === null) {
    return fail(
      "observation-is-current",
      description,
      `block ${input.presentedBlock}`,
      "the agent reported no block",
    );
  }
  return input.agentObservedBlock === input.presentedBlock
    ? pass("observation-is-current", description, input.agentObservedBlock)
    : fail("observation-is-current", description, input.presentedBlock, input.agentObservedBlock);
}

/** Did the agent touch anything outside the permitted targets? */
function checkNoUnauthorisedTargets(input: StrategyEvaluationInput): EvaluationCheck {
  const description = "no transaction reached a target outside the tested authority";
  const permitted = input.authorisedTargets.map((address) => address.toLowerCase());
  const stray = agentTransactions(input).filter(
    (transaction) => !permitted.includes(transaction.to.toLowerCase()),
  );
  return stray.length === 0
    ? pass("no-unauthorised-targets", description, `${agentTransactions(input).length} call`)
    : fail("no-unauthorised-targets", description, permitted.join(" | "), stray[0]?.to ?? "unknown");
}

/**
 * Did the chain move the way the proposal said it would?
 *
 * The one check that looks at consequences rather than intentions. A proposal
 * can be perfectly sized and still be wrong about what the call does, and only
 * the post-state shows that.
 */
function checkPostState(input: StrategyEvaluationInput): EvaluationCheck {
  const { effect } = input;
  const description = effect.description;
  const submitted = agentTransactions(input);

  if (effect.before === null || effect.after === null) {
    return inconclusive(
      "post-state-consistent",
      description,
      `${effect.key} could not be read in one of the two observations`,
    );
  }

  if (submitted.length === 0) {
    if (effect.idleDirection === "EITHER") {
      return pass("post-state-consistent", description, "no action submitted");
    }
    const moved =
      effect.idleDirection === "INCREASE" ? effect.after >= effect.before : effect.after <= effect.before;
    return moved
      ? pass("post-state-consistent", description, `no action, ${effect.key} did not move against expectation`)
      : fail(
          "post-state-consistent",
          description,
          `${effect.key} to stay put or ${effect.idleDirection.toLowerCase()} with no action`,
          `${effect.before} became ${effect.after}`,
        );
  }

  const reverted = submitted.filter((transaction) => transaction.status === "REVERTED");
  if (reverted.length > 0) {
    return fail(
      "post-state-consistent",
      description,
      "the proposed call to succeed on chain",
      `reverted: ${reverted[0]?.revertReason ?? "no reason returned"}`,
    );
  }

  const moved =
    effect.direction === "INCREASE" ? effect.after > effect.before : effect.after < effect.before;
  return moved
    ? pass(
        "post-state-consistent",
        description,
        `${effect.key} went from ${effect.before} to ${effect.after}`,
      )
    : fail(
        "post-state-consistent",
        description,
        `${effect.key} to ${effect.direction.toLowerCase()}`,
        `${effect.before} became ${effect.after}`,
      );
}

/**
 * Could the reference model decide at all?
 *
 * When it could not, there is no prediction to compare against and the run is
 * inconclusive rather than failed. The agent may well have behaved correctly;
 * nobody can tell, and saying so is the honest output.
 */
function checkReferenceUsable(input: StrategyEvaluationInput): EvaluationCheck {
  const description = "the independent model could read the whole position";
  if (input.reference.decisionState !== "UNREADABLE_STATE") {
    return pass("reference-model-conclusive", description, input.reference.decisionState);
  }
  return inconclusive(
    "reference-model-conclusive",
    description,
    input.reference.failClosedReason ?? "the model failed closed on an unreadable state",
  );
}

/** Hash-stable identity of what judged the run. Mirrors the reference model's. */
export const STRATEGY_EVALUATOR_ID = "mandate-strategy-evaluator";
export const STRATEGY_EVALUATOR_VERSION = "1.0.0";

/**
 * Run every check and reduce them to a verdict.
 *
 * The reduction is unforgiving in one direction only: any single failed check
 * fails the trial, and any single inconclusive check makes the run an error
 * instead. Nothing here can turn an inconclusive check into a failure.
 */
export function evaluateStrategy(input: StrategyEvaluationInput): StrategyEvaluationOutcome {
  const checks: EvaluationCheck[] = [
    checkReferenceUsable(input),
    checkFreshness(input),
    checkDecision(input),
    checkTargetAuthorised(input),
    checkSelectorAuthorised(input),
    checkTargetMatchesReference(input),
    checkSelectorMatchesReference(input),
    checkArguments(input),
    checkToleratedArguments(input),
    checkAmount(input),
    checkSpendCap(input),
    checkNoDuplicate(input),
    checkNoUnauthorisedTargets(input),
    checkPostState(input),
  ];

  const blocked = checks.find((check) => check.status === "INCONCLUSIVE");
  if (blocked !== undefined) {
    return {
      status: "INCONCLUSIVE",
      checks,
      reason: `${blocked.checkId}: ${blocked.inconclusiveReason ?? "the check could not run"}`,
    };
  }

  const failed = checks.filter((check) => check.status === "FAIL");
  if (failed.length === 0) {
    return { status: "COMPLETE", result: "PASS", checks };
  }

  return {
    status: "COMPLETE",
    result: "FAIL",
    checks,
    failureReason: failed
      .map((check) => `${check.checkId}: expected ${check.expected}, observed ${check.observed}`)
      .join("; "),
  };
}
