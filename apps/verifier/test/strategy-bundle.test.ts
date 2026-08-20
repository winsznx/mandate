import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type {
  CanonicalValue,
  EvaluationCheck,
  StrategyReferenceResult,
  StrategyTrialEvidence,
  TrialSpec,
} from "@mandate/domain";
import { GOLDEN_TRIAL_SPEC } from "@mandate/domain/fixtures";
import { parseEvidenceDocument } from "../src/bundle.js";
import { replayStrategyEvidence } from "../src/strategy-replay.js";

/**
 * The strategy path, checked end to end across the two packages that own it.
 *
 * The trial-runner assembles a `mandate.strategy-evidence-bundle/1` document and
 * the verifier is supposed to accept it, tag it as the strategy family, and
 * re-derive its outcome. Both sides validate against the same `@mandate/domain`
 * schema, so nothing but a drift between the two assemblers and the verifier's
 * reader can break this, and that drift is exactly what a round trip catches
 * that two same-package unit tests cannot.
 *
 * The runner's assemblers are loaded through a computed specifier rather than a
 * static import. An application must not take a build dependency on a service it
 * consumes, and a static import here would put the trial-runner in the
 * verifier's graph to satisfy one test. The specifier resolves at run time only,
 * which is the moment the conformance claim has to hold. It mirrors the
 * trial-runner's own bundle test, which loads the verifier's schema the same way.
 */
interface AssembledStrategyEvidence {
  evidence: StrategyTrialEvidence;
  evidenceHash: Hex;
}

interface AssembledStrategyBundle {
  bundle: unknown;
  bundleHash: Hex;
}

type AssembleStrategyEvidence = (
  input: Readonly<Record<string, unknown>>,
  wallet: Address,
  skill: string,
) => AssembledStrategyEvidence;

type AssembleStrategyBundle = (
  evidence: StrategyTrialEvidence,
  evidenceHash: Hex,
  trialSpec: TrialSpec,
) => AssembledStrategyBundle;

const assembleStrategyEvidence = (
  (await import(
    new URL("../../../services/trial-runner/src/strategy-evidence.ts", import.meta.url).href
  )) as { assembleStrategyEvidence: AssembleStrategyEvidence }
).assembleStrategyEvidence;

const assembleStrategyBundle = (
  (await import(
    new URL("../../../services/trial-runner/src/bundle.ts", import.meta.url).href
  )) as { assembleStrategyBundle: AssembleStrategyBundle }
).assembleStrategyBundle;

const VUSDC = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7" as Address;
const VUSDT = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a" as Address;
const USDC = "0x16227d60f7a0e586c66b005219dfc887d13c9531" as Address;
const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const REGISTRY = "0x2222222222222222222222222222222222222222" as Address;
const MINT_SELECTOR = "0xa0712d68" as Hex;
const BLOCK = "125929412";

function bytes32(fill: string): Hex {
  return `0x${fill.repeat(32)}` as Hex;
}

function observation(): CanonicalValue {
  return {
    schemaVersion: "mandate.venus-observation/1",
    protocolId: "venus",
    chainId: 97,
    account: ACCOUNT,
    blockNumber: BLOCK,
    blockHash: bytes32("ab"),
    comptroller: "0x94d1820b2d1c7c7452a163983dc888cec546b77d",
    markets: [],
    enteredMarkets: [],
    nonMarketDebt: [],
    accountLiquidity: { errorCode: "0", liquidity: "0", shortfall: "0" },
    implementations: {},
  };
}

function reference(overrides: Partial<StrategyReferenceResult> = {}): StrategyReferenceResult {
  return {
    modelId: "venus-yield-reference",
    modelVersion: "1.0.0",
    decisionState: "ACTIONABLE",
    metrics: [{ key: "total-idle-usd", value: "1000000000000000000000", unit: "usd-1e18" }],
    expectedAction: {
      target: VUSDC,
      selector: MINT_SELECTOR,
      args: [{ type: "uint256", value: "1000000000" }],
      amountArgIndex: 0,
      toleratedArgIndexes: [0],
      spendToken: USDC,
      spendDecimals: 6,
    },
    amountToleranceBps: 50,
    notes: [],
    ...overrides,
  };
}

