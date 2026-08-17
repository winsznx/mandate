/**
 * Process entry point.
 *
 * Identical in shape to every other reference agent: the HTTP face, the agent
 * card, the JSON-RPC decode, logging and the healthcheck all come from
 * `@mandate/agent-runtime`. This agent contributes a strategy and nothing else,
 * and that strategy is a declared stub.
 */
import { startAgent } from "@mandate/agent-runtime";
import { createStrategy } from "./strategy.js";

await startAgent({ executor: createStrategy(), strategyStatus: "PENDING" });
