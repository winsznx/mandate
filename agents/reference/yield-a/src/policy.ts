/**
 * The Cost-Aware Optimizer's risk policy.
 *
 * Published in the agent card and hashed into `TrialTask.parametersHash`, so
 * these numbers are part of what a trial certifies rather than an internal
 * tuning knob. Changing one produces a different card hash, which supersedes
 * any receipt earned under the old values.
 *
 * The pair in this category differ on one axis, deliberately. This agent has no
 * concentration cap: if the best net rate is in a single market it will put
 * everything there. The Diversified Optimizer holds a per-market ceiling and
 * will accept a worse rate rather than breach it. An evaluator that cannot tell
 * the two apart on the same state is measuring the category, not the agents.
 */
import type { CanonicalValue } from "@mandate/domain";
import { MINT_SIGNATURE } from "./venus/index.js";

export interface YieldPolicy {
  readonly policyId: string;
  /**
   * The annualised supply rate a market must clear, net of the gas buffer,
   * before any capital is committed to it. Deploying idle cash at 4 bps is
   * worse than leaving it idle once the transaction is paid for.
   */
  readonly minNetSupplyRateBps: number;
  /** Subtracted from every market's rate as the standing cost of moving. */
  readonly gasCostBufferBps: number;
  /**
   * Blocks per year, used to turn `supplyRatePerBlock` into an annual figure.
   *
   * A stated convention rather than a chain reading. Venus's interest-rate
   * model on chain 97 sits behind a proxy that reverts on
   * `blocksOrSecondsPerYear()`, and BSC's block interval is not fixed in any
   * case. It is published here so a reader can see which convention produced
   * the rate on the proof page, and because the reference model must be handed
   * the same one — a comparison between two agents using different conventions
   * would be measuring the conventions.
   */
  readonly blocksPerYear: number;
  /** Below this the transaction costs more than the yield it buys. USD at 1e18. */
  readonly minDeploymentUsdMantissa: bigint;
  /**
   * Ceiling on the share of the account's total capital — supplied plus idle —
   * that any one market may hold after the deployment, in basis points. `null`
   * means no ceiling.
   *
   * This is the parameter the pair differ on, and it is null here on purpose:
   * concentration is what "cost-aware" buys.
   */
  readonly maxVenueShareBps: number | null;
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
 * Ten million blocks a year.
 *
 * A round number chosen to be legible rather than precise, and legible is the
 * honest choice here: BSC's block interval has moved from 3 s to 0.75 s within
 * the life of this protocol deployment, so any figure claiming precision would
 * be claiming to know something the chain does not guarantee. What the
 * convention has to be is fixed and disclosed, and it is both.
 */
export const BLOCKS_PER_YEAR = 10_000_000;

export const COST_AWARE_OPTIMIZER_POLICY: YieldPolicy = {
  policyId: "cost-aware-optimizer",
  minNetSupplyRateBps: 75,
  gasCostBufferBps: 25,
  blocksPerYear: BLOCKS_PER_YEAR,
  minDeploymentUsdMantissa: 10n * 10n ** 18n,
  maxVenueShareBps: null,
  amountToleranceBps: 50,
};

/** The policy as it appears in the agent card. Wide integers travel as decimal strings. */
export function describePolicy(policy: YieldPolicy): CanonicalValue {
  return {
    policyId: policy.policyId,
    minNetSupplyRateBps: policy.minNetSupplyRateBps,
    gasCostBufferBps: policy.gasCostBufferBps,
    blocksPerYear: policy.blocksPerYear,
    minDeploymentUsdMantissa: policy.minDeploymentUsdMantissa.toString(10),
    maxVenueShareBps: policy.maxVenueShareBps,
    amountToleranceBps: policy.amountToleranceBps,
    rateSource: "vToken.supplyRatePerBlock",
    rateAnnualisation: "simple, blocksPerYear as published",
    action: MINT_SIGNATURE,
  };
}
