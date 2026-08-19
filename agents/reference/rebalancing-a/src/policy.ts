/**
 * The Narrow Band Allocator's risk policy.
 *
 * Published in the agent card and hashed into `TrialTask.parametersHash`, so
 * these numbers are part of what a trial certifies rather than an internal
 * tuning knob. Changing one produces a different card hash, which supersedes
 * any receipt earned under the old values.
 *
 * The target weights are published for the same reason the drift trigger is.
 * "Rebalanced" is meaningless without saying rebalanced towards what, and an
 * allocation the buyer cannot read is one they cannot hold the agent to. A
 * reader of the card knows both the destination and how far the portfolio is
 * allowed to wander from it before the agent spends their money.
 *
 * The pair in this category differ on one axis, deliberately. This agent's band
 * is 100 bps: a portfolio one percent away from its published weights is one
 * this agent will act on. The Wide Band Allocator tolerates six percent and
 * holds where this one trades. An evaluator that cannot tell the two apart on
 * the same state is measuring the category, not the agents.
 */
import type { CanonicalValue } from "@mandate/domain";
import type { Address } from "viem";
import {
  BASIS_POINTS,
  MINT_SIGNATURE,
  REDEEM_UNDERLYING_SIGNATURE,
  VUSDC_BSC_TESTNET,
  VUSDT_BSC_TESTNET,
} from "./venus/index.js";

/** One market and the share of the portfolio the policy says it should hold. */
export interface AllocationTarget {
  readonly vToken: Address;
  readonly weightBps: number;
}

export interface RebalancingPolicy {
  readonly policyId: string;
  /** The published allocation. Weights sum to 10000 or the policy does not construct. */
  readonly targets: readonly AllocationTarget[];
  /**
   * How far a market may fall below its target before the agent acts, in basis
   * points of the whole portfolio.
   *
   * Measured against the portfolio rather than against the market's own target,
   * so the same number means the same thing whatever the weight is. A 100 bps
   * trigger on a $1000 book is $10 short, whether the market is meant to hold
   * half of it or a tenth.
   */
  readonly driftTriggerBps: number;
  /** Below this the transaction costs more than the correction buys. USD at 1e18. */
  readonly minRebalanceUsdMantissa: bigint;
  /**
   * Tolerance on the proposed amount, in basis points.
   *
   * Two correct implementations disagree in the last few units through
   * rounding, and the market's exchange rate moves between the observation and
   * the proposal. Published because the evaluator compares within it, so it is
   * part of what a trial certifies rather than a harness detail.
   */
  readonly amountToleranceBps: number;
}

/**
 * Equal weights across the two live Core-pool stablecoin markets on chain 97.
 *
 * Shared by both agents in the pair on purpose. The destination is the same;
 * only the tolerance for being away from it differs, which is what makes a
 * side-by-side receipt a comparison of two policies rather than of two
 * unrelated mandates.
 *
 * vBUSD carries no weight. It is listed and priced and it is in the configured
 * universe, but `mintPaused` is true and its supply cap is zero, so a target
 * weight on it would be an instruction the chain cannot carry out.
 */
export const STABLECOIN_PARITY_TARGETS: readonly AllocationTarget[] = [
  { vToken: VUSDT_BSC_TESTNET, weightBps: 5_000 },
  { vToken: VUSDC_BSC_TESTNET, weightBps: 5_000 },
];

/**
 * Build a policy, refusing one whose weights do not describe a whole portfolio.
 *
 * Weights summing to anything but 10000 are not a slightly odd allocation, they
 * are an incoherent one: every market's dollar target is a share of the same
 * portfolio total, so weights summing to 9000 leave a tenth of the book with no
 * home and every market permanently at its target, while weights summing to
 * 11000 leave every market permanently short and the agent buying until it runs
 * out of cash. Neither failure announces itself in the output — both look like
 * an agent behaving consistently — so the check has to happen where the numbers
 * are written rather than where they are used.
 */
export function createRebalancingPolicy(policy: RebalancingPolicy): RebalancingPolicy {
  const total = policy.targets.reduce((sum, target) => sum + BigInt(target.weightBps), 0n);
  if (total !== BASIS_POINTS) {
    throw new Error(
      `policy '${policy.policyId}' publishes target weights summing to ${total} bps, not ${BASIS_POINTS}`,
    );
  }
  return policy;
}

export const NARROW_BAND_ALLOCATOR_POLICY: RebalancingPolicy = createRebalancingPolicy({
  policyId: "narrow-band-allocator",
  targets: STABLECOIN_PARITY_TARGETS,
  driftTriggerBps: 100,
  minRebalanceUsdMantissa: 10n * 10n ** 18n,
  amountToleranceBps: 50,
});

/** The policy as it appears in the agent card. Wide integers travel as decimal strings. */
export function describePolicy(policy: RebalancingPolicy): CanonicalValue {
  return {
    policyId: policy.policyId,
    targets: policy.targets.map((target) => ({
      vToken: target.vToken,
      weightBps: target.weightBps,
    })),
    driftTriggerBps: policy.driftTriggerBps,
    minRebalanceUsdMantissa: policy.minRebalanceUsdMantissa.toString(10),
    amountToleranceBps: policy.amountToleranceBps,
    action: MINT_SIGNATURE,
    // Stated in the card rather than only in the code, because it is the
    // limitation a buyer most needs to know before granting: this agent can
    // only ever add to an under-weight market. Reducing an over-weight one
    // needs `redeemUnderlying(uint256)`, which withdraws collateral and can
    // drive a borrowing account's health factor below one — a risk invariant no
    // (target, selector, spend cap) triple can express.
    rebalanceDirection: "top-up only",
    withheldAction: REDEEM_UNDERLYING_SIGNATURE,
    withheldActionReason: "GUARD_REQUIRED: withdrawing collateral can push the health factor below 1",
    driftMeasure: "basis points of total portfolio USD, supplied plus idle",
  };
}
