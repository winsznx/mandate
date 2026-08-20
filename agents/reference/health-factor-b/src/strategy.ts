/**
 * The Efficient Guardian — the same deliberation under a thinner buffer.
 *
 * The reasoning is imported from `@mandate/agent-health-factor-a` rather than
 * copied. That is the honest arrangement for a variant pair: the two agents in
 * a category are meant to differ in their published risk parameters and in
 * nothing else, so a reader comparing their receipts is comparing the
 * parameters. Forking the code would let the two drift apart in ways the cards
 * do not disclose, and the trial would then be certifying an undisclosed
 * difference.
 *
 * The independence that matters runs the other way, between an agent and the
 * model that judges it, and it is untouched by this: `reference/health-factor`
 * shares `@mandate/domain` and `viem` with both agents and nothing else.
 *
 * Everything the sibling refuses to act on, this agent refuses to act on too.
 * The implementation pin, the VAI term, the reconstruction cross-check and the
 * single authorised market are properties of the protocol and of the authority,
 * not of the threshold, so they are inherited rather than re-argued.
 */
import type { AgentExecutor, ChainClient } from "@mandate/agent-runtime";
import {
  RESTORE_HEALTH_FACTOR_SKILL,
  createHealthFactorStrategy,
} from "@mandate/agent-health-factor-a";
import { createVenusReader, venusDeploymentFor } from "@mandate/agent-health-factor-a/venus";
import type { VenusDeployment, VenusReader } from "@mandate/agent-health-factor-a/venus";
import { EFFICIENT_GUARDIAN_POLICY } from "./policy.js";

export { RESTORE_HEALTH_FACTOR_SKILL };
export { createVenusReader, venusDeploymentFor };

export const DISPLAY_NAME = "Efficient Guardian" as const;

export const DESCRIPTION =
  "Defends a Venus Core-pool borrow position on BNB Smart Chain, running closer to the liquidation " +
  "line than the Conservative Guardian. Intervenes when the liquidation-threshold-weighted health " +
  "factor falls below 1.15 and proposes a repayBorrow(uint256) that restores it to 1.20, leaving " +
  "more of the position borrowed at the cost of a thinner buffer. Reference agent built from the " +
  "BNB Agent Studio scaffold and self-hosted by the MANDATE team.";

export interface EfficientGuardianStrategyOptions {
  readonly deployment: VenusDeployment;
  readonly reader: VenusReader;
}

export function createStrategy(options: EfficientGuardianStrategyOptions): AgentExecutor {
  return createHealthFactorStrategy({
    slug: "health-factor-b",
    displayName: DISPLAY_NAME,
    description: DESCRIPTION,
    policy: EFFICIENT_GUARDIAN_POLICY,
    deployment: options.deployment,
    reader: options.reader,
  });
}

/** The strategy wired to a live chain client, for the process entry point. */
export function createLiveStrategy(client: ChainClient, chainId: number): AgentExecutor {
  const deployment = venusDeploymentFor(chainId);
  return createStrategy({ deployment, reader: createVenusReader(client, deployment) });
}
