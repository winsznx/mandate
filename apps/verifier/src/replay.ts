/**
 * Re-deriving the verdict.
 *
 * The artifact states a result. That statement is the thing under examination,
 * so this module never reads it as an input — it recomputes a result from the
 * evaluator's checks and the reference model's expectations, and then compares.
 * Agreement is the finding; disagreement means the published conclusion is not
 * supported by the evidence published alongside it, which is the single most
 * useful thing an independent verifier can discover.
 *
 * What this does NOT do is re-execute the reference model. Doing that would
 * mean forking BSC at the snapshot block and running the model's code, which is
 * the trial runner's job and needs an archive RPC. What it does instead is
 * check the model's disclosed expectations against the observed post-state:
 * cheaper, offline, and enough to catch a run whose outcome contradicts the
 * model it was measured against.
 */
import type { EvidenceArtifact, StateReading, TrialOutcome } from "./types.js";

export type ExpectationStatus = "MATCHED" | "DIVERGED" | "UNRECORDED";

export interface ExpectationComparison {
  key: string;
  status: ExpectationStatus;
  expected: string;
  expectedUnit: string;
  observed?: string;
  observedUnit?: string;
}

export interface ReplayResult {
  /** The result the disclosed evidence supports, computed without reading `artifact.result`. */
  derived: TrialOutcome;
  /** Why `derived` is what it is, in the order the rules were applied. */
  reasons: string[];
  expectations: ExpectationComparison[];
  failedCheckIds: string[];
  inconclusiveCheckIds: string[];
}

function findReading(readings: readonly StateReading[], key: string): StateReading | undefined {
  return readings.find((reading) => reading.key === key);
}

/**
 * Compare what the reference model said should happen against what was recorded.
 *
 * `source` is deliberately excluded from the comparison: the expectation is
 * tagged `REFERENCE_MODEL` and the observation `CHAIN`, and requiring them to
 * agree on that field would make every comparison fail. Key, unit and value are
 * what have to match, and unit is included because a value compared across
 * different units is not a comparison at all.
 */
export function compareExpectations(artifact: EvidenceArtifact): ExpectationComparison[] {
  return artifact.referenceOutcome.expected.map((expected) => {
    const observed = findReading(artifact.postState, expected.key);
    if (observed === undefined) {
      return {
        key: expected.key,
        status: "UNRECORDED" as const,
        expected: expected.value,
        expectedUnit: expected.unit,
      };
    }
    const matches = observed.value === expected.value && observed.unit === expected.unit;
    return {
      key: expected.key,
      status: matches ? ("MATCHED" as const) : ("DIVERGED" as const),
      expected: expected.value,
      expectedUnit: expected.unit,
      observed: observed.value,
      observedUnit: observed.unit,
    };
  });
}

/**
 * Recompute the trial's outcome from its evidence.
 *
 * Three rules, all fail-closed:
 *
 *  1. Every evaluator check must have passed.
 *  2. No passing check may carry an `inconclusiveReason`. A check that could
 *     not run is not a check that succeeded, and the artifact schema does not
 *     forbid that combination, so the verifier does.
 *  3. Every reference-model expectation must appear in the post-state with the
 *     same unit and value. An expectation the run never recorded counts against
 *     the result rather than being ignored — otherwise a runner could turn any
 *     divergence into a pass by declining to record the reading.
 */
export function replayEvaluation(artifact: EvidenceArtifact): ReplayResult {
  const reasons: string[] = [];

  const failedCheckIds = artifact.checks.filter((check) => !check.passed).map((check) => check.checkId);
  const inconclusiveCheckIds = artifact.checks
    .filter((check) => check.inconclusiveReason !== undefined)
    .map((check) => check.checkId);

  if (failedCheckIds.length > 0) {
    reasons.push(`${failedCheckIds.length} evaluator check(s) failed: ${failedCheckIds.join(", ")}`);
  }

  const inconclusivePasses = artifact.checks
    .filter((check) => check.passed && check.inconclusiveReason !== undefined)
    .map((check) => check.checkId);
  if (inconclusivePasses.length > 0) {
    reasons.push(
      `check(s) recorded as passing but inconclusive, which cannot support a PASS: ${inconclusivePasses.join(", ")}`,
    );
  }

  const expectations = compareExpectations(artifact);
  const diverged = expectations.filter((entry) => entry.status === "DIVERGED");
  const unrecorded = expectations.filter((entry) => entry.status === "UNRECORDED");

  for (const entry of diverged) {
    reasons.push(
      `reference model expected ${entry.key} = ${entry.expected} ${entry.expectedUnit}, run observed ${entry.observed ?? "nothing"} ${entry.observedUnit ?? ""}`.trim(),
    );
  }
  for (const entry of unrecorded) {
    reasons.push(`reference model expected ${entry.key} but the run recorded no such post-state reading`);
  }

  const supportsPass =
    failedCheckIds.length === 0 &&
    inconclusivePasses.length === 0 &&
    diverged.length === 0 &&
    unrecorded.length === 0;

  if (supportsPass) {
    reasons.push(
      `all ${artifact.checks.length} evaluator check(s) passed and all ${expectations.length} reference expectation(s) matched`,
    );
  }

  return {
    derived: supportsPass ? "PASS" : "FAIL",
    reasons,
    expectations,
    failedCheckIds,
    inconclusiveCheckIds,
  };
}
