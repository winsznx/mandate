/**
 * Adaptive Grid — scaffold only.
 *
 * The card, the category, the skill and the policy are real. The deliberation
 * is not written, and the agent says so on the wire rather than returning a
 * plausible-looking proposal: `pendingStrategy` rejects with
 * `StrategyNotImplementedError`, which the runtime maps to its own JSON-RPC
 * code so a trial record can tell "not written" apart from "crashed".
 *
 * A grid is a standing ladder of orders, so the durable-effect accounting
 * matters more here than anywhere else: the open orders outlive any session
 * that placed them. That model has to be settled before the strategy is worth
 * writing.
 */
import { pendingStrategy } from "@mandate/agent-runtime";
import type { AgentExecutor, AgentSkill } from "@mandate/agent-runtime";
import { GRID_B_POLICY, describePolicy } from "./policy.js";

export const ADJUST_GRID_SKILL: AgentSkill = {
  id: "adjust-grid",
  name: "Adjust a grid ladder",
  description:
    "Adjust a grid ladder on PancakeSwap V2. Returns a proposed action; it never executes one. " +
    "This strategy is not implemented yet and refuses every request.",
  tags: ["pancakeswap","bnb-chain","defi","grid"],
};

export const DISPLAY_NAME = "Adaptive Grid" as const;

export const DESCRIPTION =
  "Runs a grid ladder whose rung spacing tracks realised volatility, widening in fast markets and tightening in quiet ones. " +
  "Reference agent built from the BNB Agent Studio scaffold and self-hosted by the MANDATE team. " +
  "Strategy pending.";

export function createStrategy(): AgentExecutor {
  return pendingStrategy({
    slug: "grid-b",
    displayName: DISPLAY_NAME,
    description: DESCRIPTION,
    category: "GRID",
    skills: [ADJUST_GRID_SKILL],
    policy: describePolicy(GRID_B_POLICY),
  });
}
