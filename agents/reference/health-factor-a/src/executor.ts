/**
 * This agent's executor, built from a runtime config.
 *
 * Split out of `main.ts` so both the `node:http` entry point and the
 * Cloudflare Workers gateway construct the identical executor.
 */
import { createChainClient } from "@mandate/agent-runtime";
import type { AgentExecutor, AgentRuntimeConfig } from "@mandate/agent-runtime";
import { venusDeploymentFor } from "./venus/addresses.js";
import { createVenusReader } from "./venus/reader.js";
import { createHealthFactorStrategy } from "./strategy.js";
import { CONSERVATIVE_GUARDIAN_POLICY } from "./policy.js";

export function buildExecutor(config: AgentRuntimeConfig): AgentExecutor {
  const deployment = venusDeploymentFor(config.chainId);
  return createHealthFactorStrategy({
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
  });
}
