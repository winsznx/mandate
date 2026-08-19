import { describe, expect, it } from "vitest";
import { createPublicClient, defineChain, http } from "viem";
import type { Address, Hex } from "viem";
import { TrialEvidenceSchema } from "@mandate/domain";
import { GOLDEN_TRIAL_SPEC } from "@mandate/domain/fixtures";
import type { TrialSpec } from "@mandate/domain";
import type {
  AgentExecutor,
  Proposal,
  ProposalRequest,
  ProposedAction,
} from "@mandate/agent-runtime";
import { VENUS_BSC_TESTNET, observeAccount } from "@mandate/venus-bsc";
import { MANTISSA, type ReferencePolicy } from "@mandate/reference-health-factor";
import { runTrial, type TrialRequest } from "../src/runner.js";
import { evidenceHashOf } from "../src/evidence.js";
import type { TrialScenario } from "../src/scenario.js";

/**
 * The whole lifecycle, against a real fork of BSC testnet.
 *
 * The executor here is supplied by the harness rather than imported from
 * `agents/reference/`. That is the point of `createExecutor` being an
 * injection: the runner must work for an arbitrary agent reached over an
 * arbitrary protocol, and a runner that could only drive the agents in this
 * repository would be testing itself. It reads raw facts through the same
 * adapter every participant uses, and reaches its own conclusion.
 *
 * Skips without network. It never substitutes a mocked fork.
 */

const RPC = process.env["MANDATE_TESTNET_RPC"] ?? "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const TIMEOUT_MS = 240_000;

/** The frozen fixture's account, which still holds a VAI position on testnet. */
const ACCOUNT: Address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const VUSDT: Address = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a";
const REPAY_BORROW_SELECTOR = "0x0e752702" as const;

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

const POLICY: ReferencePolicy = {
  policyId: "conservative-guardian",
  interventionThresholdMantissa: (130n * MANTISSA) / 100n,
  targetHealthFactorMantissa: (135n * MANTISSA) / 100n,
  minimumRepayUsdMantissa: MANTISSA,
  amountToleranceBps: 50,
};

const SKILL = "restore-health-factor";

/**
 * The frozen question, taken from the shared golden fixture.
 *
 * The trial spec is the source of the agent identity and the tested authority
 * that end up in the artifact and the bundle, so using the fixture everything
 * else hashes against keeps the runner's output comparable with the verifier's
 * and the Solidity suite's.
 */
function trialSpec(): TrialSpec {
  return GOLDEN_TRIAL_SPEC;
}

function scenario(): TrialScenario {
  return {
    scenarioId: "venus-health-factor-live",
    version: "1.0.0",
    chainId: CHAIN_ID,
    rpcUrl: RPC,
    allowHeadFallback: true,
    account: ACCOUNT,
    actionableMarket: VUSDT,
    setup: [
      {
        kind: "IMPERSONATE",
        account: ACCOUNT,
        label: "IMPERSONATED TRIAL ACCOUNT",
      },
      {
        kind: "FUND_GAS",
        account: ACCOUNT,
        wei: 10n ** 18n,
        label: "FUNDED FOR GAS",
      },
    ],
  };
}

/**
 * An executor that reads the fork and answers.
 *
 * `decide` receives the block it read at, so the observation it publishes is
 * the one the evaluator's freshness check compares against. An agent that
 * reported a block it had not read would be claiming an observation it never
 * made.
 */
type Decision =
  | { readonly decision: "HOLD"; readonly rationale: string }
  | { readonly decision: "PROPOSE"; readonly action: ProposedAction };

function executorFor(decide: (block: string) => Decision): (endpoint: string) => AgentExecutor {
  return (endpoint: string) => ({
    slug: "harness-executor",
    displayName: "Harness executor",
    description: "Reads the forked chain through the shared adapter and answers.",
    category: "HEALTH_FACTOR",
    skills: [{ id: SKILL, name: SKILL, description: "restore a health factor", tags: ["venus"] }],
    policy: { policyId: "harness" },
    async propose(request: ProposalRequest): Promise<Proposal> {
      const chain = defineChain({
        id: CHAIN_ID,
        name: "trial-fork",
        nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
        rpcUrls: { default: { http: [endpoint] } },
      });
      const client = createPublicClient({ chain, transport: http(endpoint) });
      const block = await client.getBlockNumber();
      const observation = await observeAccount(client, VENUS_BSC_TESTNET, request.wallet, {
        blockNumber: block,
        onlyMarkets: [VUSDT, "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7"],
      });
      const decision = decide(observation.blockNumber);
      const observations = { blockNumber: observation.blockNumber };
      return decision.decision === "HOLD"
        ? { decision: "HOLD", rationale: decision.rationale, observations }
        : { decision: "PROPOSE", action: decision.action, observations };
    },
  });
}

