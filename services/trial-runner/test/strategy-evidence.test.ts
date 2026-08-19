import { describe, expect, it } from "vitest";
import { StrategyTrialEvidenceSchema, canonicalHash } from "@mandate/domain";
import type { CanonicalValue, StrategyReferenceResult, StrategyTrialEvidence } from "@mandate/domain";
import type { Address, Hex } from "viem";
import {
  assembleStrategyEvidence,
  strategyEvidenceHashOf,
  type StrategyEvidenceInput,
} from "../src/strategy-evidence.js";

/**
 * The artifact these categories publish, built through the schema.
 *
 * Assembling by hand and validating afterwards would make the refinements a
 * convention the assembly code is supposed to remember. Building through the
 * schema makes them unbreakable, which matters most for the ones that keep a
 * PASS honest.
 */

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

function input(overrides: Partial<StrategyEvidenceInput> = {}): StrategyEvidenceInput {
  return {
    category: "YIELD",
    trialSpecHash: bytes32("11"),
    fork: {
      blockNumber: BigInt(BLOCK),
      blockHash: bytes32("ab"),
      rpcSourceClass: "archive",
      anvilVersion: "anvil 1.7.1",
    } as StrategyEvidenceInput["fork"],
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
    } as StrategyEvidenceInput["invocation"],
    preState: observation() as unknown as StrategyEvidenceInput["preState"],
    postState: observation() as unknown as StrategyEvidenceInput["postState"],
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
    ],
    result: "PASS",
    observedAt: 1_786_400_000,
    ...overrides,
  };
}

function assemble(overrides: Partial<StrategyEvidenceInput> = {}) {
  return assembleStrategyEvidence(input(overrides), ACCOUNT, "optimise-yield");
}

