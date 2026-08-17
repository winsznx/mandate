/**
 * Conservative Guardian — the deliberation.
 *
 * Reads the account's Venus position, decides whether it is below the policy
 * threshold, and if so proposes a `repayBorrow(uint256)` sized to restore the
 * target health factor. It proposes. It does not sign, submit, or hold a key.
 *
 * Every path that is not a clear, reproducible "act" ends in `HOLD`. That
 * asymmetry is deliberate: a guardian that acts on a number it could not
 * reconstruct is worse than one that does nothing, because the action is
 * irreversible and the inaction is not.
 */
import type {
  AgentExecutor,
  AgentSkill,
  Proposal,
  ProposalRequest,
} from "@mandate/agent-runtime";
import type { CanonicalValue } from "@mandate/domain";
import { REPAY_BORROW_SELECTOR, REPAY_BORROW_SIGNATURE } from "./venus/abi.js";
import { assessHealth, formatHealthFactor, planRepay, underlyingToUsd } from "./venus/health.js";
import type { HealthAssessment } from "./venus/health.js";
import type { VenusAccountState, VenusReader } from "./venus/reader.js";
import type { VenusDeployment } from "./venus/addresses.js";
import { describePolicy } from "./policy.js";
import type { HealthFactorPolicy } from "./policy.js";

export const RESTORE_HEALTH_FACTOR_SKILL: AgentSkill = {
  id: "restore-health-factor",
  name: "Restore health factor",
  description:
    "Reads a Venus Core-pool position and proposes a repayBorrow sized to lift the " +
    "liquidation-threshold-weighted health factor back to the policy target. Returns a " +
    "proposed action; it never executes one.",
  tags: ["venus", "bnb-chain", "health-factor", "defi"],
};

export interface HealthFactorStrategyOptions {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly policy: HealthFactorPolicy;
  readonly deployment: VenusDeployment;
  readonly reader: VenusReader;
}

export function createHealthFactorStrategy(options: HealthFactorStrategyOptions): AgentExecutor {
  const { slug, displayName, description, policy, deployment, reader } = options;

  return {
    slug,
    displayName,
    description,
    category: "HEALTH_FACTOR",
    skills: [RESTORE_HEALTH_FACTOR_SKILL],
    policy: describePolicy(policy),

    async propose(request: ProposalRequest): Promise<Proposal> {
      const state = await reader.readAccountState(request.wallet);
      const assessment = assessHealth(state.markets, {
        liquidityUsd: state.liquidityUsd,
        shortfallUsd: state.shortfallUsd,
        vaiDebtUsd: state.vaiDebtUsd,
      });
      const observations = describeObservations(state, assessment, deployment);

      if (state.vTokenImplementation !== deployment.vTokenImplementation) {
        return hold(
          `vToken implementation is ${state.vTokenImplementation}, not the audited ` +
            `${deployment.vTokenImplementation}; the analysis this policy rests on no longer applies`,
          observations,
        );
      }

      if (assessment.healthFactorMantissa === null) {
        return hold("account has no outstanding Venus debt, so there is no health factor to defend", observations);
      }

      if (
        assessment.reconstructionDriftBps !== null &&
        assessment.reconstructionDriftBps > policy.maxReconstructionDriftBps
      ) {
        return hold(
          `liquidity reconstruction differs from getAccountLiquidity by ` +
            `${assessment.reconstructionDriftBps} bps, above the ${policy.maxReconstructionDriftBps} bps tolerance`,
          observations,
        );
      }

      if (assessment.healthFactorMantissa >= policy.interventionThresholdMantissa) {
        return hold(
          `health factor ${formatHealthFactor(assessment.healthFactorMantissa)} is at or above the ` +
            `${formatHealthFactor(policy.interventionThresholdMantissa)} intervention threshold`,
          observations,
        );
      }

      const market = state.targetMarket;
      if (market === undefined || market.borrowBalance === 0n) {
        return hold(
          `health factor ${formatHealthFactor(assessment.healthFactorMantissa)} is below threshold, but the ` +
            `account holds no ${deployment.underlyingSymbol} debt this agent is authorised to repay`,
          observations,
        );
      }

      const plan = planRepay({
        assessment,
        targetMantissa: policy.targetHealthFactorMantissa,
        outstandingDebt: market.borrowBalance,
        priceMantissa: market.priceMantissa,
      });

      if (underlyingToUsd(plan.amount, market.priceMantissa) < policy.minimumRepayUsdMantissa) {
        return hold(
          `the repay needed to reach the target is below the ` +
            `${formatHealthFactor(policy.minimumRepayUsdMantissa)} USD floor`,
          observations,
        );
      }

      return {
        decision: "PROPOSE",
        action: {
          target: deployment.vToken,
          selector: REPAY_BORROW_SELECTOR,
          args: [{ type: "uint256", value: plan.amount.toString(10) }],
          rationale:
            `Health factor ${formatHealthFactor(assessment.healthFactorMantissa)} is below the ` +
            `${formatHealthFactor(policy.interventionThresholdMantissa)} threshold. Repaying ` +
            `${formatUnits(plan.amount, deployment.underlyingDecimals)} ${deployment.underlyingSymbol} ` +
            `via ${REPAY_BORROW_SIGNATURE} restores it to ` +
            `${formatHealthFactor(policy.targetHealthFactorMantissa)}` +
            (plan.cappedByDebt ? ", capped at the account's own outstanding debt" : "") +
            ".",
        },
        observations: {
          ...observations,
          repay: {
            amount: plan.amount.toString(10),
            decimals: deployment.underlyingDecimals,
            symbol: deployment.underlyingSymbol,
            requiredUsdMantissa: plan.requiredUsd.toString(10),
            cappedByDebt: plan.cappedByDebt,
          },
        },
      };
    },
  };
}

