/**
 * Replaying the rich artifact.
 *
 * The flat replay compares two lists of numbers the publisher wrote. This one
 * re-runs the reference model over the disclosed observation and checks that
 * the published result follows from it, which is a stronger claim: a publisher
 * can choose what to record, but cannot choose what an independent model
 * computes from a raw observation.
 *
 * It produces the same `ReplayResult` shape as the flat path, so every check
 * downstream stays single-implementation. Two replays feeding two sets of
 * checks would be two places for the verdict to diverge.
 */
import { canonicalHash } from "@mandate/domain/canonical";
import type { CanonicalValue } from "@mandate/domain/canonical";
import type { AnyArtifact } from "./artifact-view.js";
import { artifactChecks } from "./artifact-view.js";
import type { ExpectationComparison, ReplayResult } from "./replay.js";
import { healthFactorReplayAdapter } from "./replay-adapters/health-factor.js";
import type { HealthFactorReplayInput } from "./replay-adapters/health-factor.js";
import type { ReplayProjectionError } from "./replay-adapters/types.js";

/**
 * The reference model, supplied by the caller.
 *
 * Injected rather than imported so the verifier does not hard-depend on one
 * category's package, and so a test can prove the projection independently of
 * the model's arithmetic.
 */
export interface ReferenceModelRunner {
  implementationHash: string;
  run(input: HealthFactorReplayInput): {
    riskState: string;
    healthFactorMantissa: string | null;
    liquidityUsdMantissa: string;
    shortfallUsdMantissa: string;
    totalBorrowUsdMantissa: string;
    weightedCollateralUsdMantissa: string;
  };
}

export interface RichReplayOptions {
  artifact: AnyArtifact;
  model: ReferenceModelRunner;
}

export type RichReplayOutcome =
  | { ok: true; replay: ReplayResult }
  | { ok: false; error: ReplayProjectionError };

/** Compare one recomputed figure against the published one. */
function compare(
  key: string,
  expected: string | null,
  observed: string | null,
): ExpectationComparison {
  if (expected === null && observed === null) {
    return { key, status: "MATCHED", expected: "null", expectedUnit: "none", observed: "null", observedUnit: "none" };
  }
  if (expected === null || observed === null) {
    return {
      key,
      status: "DIVERGED",
      expected: expected ?? "null",
      expectedUnit: "mantissa",
      observed: observed ?? "null",
      observedUnit: "mantissa",
    };
  }
  return {
    key,
    status: expected === observed ? "MATCHED" : "DIVERGED",
    expected,
    expectedUnit: "mantissa",
    observed,
    observedUnit: "mantissa",
  };
}

/**
 * Recompute a rich artifact's conclusion.
 *
 * The published `reference.output` is treated as a claim and compared field by
 * field against what the model produces from the disclosed pre-state. Any
 * divergence is a FAIL: it means the result does not follow from the evidence,
 * which is exactly the case a verifier exists to catch.
 */
export function replayRichEvidence(options: RichReplayOptions): RichReplayOutcome {
  const { artifact, model } = options;

  if (!healthFactorReplayAdapter.supports(artifact)) {
    return {
      ok: false,
      error: {
        code: "NO_ADAPTER",
        message: `no replay projector claims this artifact (${artifact.schemaVersion})`,
      },
    };
  }

  const projected = healthFactorReplayAdapter.project(artifact);
  if (!projected.ok) return { ok: false, error: projected.error };

  const reasons: string[] = [];
  const published = artifact.reference.output;

  // The inputs hash has to bind the inputs that were disclosed, or the
  // disclosure could be swapped for a friendlier one after the fact.
  const disclosedInputsHash = canonicalHash(artifact.reference.inputs as unknown as CanonicalValue);
  if (disclosedInputsHash.toLowerCase() !== artifact.reference.inputsHash.toLowerCase()) {
    reasons.push(
      `the disclosed reference inputs hash to ${disclosedInputsHash}, not the committed ${artifact.reference.inputsHash}`,
    );
  }

  // A reference model that shares the agent's implementation is not independent,
  // and its agreement would prove nothing.
  if (model.implementationHash.toLowerCase() === artifact.agent.agentVersionHash.toLowerCase()) {
    reasons.push("the reference model and the agent report the same implementation hash");
  }

  const recomputed = model.run(projected.value.pre);

  const expectations: ExpectationComparison[] = [
    compare("risk-state", published.riskState, recomputed.riskState),
    compare("health-factor", published.healthFactorMantissa, recomputed.healthFactorMantissa),
    compare("liquidity-usd", published.liquidityUsdMantissa, recomputed.liquidityUsdMantissa),
    compare("shortfall-usd", published.shortfallUsdMantissa, recomputed.shortfallUsdMantissa),
    compare("total-borrow-usd", published.totalBorrowUsdMantissa, recomputed.totalBorrowUsdMantissa),
    compare(
      "weighted-collateral-usd",
      published.weightedCollateralUsdMantissa,
      recomputed.weightedCollateralUsdMantissa,
    ),
  ];

  const diverged = expectations.filter((entry) => entry.status !== "MATCHED");
  if (diverged.length > 0) {
    reasons.push(
      `re-running the reference model over the disclosed pre-state reproduced ${expectations.length - diverged.length}/${expectations.length} published figures; ${diverged.map((entry) => entry.key).join(", ")} diverged`,
    );
  }

  const checks = artifactChecks(artifact);
  const failedCheckIds = checks.filter((check) => !check.passed).map((check) => check.checkId);
  const inconclusiveCheckIds = artifact.evaluator.checks
    .filter((check) => check.status === "INCONCLUSIVE")
    .map((check) => check.checkId);

  if (failedCheckIds.length > 0) {
    reasons.push(`evaluator check(s) failed: ${failedCheckIds.join(", ")}`);
  }
  // An inconclusive check is an infrastructure fact, not a verdict about the
  // agent. It cannot support a PASS, and it must not be recorded as a FAIL.
  if (inconclusiveCheckIds.length > 0) {
    reasons.push(`evaluator check(s) were inconclusive: ${inconclusiveCheckIds.join(", ")}`);
  }

  const derived =
    reasons.length === 0 && failedCheckIds.length === 0 && inconclusiveCheckIds.length === 0
      ? ("PASS" as const)
      : ("FAIL" as const);

  if (derived === "PASS") {
    reasons.push(
      `the reference model reproduced all ${expectations.length} published figures from the disclosed pre-state, and all ${checks.length} evaluator check(s) passed`,
    );
  }

  return {
    ok: true,
    replay: { derived, reasons, expectations, failedCheckIds, inconclusiveCheckIds },
  };
}
