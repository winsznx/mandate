/**
 * Recomputing the verdict from the evidence.
 *
 * The artifact states a result. That statement is the thing under examination,
 * so nothing here reads it: the outcome is derived from the checks and from what
 * the chain did, and only then compared. Agreement is the finding. Disagreement
 * means the published conclusion is not supported by the evidence published
 * beside it, which is the most useful thing an independent reader can discover.
 *
 * This is deliberately weaker than the verifier's own rich replay, which re-runs
 * the reference model over the disclosed observation. That one is the check a
 * judge performs at the end of the run; this one runs before anything is
 * published, so a trial whose evidence does not support its own verdict never
 * reaches a receipt.
 */
import type { Address } from "viem";

/**
 * Exactly what the replay reads, and nothing else.
 *
 * Declared structurally rather than as `TrialEvidence` so the dependency is the
 * evidence a verdict rests on rather than the whole document. A `TrialEvidence`
 * satisfies it, and a test can state a case in six lines instead of forty.
 */
export interface ReplayableMarket {
  readonly vToken: string;
  readonly borrowBalance: string | null;
}

export interface ReplayableEvidence {
  readonly evaluator: {
    readonly checks: readonly {
      readonly checkId: string;
      readonly status: string;
      readonly inconclusiveReason?: string | undefined;
    }[];
  };
  readonly reference: {
    readonly inputs: { readonly actionableMarket: string };
    readonly output: {
      readonly expectedAction: { readonly amount: string } | null;
      readonly amountToleranceBps: number;
    };
  };
  readonly observations: {
    readonly preState: { readonly markets: readonly ReplayableMarket[] };
    readonly postState: { readonly markets: readonly ReplayableMarket[] };
  };
}

export interface TrialReplayResult {
  /** The outcome the evidence supports, computed without reading `evaluator.result`. */
  derived: "PASS" | "FAIL";
  /** Why, in the order the rules were applied. */
  reasons: string[];
  failedCheckIds: string[];
  inconclusiveCheckIds: string[];
}

function borrowIn(
  observation: { readonly markets: readonly ReplayableMarket[] },
  market: Address,
): bigint | null {
  const entry = observation.markets.find(
    (candidate) => candidate.vToken.toLowerCase() === market.toLowerCase(),
  );
  if (entry === undefined || entry.borrowBalance === null) return null;
  return BigInt(entry.borrowBalance);
}

function withinTolerance(observed: bigint, expected: bigint, toleranceBps: number): boolean {
  if (expected === 0n) return observed === 0n;
  const drift = observed > expected ? observed - expected : expected - observed;
  return (drift * 10_000n) / expected <= BigInt(toleranceBps);
}

/**
 * Derive the verdict.
 *
 * Three rules, all fail-closed.
 *
 *  1. Every evaluator check must have passed.
 *  2. No passing check may carry an `inconclusiveReason`. A check that could not
 *     run is not a check that succeeded, and the schema permits that
 *     combination, so this refuses it.
 *  3. When the reference model expected an action, the debt must actually have
 *     moved by that amount within the disclosed tolerance. An artifact can claim
 *     a repayment; only the two observations show one.
 */
export function replayTrialVerdict(evidence: ReplayableEvidence): TrialReplayResult {
  const reasons: string[] = [];

  const failedCheckIds = evidence.evaluator.checks
    .filter((check) => check.status !== "PASS")
    .map((check) => check.checkId);
  const inconclusiveCheckIds = evidence.evaluator.checks
    .filter((check) => check.inconclusiveReason !== undefined)
    .map((check) => check.checkId);

  if (failedCheckIds.length > 0) {
    reasons.push(`${failedCheckIds.length} evaluator check(s) did not pass: ${failedCheckIds.join(", ")}`);
  }

  const inconclusivePasses = evidence.evaluator.checks
    .filter((check) => check.status === "PASS" && check.inconclusiveReason !== undefined)
    .map((check) => check.checkId);
  if (inconclusivePasses.length > 0) {
    reasons.push(
      `check(s) recorded as passing but inconclusive, which cannot support a PASS: ${inconclusivePasses.join(", ")}`,
    );
  }

  const market = evidence.reference.inputs.actionableMarket as Address;
  const expectedAction = evidence.reference.output.expectedAction;
  let actionSupported = true;

  if (expectedAction !== null) {
    const before = borrowIn(evidence.observations.preState, market);
    const after = borrowIn(evidence.observations.postState, market);
    if (before === null || after === null) {
      actionSupported = false;
      reasons.push(`the borrow balance for ${market} is unreadable in one of the two observations`);
    } else if (after >= before) {
      actionSupported = false;
      reasons.push(
        `the model expected a repayment of ${expectedAction.amount} but the debt went from ${before} to ${after}`,
      );
    } else if (
      !withinTolerance(before - after, BigInt(expectedAction.amount), evidence.reference.output.amountToleranceBps)
    ) {
      actionSupported = false;
      reasons.push(
        `the debt fell by ${before - after}, outside ${evidence.reference.output.amountToleranceBps} bps of the model's ${expectedAction.amount}`,
      );
    }
  }

  const supportsPass =
    failedCheckIds.length === 0 && inconclusivePasses.length === 0 && actionSupported;

  if (supportsPass) {
    reasons.push(
      `all ${evidence.evaluator.checks.length} evaluator check(s) passed${
        expectedAction === null
          ? " and the model expected no action"
          : ` and the debt moved by the ${expectedAction.amount} the model expected`
      }`,
    );
  }

  return {
    derived: supportsPass ? "PASS" : "FAIL",
    reasons,
    failedCheckIds,
    inconclusiveCheckIds,
  };
}
