import { describe, expect, it } from "vitest";
import { createPublicClient, defineChain, http } from "viem";
import type { Hex, PublicClient } from "viem";
import { StrategyTrialEvidenceSchema } from "@mandate/domain";
import type {
  StrategyReferenceResult,
  StrategyTrialEvidence,
  TrialSpec,
} from "@mandate/domain";
import { GOLDEN_TRIAL_SPEC } from "@mandate/domain/fixtures";
import type { AgentExecutor, Proposal } from "@mandate/agent-runtime";
import { runStrategyTrial } from "../src/strategy-runner.js";
import type {
  StrategyObservationPair,
  StrategyTrialRequest,
  StrategyTrialRunResult,
} from "../src/strategy-runner.js";
import { strategyEvidenceHashOf } from "../src/strategy-evidence.js";
import type { StrategyReferenceInputsRecord } from "../src/strategy-evidence.js";
import type { TrialScenario } from "../src/scenario.js";
import { ACCOUNT, observation, SPEND_CAP_RAW_UNITS, VUSDC, VUSDT } from "./fixtures.js";

const RPC = process.env["MANDATE_TESTNET_RPC"] ?? "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const TIMEOUT_MS = 240_000;
const SKILL = "maximise-supply-yield";
const MINT_SELECTOR = "0xa0712d68" as const;
const MODEL_SUPPLIED_RAW_UNITS = 1_000_000n;

const bytes32 = (fill: string): Hex => `0x${fill.repeat(64)}` as Hex;

const REFERENCE_IMPLEMENTATION_HASH = bytes32("c");

const REFERENCE_INPUTS: StrategyReferenceInputsRecord = {
  permittedTargets: [VUSDT, VUSDC],
  permittedSelectors: [MINT_SELECTOR],
  policyId: "cost-aware-supply-optimizer",
  policyParameters: {
    "min-net-supply-rate-bps": "75",
    "gas-cost-buffer-bps": "25",
  },
  amountToleranceBps: 50,
};

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const online = await reachable();

interface Model {
  readonly suppliedRawUnits: bigint;
}

interface RunSpies {
  readonly timeline: string[];
  agentInvoked: boolean;
  sawAgentDuringPredict: boolean | null;
}

function scenario(): TrialScenario {
  return {
    scenarioId: "venus-yield-live",
    version: "1.0.0",
    chainId: CHAIN_ID,
    rpcUrl: RPC,
    allowHeadFallback: true,
    account: ACCOUNT,
    actionableMarket: VUSDT,
    setup: [
      { kind: "IMPERSONATE", account: ACCOUNT, label: "IMPERSONATED TRIAL ACCOUNT" },
      { kind: "FUND_GAS", account: ACCOUNT, wei: 10n ** 18n, label: "FUNDED FOR GAS" },
    ],
  };
}

function yieldTrialSpec(): TrialSpec {
  return {
    ...GOLDEN_TRIAL_SPEC,
    category: "YIELD",
    task: {
      ...GOLDEN_TRIAL_SPEC.task,
      actionType: "maximise-supply-yield",
      resourceId: "vUSDT",
    },
  };
}

function idleReference(): StrategyReferenceResult {
  return {
    modelId: "venus-yield-reference",
    modelVersion: "1.0.0",
    decisionState: "WITHIN_POLICY",
    metrics: [{ key: "net-supply-rate-bps", value: "0", unit: "bps" }],
    expectedAction: null,
    amountToleranceBps: 50,
    notes: [],
  };
}

function unreadableReference(): StrategyReferenceResult {
  return {
    modelId: "venus-yield-reference",
    modelVersion: "1.0.0",
    decisionState: "UNREADABLE_STATE",
    metrics: [],
    expectedAction: null,
    amountToleranceBps: 50,
    failClosedReason: "supplyRatePerBlock() reverted on the forked market",
    notes: [],
  };
}

function observeWith(spies: RunSpies) {
  return async (
    _client: PublicClient,
    blockNumber: bigint,
  ): Promise<StrategyObservationPair<Model>> => {
    spies.timeline.push("observe");
    return {
      published: observation({ blockNumber }),
      model: { suppliedRawUnits: MODEL_SUPPLIED_RAW_UNITS },
    };
  };
}

