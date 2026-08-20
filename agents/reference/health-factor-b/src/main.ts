/**
 * Process entry point.
 *
 * Identical in shape to every other reference agent: the HTTP face, the agent
 * card, the JSON-RPC decode, logging and the healthcheck all come from
 * `@mandate/agent-runtime`. This agent contributes a policy and nothing else,
 * because the deliberation is its sibling's.
 *
 * The chain client the runtime hands over is a read-only viem `PublicClient`.
 * There is no signer here to construct even by accident: this agent proposes a
 * repay and the deterministic layer decides whether it is within the mandate.
 */
import { createChainClient, readRuntimeConfig, startAgent } from "@mandate/agent-runtime";
import { createLiveStrategy } from "./strategy.js";

const config = readRuntimeConfig();

await startAgent({
  strategyStatus: "IMPLEMENTED",
  executor: createLiveStrategy(createChainClient(config), config.chainId),
});
