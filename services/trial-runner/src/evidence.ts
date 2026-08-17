/**
 * Assembling the artifact a verifier replays.
 *
 * The document is built once, validated against the published schema, and
 * hashed through the canonical encoding. Validation is not a formality here:
 * the schema carries the fail-closed refinements — a PASS cannot contain a
 * failed check, a modified environment must carry its label, a head-pinned fork
 * must say why — and building the artifact through the schema is what makes
 * those unbreakable rather than conventions the assembly code is supposed to
 * remember.
 *
 * The hash is taken over the parsed document rather than the input, so what was
 * hashed is exactly what a reader will validate.
 */
import { TrialEvidenceSchema, canonicalHash, TRIAL_EVIDENCE_SCHEMA_VERSION } from "@mandate/domain";
import type {
  AgentCategory,
  CanonicalValue,
  EvaluationCheck,
  RawProtocolObservation,
  ReferenceResult,
  StateModification,
  TransactionEvidence,
  TrialEvidence,
} from "@mandate/domain";
import type { Proposal } from "@mandate/agent-runtime";
import type { Address, Hex } from "viem";
import type { ReferencePolicy } from "@mandate/reference-health-factor";
import type { ForkHandle } from "./anvil.js";
import type { InvocationRecord } from "./invoke.js";
import { RUNNER_VERSION } from "./identity.js";

export class EvidenceAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceAssemblyError";
  }
}

export interface AgentIdentity {
  readonly identityRegistry: Address;
  readonly agentId: string;
  readonly agentVersionHash: Hex;
}

export interface EvidenceInput {
  readonly category: AgentCategory;
  readonly trialSpecHash: Hex;
  readonly trialSpecUri?: string;
  readonly fork: ForkHandle;
  readonly chainId: number;
  readonly modifications: readonly StateModification[];
  readonly agent: AgentIdentity;
  readonly invocation: InvocationRecord;
  readonly preState: RawProtocolObservation;
  readonly postState: RawProtocolObservation;
  readonly transactions: readonly TransactionEvidence[];
  readonly referenceImplementationHash: Hex;
  /**
   * The non-observation inputs the model was run with.
   *
   * Disclosed rather than only committed to. `inputsHash` proves nothing
   * changed after publication; it does not let a reader re-run the model, and
   * an expectation nobody can recompute is a claim rather than a check.
   */
  readonly referenceInputs: ReferenceInputs;
  readonly reference: ReferenceResult;
  readonly evaluatorImplementationHash: Hex;
  readonly checks: readonly EvaluationCheck[];
  readonly result: "PASS" | "FAIL";
  readonly failureReason?: string;
  readonly observedAt: number;
}

/**
 * What the reference model was configured with, beside the observation.
 *
 * The observation itself is not repeated here: it is already carried whole under
 * `observations.preState`, and a second copy would be a second thing that can
 * disagree with the first.
 */
export interface ReferenceInputs {
  readonly actionableMarket: Address;
  readonly repaySelector: Hex;
  readonly policy: ReferencePolicy;
}

/** The agent's answer in the artifact's shape. */
function describeProposal(
  proposal: Proposal,
  invocation: InvocationRecord,
  wallet: Address,
  skill: string,
): CanonicalValue {
  const base = {
    requestId: invocation.requestId,
    skill,
    wallet,
    observationsHash: invocation.observationsHash,
    invocation: {
      protocol: invocation.protocol,
      endpointHash: invocation.endpointHash,
      requestHash: invocation.requestHash,
      responseHash: invocation.responseHash,
      latencyMs: invocation.latencyMs,
      ...(invocation.reportedVersion === undefined
        ? {}
        : { reportedVersion: invocation.reportedVersion }),
      outcome: "OK" as const,
    },
  };

  if (proposal.decision === "HOLD") {
    return { ...base, decision: "HOLD", rationale: proposal.rationale };
  }

  return {
    ...base,
    decision: "PROPOSE",
    action: {
      target: proposal.action.target,
      selector: proposal.action.selector,
      args: proposal.action.args.map((argument) => ({ type: argument.type, value: argument.value })),
      rationale: proposal.action.rationale,
    },
  };
}

