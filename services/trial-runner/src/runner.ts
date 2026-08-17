/**
 * The trial lifecycle, end to end.
 *
 * Fork, set the scene, read the chain, ask the model, ask the agent, submit
 * what the agent proposed, read the chain again, judge, emit. The order is
 * load-bearing in one place: the reference model runs against the pre-state
 * before the agent is invoked and cannot see the agent's answer. A model that
 * ran afterwards could be influenced by it, and the artifact's claim that two
 * conclusions were reached independently would stop being true.
 *
 * Every exit that is not a verdict is an `ERROR`. A trial that could not run
 * produces no evidence, so there is nothing for a receipt to commit to and
 * nothing that reaches an agent's public record.
 */
import { createPublicClient, defineChain, encodeAbiParameters, http } from "viem";
import type { AbiParameter, Address, Hex, PublicClient } from "viem";
import type { TransactionEvidence, TrialEvidence, TrialSpec } from "@mandate/domain";
import type { AgentExecutor, Proposal } from "@mandate/agent-runtime";
import type { VenusDeployment } from "@mandate/venus-bsc";
import {
  referenceImplementationHash,
  referenceInputsHash,
  runReferenceModel,
  type ReferencePolicy,
} from "@mandate/reference-health-factor";
import { startFork, forkRpc, type ForkHandle } from "./anvil.js";
import { applyScenario, type SetupTransaction, type TrialScenario } from "./scenario.js";
import { TrialInfrastructureError, toErrorRecord, type TrialErrorRecord } from "./errors.js";
import { observe, toProtocolObservation } from "./observation.js";
import { invokeAgent, type InvocationProtocol, type InvocationRecord } from "./invoke.js";
import { evaluate } from "./evaluator.js";
import { evaluatorImplementationHash } from "./identity.js";
import { assembleEvidence } from "./evidence.js";
import {
  assembleBundle,
  testedAuthorityHashOf,
  trialSpecHashOf,
  type EvidenceBundle,
} from "./bundle.js";

export interface TrialRequest {
  readonly scenario: TrialScenario;
  /**
   * The frozen question.
   *
   * Carried whole rather than as a hash. The receipt's `trialSpecHash` is
   * derived from it here, so the document a verifier reads and the commitment
   * it checks cannot disagree, and the agent identity and category come out of
   * the same place instead of being restated where they could drift.
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
  readonly policy: ReferencePolicy;
  readonly deployment: VenusDeployment;
  /** The one selector the tested authority permits, e.g. `repayBorrow(uint256)`. */
  readonly authorisedSelector: Hex;
  /** The authority's spend cap in raw underlying units. */
  readonly spendCapRawUnits: bigint;
}

export type TrialRunResult =
  | {
      readonly status: "COMPLETED";
      readonly evidence: TrialEvidence;
      /** Hash of the artifact alone. Bound into the bundle through a recorded note. */
      readonly evidenceHash: Hex;
      /** What goes to `evidenceURI`. Carries the spec and the tested authority in full. */
      readonly bundle: EvidenceBundle;
      /** What the receipt's `evidenceHash` field must be set to. */
      readonly bundleHash: Hex;
      /** What the receipt's `trialSpecHash` field must be set to. */
      readonly trialSpecHash: Hex;
      /** What the receipt's `testedAuthorityHash` field must be set to. */
      readonly testedAuthorityHash: Hex;
    }
  | TrialErrorRecord;

function forkClient(fork: ForkHandle, chainId: number): PublicClient {
  const chain = defineChain({
    id: chainId,
    name: "trial-fork",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [fork.endpoint] } },
  });
  return createPublicClient({ chain, transport: http(fork.endpoint) }) as PublicClient;
}

/**
 * Encode a proposed action into calldata.
 *
 * The argument types come from the proposal itself, which is why
 * `ProposedAction` carries them: the deterministic layer encodes what the agent
 * described rather than inferring types from a signature it guessed at.
 */
