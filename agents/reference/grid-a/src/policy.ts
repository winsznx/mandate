/**
 * Tight Grid — the risk policy.
 *
 * The rungs are fixed at 50 bps regardless of conditions. The Adaptive Grid
 * widens and narrows with realised volatility instead, so the two diverge
 * sharply in a fast market.
 *
 * The numbers are real and published in the agent card even though the
 * deliberation that applies them is not written yet. A trial binds to the
 * parameters, so they have to exist before the strategy does.
 */
import type { CanonicalValue } from "@mandate/domain";

export interface GridAPolicy {
  readonly policyId: string;
  readonly gridSpacingBps: number;
  readonly gridLevels: number;
  readonly repriceTriggerBps: number;
}

export const GRID_A_POLICY: GridAPolicy = {
  policyId: "tight-grid",
  gridSpacingBps: 50,
  gridLevels: 20,
  repriceTriggerBps: 150,
};

/** The policy as it appears in the agent card. Wide integers travel as decimal strings. */
export function describePolicy(policy: GridAPolicy): CanonicalValue {
  return {
    policyId: policy.policyId,
    gridSpacingBps: policy.gridSpacingBps,
    gridLevels: policy.gridLevels,
    repriceTriggerBps: policy.repriceTriggerBps,
    action: "pending",
  };
}
