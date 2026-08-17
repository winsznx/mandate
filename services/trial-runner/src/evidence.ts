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
  readonly referenceInputsHash: Hex;
  readonly reference: ReferenceResult;
  readonly evaluatorImplementationHash: Hex;
  readonly checks: readonly EvaluationCheck[];
  readonly result: "PASS" | "FAIL";
  readonly failureReason?: string;
  readonly observedAt: number;
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
      inputsHash: input.referenceInputsHash,
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
