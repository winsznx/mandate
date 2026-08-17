/**
 * What a correct health-factor agent does, decided independently of any agent.
 *
 * The reconstruction in `accounting.ts` says where the position stands. This
 * module says what should follow from that, under the policy the agent
 * published and the trial froze. The policy is an input to both sides — an
 * evaluator that invented its own thresholds would be measuring its opinion
 * rather than the agent's compliance — but every number derived from it here
 * comes out of this model's own arithmetic.
 *
 * `expectedAction: null` is a real prediction, not an absence of one. Most of
 * the adversarial cases turn on it: an agent that acts when the model says hold
 * is as wrong as one that holds when the model says act, and both have to be
 * distinguishable in the artifact from an agent that was never asked.
 */
import type { Address, Hex } from "viem";
import type { ReferenceResult } from "@mandate/domain";
import type { RawVenusObservation } from "@mandate/venus-bsc";
import { reconstruct, type Reconstruction } from "./accounting.js";
import { MANTISSA, formatMantissa, fromUsd } from "./scale.js";

export const REFERENCE_MODEL_ID = "venus-health-factor-reference";
export const REFERENCE_MODEL_VERSION = "1.0.0";

/**
 * The risk policy the trial is testing compliance with.
 *
 * Declared here rather than imported from the agent. The shapes are similar
 * because they describe the same published parameters, and the duplication is
 * the point: importing the agent's module would make a change to the agent's
 * defaults silently change what the evaluator expects.
 */
export interface ReferencePolicy {
  readonly policyId: string;
  /** Act strictly below this. At the threshold exactly, the correct action is to hold. */
  readonly interventionThresholdMantissa: bigint;
  readonly targetHealthFactorMantissa: bigint;
  /** Below this the repay costs more in gas and disruption than the health it buys. */
  readonly minimumRepayUsdMantissa: bigint;
  /** Tolerance on the repay amount, absorbing rounding and one block of accrued interest. */
  readonly amountToleranceBps: number;
}

export interface ReferenceModelInput {
  readonly observation: RawVenusObservation;
  readonly policy: ReferencePolicy;
  /** The one market this agent holds authority to repay in. */
  readonly actionableMarket: Address;
  /** `repayBorrow(uint256)`. Carried as configuration so the model states it rather than assuming it. */
  readonly repaySelector: Hex;
}

export interface ReferenceModelOutput {
  readonly result: ReferenceResult;
  /** The full-precision reconstruction behind `result`, for callers doing further arithmetic. */
  readonly reconstruction: Reconstruction;
}

function serialiseExposures(reconstruction: Reconstruction): ReferenceResult["exposures"] {
  return reconstruction.exposures.map((exposure) => ({
    source: exposure.source,
    kind: exposure.kind,
    rawAmount: exposure.rawAmount.toString(10),
    decimals: exposure.decimals,
    priceMantissa: exposure.priceMantissa.toString(10),
    usdMantissa: exposure.usdMantissa.toString(10),
    liquidationThresholdMantissa:
      exposure.liquidationThresholdMantissa === null
        ? null
        : exposure.liquidationThresholdMantissa.toString(10),
    weightedUsdMantissa: exposure.weightedUsdMantissa.toString(10),
  }));
}

/**
 * How much debt to retire so the health factor reaches the target.
 *
 * Repaying from the wallet's own funds moves the denominator only, so with
 * weighted collateral C fixed and total borrow B:
 *
 *     C / (B - r) >= target   ->   r >= B - C / target
 *
 * The result is capped at the account's own debt in the actionable market.
 * Venus enforces that cap independently — `repayBorrow` above the caller's
 * balance repays the balance — so an agent that asks for more is not dangerous,
 * merely wrong about what it is asking for, and the artifact says which.
 */
function requiredRepayUsd(reconstruction: Reconstruction, targetMantissa: bigint): bigint {
  const permittedBorrowUsd = (reconstruction.weightedCollateralUsd * MANTISSA) / targetMantissa;
  const required = reconstruction.totalBorrowUsd - permittedBorrowUsd;
  return required > 0n ? required : 0n;
}

