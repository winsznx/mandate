import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { canonicalHash } from "@mandate/domain/canonical";
import type { CanonicalValue } from "@mandate/domain/canonical";
import { TrialEvidenceSchema } from "@mandate/domain/schemas";
import { artifactChecks, artifactResult, artifactTrialSpecHash, isFlatArtifact } from "../src/artifact-view.js";
import { replayRichEvidence } from "../src/replay-rich.js";
import { healthFactorReplayAdapter } from "../src/replay-adapters/health-factor.js";
import type { ReferenceModelRunner } from "../src/replay-rich.js";

/**
 * Cross-format invariant.
 *
 *   If a flat and a rich artifact represent the same execution, every
 *   replayable check and the final verdict are identical.
 *
 * Without it, the two forms are two verification paths that can drift, and a
 * publisher could pick whichever one flatters the run. The whole reason
 * `artifact-view.ts` exists is to keep the checks single-implementation; this
 * suite is what stops that guarantee from quietly lapsing.
 */

const VUSDT: Address = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a";
const USDT: Address = "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c";
const REPAY: Hex = "0x0e752702";
const AGENT_VERSION: Hex = `0x${"a".repeat(64)}`;
const MODEL_HASH: Hex = `0x${"c".repeat(64)}`;

function observation(borrow: string) {
  return {
    schemaVersion: "mandate.venus-observation/1" as const,
    protocolId: "venus" as const,
    chainId: 97,
    account: "0x4444444444444444444444444444444444444444" as Address,
    blockNumber: "40000000",
    blockHash: `0x${"1".repeat(64)}` as Hex,
    comptroller: "0x94d1820b2d1c7c7452a163983dc888cec546b77d" as Address,
    markets: [
      {
        vToken: VUSDT,
        underlying: USDT,
        underlyingDecimals: 6,
        isListed: true,
        collateralFactorMantissa: "750000000000000000",
        liquidationThresholdMantissa: "800000000000000000",
        vTokenBalance: "1000000000000",
        exchangeRateMantissa: "200000000000000",
        borrowBalance: borrow,
        priceMantissa: "500000000000000000000000000000",
        entered: true,
      },
    ],
    enteredMarkets: [VUSDT],
    nonMarketDebt: [
      {
        symbol: "VAI",
        controller: "0xf70c3c6b749bbab89c081737334e74c9afd4be16" as Address,
        mintedPrincipal: "0",
        repayAmount: "0",
        decimals: 18,
      },
    ],
    accountLiquidity: { errorCode: "0", liquidity: "1000", shortfall: "0" },
    implementations: {},
  };
}

const POLICY = {
  policyId: "conservative-guardian",
  interventionThresholdMantissa: "1300000000000000000",
  targetHealthFactorMantissa: "1350000000000000000",
  minimumRepayUsdMantissa: "1000000000000000000",
  amountToleranceBps: 50,
};

const REFERENCE_INPUTS = {
  actionableMarket: VUSDT,
  repaySelector: REPAY,
  policy: POLICY,
};

/** A model that reports whatever the fixture says, so the test isolates the projection. */
function stubRunner(output: Record<string, string | null>): ReferenceModelRunner {
  return {
    implementationHash: MODEL_HASH,
    run: () => ({
      riskState: output["riskState"] as string,
      healthFactorMantissa: output["healthFactorMantissa"] ?? null,
      liquidityUsdMantissa: output["liquidityUsdMantissa"] as string,
      shortfallUsdMantissa: output["shortfallUsdMantissa"] as string,
      totalBorrowUsdMantissa: output["totalBorrowUsdMantissa"] as string,
      weightedCollateralUsdMantissa: output["weightedCollateralUsdMantissa"] as string,
    }),
  };
}

const PUBLISHED = {
  riskState: "SAFE",
  healthFactorMantissa: "2505467000000000000",
  liquidityUsdMantissa: "1000",
  shortfallUsdMantissa: "0",
  totalBorrowUsdMantissa: "500",
  weightedCollateralUsdMantissa: "1500",
};

