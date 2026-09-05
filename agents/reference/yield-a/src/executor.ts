/**
 * This agent's executor, built from a runtime config.
 *
 * Split out of `main.ts` so both the `node:http` entry point and the
 * Cloudflare Workers gateway construct the identical executor.
 */
import { createChainClient } from "@mandate/agent-runtime";
import type { AgentExecutor, AgentRuntimeConfig } from "@mandate/agent-runtime";
import { COST_AWARE_OPTIMIZER_POLICY } from "./policy.js";
import { createYieldStrategy } from "./strategy.js";
import { createSupplyReader, venusSupplyDeploymentFor } from "./venus/index.js";

export function buildExecutor(config: AgentRuntimeConfig): AgentExecutor {
  const deployment = venusSupplyDeploymentFor(config.chainId);
  return createYieldStrategy({
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
  });
}
