/**
 * Cost-Aware Optimizer — scaffold only.
 *
 * The card, the category, the skill and the policy are real. The deliberation
 * is not written, and the agent says so on the wire rather than returning a
 * plausible-looking proposal: `pendingStrategy` rejects with
 * `StrategyNotImplementedError`, which the runtime maps to its own JSON-RPC
 * code so a trial record can tell "not written" apart from "crashed".
 *
 * Yield reallocation is a supply-side move rather than a repay, so it needs
 * `redeemUnderlying` and `mint` rather than `repayBorrow`. `redeemUnderlying`
 * can push a health factor below one into self-liquidation, so it carries a
 * guard requirement `repayBorrow` does not.
 */
import { pendingStrategy } from "@mandate/agent-runtime";
import type { AgentExecutor, AgentSkill } from "@mandate/agent-runtime";
import { YIELD_A_POLICY, describePolicy } from "./policy.js";

export const REALLOCATE_YIELD_SKILL: AgentSkill = {
  id: "reallocate-yield",
  name: "Reallocate a yield position",
  description:
    "Reallocate a yield position on Venus Core pool. Returns a proposed action; it never executes one. " +
    "This strategy is not implemented yet and refuses every request.",
  tags: ["venus","bnb-chain","defi","yield"],
};

export const DISPLAY_NAME = "Cost-Aware Optimizer" as const;

export const DESCRIPTION =
  "Moves supplied capital between lending venues only when the yield improvement clears the cost of moving it, and refuses to churn. " +
  "Reference agent built from the BNB Agent Studio scaffold and self-hosted by the MANDATE team. " +
  "Strategy pending.";

export function createStrategy(): AgentExecutor {
  return pendingStrategy({
    slug: "yield-a",
    displayName: DISPLAY_NAME,
    description: DESCRIPTION,
    category: "YIELD",
    skills: [REALLOCATE_YIELD_SKILL],
    policy: describePolicy(YIELD_A_POLICY),
  });
}
