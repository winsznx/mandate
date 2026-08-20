/**
 * The trial lifecycle for the categories whose decision is an allocation or a
 * trade.
 *
 * Same order and the same load-bearing rule as `runner.ts`: the reference model
 * runs against the pre-state before the agent is invoked and cannot see the
 * agent's answer. What differs is that this runner knows nothing about the
 * protocol it is running against. It cannot: a yield run reads Venus supply
 * markets, a grid run reads a Curve pool, and a runner that branched on which
 * would end up holding the protocol knowledge that the whole architecture keeps
 * out of the judging layer.
 *
 * So the caller supplies four functions and this file supplies the lifecycle.
 * `observe` reads the chain, `predict` runs the independent model over it,
 * `expectedEffect` names the one reading the action should move, and
 * `spendCapFor` says which cap applies to the token the model expects to spend.
 * None of them is called anywhere the ordering could leak an answer backwards.
 *
 * Two observations come back from every read, and the distinction matters. The
 * `model` observation is the one the reference model consumes; the `published`
 * one is what the artifact carries, and `StrategyTrialEvidence` requires that to
 * be a `RawProtocolObservation`. A caller whose venue cannot produce one has to
 * say so rather than assemble a plausible-looking document out of defaults.
 *
 * Every exit that is not a verdict is an `ERROR`. A trial that could not run
 * produces no evidence, so there is nothing for a receipt to commit to and
 * nothing that reaches an agent's public record.
 */
import type { Address, Hex, PublicClient } from "viem";
import type {
  RawProtocolObservation,
  StrategyReferenceResult,
  StrategyTrialEvidence,
  TrialSpec,
} from "@mandate/domain";
import type { AgentExecutor } from "@mandate/agent-runtime";
import { startFork, type ForkHandle } from "./anvil.js";
import { applyScenario, type TrialScenario } from "./scenario.js";
import { TrialInfrastructureError, toErrorRecord, type TrialErrorRecord } from "./errors.js";
import { invokeAgent, type InvocationProtocol } from "./invoke.js";
import { evaluateStrategy, type ExpectedEffect } from "./strategy-evaluator.js";
import { strategyEvaluatorImplementationHash } from "./identity.js";
import {
  assembleStrategyEvidence,
  type AuthorityScope,
  type StrategyReferenceInputsRecord,
} from "./strategy-evidence.js";
import {
  agentObservedBlock,
  forkClient,
  setupEvidence,
  submitProposal,
} from "./submit.js";
import {
  assembleStrategyBundle,
  testedAuthorityHashOf,
  trialSpecHashOf,
  type StrategyEvidenceBundle,
} from "./bundle.js";

/**
 * One block's readings, in the two forms the run needs them.
 *
 * Split rather than merged because they answer to different contracts. The
 * model's input is whatever that category's model was written against; the
 * published document is fixed by the evidence schema. Collapsing them would
 * mean either publishing something the schema rejects or handing the model a
 * document it cannot read.
 */
export interface StrategyObservationPair<TModel> {
  /** What the artifact carries as `observations.preState` and `postState`. */
  readonly published: RawProtocolObservation;
  /** What the reference model is given. Never assembled or reshaped here. */
  readonly model: TModel;
}

export interface StrategyTrialRequest<TModel> {
  readonly scenario: TrialScenario;
  /**
   * The frozen question.
   *
   * Carried whole rather than as a hash, for the same reason `runTrial` carries
   * it: the receipt's `trialSpecHash` is derived here, so the document a
   * verifier reads and the commitment it checks cannot disagree.
   */
  readonly trialSpec: TrialSpec;
  readonly trialSpecUri?: string;
  /**
   * Build the executor against the fork.
   *
   * A factory rather than an instance because the agent has to read the forked
   * chain. An executor wired to the public RPC would answer about a position
   * the trial did not create, and would pass or fail on it.
   */
  readonly createExecutor: (endpoint: string) => AgentExecutor | Promise<AgentExecutor>;
  /** The agent's published endpoint, hashed into the artifact. Defaults to the fork's. */
  readonly publishedEndpoint?: string;
  readonly protocol: InvocationProtocol;
  readonly skill: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Read the venue at one block. Called for the pre-state and again for the post-state. */
  readonly observe: (
    client: PublicClient,
    blockNumber: bigint,
  ) => Promise<StrategyObservationPair<TModel>>;
  /** The independent prediction. Runs on the pre-state, before the agent is asked. */
  readonly predict: (observation: TModel) => StrategyReferenceResult;
  readonly referenceImplementationHash: Hex;
  /** The non-observation inputs the model ran with, disclosed in the artifact. */
  readonly referenceInputs: StrategyReferenceInputsRecord;
  readonly authorityScope: AuthorityScope;
  /** Every `(target, selector)` pair the tested authority permits. */
  readonly authorisedTargets: readonly Address[];
  readonly authorisedSelectors: readonly Hex[];
  /**
   * The cap that applies to the token the model expects the action to spend.
   *
   * A function of the prediction rather than a figure, because a two-sided
   * venue spends a different coin depending on which way it is leaning, and one
   * number carried across both directions would compare an amount of one token
   * against a cap denominated in another.
   */
  readonly spendCapFor: (reference: StrategyReferenceResult) => bigint;
  /**
   * The one chain reading the action should move, read on both sides.
   *
   * Supplied by the caller because finding a balance in an observation is
   * protocol knowledge, and the evaluator is built to have none.
   */
  readonly expectedEffect: (
    pre: TModel,
    post: TModel,
    reference: StrategyReferenceResult,
  ) => ExpectedEffect;
}

