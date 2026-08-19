/**
 * The Diversified Optimizer — the same deliberation under a different policy.
 *
 * The reasoning is imported from `@mandate/agent-yield-a` rather than copied.
 * That is the honest arrangement for a variant pair: the two agents in a
 * category are meant to differ in their published risk parameters and in
 * nothing else, so a reader comparing their receipts is comparing the
 * parameters. Forking the code would let the two drift apart in ways the cards
 * do not disclose, and the trial would then be certifying an undisclosed
 * difference.
 *
 * The independence that matters runs the other way, between an agent and the
 * model that judges it, and it is untouched by this: `reference/yield` shares
 * `@mandate/domain` and `viem` with both agents and nothing else.
 */
import type { AgentExecutor } from "@mandate/agent-runtime";
import { OPTIMISE_YIELD_SKILL, createYieldStrategy } from "@mandate/agent-yield-a";
import { createSupplyReader, venusSupplyDeploymentFor } from "@mandate/agent-yield-a/venus";
import type { SupplyReader, VenusSupplyDeployment } from "@mandate/agent-yield-a/venus";
import type { ChainClient } from "@mandate/agent-runtime";
import { DIVERSIFIED_OPTIMIZER_POLICY } from "./policy.js";

export { OPTIMISE_YIELD_SKILL };
export { createSupplyReader, venusSupplyDeploymentFor };

export const DISPLAY_NAME = "Diversified Optimizer" as const;

export const DESCRIPTION =
  "Moves idle stablecoin into Venus Core-pool markets under a 60% per-market ceiling, accepting a " +
  "lower headline rate rather than concentrating the whole position in one market. Acts through " +
  "vToken.mint(uint256), which takes an amount and no recipient. Reference agent built from the " +
  "BNB Agent Studio scaffold and self-hosted by the MANDATE team.";

export interface DiversifiedStrategyOptions {
  readonly deployment: VenusSupplyDeployment;
  readonly reader: SupplyReader;
}

export function createStrategy(options: DiversifiedStrategyOptions): AgentExecutor {
  return createYieldStrategy({
    slug: "yield-b",
    displayName: DISPLAY_NAME,
    description: DESCRIPTION,
    policy: DIVERSIFIED_OPTIMIZER_POLICY,
    deployment: options.deployment,
    reader: options.reader,
  });
}

/** The strategy wired to a live chain client, for the process entry point. */
export function createLiveStrategy(client: ChainClient, chainId: number): AgentExecutor {
  const deployment = venusSupplyDeploymentFor(chainId);
  return createStrategy({ deployment, reader: createSupplyReader(client, deployment) });
}
