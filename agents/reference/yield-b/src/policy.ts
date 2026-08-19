/**
 * The Diversified Optimizer's risk policy.
 *
 * The 6000 bps per-market ceiling is the whole difference between this agent
 * and the Cost-Aware Optimizer, and it is binding rather than decorative: on a
 * portfolio already 60% concentrated in the best-paying market, this agent
 * deploys nothing there and either falls to the next market or holds, while its
 * sibling puts everything in. Two agents in a category that behave identically
 * on every state make the category the unit of measurement, and the point of a
 * trial is that the agent is.
 *
 * The rate floor is lower here for a reason that follows from the same choice.
 * An agent that must spread across markets will spend part of its capital in
 * the second-best one, so holding out for the same headline rate would leave it
 * permanently idle. Accepting 50 bps net is the price of the constraint.
 */
import type { CanonicalValue } from "@mandate/domain";
import { BLOCKS_PER_YEAR, describePolicy as describeYieldPolicy } from "@mandate/agent-yield-a/policy";
import type { YieldPolicy } from "@mandate/agent-yield-a/policy";

export type { YieldPolicy };

export const DIVERSIFIED_OPTIMIZER_POLICY: YieldPolicy = {
  policyId: "diversified-optimizer",
  minNetSupplyRateBps: 50,
  gasCostBufferBps: 25,
  blocksPerYear: BLOCKS_PER_YEAR,
  minDeploymentUsdMantissa: 10n * 10n ** 18n,
  maxVenueShareBps: 6_000,
  amountToleranceBps: 50,
};

/**
 * The policy as it appears in the agent card.
 *
 * Rendered by the same function the sibling uses, so the two cards are
 * comparable field for field. A reader deciding between them is looking at one
 * document with different numbers in it rather than two documents that have to
 * be reconciled first.
 */
export function describePolicy(policy: YieldPolicy): CanonicalValue {
  return describeYieldPolicy(policy);
}
