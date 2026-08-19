/**
 * The Wide Band Allocator — the same deliberation under a different band.
 *
 * The reasoning is imported from `@mandate/agent-rebalancing-a` rather than
 * copied. That is the honest arrangement for a variant pair: the two agents in
 * a category are meant to differ in their published risk parameters and in
 * nothing else, so a reader comparing their receipts is comparing the
 * parameters. Forking the code would let the two drift apart in ways the cards
 * do not disclose, and the trial would then be certifying an undisclosed
 * difference.
 *
 * The independence that matters runs the other way, between an agent and the
 * model that judges it, and it is untouched by this: `reference/rebalancing`
 * shares `@mandate/domain` and `viem` with both agents and nothing else.
 *
 * The top-up-only limitation is inherited along with everything else. This
 * agent acts less often than its sibling, so it meets the case less often, but
 * when a gap can only be closed by withdrawing from the over-weight side it
 * holds and names `redeemUnderlying(uint256)` in exactly the same words.
 */
import type { AgentExecutor, ChainClient } from "@mandate/agent-runtime";
import { REBALANCE_ALLOCATION_SKILL, createRebalancingStrategy } from "@mandate/agent-rebalancing-a";
import {
  createAllocationReader,
  venusAllocationDeploymentFor,
} from "@mandate/agent-rebalancing-a/venus";
import type { AllocationReader, VenusAllocationDeployment } from "@mandate/agent-rebalancing-a/venus";
import { WIDE_BAND_ALLOCATOR_POLICY } from "./policy.js";

export { REBALANCE_ALLOCATION_SKILL };
export { createAllocationReader, venusAllocationDeploymentFor };

export const DISPLAY_NAME = "Wide Band Allocator" as const;

export const DESCRIPTION =
  "Holds an equal-weight allocation across the Venus Core-pool stablecoin markets and lets it " +
  "wander 600 bps of the portfolio before correcting, trading a portfolio that sits further from " +
  "its weights for far fewer transactions. Tops up the under-weight side through " +
  "vToken.mint(uint256), which takes an amount and no recipient; it never withdraws, because " +
  "redeemUnderlying(uint256) can push a borrowing account's health factor below one and needs a " +
  "guard this authority does not carry. Reference agent built from the BNB Agent Studio scaffold " +
  "and self-hosted by the MANDATE team.";

export interface WideBandStrategyOptions {
  readonly deployment: VenusAllocationDeployment;
  readonly reader: AllocationReader;
}

export function createStrategy(options: WideBandStrategyOptions): AgentExecutor {
  return createRebalancingStrategy({
    slug: "rebalancing-b",
    displayName: DISPLAY_NAME,
    description: DESCRIPTION,
    policy: WIDE_BAND_ALLOCATOR_POLICY,
    deployment: options.deployment,
    reader: options.reader,
  });
}

/** The strategy wired to a live chain client, for the process entry point. */
export function createLiveStrategy(client: ChainClient, chainId: number): AgentExecutor {
  const deployment = venusAllocationDeploymentFor(chainId);
  return createStrategy({ deployment, reader: createAllocationReader(client, deployment) });
}