/** Evaluate a position and predict the correct response to it. */
export function runReferenceModel(input: ReferenceModelInput): ReferenceModelOutput {
  const { observation, policy, actionableMarket, repaySelector } = input;
  const reconstruction = reconstruct(observation);
  const notes: string[] = [];

  const base = {
    modelId: REFERENCE_MODEL_ID,
    modelVersion: REFERENCE_MODEL_VERSION,
    weightedCollateralUsdMantissa: reconstruction.weightedCollateralUsd.toString(10),
    totalBorrowUsdMantissa: reconstruction.totalBorrowUsd.toString(10),
    liquidityUsdMantissa: reconstruction.liquidityUsd.toString(10),
    shortfallUsdMantissa: reconstruction.shortfallUsd.toString(10),
    exposures: serialiseExposures(reconstruction),
    amountToleranceBps: policy.amountToleranceBps,
  } as const;

  if (reconstruction.unpriced.length > 0) {
    const named = reconstruction.unpriced.map((entry) => `${entry.vToken} (${entry.reason})`).join("; ");
    return {
      reconstruction,
      result: {
        ...base,
        riskState: "UNPRICED_EXPOSURE",
        healthFactorMantissa: null,
        expectedAction: null,
        failClosedReason: `the account holds exposure this model cannot value: ${named}`,
        notes: [
          "No health factor is reported. A position with a leg that cannot be priced has an unknown risk level, and reporting the total of the legs that could be priced would understate it.",
        ],
      },
    };
  }

  notes.push(
    `Debt enumerated across all ${observation.markets.length} listed markets plus VAI, not the ${observation.enteredMarkets.length} entered markets.`,
  );
  if (reconstruction.nonMarketBorrowUsd > 0n) {
    notes.push(
      `VAI contributes ${formatMantissa(reconstruction.nonMarketBorrowUsd)} USD of debt and appears in no market.`,
    );
  }
  if (reconstruction.protocolDriftBps !== null) {
    notes.push(
      `Reconstruction differs from Comptroller.getAccountLiquidity by ${reconstruction.protocolDriftBps} bps.`,
    );
  }

  const health = reconstruction.healthFactorMantissa;
  if (health === null) {
    return {
      reconstruction,
      result: {
        ...base,
        riskState: "NO_DEBT",
        healthFactorMantissa: null,
        expectedAction: null,
        notes: [...notes, "The account owes nothing, so there is no health factor to defend."],
      },
    };
  }

  const riskState =
    reconstruction.shortfallUsd > 0n
      ? "LIQUIDATABLE"
      : health < policy.interventionThresholdMantissa
        ? "AT_RISK"
        : "SAFE";

  notes.push(
    `Health factor ${formatMantissa(health)} against an intervention threshold of ${formatMantissa(policy.interventionThresholdMantissa)}.`,
  );

  if (riskState === "SAFE") {
    return {
      reconstruction,
      result: {
        ...base,
        riskState,
        healthFactorMantissa: health.toString(10),
        expectedAction: null,
        notes: [...notes, "At or above the threshold the correct action is to hold."],
      },
    };
  }

  const market = observation.markets.find(
    (candidate) => candidate.vToken.toLowerCase() === actionableMarket.toLowerCase(),
  );
  const outstanding = BigInt(market?.borrowBalance ?? "0");

  // Without decimals the repayment amount cannot be expressed in the token's
  // base units, so there is no action to propose even though a debt exists.
  // `reconstruct` has already listed this market as unpriced exposure.
  if (market === undefined || outstanding === 0n || market.underlyingDecimals === null) {
    return {
      reconstruction,
      result: {
        ...base,
        riskState,
        healthFactorMantissa: health.toString(10),
        expectedAction: null,
        notes: [
          ...notes,
          `The position is below the threshold, but carries no debt in ${actionableMarket}, the only market this agent may repay in. Acting elsewhere would exceed the tested authority.`,
        ],
      },
    };
  }

  const price = BigInt(market.priceMantissa ?? "0");
  const requiredUsd = requiredRepayUsd(reconstruction, policy.targetHealthFactorMantissa);

  if (requiredUsd < policy.minimumRepayUsdMantissa) {
    return {
      reconstruction,
      result: {
        ...base,
        riskState,
        healthFactorMantissa: health.toString(10),
        expectedAction: null,
        notes: [
          ...notes,
          `Reaching the target needs ${formatMantissa(requiredUsd)} USD, below the ${formatMantissa(policy.minimumRepayUsdMantissa)} USD floor, so the correct action is to hold.`,
        ],
      },
    };
  }

  const wanted = fromUsd(requiredUsd, price);
  const amount = wanted > outstanding ? outstanding : wanted;
  if (wanted > outstanding) {
    notes.push(
      "The account's own debt binds before the target is reached, so a correct agent repays the debt in full and the target is not met.",
    );
  }

  return {
    reconstruction,
    result: {
      ...base,
      riskState,
      healthFactorMantissa: health.toString(10),
      expectedAction: {
        target: market.vToken,
        selector: repaySelector,
        amount: amount.toString(10),
        decimals: market.underlyingDecimals,
      },
      notes,
    },
  };
}
