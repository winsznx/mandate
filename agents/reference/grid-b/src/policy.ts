/**
 * The Wide Grid's risk policy.
 *
 * The ladder geometry is the whole difference between this agent and the Tight
 * Grid. Rungs four times as wide and half as many of them means this agent
 * ignores dislocations its sibling trades on, and when both do act it sets a
 * looser minimum output. On the same pool at the same block the two reach
 * different decisions, which is the property that makes a receipt a statement
 * about an agent rather than about its category.
 *
 * The wider slippage bound is a consequence of the wider rungs rather than a
 * separate opinion. An agent that only trades a market already 100 bps out of
 * line is trading a market that is moving, and holding out for the same 30 bps
 * execution its sibling demands would leave it reverting rather than trading.
 *
 * The scaffold this replaced described spacing that tracked realised
 * volatility. That is not implemented, and it is not implemented for a stated
 * reason: the only history this pool exposes is an exponential moving average
 * with an 866-second half-life, and a "volatility" derived from a single EMA
 * reading would be a number with a plausible name and no content.
 */
import type { CanonicalValue } from "@mandate/domain";
import { describePolicy as describeGridPolicy } from "@mandate/agent-grid-a/policy";
import type { GridPolicy } from "@mandate/agent-grid-a/policy";

export type { GridPolicy };

export const WIDE_GRID_POLICY: GridPolicy = {
  policyId: "wide-grid",
  spacingBps: 100,
  levels: 4,
  inventoryStepBps: 500,
  trancheRawUnits: 10n ** 18n,
  maxSlippageBps: 50,
  probeSizeRawUnits: 10n ** 18n,
  amountToleranceBps: 50,
};

/**
 * The policy as it appears in the agent card.
 *
 * Rendered by the same function the sibling uses, so the two cards are
 * comparable field for field. A reader deciding between them is looking at one
 * document with different numbers in it rather than two documents that have to
 * be reconciled first.
 */
export function describePolicy(policy: GridPolicy): CanonicalValue {
  return describeGridPolicy(policy);
}