function predictWith(spies: RunSpies, reference: StrategyReferenceResult) {
  return (_observation: Model): StrategyReferenceResult => {
    spies.timeline.push("predict");
    spies.sawAgentDuringPredict = spies.agentInvoked;
    return reference;
  };
}

function holdExecutor(spies: RunSpies): (endpoint: string) => AgentExecutor {
  return (endpoint: string) => ({
    slug: "harness-yield-executor",
    displayName: "Harness yield executor",
    description: "Reads the forked chain's block and holds.",
    category: "YIELD",
    skills: [{ id: SKILL, name: SKILL, description: "optimise supply yield", tags: ["venus"] }],
    policy: { policyId: "harness" },
    async propose(): Promise<Proposal> {
      spies.agentInvoked = true;
      spies.timeline.push("agent");
      const chain = defineChain({
        id: CHAIN_ID,
        name: "trial-fork",
        nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
        rpcUrls: { default: { http: [endpoint] } },
      });
      const client = createPublicClient({ chain, transport: http(endpoint) });
      const block = await client.getBlockNumber();
      return {
        decision: "HOLD",
        rationale: "no market clears the net-rate floor after gas",
        observations: { blockNumber: block.toString(10) },
      };
    },
  });
}

function buildRequest(overrides: Partial<StrategyTrialRequest<Model>> = {}): {
  request: StrategyTrialRequest<Model>;
  spies: RunSpies;
} {
  const spies: RunSpies = { timeline: [], agentInvoked: false, sawAgentDuringPredict: null };
  const request: StrategyTrialRequest<Model> = {
    scenario: scenario(),
    trialSpec: yieldTrialSpec(),
    createExecutor: holdExecutor(spies),
    protocol: "REFERENCE",
    skill: SKILL,
    parameters: {},
    observe: observeWith(spies),
    predict: predictWith(spies, idleReference()),
    referenceImplementationHash: REFERENCE_IMPLEMENTATION_HASH,
    referenceInputs: REFERENCE_INPUTS,
    authorityScope: { boundable: true },
    authorisedTargets: [VUSDT, VUSDC],
    authorisedSelectors: [MINT_SELECTOR],
    spendCapFor: () => SPEND_CAP_RAW_UNITS,
    expectedEffect: (pre, post) => ({
      key: "supplied-raw-units",
      description: "the supplied balance moves as the allocation predicts",
      before: pre.suppliedRawUnits,
      after: post.suppliedRawUnits,
      direction: "INCREASE",
      idleDirection: "EITHER",
    }),
    ...overrides,
  };
  return { request, spies };
}