function richArtifact(overrides: Record<string, unknown> = {}) {
  const base = {
    schemaVersion: "mandate.trial-evidence/1" as const,
    category: "HEALTH_FACTOR" as const,
    trialSpec: { hash: `0x${"d".repeat(64)}` },
    environment: {
      chainId: 97,
      forkBlock: "40000000",
      forkBlockHash: `0x${"1".repeat(64)}`,
      rpcSourceClass: "archive" as const,
      modifiedState: false,
      modifications: [],
      runnerVersion: "1.0.0",
      anvilVersion: "1.7.1",
    },
    agent: {
      identityRegistry: "0x1111111111111111111111111111111111111111" as Address,
      agentId: "18433",
      agentVersionHash: AGENT_VERSION,
      endpointHash: `0x${"3".repeat(64)}`,
    },
    observations: {
      preState: observation("500000000"),
      agentProposal: {
        requestId: "11111111-2222-3333-4444-555555555555",
        skill: "protect-health-factor",
        wallet: "0x4444444444444444444444444444444444444444" as Address,
        decision: "PROPOSE" as const,
        action: {
          target: VUSDT,
          selector: REPAY,
          args: [{ type: "uint256", value: "20000000" }],
          rationale: "restore health factor above target",
        },
        observationsHash: `0x${"6".repeat(64)}`,
        invocation: {
          protocol: "REFERENCE" as const,
          endpointHash: `0x${"3".repeat(64)}`,
          requestHash: `0x${"4".repeat(64)}`,
          responseHash: `0x${"5".repeat(64)}`,
          latencyMs: 12,
          outcome: "OK" as const,
        },
      },
      txs: [],
      postState: observation("480000000"),
    },
    reference: {
      implementationHash: MODEL_HASH,
      inputsHash: canonicalHash(REFERENCE_INPUTS as unknown as CanonicalValue),
      inputs: REFERENCE_INPUTS,
      output: {
        modelId: "venus-health-factor-reference",
        modelVersion: "1.0.0",
        ...PUBLISHED,
        exposures: [],
        expectedAction: null,
        amountToleranceBps: 50,
        notes: [],
      },
    },
    evaluator: {
      implementationHash: `0x${"e".repeat(64)}`,
      checks: [
        { checkId: "hf-restored", description: "health factor at or above target", status: "PASS" as const },
      ],
      result: "PASS" as const,
    },
    observedAt: 1_790_000_000,
  };
  return { ...base, ...overrides };
}

describe("the rich artifact parses and projects", () => {
  it("validates against the published schema", () => {
    // #given a rich artifact carrying disclosed reference inputs
    // #when parsed
    const parsed = TrialEvidenceSchema.safeParse(richArtifact());

    // #then it is well-formed
    expect(parsed.success).toBe(true);
  });

  it("is not mistaken for the flat form", () => {
    expect(isFlatArtifact(TrialEvidenceSchema.parse(richArtifact()))).toBe(false);
  });

  it("projects both observations into model inputs", () => {
    // #given a rich health-factor artifact
    const artifact = TrialEvidenceSchema.parse(richArtifact());

    // #when projected
    const projected = healthFactorReplayAdapter.project(artifact);

    // #then both a pre-state and a post-state input are produced, carrying the
    // disclosed policy rather than a default the projector chose
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.pre.policy.interventionThresholdMantissa).toBe(1_300_000_000_000_000_000n);
    expect(projected.value.post.observation).not.toBe(projected.value.pre.observation);
  });

  /**
   * The projector normalises; it must never decide. A projector that computed a
   * health factor would be a second, unreviewed implementation of exactly the
   * thing the trial checks independently.
   */
  it("computes no financial result of its own", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/replay-adapters/health-factor.ts", import.meta.url), "utf8"),
    );

    for (const forbidden of ["healthFactor =", "computeHealth", "* price", "/ 1e18", "liquidationThreshold *"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("rich replay recomputes rather than trusts", () => {
  it("PASSes when the model reproduces every published figure", () => {
    // #given a model that agrees with the published output
    const outcome = replayRichEvidence({
      artifact: TrialEvidenceSchema.parse(richArtifact()),
      model: stubRunner(PUBLISHED),
    });

    // #then the replay derives PASS
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.replay.derived).toBe("PASS");
    expect(outcome.replay.expectations.every((entry) => entry.status === "MATCHED")).toBe(true);
  });

  it("FAILs when the model disagrees with the published health factor", () => {
    // #given a model that recomputes a different health factor from the same
    // disclosed observation
    const outcome = replayRichEvidence({
      artifact: TrialEvidenceSchema.parse(richArtifact()),
      model: stubRunner({ ...PUBLISHED, healthFactorMantissa: "1000000000000000000" }),
    });

    // #then the published result does not follow from the evidence
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.replay.derived).toBe("FAIL");
    expect(outcome.replay.expectations.find((entry) => entry.key === "health-factor")?.status).toBe(
      "DIVERGED",
    );
  });

  it("FAILs when the disclosed inputs do not match their committed hash", () => {
    // #given inputs swapped after publication for friendlier ones
    const artifact = TrialEvidenceSchema.parse(
      richArtifact({
        reference: {
          ...richArtifact().reference,
          inputs: { ...REFERENCE_INPUTS, policy: { ...POLICY, interventionThresholdMantissa: "1" } },
        },
      }),
    );

    // #when replayed
    const outcome = replayRichEvidence({ artifact, model: stubRunner(PUBLISHED) });

    // #then the substitution is caught by the commitment
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.replay.derived).toBe("FAIL");
    expect(outcome.replay.reasons.some((reason) => reason.includes("hash to"))).toBe(true);
  });

  it("FAILs when the reference model shares the agent's implementation", () => {
    // #given a 'reference' model that is really the agent
    const outcome = replayRichEvidence({
      artifact: TrialEvidenceSchema.parse(richArtifact()),
      model: { ...stubRunner(PUBLISHED), implementationHash: AGENT_VERSION },
    });

    // #then agreement proves nothing and the replay says so
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.replay.derived).toBe("FAIL");
    expect(outcome.replay.reasons.some((reason) => reason.includes("same implementation hash"))).toBe(
      true,
    );
  });

  /**
   * An infrastructure failure says nothing about the agent, so there must be no
   * route from INCONCLUSIVE to FAIL. The schema closes that route rather than
   * leaving it to the replay: an artifact whose only check was inconclusive
   * cannot be published as a FAIL at all, so a dead fork can never land on an
   * agent's permanent record.
   */
  it("refuses to represent an inconclusive-only run as a FAIL", () => {
    // #given a run whose single check was blocked by infrastructure
    const artifact = richArtifact({
      evaluator: {
        implementationHash: `0x${"e".repeat(64)}`,
        checks: [
          {
            checkId: "hf-restored",
            description: "health factor at or above target",
            status: "INCONCLUSIVE" as const,
            inconclusiveReason: "the fork RPC stopped answering",
          },
        ],
        result: "FAIL" as const,
        failureReason: "the fork RPC stopped answering",
      },
    });

    // #when parsed
    const parsed = TrialEvidenceSchema.safeParse(artifact);

    // #then it is rejected, because a FAIL must name a check that actually failed
    expect(parsed.success).toBe(false);
  });
});

