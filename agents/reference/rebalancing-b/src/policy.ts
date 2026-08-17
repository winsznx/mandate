/**
 * Wide Range Manager — the risk policy.
 *
 * Against the Narrow Range Manager's 250 bps band, this agent's 1500 bps band
 * earns less per unit of capital but survives a much larger price move without
 * acting.
 *
 * The numbers are real and published in the agent card even though the
 * deliberation that applies them is not written yet. A trial binds to the
 * parameters, so they have to exist before the strategy does.
 */
import type { CanonicalValue } from "@mandate/domain";

export interface RebalancingBPolicy {
  readonly policyId: string;
  readonly rangeHalfWidthBps: number;
  readonly driftTriggerBps: number;
  readonly minSecondsBetweenRebalances: number;
}

export const REBALANCING_B_POLICY: RebalancingBPolicy = {
  policyId: "wide-range-manager",
  rangeHalfWidthBps: 1_500,
  driftTriggerBps: 600,
  minSecondsBetweenRebalances: 21_600,
};

/** The policy as it appears in the agent card. Wide integers travel as decimal strings. */
export function describePolicy(policy: RebalancingBPolicy): CanonicalValue {
  return {
    policyId: policy.policyId,
    rangeHalfWidthBps: policy.rangeHalfWidthBps,
    driftTriggerBps: policy.driftTriggerBps,
    minSecondsBetweenRebalances: policy.minSecondsBetweenRebalances,
    action: "pending",
  };
}