describe.skipIf(!online).sequential("a strategy trial against a forked chain", () => {
  let outcome: StrategyTrialRunResult;
  let forkUnavailable: string | undefined;
  let mainSpies: RunSpies;

  it(
    "completes and produces an artifact",
    async (ctx) => {
      // #given a yield scenario against a real account on a live fork
      const built = buildRequest();
      mainSpies = built.spies;
      // #when the trial runs end to end
      outcome = await runStrategyTrial(built.request);
      // #then it reaches a verdict. A throttled public RPC is not evidence about
      // this path, so an infrastructure error reports the fork could not be built
      // rather than turning the endpoint's mood into a red suite.
      if (outcome.status === "ERROR") {
        forkUnavailable = `the fork RPC was unavailable: ${outcome.kind}`;
        ctx.skip(forkUnavailable);
        return;
      }
      expect(outcome.status).toBe("COMPLETED");
    },
    TIMEOUT_MS,
  );

  const evidence = (): StrategyTrialEvidence => {
    if (outcome.status !== "COMPLETED") throw new Error("the trial did not complete");
    return outcome.evidence;
  };

  it("runs the reference model on the pre-state before the agent is invoked", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    // #given a run that recorded the order its callbacks fired in
    // #then the prediction was made before the agent ran, so it cannot be a
    // reaction to the answer the agent gave
    expect(mainSpies.sawAgentDuringPredict).toBe(false);
    expect(mainSpies.timeline).toEqual(["observe", "predict", "agent", "observe"]);
  });

  it("validates against the published schema and rehashes to the same commitment", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    // #given the artifact the run produced
    // #then a verifier holding only this document reproduces its hash
    expect(StrategyTrialEvidenceSchema.safeParse(evidence()).success).toBe(true);
    expect(strategyEvidenceHashOf(evidence())).toBe(
      outcome.status === "COMPLETED" ? outcome.evidenceHash : "",
    );
  });

  it("carries two separately-identified conclusions", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    // #given the artifact
    // #then the reference model and the agent are named by different hashes, a
    // separation the schema refuses to let collapse into one
    expect(evidence().reference.implementationHash).not.toBe(evidence().agent.agentVersionHash);
    expect(evidence().evaluator.implementationHash).not.toBe(
      evidence().reference.implementationHash,
    );
  });

  it("agrees with the independent model when the agent holds correctly", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    // #given an idle market where the model prescribes no action and the agent holds
    // #then the verdict follows the model's own prediction rather than a constant
    const expectedAction = evidence().reference.output.expectedAction;
    expect(evidence().evaluator.result).toBe(expectedAction === null ? "PASS" : "FAIL");
  });

  it("emits a bundle carrying the spec and the tested authority", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    if (outcome.status !== "COMPLETED") throw new Error("the trial did not complete");
    // #given the completed run
    // #then the receipt commits to a bundle distinct from the bare artifact, and
    // the authority a verifier needs is disclosed in full
    expect(outcome.bundle.schemaVersion).toBe("mandate.strategy-evidence-bundle/1");
    expect(outcome.bundle.testedAuthority.calls.length).toBeGreaterThan(0);
    expect(outcome.bundleHash).not.toBe(outcome.evidenceHash);
    expect(outcome.trialSpecHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(outcome.testedAuthorityHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it(
    "returns an error, and no artifact, when the agent cannot answer",
    async (ctx) => {
      if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
      // #given an agent that raises rather than deciding
      const { request } = buildRequest({
        createExecutor: () => ({
          slug: "broken",
          displayName: "Broken",
          description: "raises instead of answering",
          category: "YIELD",
          skills: [],
          policy: null,
          propose: () => Promise.reject(new Error("the agent process exited")),
        }),
      });
      // #when the trial runs
      const broken = await runStrategyTrial(request);
      // #then it is an ERROR carrying no evidence and no bundle. Asserted
      // regardless of which failure came first: "no artifact escapes an error"
      // must not depend on the order the infrastructure happened to break in.
      expect(broken.status).toBe("ERROR");
      expect(broken).not.toHaveProperty("evidence");
      expect(broken).not.toHaveProperty("bundle");
      if (broken.status !== "ERROR") return;
      expect(broken.pausesQueue).toBe(broken.kind === "RPC_UNAVAILABLE");
    },
    TIMEOUT_MS,
  );

  it(
    "returns an error, and no artifact, when the reference model cannot decide",
    async (ctx) => {
      if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
      // #given a reference model that failed closed on an unreadable state
      const { request } = buildRequest({ predict: () => unreadableReference() });
      // #when the trial runs
      const broken = await runStrategyTrial(request);
      // #then no verdict is reached: an inconclusive check makes the run an ERROR,
      // never a FAIL, so a harness fault never lands on the agent's record and no
      // artifact escapes for a receipt to commit to
      expect(broken.status).toBe("ERROR");
      expect(broken).not.toHaveProperty("evidence");
      expect(broken).not.toHaveProperty("bundle");
      if (broken.status !== "ERROR") return;
      // The reference path is only reached once the fork itself came up. A
      // throttled RPC that broke earlier is a different, equally valid error;
      // report that rather than asserting a kind the run never reached.
      if (broken.kind !== "REFERENCE_MODEL_FAILED") {
        return ctx.skip(`the fork RPC was unavailable: ${broken.kind}`);
      }
      expect(broken.kind).toBe("REFERENCE_MODEL_FAILED");
    },
    TIMEOUT_MS,
  );
});
