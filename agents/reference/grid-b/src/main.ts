/**
 * Process entry point.
 *
 * Identical in shape to every other reference agent: the HTTP face, the agent
 * card, the JSON-RPC decode, logging and the healthcheck all come from
 * `@mandate/agent-runtime`. This agent contributes a ladder and nothing else,
 * because the deliberation is its sibling's.
 */
import { createChainClient, readRuntimeConfig, startAgent } from "@mandate/agent-runtime";
import { createLiveStrategy } from "./strategy.js";

const config = readRuntimeConfig();

await startAgent({
  strategyStatus: "IMPLEMENTED",
  executor: createLiveStrategy(createChainClient(config), config.chainId),
});