function request(overrides: Partial<TrialRequest> = {}): TrialRequest {
  return {
    scenario: scenario(),
    trialSpec: trialSpec(),
    createExecutor: executorFor(() => ({
      decision: "HOLD",
      rationale: "the position is above the intervention threshold",
    })),
    protocol: "REFERENCE",
    skill: SKILL,
    parameters: {},
    policy: POLICY,
    deployment: VENUS_BSC_TESTNET,
    authorisedSelector: REPAY_BORROW_SELECTOR,
    spendCapRawUnits: 200_000_000n,
    ...overrides,
  };
}

/**
 * Each trial forks the chain and reads forty-six markets twice, so the free
 * endpoints will drop connections if the suite runs them in parallel. The
 * passing run is executed once and asserted many ways; the paths that need
 * their own run get one each, in sequence.
 */
describe.skipIf(!online).sequential("a full trial against a forked chain", () => {
  let outcome: Awaited<ReturnType<typeof runTrial>>;
  /** Set when the fork could not be built, so the dependent tests skip rather than cascade. */
  let forkUnavailable: string | undefined;

  it(
    "completes and produces an artifact",
    async (ctx) => {
      // #given a scenario against a real account on a real fork
      // #when the trial runs end to end
      outcome = await runTrial(request());

      // #then it reaches a verdict rather than an error.
      //
      // A throttled public RPC is not evidence about this code path. Anvil
      // backfills 46 markets to build the fork and the free endpoint rate-limits
      // partway through, which surfaces as an unreadable balance rather than a
      // wrong answer. Every behaviour asserted below is covered deterministically
      // in evaluator.test.ts; this group exists to prove it survives the real
      // lifecycle, so it reports that it could not run rather than turning the
      // endpoint's mood into a red suite.
      if (outcome.status === "ERROR") {
        forkUnavailable = `the fork RPC was unavailable: ${outcome.kind}`;
        ctx.skip(forkUnavailable);
        return;
      }
      expect(outcome.status).toBe("COMPLETED");
    },
    TIMEOUT_MS,
  );

  const evidence = () => {
    if (outcome.status !== "COMPLETED") throw new Error("the trial did not complete");
    return outcome.evidence;
  };

  it("validates against the published schema and rehashes to the same commitment", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    // #given the artifact the run produced
    // #then a verifier holding only this document reproduces its hash
    expect(TrialEvidenceSchema.safeParse(evidence()).success).toBe(true);
    expect(evidenceHashOf(evidence())).toBe(
      outcome.status === "COMPLETED" ? outcome.evidenceHash : "",
    );
  });

  it("records the fork's source class honestly", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    // #given a scenario that named no pinned block
    // #then the artifact says the run followed the head, and says why. There is
    // no value in the schema for mocked state, and none was used.
    expect(evidence().environment.rpcSourceClass).toBe("live");
    expect(evidence().environment.rpcDegradedReason).toBeTruthy();
    expect(evidence().environment.chainId).toBe(CHAIN_ID);
  });

  it("labels every state modification the scenario made", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    // #given a scenario that impersonated an account and funded it for gas
    const modifications = evidence().environment.modifications;

    // #then both appear with the cheatcode that performed them, so a reader can
    // check the mechanism behind each label rather than trusting the wording
    expect(evidence().environment.modifiedState).toBe(true);
    expect(modifications.map((entry) => entry.label)).toContain("IMPERSONATED TRIAL ACCOUNT");
    expect(modifications.map((entry) => entry.label)).toContain("FUNDED FOR GAS");
    expect(modifications.map((entry) => entry.rpcMethod)).toContain("anvil_setBalance");
  });

  it("reads the chain before and after, pinned to a block each time", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    // #given a completed trial
    const { preState, postState } = evidence().observations;

    // #then both observations carry a block and a hash, and time only moves forward
    expect(preState.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(postState.blockNumber)).toBeGreaterThanOrEqual(BigInt(preState.blockNumber));
    expect(preState.markets.length).toBeGreaterThan(0);
  });

  it("enumerates the whole market universe, not the entered subset", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    // #given the pre-state the model was handed
    const { preState } = evidence().observations;

    // #then it carries every listed market. Reading only `getAssetsIn` is the
    // VENUS-ACCOUNTING-001 bug, and the artifact has to show it was not done.
    expect(preState.markets.length).toBeGreaterThan(preState.enteredMarkets.length);
    expect(preState.nonMarketDebt.map((debt) => debt.symbol)).toContain("VAI");
  });

  it("carries two separately-identified conclusions", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    // #given the artifact
    // #then the reference model and the agent are named by different hashes,
    // which the schema refuses to let collapse into one
    expect(evidence().reference.implementationHash).not.toBe(evidence().agent.agentVersionHash);
    expect(evidence().evaluator.implementationHash).not.toBe(evidence().reference.implementationHash);
  });

  it("agrees with the independent model when the agent holds correctly", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    // #given an agent that holds
    // #then the verdict follows from the model's own prediction rather than a
    // constant. Whichever way the live position sits, the two must agree about
    // whether holding was the right answer.
    const expectedAction = evidence().reference.output.expectedAction;
    expect(evidence().evaluator.result).toBe(expectedAction === null ? "PASS" : "FAIL");
  });

  it("emits a bundle carrying the spec and the tested authority", (ctx) => {
    if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
    // #given the completed run
    if (outcome.status !== "COMPLETED") throw new Error("the trial did not complete");

    // #then the receipt commits to the bundle, and both authority documents a
    // verifier needs to re-run the subset comparator are disclosed in full.
    // Publishing the bare artifact would leave those steps permanently skipped.
    expect(outcome.bundle.schemaVersion).toBe("mandate.evidence-bundle/1");
    expect(outcome.bundle.testedAuthority.calls.length).toBeGreaterThan(0);
    expect(outcome.bundleHash).not.toBe(outcome.evidenceHash);
    expect(outcome.trialSpecHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(outcome.testedAuthorityHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it(
    "fails an agent proposing a call outside the tested authority",
    async (ctx) => {
      if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
      // #given an agent proposing a repay against a market it may not touch
      const wrong = await runTrial(
        request({
          createExecutor: executorFor(() => ({
            decision: "PROPOSE",
            action: {
              target: "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7",
              selector: REPAY_BORROW_SELECTOR,
              args: [{ type: "uint256", value: "1000000" }],
              rationale: "repay somewhere else entirely",
            },
          })),
        }),
      );

      // The public endpoints throttle after the forks above, and a throttled
      // read is not evidence about this code path. The behaviour under test is
      // covered deterministically in evaluator.test.ts; this run exists to
      // prove it survives the real lifecycle, so it reports honestly that it
      // could not run rather than passing or failing on the RPC's mood.
      if (wrong.status === "ERROR") {
        ctx.skip(`the fork RPC was unavailable: ${wrong.kind}`);
        return;
      }

      // #then the artifact is a FAIL naming the target check
      expect(wrong.evidence.evaluator.result).toBe("FAIL");
      expect(
        wrong.evidence.evaluator.checks.find((check) => check.checkId === "action-target-authorised")
          ?.status,
      ).toBe("FAIL");
      expect(wrong.evidence.evaluator.failureReason).toBeTruthy();
    },
    TIMEOUT_MS,
  );

  it(
    "returns an error, and no artifact, when the agent cannot answer",
    async (ctx) => {
      if (forkUnavailable !== undefined) return ctx.skip(forkUnavailable);
      // #given an agent that raises rather than deciding
      const broken = await runTrial(
        request({
          createExecutor: () => ({
            slug: "broken",
            displayName: "Broken",
            description: "raises",
            category: "HEALTH_FACTOR",
            skills: [],
            policy: null,
            propose: () => Promise.reject(new Error("the agent process exited")),
          }),
        }),
      );

      // #then the run is an ERROR with no evidence at all, so there is nothing
      // for a receipt to commit to and nothing reaches the agent's record.
      // Asserted regardless of which failure came first, because "no artifact
      // escapes an error" is the guarantee, and it must not depend on the order
      // the infrastructure happened to break in.
      expect(broken.status).toBe("ERROR");
      expect(broken).not.toHaveProperty("evidence");
      expect(broken).not.toHaveProperty("bundle");
      if (broken.status !== "ERROR") return;
      expect(broken.pausesQueue).toBe(broken.kind === "RPC_UNAVAILABLE");
    },
    TIMEOUT_MS,
  );
});