export type StrategyTrialRunResult =
  | {
      readonly status: "COMPLETED";
      readonly evidence: StrategyTrialEvidence;
      /** Hash of the artifact alone. The bundle is what a receipt commits to. */
      readonly evidenceHash: Hex;
      /** What goes to `evidenceURI`. Carries the spec and the tested authority in full. */
      readonly bundle: StrategyEvidenceBundle;
      /** What the receipt's `evidenceHash` field must be set to. */
      readonly bundleHash: Hex;
      /** What the receipt's `trialSpecHash` field must be set to. */
      readonly trialSpecHash: Hex;
      /** What the receipt's `testedAuthorityHash` field must be set to. */
      readonly testedAuthorityHash: Hex;
    }
  | TrialErrorRecord;

/**
 * Run one allocation or trading trial.
 *
 * The fork is torn down on every path, including the failing ones. A leaked
 * anvil holds its port and its memory for the lifetime of the runner process,
 * and the next trial in the queue fails in a way that looks nothing like the
 * problem that caused it.
 */
export async function runStrategyTrial<TModel>(
  request: StrategyTrialRequest<TModel>,
): Promise<StrategyTrialRunResult> {
  const observedAt = Math.floor(Date.now() / 1000);
  let fork: ForkHandle | undefined;

  try {
    fork = await startFork({
      rpcUrl: request.scenario.rpcUrl,
      chainId: request.scenario.chainId,
      ...(request.scenario.blockNumber === undefined
        ? {}
        : { blockNumber: request.scenario.blockNumber }),
      allowHeadFallback: request.scenario.allowHeadFallback,
    });

    const { modifications, setupTransactions } = await applyScenario(fork, request.scenario);
    const client = forkClient(fork, request.scenario.chainId);

    const preBlock = await client.getBlockNumber();
    const preState = await request.observe(client, preBlock);

    // Before the agent is asked anything, so the prediction cannot be a
    // reaction to the answer.
    const reference = request.predict(preState.model);

    const executor = await request.createExecutor(fork.endpoint);
    const invocation = await invokeAgent({
      executor,
      protocol: request.protocol,
      endpoint: request.publishedEndpoint ?? fork.endpoint,
      skill: request.skill,
      chainId: request.scenario.chainId,
      wallet: request.scenario.account,
      parameters: request.parameters,
    });

    const transactions = await setupEvidence(fork, setupTransactions);
    if (invocation.proposal.decision === "PROPOSE") {
      transactions.push(
        await submitProposal(
          fork,
          request.scenario.account,
          invocation.proposal,
          transactions.length,
        ),
      );
    }

    const postBlock = await client.getBlockNumber();
    const postState = await request.observe(client, postBlock);

    const outcome = evaluateStrategy({
      proposal: invocation.proposal,
      reference,
      transactions,
      authorisedTargets: request.authorisedTargets,
      authorisedSelectors: request.authorisedSelectors,
      spendCapRawUnits: request.spendCapFor(reference),
      presentedBlock: preState.published.blockNumber,
      agentObservedBlock: agentObservedBlock(invocation),
      effect: request.expectedEffect(preState.model, postState.model, reference),
    });

    if (outcome.status === "INCONCLUSIVE") {
      // A check that could not run is not a verdict. The run ends as an error
      // and touches nothing on the agent's record.
      throw new TrialInfrastructureError("REFERENCE_MODEL_FAILED", outcome.reason);
    }

    const trialSpecHash = trialSpecHashOf(request.trialSpec);
    const assembled = assembleStrategyEvidence(
      {
        category: request.trialSpec.category,
        trialSpecHash,
        ...(request.trialSpecUri === undefined ? {} : { trialSpecUri: request.trialSpecUri }),
        fork,
        chainId: request.scenario.chainId,
        modifications,
        agent: {
          identityRegistry: request.trialSpec.agent.identityRegistry,
          agentId: request.trialSpec.agent.agentId,
          agentVersionHash: request.trialSpec.agent.agentVersionHash,
        },
        authorityScope: request.authorityScope,
        invocation,
        preState: preState.published,
        postState: postState.published,
        transactions,
        referenceImplementationHash: request.referenceImplementationHash,
        referenceInputs: request.referenceInputs,
        reference,
        evaluatorImplementationHash: strategyEvaluatorImplementationHash(),
        checks: outcome.checks,
        result: outcome.result,
        ...(outcome.failureReason === undefined ? {} : { failureReason: outcome.failureReason }),
        observedAt,
      },
      request.scenario.account,
      request.skill,
    );

    // The receipt commits to the bundle, not to the bare artifact. A receipt
    // pointing at an artifact alone leaves the verifier without the authority
    // documents it needs to re-run the subset comparator.
    const bundled = assembleStrategyBundle(
      assembled.evidence,
      assembled.evidenceHash,
      request.trialSpec,
    );

    return {
      status: "COMPLETED",
      evidence: assembled.evidence,
      evidenceHash: assembled.evidenceHash,
      bundle: bundled.bundle,
      bundleHash: bundled.bundleHash,
      trialSpecHash,
      testedAuthorityHash: testedAuthorityHashOf(request.trialSpec.authority),
    };
  } catch (error) {
    return toErrorRecord(error, observedAt);
  } finally {
    await fork?.stop();
  }
}
