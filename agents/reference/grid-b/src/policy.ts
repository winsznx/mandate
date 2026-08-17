/**
 * Adaptive Grid — the risk policy.
 *
 * Where the Tight Grid holds 50 bps rungs through anything, this agent moves
 * between 80 and 400 bps. In a calm market the two behave alike; in a violent
 * one they do not.
 *
 * The numbers are real and published in the agent card even though the
 * deliberation that applies them is not written yet. A trial binds to the
 * parameters, so they have to exist before the strategy does.
 */
import type { CanonicalValue } from "@mandate/domain";

export interface GridBPolicy {
  readonly policyId: string;
  readonly minGridSpacingBps: number;
  readonly maxGridSpacingBps: number;
  readonly gridLevels: number;
  readonly volatilityLookbackSeconds: number;
}

export const GRID_B_POLICY: GridBPolicy = {
  policyId: "adaptive-grid",
  minGridSpacingBps: 80,
  maxGridSpacingBps: 400,
  gridLevels: 12,
  volatilityLookbackSeconds: 86_400,
};

/** The policy as it appears in the agent card. Wide integers travel as decimal strings. */
export function describePolicy(policy: GridBPolicy): CanonicalValue {
  return {
    policyId: policy.policyId,
    minGridSpacingBps: policy.minGridSpacingBps,
    maxGridSpacingBps: policy.maxGridSpacingBps,
    gridLevels: policy.gridLevels,
    volatilityLookbackSeconds: policy.volatilityLookbackSeconds,
    action: "pending",
  };
}
