/**
 * Narrow Range Manager — scaffold only.
 *
 * The card, the category, the skill and the policy are real. The deliberation
 * is not written, and the agent says so on the wire rather than returning a
 * plausible-looking proposal: `pendingStrategy` rejects with
 * `StrategyNotImplementedError`, which the runtime maps to its own JSON-RPC
 * code so a trial record can tell "not written" apart from "crashed".
 *
 * Every PancakeSwap entry point worth rebalancing through puts a recipient
 * address in calldata, which `(target, selector)` permissions cannot
 * constrain. This category therefore depends on the typed guard, not just on a
 * strategy being written.
 */
import { pendingStrategy } from "@mandate/agent-runtime";
import type { AgentExecutor, AgentSkill } from "@mandate/agent-runtime";
import { REBALANCING_A_POLICY, describePolicy } from "./policy.js";

export const REBALANCE_RANGE_SKILL: AgentSkill = {
  id: "rebalance-range",
  name: "Rebalance a liquidity range",
  description:
    "Rebalance a liquidity range on PancakeSwap V3 concentrated liquidity. Returns a proposed action; it never executes one. " +
    "This strategy is not implemented yet and refuses every request.",
  tags: ["pancakeswap","bnb-chain","defi","rebalancing"],
};

export const DISPLAY_NAME = "Narrow Range Manager" as const;

export const DESCRIPTION =
  "Keeps a concentrated-liquidity position centred on price inside a tight band, trading more frequent rebalances for higher fee capture per unit of capital. " +
  "Reference agent built from the BNB Agent Studio scaffold and self-hosted by the MANDATE team. " +
  "Strategy pending.";

export function createStrategy(): AgentExecutor {
  return pendingStrategy({
    slug: "rebalancing-a",
    displayName: DISPLAY_NAME,
    description: DESCRIPTION,
    category: "REBALANCING",
    skills: [REBALANCE_RANGE_SKILL],
    policy: describePolicy(REBALANCING_A_POLICY),
  });
}
