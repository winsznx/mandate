/**
 * Diversified Optimizer — the risk policy.
 *
 * The 40% per-venue cap is binding: this agent will hold a worse rate rather
 * than concentrate. The Cost-Aware Optimizer has no such cap.
 *
 * The numbers are real and published in the agent card even though the
 * deliberation that applies them is not written yet. A trial binds to the
 * parameters, so they have to exist before the strategy does.
 */
import type { CanonicalValue } from "@mandate/domain";

export interface YieldBPolicy {
  readonly policyId: string;
  readonly maxVenueSharePercent: number;
  readonly minVenues: number;
  readonly minNetGainBps: number;
}

export const YIELD_B_POLICY: YieldBPolicy = {
  policyId: "diversified-optimizer",
  maxVenueSharePercent: 40,
  minVenues: 3,
  minNetGainBps: 50,
};

/** The policy as it appears in the agent card. Wide integers travel as decimal strings. */
export function describePolicy(policy: YieldBPolicy): CanonicalValue {
  return {
    policyId: policy.policyId,
    maxVenueSharePercent: policy.maxVenueSharePercent,
    minVenues: policy.minVenues,
    minNetGainBps: policy.minNetGainBps,
    action: "pending",
  };
}
