/**
 * Health-factor replay projection.
 *
 * Turns the raw Venus observations in a rich artifact into the inputs
 * `runReferenceModel` accepts. It reads the disclosed policy and market rather
 * than choosing them, and it computes no risk numbers of its own — the model
 * owns every financial conclusion, which is what keeps the verifier's
 * reconstruction independent of the agent's.
 */
import type { AnyArtifact } from "../artifact-view.js";
import type { TrialEvidence } from "../types.js";
import type { ProjectionResult, ReferenceReplayAdapter } from "./types.js";

/**
 * The model's input, restated structurally.
 *
 * Mirrored rather than imported so the adapter contract does not force every
 * consumer of the verifier to resolve the reference package. The runtime
 * binding is supplied by the caller, so a mismatch surfaces there.
 */
export interface HealthFactorReplayInput {
  observation: unknown;
  policy: {
    policyId: string;
    interventionThresholdMantissa: bigint;
    targetHealthFactorMantissa: bigint;
    minimumRepayUsdMantissa: bigint;
    amountToleranceBps: number;
  };
  actionableMarket: `0x${string}`;
  repaySelector: `0x${string}`;
}

/**
 * Map a protocol-agnostic observation onto the Venus model's input shape.
 *
 * The canonical document generalises what Venus calls VAI into `nonMarketDebt`,
 * so the adapter has to put it back. This is the substantive work of a
 * projector: a rename and a reshape, with no arithmetic. Every quantity crosses
 * unchanged, including the nulls — collapsing an unreadable market into a zero
 * here would defeat the fail-closed handling downstream.
 */
function toVenusObservation(
  observation: TrialEvidence["observations"]["preState"],
): ProjectionResult<Record<string, unknown>> {
  if (observation.protocolId !== "venus") {
    return {
      ok: false,
      error: {
        code: "NO_ADAPTER",
        message: `this projector reads venus observations, not ${observation.protocolId}`,
      },
    };
  }

  // Venus has exactly one non-market debt instrument. More than one would mean
  // the observation describes a protocol this projector does not understand.
  const vaiEntries = observation.nonMarketDebt.filter((debt) => debt.symbol.toUpperCase() === "VAI");
  if (observation.nonMarketDebt.length > vaiEntries.length) {
    return {
      ok: false,
      error: {
        code: "MALFORMED_OBSERVATION",
        message: "the observation records non-market debt this projector does not recognise",
      },
    };
  }

  const vai = vaiEntries[0];

  return {
    ok: true,
    value: {
      schemaVersion: "mandate.venus-observation/1",
      chainId: observation.chainId,
      account: observation.account,
      blockNumber: observation.blockNumber,
      blockHash: observation.blockHash,
      comptroller: observation.comptroller,
      markets: observation.markets,
      enteredMarkets: observation.enteredMarkets,
      // An absent VAI record means none was owed, which is a fact the source
      // observation states rather than an assumption made here.
      vai: {
        controller: vai?.controller ?? "0x0000000000000000000000000000000000000000",
        mintedPrincipal: vai?.mintedPrincipal ?? "0",
        repayAmount: vai?.repayAmount ?? "0",
        decimals: vai?.decimals ?? 18,
      },
      accountLiquidity: observation.accountLiquidity,
      vTokenImplementations: observation.implementations,
    },
  };
}

function isRichHealthFactor(artifact: AnyArtifact): artifact is TrialEvidence {
  return (
    artifact.schemaVersion === "mandate.trial-evidence/1" && artifact.category === "HEALTH_FACTOR"
  );
}

export const healthFactorReplayAdapter: ReferenceReplayAdapter<
  TrialEvidence,
  HealthFactorReplayInput
> = {
  id: "health-factor-venus-bsc",

  supports: isRichHealthFactor,

  project(artifact): ProjectionResult<{ pre: HealthFactorReplayInput; post: HealthFactorReplayInput }> {
    const { inputs } = artifact.reference;

    // Both observations are required. Replaying against only the pre-state would
    // check that the prediction was well-formed while saying nothing about what
    // the run actually did to the position.
    if (artifact.observations.preState === undefined || artifact.observations.postState === undefined) {
      return {
        ok: false,
        error: {
          code: "INCOMPLETE_DISCLOSURE",
          message: "the artifact does not disclose both a pre-state and a post-state observation",
        },
      };
    }

    const policy = {
      policyId: inputs.policy.policyId,
      interventionThresholdMantissa: BigInt(inputs.policy.interventionThresholdMantissa),
      targetHealthFactorMantissa: BigInt(inputs.policy.targetHealthFactorMantissa),
      minimumRepayUsdMantissa: BigInt(inputs.policy.minimumRepayUsdMantissa),
      amountToleranceBps: inputs.policy.amountToleranceBps,
    };

    const shared = {
      policy,
      actionableMarket: inputs.actionableMarket,
      repaySelector: inputs.repaySelector as `0x${string}`,
    };

    const pre = toVenusObservation(artifact.observations.preState);
    if (!pre.ok) return pre;
    const post = toVenusObservation(artifact.observations.postState);
    if (!post.ok) return post;

    return {
      ok: true,
      value: {
        pre: { observation: pre.value, ...shared },
        post: { observation: post.value, ...shared },
      },
    };
  },
};
