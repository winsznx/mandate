/**
 * Process entry point for local runs and the Docker image.
 *
 * The HTTP face, the agent card, the JSON-RPC decode, logging and the
 * healthcheck all come from `@mandate/agent-runtime`. The executor is built in
 * `executor.ts` so the Workers gateway can construct the same one.
 */
import { readRuntimeConfig, startAgent } from "@mandate/agent-runtime";
import { buildExecutor } from "./executor.js";

await startAgent({
  strategyStatus: "IMPLEMENTED",
  executor: buildExecutor(readRuntimeConfig()),
});