function encodeAction(proposal: Extract<Proposal, { decision: "PROPOSE" }>): Hex {
  const parameters: AbiParameter[] = proposal.action.args.map((argument) => ({
    type: argument.type,
    name: "",
  }));

  const values = proposal.action.args.map((argument) => {
    if (argument.type.startsWith("uint") || argument.type.startsWith("int")) {
      return BigInt(argument.value);
    }
    if (argument.type === "bool") return argument.value === "true";
    if (argument.type === "address" || argument.type.startsWith("bytes")) {
      return argument.value as Hex;
    }
    if (argument.type === "string") return argument.value;
    throw new TrialInfrastructureError(
      "TRANSACTION_SUBMISSION_FAILED",
      `the proposal used an argument type the runner cannot encode: ${argument.type}`,
    );
  });

  const encoded = encodeAbiParameters(parameters, values);
  return `${proposal.action.selector}${encoded.slice(2)}` as Hex;
}

function selectorOf(data: Hex): string | undefined {
  return data.length >= 10 ? data.slice(0, 10).toLowerCase() : undefined;
}

interface RawReceipt {
  readonly status: Hex;
  readonly gasUsed: Hex;
  readonly blockNumber: Hex;
}

const RECEIPT_POLL_ATTEMPTS = 40;
const RECEIPT_POLL_MS = 250;

/**
 * Wait for a receipt.
 *
 * Anvil automines, so the receipt is usually there on the first ask, but the
 * send and the lookup are two round trips and the mine lands between them. A
 * single unpolled read turns that race into `TRANSACTION_SUBMISSION_FAILED`,
 * which would abandon a trial over a few hundred milliseconds.
 */
async function awaitReceipt(fork: ForkHandle, hash: Hex): Promise<RawReceipt> {
  for (let attempt = 0; attempt < RECEIPT_POLL_ATTEMPTS; attempt += 1) {
    const receipt = await forkRpc<RawReceipt | null>(fork, "eth_getTransactionReceipt", [hash]);
    if (receipt !== null) return receipt;
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
  }
  throw new TrialInfrastructureError(
    "TRANSACTION_SUBMISSION_FAILED",
    `the fork produced no receipt for ${hash}`,
  );
}

async function toTransactionEvidence(
  fork: ForkHandle,
  hash: Hex,
  index: number,
  origin: "AGENT_PROPOSAL" | "SCENARIO_SETUP",
  request: { from: Address; to: Address; data: Hex; value: bigint },
): Promise<TransactionEvidence> {
  const receipt = await awaitReceipt(fork, hash);

  const succeeded = BigInt(receipt.status) === 1n;
  const selector = selectorOf(request.data);

  return {
    index,
    from: request.from.toLowerCase() as Address,
    to: request.to.toLowerCase() as Address,
    ...(selector === undefined ? {} : { selector }),
    value: request.value.toString(10),
    data: request.data.toLowerCase() as Hex,
    gasUsed: BigInt(receipt.gasUsed).toString(10),
    status: succeeded ? "SUCCESS" : "REVERTED",
    blockNumber: BigInt(receipt.blockNumber).toString(10),
    txHash: hash.toLowerCase() as Hex,
    origin,
  };
}

/**
 * Submit the agent's proposal.
 *
 * A revert is a result, not an infrastructure failure — an agent that proposes
 * a call the protocol rejects has told us something real — so the reverted
 * receipt is captured and handed to the evaluator rather than raised.
 */