function hold(rationale: string, observations: CanonicalValue): Proposal {
  return { decision: "HOLD", rationale, observations };
}

/**
 * What the agent saw, in a form the canonical encoding accepts.
 *
 * This is the evidence record for the deliberation, so it carries the inputs a
 * third party needs to recompute the same verdict: the block, the price, the
 * decimals that scaled it, and both collateral figures rather than only the one
 * the decision used.
 */
function describeObservations(
  state: VenusAccountState,
  assessment: HealthAssessment,
  deployment: VenusDeployment,
): Record<string, CanonicalValue> {
  const market = state.targetMarket;
  return {
    chainId: state.chainId,
    blockNumber: state.blockNumber.toString(10),
    account: state.account,
    comptroller: deployment.comptroller,
    vToken: deployment.vToken,
    vTokenImplementation: state.vTokenImplementation,
    vTokenImplementationPinned: deployment.vTokenImplementation,
    healthFactor: formatHealthFactor(assessment.healthFactorMantissa),
    healthFactorMantissa:
      assessment.healthFactorMantissa === null ? null : assessment.healthFactorMantissa.toString(10),
    healthFactorWeighting: "LIQUIDATION_THRESHOLD",
    liquidatable: assessment.liquidatable,
    liquidityUsdMantissa: state.liquidityUsd.toString(10),
    shortfallUsdMantissa: state.shortfallUsd.toString(10),
    totalBorrowUsdMantissa: assessment.totalBorrowUsd.toString(10),
    marketBorrowUsdMantissa: assessment.marketBorrowUsd.toString(10),
    vaiDebtUsdMantissa: assessment.vaiDebtUsd.toString(10),
    weightedCollateralUsdMantissa: assessment.weightedCollateralUsd.toString(10),
    reconstructedCollateralUsdMantissa: assessment.reconstructedCollateralUsd.toString(10),
    reconstructionDriftBps: assessment.reconstructionDriftBps,
    marketsEntered: state.markets.length,
    targetMarket:
      market === undefined
        ? null
        : {
            borrowBalance: market.borrowBalance.toString(10),
            underlyingDecimals: market.underlyingDecimals,
            underlyingSymbol: deployment.underlyingSymbol,
            priceMantissa: market.priceMantissa.toString(10),
            liquidationThresholdMantissa: market.liquidationThresholdMantissa.toString(10),
            collateralFactorMantissa: market.collateralFactorMantissa.toString(10),
          },
  };
}

/** Decimal rendering of a raw token amount, for the human-readable rationale. */
function formatUnits(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString(10).padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? `${amount / scale}` : `${amount / scale}.${fraction}`;
}
