/**
 * The Efficient Guardian's risk policy.
 *
 * Published in the agent card and hashed into `TrialTask.parametersHash`, so
 * these numbers are part of what a trial certifies rather than an internal
 * tuning knob. Changing one produces a different card hash, which supersedes
 * any receipt earned under the old values.
 *
 * The pair in this category differ on one axis, deliberately. The Conservative
 * Guardian intervenes at 1.30 and restores to 1.35; this agent lets the position
 * run to 1.15 and restores only to 1.20. What the thinner buffer buys is fewer
 * interventions and a smaller repay when one comes, so more of the user's
 * capital stays borrowed. What it costs is the buffer itself: this agent acts
 * with 15 points of margin above liquidation where its sibling acts with 30, and
 * a price move that its sibling has room to absorb is one this agent does not.
 * An evaluator that cannot tell the two apart on the same state is measuring the
 * category, not the agents.
 *
 * The tighter drift tolerance follows from the same choice rather than being a
 * second opinion. `maxReconstructionDriftBps` bounds the error permitted in the
 * collateral figure, and that error propagates into the health factor
 * proportionally: 200 bps of drift at the sibling's 1.30 threshold is 0.026 of
 * health factor, which is 8.7% of its 0.30 margin to liquidation, while the same
 * 200 bps at 1.15 is 0.023 against a 0.15 margin — 15.3%, nearly twice the share.
 * Halving the tolerance to 100 bps puts this agent back at 7.7%. An agent that
 * runs closer to the line has to reproduce the protocol's own number more
 * exactly, not less, because it has less room to be wrong in.
 */
import type { CanonicalValue } from "@mandate/domain";
import { MANTISSA } from "@mandate/agent-health-factor-a/venus";
import { describePolicy as describeHealthFactorPolicy } from "@mandate/agent-health-factor-a/policy";
import type { HealthFactorPolicy } from "@mandate/agent-health-factor-a/policy";

export type { HealthFactorPolicy };

export const EFFICIENT_GUARDIAN_POLICY: HealthFactorPolicy = {
  policyId: "efficient-guardian",
  interventionThresholdMantissa: (115n * MANTISSA) / 100n,
  targetHealthFactorMantissa: (120n * MANTISSA) / 100n,
  minimumRepayUsdMantissa: MANTISSA,
  maxReconstructionDriftBps: 100,
};

/**
 * The policy as it appears in the agent card.
 *
 * Rendered by the same function the sibling uses, so the two cards are
 * comparable field for field. A reader deciding between them is looking at one
 * document with different numbers in it rather than two documents that have to
 * be reconciled first.
 */
export function describePolicy(policy: HealthFactorPolicy): CanonicalValue {
  return describeHealthFactorPolicy(policy);
}