async function submitProposal(
  fork: ForkHandle,
  wallet: Address,
  proposal: Extract<Proposal, { decision: "PROPOSE" }>,
  index: number,
): Promise<TransactionEvidence> {
  const data = encodeAction(proposal);
  const request = { from: wallet, to: proposal.action.target, data, value: 0n };

  const hash = await forkRpc<Hex>(fork, "eth_sendTransaction", [
    { from: request.from, to: request.to, data: request.data, value: "0x0" },
  ]).catch((error: unknown) => {
    if (error instanceof TrialInfrastructureError && /revert/i.test(error.detail)) {
      return null;
    }
    throw error;
  });

  if (hash === null) {
    return {
      index,
      from: wallet.toLowerCase() as Address,
      to: proposal.action.target.toLowerCase() as Address,
      ...(selectorOf(data) === undefined ? {} : { selector: selectorOf(data) as string }),
      value: "0",
      data: data.toLowerCase() as Hex,
      gasUsed: "0",
      status: "REVERTED",
      revertReason: "the fork rejected the transaction before it was mined",
      blockNumber: fork.blockNumber.toString(10),
      txHash: `0x${"0".repeat(64)}` as Hex,
      origin: "AGENT_PROPOSAL",
    };
  }

  return toTransactionEvidence(fork, hash, index, "AGENT_PROPOSAL", request);
}

/** The block the agent says it reasoned about, when it publishes one. */
function agentObservedBlock(invocation: InvocationRecord): string | null {
  const observations = invocation.proposal.observations;
  if (observations === null || typeof observations !== "object" || Array.isArray(observations)) {
    return null;
  }
  const block = (observations as Record<string, unknown>)["blockNumber"];
  return typeof block === "string" ? block : null;
}

async function setupEvidence(
  fork: ForkHandle,
  setup: readonly SetupTransaction[],
): Promise<TransactionEvidence[]> {
  const records: TransactionEvidence[] = [];
  for (const [index, transaction] of setup.entries()) {
    records.push(
      await toTransactionEvidence(fork, transaction.hash, index, "SCENARIO_SETUP", {
        from: transaction.from,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
      }),
    );
  }
  return records;
}

/**
 * Run one trial.
 *
 * The fork is torn down on every path, including the failing ones. A leaked
 * anvil holds its port and its memory for the lifetime of the runner process,
 * and the next trial in the queue fails in a way that looks nothing like the
 * problem that caused it.
 */
export async function runTrial(request: TrialRequest): Promise<TrialRunResult> {
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
    const preState = await observe(client, request.deployment, request.scenario.account, preBlock);

    // Before the agent is asked anything, so the prediction cannot be a
    // reaction to the answer.
    const { result: reference } = runReferenceModel({
      observation: preState,
      policy: request.policy,
      actionableMarket: request.scenario.actionableMarket,
      repaySelector: request.authorisedSelector,
    });

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
        await submitProposal(fork, request.scenario.account, invocation.proposal, transactions.length),
      );
    }

    const postBlock = await client.getBlockNumber();
    const postState = await observe(client, request.deployment, request.scenario.account, postBlock);

    const outcome = evaluate({
      preState: toProtocolObservation(preState),
      postState: toProtocolObservation(postState),
      proposal: invocation.proposal,
      reference,
      transactions,
      authorisedTarget: request.scenario.actionableMarket,
      authorisedSelector: request.authorisedSelector,
      spendCapRawUnits: request.spendCapRawUnits,
      agentObservedBlock: agentObservedBlock(invocation),
    });

    if (outcome.status === "INCONCLUSIVE") {
      // A check that could not run is not a verdict. The run ends as an error
      // and touches nothing on the agent's record.
      throw new TrialInfrastructureError("REFERENCE_MODEL_FAILED", outcome.reason);
    }

    const trialSpecHash = trialSpecHashOf(request.trialSpec);
    const assembled = assembleEvidence(
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
        invocation,
        preState: toProtocolObservation(preState),
        postState: toProtocolObservation(postState),
        transactions,
        referenceImplementationHash: referenceImplementationHash(),
        referenceInputsHash: referenceInputsHash(preState),
        reference,
        evaluatorImplementationHash: evaluatorImplementationHash(),
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
    // documents it needs to re-run the subset comparator, and its authority
    // steps skip permanently.
    const bundled = assembleBundle(assembled.evidence, assembled.evidenceHash, request.trialSpec);

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
