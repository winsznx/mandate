/**
 * Cost-Aware Optimizer — the risk policy.
 *
 * This agent will concentrate everything in one venue if that is where the
 * net-of-cost yield is. The Diversified Optimizer will not, which is the whole
 * difference between them.
 *
 * The numbers are real and published in the agent card even though the
 * deliberation that applies them is not written yet. A trial binds to the
 * parameters, so they have to exist before the strategy does.
 */
import type { CanonicalValue } from "@mandate/domain";

export interface YieldAPolicy {
  readonly policyId: string;
  readonly minNetGainBps: number;
  readonly maxMovesPerDay: number;
  readonly gasCostBufferBps: number;
}

export const YIELD_A_POLICY: YieldAPolicy = {
  policyId: "cost-aware-optimizer",
  minNetGainBps: 75,
  maxMovesPerDay: 1,
  gasCostBufferBps: 25,
};

/** The policy as it appears in the agent card. Wide integers travel as decimal strings. */
export function describePolicy(policy: YieldAPolicy): CanonicalValue {
  return {
    policyId: policy.policyId,
    minNetGainBps: policy.minNetGainBps,
    maxMovesPerDay: policy.maxMovesPerDay,
    gasCostBufferBps: policy.gasCostBufferBps,
    action: "pending",
  };
}
