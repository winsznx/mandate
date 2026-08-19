/**
 * The Tight Grid's risk policy.
 *
 * Published in the agent card and hashed into `TrialTask.parametersHash`, so
 * these numbers are part of what a trial certifies rather than an internal
 * tuning knob. Changing one produces a different card hash, which supersedes
 * any receipt earned under the old values.
 *
 * The pair in this category differ on the shape of the ladder. This agent runs
 * 25 bps rungs eight deep, so it reacts to small dislocations, trades often and
 * carries a large inventory swing at the extremes. The Wide Grid runs 100 bps
 * rungs four deep and mostly sits still. On the same pool at the same block the
 * two reach different decisions, which is what makes a receipt a statement
 * about an agent rather than about its category.
 *
 * The scaffold this replaced described an adaptive ladder whose spacing tracked
 * realised volatility. That is not implemented, and it is not implemented for a
 * stated reason rather than an omission: realised volatility needs a price
 * history, the only history this pool exposes is an exponential moving average
 * with a 866-second half-life, and a "volatility" derived from a single EMA
 * reading would be a number with a plausible name and no content. The pair
 * therefore differ on rung geometry, which is a real risk parameter and one
 * both sides can compute from state the chain actually publishes.
 */
import type { CanonicalValue } from "@mandate/domain";
import { EXCHANGE_SIGNATURE } from "./pool/index.js";

export interface GridPolicy {
  readonly policyId: string;
  /** Price movement off fair, in basis points, that advances the ladder one rung. */
  readonly spacingBps: number;
  /** Rungs either side of fair. The ladder clamps here rather than extending. */
  readonly levels: number;
  /** How far the target inventory share moves per rung, in basis points. */
  readonly inventoryStepBps: number;
  /** Input size of one rung's trade, in the sold coin's own units. */
  readonly trancheRawUnits: bigint;
  /**
   * How far below the quote `min_dy` is set.
   *
   * The only protection this action carries. `exchange` takes `min_dy` from
   * calldata, so a session proposing zero would be inside its mandate and would
   * still lose the trade to the first searcher who noticed. Published because it
   * is the mitigation, and compared by the evaluator for the same reason.
   */
  readonly maxSlippageBps: number;
  /**
   * The trade size the deviation is measured at.
   *
   * A stated convention rather than a property of the pool. On a curve the price
   * depends on the size, so "the price" is only defined once a size is fixed.
   * Published so both the agent and the model measuring it use the same probe,
   * and so a reader can see which size produced the figure on the proof page.
   */
  readonly probeSizeRawUnits: bigint;
  /**
   * Tolerance on the derived arguments, in basis points.
   *
   * The tranche and the coin indices are exact on both sides. `min_dy` is not:
   * this agent takes it from the pool's quote and the reference model derives it
   * by solving the invariant, and demanding they agree to the wei would fail the
   * two independent routes the whole architecture is built on.
   */
  readonly amountToleranceBps: number;
}

export const TIGHT_GRID_POLICY: GridPolicy = {
  policyId: "tight-grid",
  spacingBps: 25,
  levels: 8,
  inventoryStepBps: 250,
  trancheRawUnits: 10n ** 18n,
  maxSlippageBps: 30,
  probeSizeRawUnits: 10n ** 18n,
  amountToleranceBps: 50,
};

/** The policy as it appears in the agent card. Wide integers travel as decimal strings. */
export function describePolicy(policy: GridPolicy): CanonicalValue {
  return {
    policyId: policy.policyId,
    spacingBps: policy.spacingBps,
    levels: policy.levels,
    inventoryStepBps: policy.inventoryStepBps,
    trancheRawUnits: policy.trancheRawUnits.toString(10),
    maxSlippageBps: policy.maxSlippageBps,
    probeSizeRawUnits: policy.probeSizeRawUnits.toString(10),
    amountToleranceBps: policy.amountToleranceBps,
    priceSource: "pool.get_dy at the published probe size",
    ladderCentre: "stored_rates ratio",
    action: EXCHANGE_SIGNATURE,
  };
}