describe("the assembled artifact", () => {
  it("validates against the published schema", () => {
    // #given a completed run
    const { evidence } = assemble();

    // #then the document a receipt commits to is one a verifier can parse
    expect(StrategyTrialEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(evidence.schemaVersion).toBe("mandate.strategy-trial-evidence/1");
  });

  it("hashes over the parsed document, so what was hashed is what a reader validates", () => {
    // #given the assembled artifact and its hash
    const { evidence, evidenceHash } = assemble();

    // #then re-deriving the hash the way a verifier does returns the same value
    expect(strategyEvidenceHashOf(evidence)).toBe(evidenceHash);
  });

  it("commits to the disclosed inputs rather than to something nobody can check", () => {
    // #given the artifact
    const { evidence } = assemble();

    // #then `inputsHash` is the hash of the inputs block that travels beside it,
    // so a reader can rehash what they were given and confirm it is what was
    // published. A commitment to something absent from the document would prove
    // only that it had not changed.
    expect(evidence.reference.inputsHash).toBe(
      canonicalHash(evidence.reference.inputs as unknown as CanonicalValue),
    );
  });

  it("carries both conclusions, each with the hash of the code that produced it", () => {
    // #given the artifact
    const { evidence } = assemble();

    // #then the reference model and the evaluator are named separately, and
    // neither is the agent. The whole point of the trial is that they were
    // reached apart; one number called agreed would prove nothing.
    expect(evidence.reference.implementationHash).not.toBe(evidence.agent.agentVersionHash);
    expect(evidence.evaluator.implementationHash).not.toBe(evidence.reference.implementationHash);
  });
});

describe("the refinements that keep a PASS honest", () => {
  it("refuses a PASS containing a failed check", () => {
    // #given a run marked PASS whose checks include a failure
    // #then assembly raises rather than publishing it. A verdict that
    // contradicts its own evidence is a bug in the runner, not a result.
    expect(() =>
      assemble({
        checks: [
          { checkId: "decision-matches-reference", description: "fixture", status: "FAIL", expected: "PROPOSE", observed: "HOLD" },
        ],
      }),
    ).toThrow(/not valid strategy evidence/);
  });

  it("refuses a FAIL that states no reason", () => {
    // #given a failing run with no reason attached
    expect(() =>
      assemble({
        result: "FAIL",
        checks: [
          { checkId: "decision-matches-reference", description: "fixture", status: "FAIL", expected: "PROPOSE", observed: "HOLD" },
        ],
      }),
    ).toThrow(/not valid strategy evidence/);
  });

  it("refuses a health-factor run", () => {
    // #given a document claiming the health-factor category
    // #then it is rejected. That category publishes `TrialEvidence`, whose
    // reference block commits to a health factor; routing it through this
    // document would drop the solvency figures a reader expects to find.
    expect(() => assemble({ category: "HEALTH_FACTOR" })).toThrow(/not valid strategy evidence/);
  });

  it("refuses an observation from a chain the fork was not taken from", () => {
    // #given a pre-state read from a different chain
    const foreign = { ...(observation() as Record<string, unknown>), chainId: 56 };
    expect(() =>
      assemble({ preState: foreign as unknown as StrategyEvidenceInput["preState"] }),
    ).toThrow(/not valid strategy evidence/);
  });

  it("refuses an unboundable authority that does not say what makes it unboundable", () => {
    // #given a fork-only run with no reason recorded
    // #then it raises. "This needs a guard" is not a finding; the specific
    // calldata argument or invariant is, and the artifact has to carry it or a
    // reader cannot tell a fork-only result from a grant-ready one.
    expect(() => assemble({ authorityScope: { boundable: false } })).toThrow(
      /not valid strategy evidence/,
    );
  });

  it("accepts an unboundable authority that names its reason", () => {
    // #given a fork-only run that states the argument
    const { evidence } = assemble({
      authorityScope: {
        boundable: false,
        unboundableReason:
          "argument 4 of swapExactTokensForTokens is an arbitrary recipient, and argument 3 is an arbitrary token path",
      },
    });

    // #then the artifact records the trial and the limitation together, so the
    // result cannot be read as evidence that a live grant is safe
    expect(evidence.authorityScope.boundable).toBe(false);
    expect(evidence.authorityScope.unboundableReason).toMatch(/arbitrary recipient/);
  });

  it("refuses a reference block whose disclosed tolerance contradicts its output", () => {
    // #given inputs claiming one tolerance and an output reporting another
    expect(() =>
      assemble({
        referenceInputs: { ...input().referenceInputs, amountToleranceBps: 10 },
      }),
    ).toThrow(/not valid strategy evidence/);
  });

  it("refuses a model that failed closed and still prescribed an action", () => {
    // #given an `UNREADABLE_STATE` result carrying an expected action
    expect(() =>
      assemble({
        reference: reference({
          decisionState: "UNREADABLE_STATE",
          failClosedReason: "supplyRatePerBlock(): connection reset",
        }),
      }),
    ).toThrow(/not valid strategy evidence/);
  });
});

describe("a holding agent produces a complete artifact", () => {
  it("records a HOLD with its reason and no action", () => {
    // #given a run where the model and the agent both declined to act
    const { evidence } = assemble({
      invocation: {
        ...input().invocation,
        proposal: { decision: "HOLD", rationale: "no market clears the floor", observations: { blockNumber: BLOCK } },
      } as StrategyEvidenceInput["invocation"],
      reference: reference({ decisionState: "WITHIN_POLICY", expectedAction: null }),
    });

    // #then holding is a normal outcome carried in full. An agent that
    // correctly declines to act has to be able to produce a passing artifact,
    // or the only way to earn a receipt is to trade.
    const proposal = evidence.observations.agentProposal as StrategyTrialEvidence["observations"]["agentProposal"];
    expect(proposal.decision).toBe("HOLD");
    expect(proposal.rationale).toBe("no market clears the floor");
    expect(evidence.reference.output.expectedAction).toBeNull();
  });
});
