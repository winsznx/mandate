/**
 * Process entry point.
 *
 * Everything the agent needs beyond its strategy — the HTTP face, the agent
 * card, the JSON-RPC decode, logging, the healthcheck — comes from
 * `@mandate/agent-runtime`. The whole of this agent's own surface is the
 * strategy it hands over.
 */
import { createChainClient, readRuntimeConfig, startAgent } from "@mandate/agent-runtime";
import { venusDeploymentFor } from "./venus/addresses.js";
import { createVenusReader } from "./venus/reader.js";
import { createHealthFactorStrategy } from "./strategy.js";
import { CONSERVATIVE_GUARDIAN_POLICY } from "./policy.js";

const config = readRuntimeConfig();
const deployment = venusDeploymentFor(config.chainId);

await startAgent({
  strategyStatus: "IMPLEMENTED",
  executor: createHealthFactorStrategy({
    slug: "health-factor-a",
    displayName: "Conservative Guardian",
    description:
      "Defends a Venus Core-pool borrow position on BNB Smart Chain. Intervenes when the " +
      "liquidation-threshold-weighted health factor falls below 1.30 and proposes a repayBorrow " +
      "that restores it to 1.35. Reference agent built from the BNB Agent Studio scaffold and " +
      "self-hosted by the MANDATE team.",
    policy: CONSERVATIVE_GUARDIAN_POLICY,
    deployment,
    reader: createVenusReader(createChainClient(config), deployment),
  }),
});
