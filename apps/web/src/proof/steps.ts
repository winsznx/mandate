/**
 * The step vocabulary, kept word-for-word with the CLI verifier.
 *
 * A judge who reads this page and then runs `pnpm verify:mandate <id>` must see
 * the same step names, the same three outcomes and the same verdict words. If
 * the page invented friendlier language the two would disagree in exactly the
 * situations where agreement matters most.
 *
 * Every step prints, including the ones that could not run, because a silently
 * omitted line reads as "fine". And every non-PASS carries its reason, because
 * "FAIL" without a cause is an accusation and "SKIP" without a cause is an
 * excuse.
 */

/**
 * `SKIP` is not a soft pass.
 *
 * It means the check could not run — nothing was disclosed, the document was
 * unreachable, the chain does not host the contract being probed. A skipped
 * step caps the verdict at PARTIALLY VERIFIED, so a skip can never launder a
 * claim that was not actually checked.
 */
export type StepStatus = "PASS" | "FAIL" | "SKIP";

export const STEP_IDS = [
  "agent identity",
  "agent version",
  "trial receipt",
  "evidence hash",
  "reference result",
  "tested authority",
  "granted authority",
  "subset relation",
  "session registration",
  "allowed execution",
  "blocked execution",
  // Refusals that never became a transaction. A different guarantee from a
  // reverted call, so it gets its own step rather than sharing one.
  "rejected intents",
] as const;

export type StepId = (typeof STEP_IDS)[number];

export interface Step {
  id: StepId;
  status: StepStatus;
  /** Required on FAIL and SKIP, optional on PASS. */
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

/** Fill anything unreported as a skip, so a missing line can never read as a clean one. */
export function orderSteps(steps: readonly Step[], missingReason: string): Step[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return STEP_IDS.map((id) => byId.get(id) ?? skip(id, missingReason));
}

/**
 * Reduce the step set to one verdict.
 *
 * Precedence is FAILED > STALE > PARTIALLY VERIFIED > VERIFIED. A receipt past
 * its freshness horizon is not current certification whatever else checked out,
 * so STALE outranks PARTIALLY VERIFIED. A contradiction still wins: an expired
 * receipt with a broken hash is FAILED, not STALE.
 */
export function decideVerdict(input: { steps: readonly Step[]; stale: boolean }): Verdict {
  if (input.steps.some((step) => step.status === "FAIL")) return "FAILED";
  if (input.stale) return "STALE";
  if (input.steps.some((step) => step.status === "SKIP")) return "PARTIALLY VERIFIED";
  return "VERIFIED";
}

/** One sentence naming the steps that produced the verdict. Never a bare colour. */
export function verdictExplanation(verdict: Verdict, steps: readonly Step[], freshUntil?: number): string {
  const failed = steps.filter((step) => step.status === "FAIL").map((step) => step.id);
  const skipped = steps.filter((step) => step.status === "SKIP").map((step) => step.id);

  switch (verdict) {
    case "FAILED":
      return `A published claim does not hold: ${failed.join(", ")}.`;
    case "STALE":
      return freshUntil === undefined
        ? "The receipt is past its freshness horizon."
        : `Every executed check held, but the receipt stopped being current certification at ${new Date(freshUntil * 1000).toISOString()}. It is history, not a live claim.`;
    case "PARTIALLY VERIFIED":
      return `Nothing contradicts the claim, but ${skipped.length} step(s) could not be checked: ${skipped.join(", ")}.`;
    case "VERIFIED":
      return "Every step was checked against the chain and the disclosed documents, and all of them hold.";
  }
}

/** Text label beside every status glyph. Status is never carried by colour alone. */
export function statusLabel(status: StepStatus): string {
  switch (status) {
    case "PASS":
      return "PASS";
    case "FAIL":
      return "FAIL";
    case "SKIP":
      return "SKIP";
  }
}

/** A geometric glyph, not an icon font, so the status survives a screenshot and a screen reader. */
export function statusGlyph(status: StepStatus): string {
  switch (status) {
    case "PASS":
      return "✓";
    case "FAIL":
      return "✕";
    case "SKIP":
      return "—";
  }
}
