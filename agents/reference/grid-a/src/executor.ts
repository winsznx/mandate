/**
 * This agent's executor, built from a runtime config.
 *
 * Split out of `main.ts` so both the `node:http` entry point and the
 * Cloudflare Workers gateway construct the identical executor.
 */
import { createChainClient } from "@mandate/agent-runtime";
import type { AgentExecutor, AgentRuntimeConfig } from "@mandate/agent-runtime";
import { TIGHT_GRID_POLICY } from "./policy.js";
import { createGridStrategy } from "./strategy.js";
import { createPoolReader, poolDeploymentFor } from "./pool/index.js";

export function buildExecutor(config: AgentRuntimeConfig): AgentExecutor {
  const deployment = poolDeploymentFor(config.chainId);
  return createGridStrategy({
    slug: "grid-a",
    displayName: "Tight Grid",
    description:
      "Runs a 25 bps grid ladder eight rungs deep on a Curve-style stableswap pool, harvesting small " +
      "dislocations and carrying a larger inventory swing as a result. Acts through " +
      "exchange(int128,int128,uint256,uint256), which takes two coin indices, an amount and a " +
      "minimum output, and no recipient. Reference agent built from the BNB Agent Studio scaffold " +
      "and self-hosted by the MANDATE team.",
    policy: TIGHT_GRID_POLICY,
    deployment,
    reader: createPoolReader(createChainClient(config), deployment),
  });
}