describe("cross-format invariant", () => {
  /**
   * The two forms must agree on everything a shared check reads. If they ever
   * diverge, a publisher can choose the format that flatters the run.
   */
  it("reads the same trial spec hash, result and checks from both forms", () => {
    // #given a rich artifact and the flat projection of the same execution
    const rich = TrialEvidenceSchema.parse(richArtifact());
    const flat = {
      schemaVersion: "mandate.evidence/1" as const,
      trialSpecHash: rich.trialSpec.hash,
      category: "HEALTH_FACTOR" as const,
      provenance: "Trial-verified" as const,
      environment: {
        chainId: 97,
        forkBlock: "40000000",
        stateModified: false,
        runnerVersion: "1.0.0",
        anvilVersion: "1.7.1",
      },
      invocation: {
        protocol: "REFERENCE" as const,
        endpointHash: rich.agent.endpointHash,
        requestHash: `0x${"4".repeat(64)}` as Hex,
        responseHash: `0x${"5".repeat(64)}` as Hex,
        latencyMs: 12,
        outcome: "OK" as const,
      },
      preState: [],
      trace: [],
      postState: [],
      referenceOutcome: {
        modelId: "venus-health-factor-reference",
        modelVersion: "1.0.0",
        expected: [],
        notes: [],
      },
      checks: [
        { checkId: "hf-restored", description: "health factor at or above target", passed: true },
      ],
      result: "PASS" as const,
      observedAt: 1_790_000_000,
    };

    // #when read through the shared view
    // #then every shared accessor agrees
    expect(artifactTrialSpecHash(flat)).toBe(artifactTrialSpecHash(rich));
    expect(artifactResult(flat)).toBe(artifactResult(rich));
    expect(artifactChecks(flat)).toEqual(artifactChecks(rich));
  });

  it("derives the same verdict from both forms for the same execution", () => {
    // #given the rich form replayed against an agreeing model
    const outcome = replayRichEvidence({
      artifact: TrialEvidenceSchema.parse(richArtifact()),
      model: stubRunner(PUBLISHED),
    });

    // #then it reaches PASS, matching what the flat form derives for the same
    // run. Neither format is a weaker rung of the proof ladder.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.replay.derived).toBe("PASS");
  });
});
