/**
 * Process entry point.
 *
 * Everything the agent needs beyond its strategy — the HTTP face, the agent
 * card, the JSON-RPC decode, logging, the healthcheck — comes from
 * `@mandate/agent-runtime`. The whole of this agent's own surface is the
 * strategy it hands over.
 */
import { createChainClient, readRuntimeConfig, startAgent } from "@mandate/agent-runtime";
import { COST_AWARE_OPTIMIZER_POLICY } from "./policy.js";
import { createYieldStrategy } from "./strategy.js";
import { createSupplyReader, venusSupplyDeploymentFor } from "./venus/index.js";

const config = readRuntimeConfig();
const deployment = venusSupplyDeploymentFor(config.chainId);

await startAgent({
  strategyStatus: "IMPLEMENTED",
  executor: createYieldStrategy({
    slug: "yield-a",
    displayName: "Cost-Aware Optimizer",
    description:
      "Moves idle stablecoin into the Venus Core-pool market paying the best rate, and only when " +
      "that rate clears the cost of moving it. Concentrates without limit: where the best net rate " +
      "is, the capital goes. Acts through vToken.mint(uint256), which takes an amount and no " +
      "recipient. Reference agent built from the BNB Agent Studio scaffold and self-hosted by the " +
      "MANDATE team.",
    policy: COST_AWARE_OPTIMIZER_POLICY,
    deployment,
    reader: createSupplyReader(createChainClient(config), deployment),
  }),
});
