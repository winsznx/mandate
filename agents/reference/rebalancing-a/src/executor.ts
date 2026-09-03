/**
 * This agent's executor, built from a runtime config.
 *
 * Split out of `main.ts` so both the `node:http` entry point and the
 * Cloudflare Workers gateway construct the identical executor.
 */
import { createChainClient } from "@mandate/agent-runtime";
import type { AgentExecutor, AgentRuntimeConfig } from "@mandate/agent-runtime";
import { NARROW_BAND_ALLOCATOR_POLICY } from "./policy.js";
import { createRebalancingStrategy } from "./strategy.js";
import { createAllocationReader, venusAllocationDeploymentFor } from "./venus/index.js";

export function buildExecutor(config: AgentRuntimeConfig): AgentExecutor {
  const deployment = venusAllocationDeploymentFor(config.chainId);
  return createRebalancingStrategy({
    slug: "rebalancing-a",
    displayName: "Narrow Band Allocator",
    description:
      "Holds an equal-weight allocation across the Venus Core-pool stablecoin markets and corrects " +
      "it as soon as a market falls 100 bps of the portfolio behind its target. Tops up the " +
      "under-weight side through vToken.mint(uint256), which takes an amount and no recipient; it " +
      "never withdraws, because redeemUnderlying(uint256) can push a borrowing account's health " +
      "factor below one and needs a guard this authority does not carry. Reference agent built " +
      "from the BNB Agent Studio scaffold and self-hosted by the MANDATE team.",
    policy: NARROW_BAND_ALLOCATOR_POLICY,
    deployment,
    reader: createAllocationReader(createChainClient(config), deployment),
  });
}
