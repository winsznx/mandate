/**
 * Read-only chain access.
 *
 * Deliberately a `PublicClient` and never a wallet client. An agent that cannot
 * construct a signer cannot execute the action it proposes, which turns the
 * architectural rule in `executor.ts` into something the type system helps
 * enforce rather than something a reviewer has to notice.
 *
 * The fallback transport matters more on BSC than it looks: free endpoints
 * disappear without notice (`00-DECISIONS.md` §1.1 lists five that are now dead
 * or gated), and a trial that fails because one dataseed rate-limited is a
 * false negative against the agent.
 */
import { createPublicClient, fallback, http } from "viem";
import type { PublicClient } from "viem";
import type { AgentRuntimeConfig } from "./config.js";

export type ChainClient = PublicClient;

export function createChainClient(config: AgentRuntimeConfig): ChainClient {
  const endpoints = [config.rpcUrl, ...(config.fallbackRpcUrl === undefined ? [] : [config.fallbackRpcUrl])];
  return createPublicClient({
    transport: fallback(endpoints.map((url) => http(url, { retryCount: 2 }))),
  });
}
