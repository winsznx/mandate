/**
 * The Wide Grid — the same deliberation under a different ladder.
 *
 * The reasoning is imported from `@mandate/agent-grid-a` rather than copied.
 * That is the honest arrangement for a variant pair: the two agents in a
 * category are meant to differ in their published risk parameters and in
 * nothing else, so a reader comparing their receipts is comparing the
 * parameters. Forking the code would let the two drift apart in ways the cards
 * do not disclose, and the trial would then certify an undisclosed difference.
 *
 * The independence that matters runs the other way, between an agent and the
 * model that judges it, and it is untouched by this: `reference/grid` shares
 * `@mandate/domain` and `viem` with both agents and nothing else.
 */
import type { AgentExecutor, ChainClient } from "@mandate/agent-runtime";
import { RUN_GRID_SKILL, createGridStrategy } from "@mandate/agent-grid-a";
import { createPoolReader, poolDeploymentFor } from "@mandate/agent-grid-a/pool";
import type { PoolDeployment, PoolReader } from "@mandate/agent-grid-a/pool";
import { WIDE_GRID_POLICY } from "./policy.js";

export { RUN_GRID_SKILL };
export { createPoolReader, poolDeploymentFor };

export const DISPLAY_NAME = "Wide Grid" as const;

export const DESCRIPTION =
  "Runs a 100 bps grid ladder four rungs deep on a Curve-style stableswap pool, ignoring the small " +
  "dislocations its sibling trades and holding a much smaller inventory swing. Acts through " +
  "exchange(int128,int128,uint256,uint256), which takes two coin indices, an amount and a minimum " +
  "output, and no recipient. Reference agent built from the BNB Agent Studio scaffold and " +
  "self-hosted by the MANDATE team.";

export interface WideGridStrategyOptions {
  readonly deployment: PoolDeployment;
  readonly reader: PoolReader;
}

export function createStrategy(options: WideGridStrategyOptions): AgentExecutor {
  return createGridStrategy({
    slug: "grid-b",
    displayName: DISPLAY_NAME,
    description: DESCRIPTION,
    policy: WIDE_GRID_POLICY,
    deployment: options.deployment,
    reader: options.reader,
  });
}

/** The strategy wired to a live chain client, for the process entry point. */
export function createLiveStrategy(client: ChainClient, chainId: number): AgentExecutor {
  const deployment = poolDeploymentFor(chainId);
  return createStrategy({ deployment, reader: createPoolReader(client, deployment) });
}