function input(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    category: "YIELD",
    trialSpecHash: bytes32("11"),
    fork: {
      blockNumber: BigInt(BLOCK),
      blockHash: bytes32("ab"),
      rpcSourceClass: "archive",
      anvilVersion: "anvil 1.7.1",
    },
    chainId: 97,
    modifications: [],
    agent: { identityRegistry: REGISTRY, agentId: "1824", agentVersionHash: bytes32("22") },
    authorityScope: { boundable: true },
    invocation: {
      protocol: "HTTP_JSON",
      requestId: "req-1",
      endpointHash: bytes32("33"),
      requestHash: bytes32("44"),
      responseHash: bytes32("55"),
      observationsHash: bytes32("66"),
      latencyMs: 12,
      proposal: {
        decision: "PROPOSE",
        action: {
          target: VUSDC,
          selector: MINT_SELECTOR,
          args: [{ type: "uint256", value: "1000000000" }],
          rationale: "fixture",
        },
        observations: { blockNumber: BLOCK },
      },
    },
    preState: observation(),
    postState: observation(),
    transactions: [],
    referenceImplementationHash: bytes32("77"),
    referenceInputs: {
      permittedTargets: [VUSDT, VUSDC],
      permittedSelectors: [MINT_SELECTOR],
      policyId: "cost-aware-optimizer",
      policyParameters: {
        "min-net-supply-rate-bps": "75",
        "gas-cost-buffer-bps": "25",
        "blocks-per-year": "10000000",
      },
      amountToleranceBps: 50,
    },
    reference: reference(),
    evaluatorImplementationHash: bytes32("88"),
    checks: [
      { checkId: "decision-matches-reference", description: "fixture", status: "PASS" },
    ] satisfies EvaluationCheck[],
    result: "PASS",
    observedAt: 1_786_400_000,
    ...overrides,
  };
}

function yieldTrialSpec(): TrialSpec {
  return {
    ...GOLDEN_TRIAL_SPEC,
    category: "YIELD",
    task: { ...GOLDEN_TRIAL_SPEC.task, actionType: "maximise-supply-yield", resourceId: "vUSDT" },
  };
}

describe("a strategy bundle assembled by the trial-runner", () => {
  it("is accepted by the verifier and tagged as the strategy family", () => {
    // #given a bundle the runner assembled from a passing run
    const { evidence, evidenceHash } = assembleStrategyEvidence(input(), ACCOUNT, "optimise-yield");
    const { bundle } = assembleStrategyBundle(evidence, evidenceHash, yieldTrialSpec());

    // #when the verifier interprets the document at the evidence URI
    const parsed = parseEvidenceDocument(bundle);

    // #then it parses, as STRATEGY, rather than degrading to an unreadable artifact
    expect(parsed.ok ? parsed.value.family : parsed.reason).toBe("STRATEGY");
  });

  it("replays to the PASS its checks support", () => {
    // #given the assembled artifact from a run whose only check passed
    const { evidence } = assembleStrategyEvidence(input(), ACCOUNT, "optimise-yield");

    // #when its outcome is re-derived from the evaluator checks alone
    const replay = replayStrategyEvidence(evidence);

    // #then the derived outcome is PASS
    expect(replay.derived).toBe("PASS");
  });
});

describe("the strategy replay is fail-closed and blind to the published result", () => {
  it("derives FAIL for an artifact the runner assembled as a FAIL", () => {
    // #given a run the runner published as FAIL, with a failing check and a reason
    const { evidence } = assembleStrategyEvidence(
      input({
        result: "FAIL",
        checks: [
          {
            checkId: "decision-matches-reference",
            description: "fixture",
            status: "FAIL",
            expected: "PROPOSE",
            observed: "HOLD",
          },
        ],
        failureReason: "the agent held while the reference model proposed a supply",
      }),
      ACCOUNT,
      "optimise-yield",
    );

    // #when the outcome is re-derived
    const replay = replayStrategyEvidence(evidence);

    // #then it is FAIL
    expect(replay.derived).toBe("FAIL");
  });

  it("derives FAIL when a check is inconclusive even though the result claims PASS", () => {
    // #given a valid PASS artifact whose checks are then made inconclusive while
    // `evaluator.result` is left at PASS. The schema would refuse to publish this,
    // which is the point: the replay must not trust the stated result, so we hand
    // it a document that only a result-reading check would pass.
    const { evidence } = assembleStrategyEvidence(input(), ACCOUNT, "optimise-yield");
    const resultSaysPassChecksDoNot: StrategyTrialEvidence = {
      ...evidence,
      evaluator: {
        ...evidence.evaluator,
        checks: [
          ...evidence.evaluator.checks,
          {
            checkId: "rpc-observation-fetch",
            description: "fixture",
            status: "INCONCLUSIVE",
            inconclusiveReason: "the archive node dropped the request",
          },
        ],
      },
    };

    // #when the outcome is re-derived from the checks
    const replay = replayStrategyEvidence(resultSaysPassChecksDoNot);

    // #then an inconclusive check cannot support a PASS, so it is FAIL
    expect(replay.derived).toBe("FAIL");
  });
});

describe("the strategy replay carries no health-factor arithmetic", () => {
  it("names none of the solvency quantities and does no financial math", () => {
    // #given the strategy replay source
    const source = readFileSync(
      fileURLToPath(new URL("../src/strategy-replay.ts", import.meta.url)),
      "utf8",
    );

    // #then it borrows nothing from the health-factor replay that would let a
    // strategy document be scored as a solvency one
    const forbidden = [
      "healthFactorMantissa",
      "liquidationThreshold",
      "expectedSpendRawUnits",
      "BigInt",
      "* price",
      "/ 1e18",
    ];
    expect(forbidden.filter((token) => source.includes(token))).toEqual([]);
  });
});
