/**
 * This agent's executor, built from a runtime config.
 *
 * Split out of `main.ts` so both the `node:http` entry point and the
 * Cloudflare Workers gateway construct the identical executor.
 */
import { createChainClient } from "@mandate/agent-runtime";
import type { AgentExecutor, AgentRuntimeConfig } from "@mandate/agent-runtime";
import { createLiveStrategy } from "./strategy.js";

export function buildExecutor(config: AgentRuntimeConfig): AgentExecutor {
  return createLiveStrategy(createChainClient(config), config.chainId);
}
