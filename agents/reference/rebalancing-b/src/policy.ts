/**
 * The Wide Band Allocator's risk policy.
 *
 * The 600 bps band is the whole difference between this agent and the Narrow
 * Band Allocator, and it is binding rather than decorative: on a portfolio one
 * percent away from its published weights this agent does nothing while its
 * sibling spends the user's money to correct it. Two agents in a category that
 * behave identically on every state make the category the unit of measurement,
 * and the point of a trial is that the agent is.
 *
 * The destination is deliberately identical. Both agents publish the same
 * equal-weight allocation across the two live Core-pool stablecoin markets, so
 * a buyer comparing their receipts is comparing tolerances rather than
 * reconciling two unrelated mandates. What a wider band buys is fewer
 * transactions and less gas drag; what it costs is a portfolio that spends more
 * of its life away from the weights it advertises.
 */
import type { CanonicalValue } from "@mandate/domain";
import {
  STABLECOIN_PARITY_TARGETS,
  createRebalancingPolicy,
  describePolicy as describeRebalancingPolicy,
} from "@mandate/agent-rebalancing-a/policy";
import type { RebalancingPolicy } from "@mandate/agent-rebalancing-a/policy";

export type { RebalancingPolicy };

export const WIDE_BAND_ALLOCATOR_POLICY: RebalancingPolicy = createRebalancingPolicy({
  policyId: "wide-band-allocator",
  targets: STABLECOIN_PARITY_TARGETS,
  driftTriggerBps: 600,
  minRebalanceUsdMantissa: 10n * 10n ** 18n,
  amountToleranceBps: 50,
});

/**
 * The policy as it appears in the agent card.
 *
 * Rendered by the same function the sibling uses, so the two cards are
 * comparable field for field. A reader deciding between them is looking at one
 * document with different numbers in it rather than two documents that have to
 * be reconciled first.
 */
export function describePolicy(policy: RebalancingPolicy): CanonicalValue {
  return describeRebalancingPolicy(policy);
}
