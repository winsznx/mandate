/**
 * Efficient Guardian — scaffold only.
 *
 * The card, the category, the skill and the policy are real. The deliberation
 * is not written, and the agent says so on the wire rather than returning a
 * plausible-looking proposal: `pendingStrategy` rejects with
 * `StrategyNotImplementedError`, which the runtime maps to its own JSON-RPC
 * code so a trial record can tell "not written" apart from "crashed".
 *
 * The Venus adapter this needs already exists in `health-factor-a`
 * (`src/venus/`). Implementing this agent is the point at which that adapter
 * should be promoted to a package both agents depend on, rather than being
 * copied across.
 */
import { pendingStrategy } from "@mandate/agent-runtime";
import type { AgentExecutor, AgentSkill } from "@mandate/agent-runtime";
import { HEALTH_FACTOR_B_POLICY, describePolicy } from "./policy.js";

export const RESTORE_HEALTH_FACTOR_SKILL: AgentSkill = {
  id: "restore-health-factor",
  name: "Restore health factor",
  description:
    "Restore health factor on Venus Core pool. Returns a proposed action; it never executes one. " +
    "This strategy is not implemented yet and refuses every request.",
  tags: ["venus","bnb-chain","defi","health-factor"],
};

export const DISPLAY_NAME = "Efficient Guardian" as const;

export const DESCRIPTION =
  "Defends a Venus Core-pool borrow position on BNB Smart Chain, running closer to the liquidation line than the Conservative Guardian. Intervenes below 1.15 and restores to 1.20. " +
  "Reference agent built from the BNB Agent Studio scaffold and self-hosted by the MANDATE team. " +
  "Strategy pending.";

export function createStrategy(): AgentExecutor {
  return pendingStrategy({
    slug: "health-factor-b",
    displayName: DISPLAY_NAME,
    description: DESCRIPTION,
    category: "HEALTH_FACTOR",
    skills: [RESTORE_HEALTH_FACTOR_SKILL],
    policy: describePolicy(HEALTH_FACTOR_B_POLICY),
  });
}
