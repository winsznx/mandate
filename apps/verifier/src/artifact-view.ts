/**
 * One reading of an evidence artifact, whichever form it was published in.
 *
 * A receipt may commit to the flat `mandate.evidence/1` or to the richer
 * `mandate.trial-evidence/1`. The two carry the same facts under different
 * names — `trialSpecHash` against `trialSpec.hash`, `result` against
 * `evaluator.result` — and the verifier's checks care about the facts, not the
 * spelling.
 *
 * Normalising here rather than branching at each call site keeps the checks
 * readable and, more importantly, keeps them honest: a check written twice is a
 * check that can disagree with itself, and a verifier whose verdict depended on
 * which form a publisher chose would be worth very little.
 */
import type { EvidenceArtifact, TrialEvidence } from "./types.js";

export type AnyArtifact = EvidenceArtifact | TrialEvidence;

function isRich(artifact: AnyArtifact): artifact is TrialEvidence {
  return artifact.schemaVersion === "mandate.trial-evidence/1";
}

/** Whether the richer form was published. Reported so a reader knows what was disclosed. */
export function artifactForm(artifact: AnyArtifact): "TRIAL_EVIDENCE" | "FLAT_ARTIFACT" {
  return isRich(artifact) ? "TRIAL_EVIDENCE" : "FLAT_ARTIFACT";
}

/**
 * Narrow to the flat form.
 *
 * A type predicate rather than a boolean helper so callers that only accept the
 * flat shape — the expectation replay, whose comparison is defined over named
 * `StateReading`s — narrow at the call site instead of casting.
 */
export function isFlatArtifact(artifact: AnyArtifact): artifact is EvidenceArtifact {
  return !isRich(artifact);
}

export function artifactTrialSpecHash(artifact: AnyArtifact): `0x${string}` {
  return isRich(artifact) ? artifact.trialSpec.hash : artifact.trialSpecHash;
}

export function artifactResult(artifact: AnyArtifact): "PASS" | "FAIL" {
  return isRich(artifact) ? artifact.evaluator.result : artifact.result;
}

export function artifactFailureReason(artifact: AnyArtifact): string | undefined {
  return isRich(artifact) ? artifact.evaluator.failureReason : artifact.failureReason;
}

export interface NormalizedCheck {
  checkId: string;
  description: string;
  passed: boolean;
}

/**
 * The evaluator's checks.
 *
 * The richer form admits `INCONCLUSIVE`, which is neither a pass nor a fail. It
 * is mapped to `passed: false` here only so a caller counting failures cannot
 * miss it; callers that need the distinction read the artifact directly.
 */
export function artifactChecks(artifact: AnyArtifact): NormalizedCheck[] {
  if (isRich(artifact)) {
    return artifact.evaluator.checks.map((check) => ({
      checkId: check.checkId,
      description: check.description,
      passed: check.status === "PASS",
    }));
  }
  return artifact.checks.map((check) => ({
    checkId: check.checkId,
    description: check.description,
    passed: check.passed,
  }));
}

/** True when the scenario altered chain state beyond funding accounts. */
export function artifactStateModified(artifact: AnyArtifact): boolean {
  return isRich(artifact) ? artifact.environment.modifiedState : artifact.environment.stateModified;
}

/**
 * The label a modified environment must carry, e.g. `SIMULATED ORACLE SHOCK`.
 *
 * The richer form allows several modifications, so their labels are joined. An
 * unlabelled modification cannot occur — both schemas refuse it.
 */
export function artifactModificationLabel(artifact: AnyArtifact): string | undefined {
  if (!isRich(artifact)) return artifact.environment.modificationLabel;
  const labels = artifact.environment.modifications.map((modification) => modification.label);
  return labels.length === 0 ? undefined : labels.join("; ");
}

/** Identifier of the independent model, for reporting which one produced the prediction. */
export function artifactReferenceModelId(artifact: AnyArtifact): string {
  return isRich(artifact) ? artifact.reference.implementationHash : artifact.referenceOutcome.modelId;
}

export function artifactReferenceModelVersion(artifact: AnyArtifact): string {
  return isRich(artifact) ? artifact.reference.inputsHash : artifact.referenceOutcome.modelVersion;
}
