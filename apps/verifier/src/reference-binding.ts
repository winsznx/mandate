/**
 * Binding the verifier to the independent reference model.
 *
 * The verifier runs the model itself rather than trusting the result printed in
 * the artifact. That is the point of the rich replay: a publisher chooses what
 * to record, but not what an independent implementation computes from a raw
 * observation.
 *
 * Kept in its own file so the coupling is visible. When a second category
 * arrives this becomes a registry keyed by category, and the alternative —
 * reaching into a category package from inside the verification path — would
 * scatter that dependency through the checks.
 */
import { runReferenceModel, REFERENCE_MODEL_ID, REFERENCE_MODEL_VERSION } from "@mandate/reference-health-factor";
import type { RawVenusObservation } from "@mandate/venus-bsc";
import type { ReferenceModelRunner } from "./replay-rich.js";
import type { HealthFactorReplayInput } from "./replay-adapters/health-factor.js";

/**
 * Identity of the model this verifier will run.
 *
 * Reported alongside a verdict so a reader knows which implementation produced
 * the recomputation, and can object to it on the merits.
 */
export const VERIFIER_REFERENCE_MODEL = `${REFERENCE_MODEL_ID}@${REFERENCE_MODEL_VERSION}`;

export function healthFactorModelRunner(implementationHash: string): ReferenceModelRunner {
  return {
    implementationHash,
    run(input: HealthFactorReplayInput) {
      const { result } = runReferenceModel({
        observation: input.observation as RawVenusObservation,
        policy: input.policy,
        actionableMarket: input.actionableMarket,
        repaySelector: input.repaySelector,
      });
      return {
        riskState: result.riskState,
        healthFactorMantissa: result.healthFactorMantissa,
        liquidityUsdMantissa: result.liquidityUsdMantissa,
        shortfallUsdMantissa: result.shortfallUsdMantissa,
        totalBorrowUsdMantissa: result.totalBorrowUsdMantissa,
        weightedCollateralUsdMantissa: result.weightedCollateralUsdMantissa,
      };
    },
  };
}
