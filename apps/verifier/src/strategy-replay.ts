/**
 * Re-deriving a strategy trial's outcome.
 *
 * The counterpart to `replay.ts` for `mandate.strategy-trial-evidence/1`, under
 * the same discipline: the artifact states an `evaluator.result`, and because
 * that statement is the thing under examination this module never reads it. It
 * recomputes the outcome from the evaluator's checks alone and hands back what
 * the evidence supports, for the caller to compare against the published result.
 *
 * Checks alone, with no expectation replay, and that is deliberate. The
 * health-factor document carries a reference block of typed post-state
 * expectations that `replay.ts` re-checks against the observed post-state. A
 * yield, grid or rebalancing model derives none of those; its reference block
 * records the decision it reached, not a solvency quantity to recompute. So the
 * honest offline check here is the evaluator's own checks. No chain read, and no
 * financial arithmetic, because there is none to redo.
 */
import type { StrategyTrialEvidence, TrialOutcome } from "./types.js";

export interface StrategyReplayResult {
  /** The result the checks support, computed without reading `evaluator.result`. */
  derived: TrialOutcome;
  /** Why `derived` is what it is, in the order the rules were applied. */
  reasons: string[];
  failedCheckIds: string[];
  inconclusiveCheckIds: string[];
}

/**
 * Recompute a strategy trial's outcome from its evaluator checks.
 *
 * Fail-closed on both ways a check can fall short. A FAIL is a FAIL. An
 * INCONCLUSIVE is an infrastructure fault that says nothing about the agent and
 * so cannot lift the result to PASS. Only an all-passing check set supports a
 * PASS, which is the same rule the schema enforces at publication, applied here
 * without trusting that it was.
 */
export function replayStrategyEvidence(artifact: StrategyTrialEvidence): StrategyReplayResult {
  const reasons: string[] = [];
  const checks = artifact.evaluator.checks;

  const failedCheckIds = checks.filter((check) => check.status === "FAIL").map((check) => check.checkId);
  const inconclusiveCheckIds = checks
    .filter((check) => check.status === "INCONCLUSIVE")
    .map((check) => check.checkId);

  if (failedCheckIds.length > 0) {
    reasons.push(`${failedCheckIds.length} evaluator check(s) failed: ${failedCheckIds.join(", ")}`);
  }
  if (inconclusiveCheckIds.length > 0) {
    reasons.push(`check(s) inconclusive, which cannot support a PASS: ${inconclusiveCheckIds.join(", ")}`);
  }

  const supportsPass = failedCheckIds.length === 0 && inconclusiveCheckIds.length === 0;
  if (supportsPass) {
    reasons.push(`all ${checks.length} evaluator check(s) passed`);
  }

  return {
    derived: supportsPass ? "PASS" : "FAIL",
    reasons,
    failedCheckIds,
    inconclusiveCheckIds,
  };
}
