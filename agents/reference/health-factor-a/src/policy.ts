/**
 * The Conservative Guardian's risk policy.
 *
 * Published in the agent card and hashed into `TrialTask.parametersHash`, so
 * these numbers are part of what a trial certifies rather than an internal
 * tuning knob. Changing one produces a different card hash, which supersedes
 * any receipt earned under the old values.
 *
 * The pair in this category differ on purpose. Conservative intervenes at 1.30
 * and restores to 1.35; the Efficient Guardian runs closer to the line at 1.15.
 * An evaluator that cannot tell two agents in a category apart is measuring the
 * category, not the agents.
 */
import type { CanonicalValue } from "@mandate/domain";
import { MANTISSA } from "./venus/health.js";

export interface HealthFactorPolicy {
  readonly policyId: string;
  /** Act strictly below this. At the threshold exactly, hold. */
  readonly interventionThresholdMantissa: bigint;
  readonly targetHealthFactorMantissa: bigint;
  /** Below this the repay costs more in gas and disruption than the health it buys. */
  readonly minimumRepayUsdMantissa: bigint;
  /**
   * Tolerance between `getAccountLiquidity` and the markets-derived
   * reconstruction. Interest accrues and prices tick between reads, so some
   * drift is expected; a wide gap means a decode or a scaling error and the
   * agent holds rather than acting on a number it cannot reproduce.
   */
  readonly maxReconstructionDriftBps: number;
}

export const CONSERVATIVE_GUARDIAN_POLICY: HealthFactorPolicy = {
  policyId: "conservative-guardian",
  interventionThresholdMantissa: (130n * MANTISSA) / 100n,
  targetHealthFactorMantissa: (135n * MANTISSA) / 100n,
  minimumRepayUsdMantissa: MANTISSA,
  maxReconstructionDriftBps: 200,
};

/** The policy as it appears in the agent card. Wide integers travel as decimal strings. */
export function describePolicy(policy: HealthFactorPolicy): CanonicalValue {
  return {
    policyId: policy.policyId,
    interventionThresholdMantissa: policy.interventionThresholdMantissa.toString(10),
    targetHealthFactorMantissa: policy.targetHealthFactorMantissa.toString(10),
    minimumRepayUsdMantissa: policy.minimumRepayUsdMantissa.toString(10),
    maxReconstructionDriftBps: policy.maxReconstructionDriftBps,
    healthFactorSource: "Comptroller.getAccountLiquidity",
    healthFactorWeighting: "LIQUIDATION_THRESHOLD",
    action: "repayBorrow(uint256)",
  };
}
