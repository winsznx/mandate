/**
 * The unit of verification: one named step, one outcome, one reason.
 *
 * A verifier that collapses to a single boolean is worth very little, because
 * the interesting cases are partial. A receipt whose evidence hash matches but
 * whose granted authority was never disclosed is in a completely different
 * position from one whose evidence hash is wrong, and both are different again
 * from one that verifies but expired last week. Collapsing all three to "not
 * verified" would throw away exactly the information a judge came for.
 *
 * So every check reports separately, every non-PASS carries a reason, and the
 * verdict is derived from the set rather than short-circuited on the first
 * problem. The only step that stops the run is an evidence-hash mismatch, and
 * it stops it because continuing would mean interpreting bytes that are
 * provably not what the chain committed to.
 */

/**
 * `SKIP` is not a soft pass.
 *
 * It means the check could not run — nothing was disclosed, the artefact was
 * unreachable, the chain does not host the contract being probed. A skipped
 * step caps the verdict at PARTIALLY VERIFIED, so a skip can never be used to
 * launder a claim that was not actually checked.
 */
export type StepStatus = "PASS" | "FAIL" | "SKIP";

/**
 * What a trial receipt can establish on its own.
 *
 * A receipt certifies that an agent build passed a frozen question inside a
 * stated authority envelope. It grants nothing, so the grant-side steps are not
 * unchecked questions about it — they are not questions about it at all.
 */
export const TRIAL_STEP_IDS = [
  "agent identity",
  "agent version",
  "trial receipt",
  "evidence hash",
  "reference result",
  "tested authority",
] as const;

/** The full eleven steps a mandate proof consists of, in the order PRD §89 prints them. */
export const STEP_IDS = [
  ...TRIAL_STEP_IDS,
  "granted authority",
  "subset relation",
  "session registration",
  "allowed execution",
  "blocked execution",
] as const;

export type StepId = (typeof STEP_IDS)[number];

export type SubjectKind = "TRIAL" | "MANDATE";

/** Steps that apply to a subject. Reporting an inapplicable step as skipped would overstate the gap. */
export function stepsFor(kind: SubjectKind): readonly StepId[] {
  return kind === "TRIAL" ? TRIAL_STEP_IDS : STEP_IDS;
}

export interface Step {
  id: StepId;
  status: StepStatus;
  /** Why the step reached this status. Required on FAIL and SKIP, optional on PASS. */
  reason?: string;
  /** What the check compared, so a reader can redo it by hand. */
  detail?: Record<string, string>;
}

export type Verdict = "VERIFIED" | "PARTIALLY VERIFIED" | "FAILED" | "STALE";

export function pass(id: StepId, reason?: string, detail?: Record<string, string>): Step {
  return {
    id,
    status: "PASS",
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined ? {} : { detail }),
  };
}

export function fail(id: StepId, reason: string, detail?: Record<string, string>): Step {
  return { id, status: "FAIL", reason, ...(detail === undefined ? {} : { detail }) };
}

export function skip(id: StepId, reason: string): Step {
  return { id, status: "SKIP", reason };
}

/**
 * Collect steps in the canonical order, filling anything unreported as a skip.
 *
 * Printing a fixed step list rather than only the steps that happened to run is
 * deliberate: a missing line is easy to overlook, and "this was never checked"
 * is a result a reader needs to see.
 */
export function orderSteps(kind: SubjectKind, steps: readonly Step[], missingReason: string): Step[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return stepsFor(kind).map((id) => byId.get(id) ?? skip(id, missingReason));
}

export interface VerdictInput {
  steps: readonly Step[];
  /** True when the receipt's `freshUntil` has passed. */
  stale: boolean;
}

/**
 * Reduce the step set to one verdict.
 *
 * Precedence is FAILED > STALE > PARTIALLY VERIFIED > VERIFIED, and the
 * placement of STALE above PARTIALLY VERIFIED is the deliberate part. A receipt
 * past its freshness horizon is not current certification whatever else checked
 * out, and "partially verified" would read as a milder statement than the
 * situation deserves. A contradiction still wins: an expired receipt with a
 * broken hash is FAILED, not STALE.
 */
export function decideVerdict(input: VerdictInput): Verdict {
  if (input.steps.some((step) => step.status === "FAIL")) return "FAILED";
  if (input.stale) return "STALE";
  if (input.steps.some((step) => step.status === "SKIP")) return "PARTIALLY VERIFIED";
  return "VERIFIED";
}