export interface AssembledEvidence {
  readonly evidence: TrialEvidence;
  /** keccak256 over the canonical encoding. This is what a receipt commits to. */
  readonly evidenceHash: Hex;
}

/**
 * Build, validate and hash the artifact.
 *
 * A document that does not satisfy the schema is a bug in the runner rather
 * than a result, so it raises instead of being published with a warning. The
 * refinements it would violate are the ones that keep a PASS honest.
 */
export function assembleEvidence(
  input: EvidenceInput,
  wallet: Address,
  skill: string,
): AssembledEvidence {
  const disclosedInputs: CanonicalValue = {
    actionableMarket: input.referenceInputs.actionableMarket,
    repaySelector: input.referenceInputs.repaySelector,
    policy: {
      policyId: input.referenceInputs.policy.policyId,
      interventionThresholdMantissa:
        input.referenceInputs.policy.interventionThresholdMantissa.toString(10),
      targetHealthFactorMantissa:
        input.referenceInputs.policy.targetHealthFactorMantissa.toString(10),
      minimumRepayUsdMantissa: input.referenceInputs.policy.minimumRepayUsdMantissa.toString(10),
      amountToleranceBps: input.referenceInputs.policy.amountToleranceBps,
    },
  };

  const document: CanonicalValue = {
    schemaVersion: TRIAL_EVIDENCE_SCHEMA_VERSION,
    category: input.category,
    trialSpec: {
      hash: input.trialSpecHash,
      ...(input.trialSpecUri === undefined ? {} : { uri: input.trialSpecUri }),
    },
    environment: {
      chainId: input.chainId,
      forkBlock: input.fork.blockNumber.toString(10),
      forkBlockHash: input.fork.blockHash,
      rpcSourceClass: input.fork.rpcSourceClass,
      ...(input.fork.degradedReason === undefined
        ? {}
        : { rpcDegradedReason: input.fork.degradedReason }),
      modifiedState: input.modifications.length > 0,
      modifications: input.modifications as unknown as CanonicalValue,
      runnerVersion: RUNNER_VERSION,
      anvilVersion: input.fork.anvilVersion,
    },
    agent: {
      identityRegistry: input.agent.identityRegistry,
      agentId: input.agent.agentId,
      agentVersionHash: input.agent.agentVersionHash,
      endpointHash: input.invocation.endpointHash,
    },
    observations: {
      preState: input.preState as unknown as CanonicalValue,
      agentProposal: describeProposal(input.invocation.proposal, input.invocation, wallet, skill),
      txs: input.transactions as unknown as CanonicalValue,
      postState: input.postState as unknown as CanonicalValue,
    },
    reference: {
      implementationHash: input.referenceImplementationHash,
      // The commitment is over the DISCLOSED inputs, so a reader can rehash what
      // they were given and see it is what was published. A hash of the
      // observation instead would commit to something nobody can check against
      // this field.
      inputsHash: canonicalHash(disclosedInputs),
      inputs: disclosedInputs,
      output: input.reference as unknown as CanonicalValue,
    },
    evaluator: {
      implementationHash: input.evaluatorImplementationHash,
      checks: input.checks as unknown as CanonicalValue,
      result: input.result,
      ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason }),
    },
    observedAt: input.observedAt,
  };

  const parsed = TrialEvidenceSchema.safeParse(document);
  if (!parsed.success) {
    throw new EvidenceAssemblyError(
      `the assembled artifact is not valid evidence: ${JSON.stringify(parsed.error.issues)}`,
    );
  }

  return {
    evidence: parsed.data,
    evidenceHash: canonicalHash(parsed.data as unknown as CanonicalValue),
  };
}

/** Re-derive an artifact's hash, the way a verifier does. */
export function evidenceHashOf(evidence: TrialEvidence): Hex {
  return canonicalHash(evidence as unknown as CanonicalValue);
}
