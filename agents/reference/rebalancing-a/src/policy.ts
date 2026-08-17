/**
 * Narrow Range Manager — the risk policy.
 *
 * Against the Wide Range Manager's 1500 bps band, this agent's 250 bps band
 * earns more fees while price stays inside it and rebalances far more often
 * when price moves.
 *
 * The numbers are real and published in the agent card even though the
 * deliberation that applies them is not written yet. A trial binds to the
 * parameters, so they have to exist before the strategy does.
 */
import type { CanonicalValue } from "@mandate/domain";

export interface RebalancingAPolicy {
  readonly policyId: string;
  readonly rangeHalfWidthBps: number;
  readonly driftTriggerBps: number;
  readonly minSecondsBetweenRebalances: number;
}

export const REBALANCING_A_POLICY: RebalancingAPolicy = {
  policyId: "narrow-range-manager",
  rangeHalfWidthBps: 250,
  driftTriggerBps: 100,
  minSecondsBetweenRebalances: 3_600,
};

/** The policy as it appears in the agent card. Wide integers travel as decimal strings. */
export function describePolicy(policy: RebalancingAPolicy): CanonicalValue {
  return {
    policyId: policy.policyId,
    rangeHalfWidthBps: policy.rangeHalfWidthBps,
    driftTriggerBps: policy.driftTriggerBps,
    minSecondsBetweenRebalances: policy.minSecondsBetweenRebalances,
    action: "pending",
  };
}
