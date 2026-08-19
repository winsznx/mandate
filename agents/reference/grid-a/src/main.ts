/**
 * Process entry point.
 *
 * Everything the agent needs beyond its strategy — the HTTP face, the agent
 * card, the JSON-RPC decode, logging, the healthcheck — comes from
 * `@mandate/agent-runtime`. The whole of this agent's own surface is the
 * strategy it hands over.
 */
import { createChainClient, readRuntimeConfig, startAgent } from "@mandate/agent-runtime";
import { TIGHT_GRID_POLICY } from "./policy.js";
import { createGridStrategy } from "./strategy.js";
import { createPoolReader, poolDeploymentFor } from "./pool/index.js";

const config = readRuntimeConfig();
const deployment = poolDeploymentFor(config.chainId);

await startAgent({
  strategyStatus: "IMPLEMENTED",
  executor: createGridStrategy({
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
  }),
});
