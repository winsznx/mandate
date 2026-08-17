/**
 * Efficient Guardian — the risk policy.
 *
 * The pair in this category differ only in where they draw the line. The
 * Conservative Guardian intervenes at 1.30 and restores to 1.35; this agent
 * tolerates a thinner buffer in exchange for leaving more capital borrowed. An
 * evaluator that cannot separate the two is measuring the category rather than
 * the agents.
 *
 * The numbers are real and published in the agent card even though the
 * deliberation that applies them is not written yet. A trial binds to the
 * parameters, so they have to exist before the strategy does.
 */
import type { CanonicalValue } from "@mandate/domain";

const MANTISSA = 10n ** 18n;

export interface HealthFactorBPolicy {
  readonly policyId: string;
  readonly interventionThresholdMantissa: bigint;
  readonly targetHealthFactorMantissa: bigint;
  readonly minimumRepayUsdMantissa: bigint;
}

export const HEALTH_FACTOR_B_POLICY: HealthFactorBPolicy = {
  policyId: "efficient-guardian",
  interventionThresholdMantissa: (115n * MANTISSA) / 100n,
  targetHealthFactorMantissa: (120n * MANTISSA) / 100n,
  minimumRepayUsdMantissa: MANTISSA,
};

/** The policy as it appears in the agent card. Wide integers travel as decimal strings. */
export function describePolicy(policy: HealthFactorBPolicy): CanonicalValue {
  return {
    policyId: policy.policyId,
    interventionThresholdMantissa: policy.interventionThresholdMantissa.toString(10),
    targetHealthFactorMantissa: policy.targetHealthFactorMantissa.toString(10),
    minimumRepayUsdMantissa: policy.minimumRepayUsdMantissa.toString(10),
    healthFactorSource: "Comptroller.getAccountLiquidity",
    healthFactorWeighting: "LIQUIDATION_THRESHOLD",
    action: "repayBorrow(uint256)",
  };
}
