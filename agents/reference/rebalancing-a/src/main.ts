/**
 * Process entry point.
 *
 * Everything the agent needs beyond its strategy — the HTTP face, the agent
 * card, the JSON-RPC decode, logging, the healthcheck — comes from
 * `@mandate/agent-runtime`. The whole of this agent's own surface is the
 * strategy it hands over.
 */
import { createChainClient, readRuntimeConfig, startAgent } from "@mandate/agent-runtime";
import { NARROW_BAND_ALLOCATOR_POLICY } from "./policy.js";
import { createRebalancingStrategy } from "./strategy.js";
import { createAllocationReader, venusAllocationDeploymentFor } from "./venus/index.js";

const config = readRuntimeConfig();
const deployment = venusAllocationDeploymentFor(config.chainId);

await startAgent({
  strategyStatus: "IMPLEMENTED",
  executor: createRebalancingStrategy({
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
  }),
});
