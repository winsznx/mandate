/**
 * Assembling the artifact a verifier replays, for the yield, grid and
 * rebalancing categories.
 *
 * The same discipline as `evidence.ts`: the document is built once, validated
 * against the published schema, and hashed through the canonical encoding.
 * Validation is not a formality — the schema carries the fail-closed
 * refinements, and building the artifact through it is what makes those
 * unbreakable rather than conventions the assembly code is supposed to remember.
 *
 * It is a second assembly rather than a branch inside the first because it
 * produces a genuinely different document. `TrialEvidence` commits to a health
 * factor, a liquidation-threshold-weighted collateral total and a per-leg
 * exposure table. A yield model derives none of those, and emitting
 * `riskState: "SAFE"` with `healthFactorMantissa: null` for a model that never
 * computed either would read to a verifier as a solvency claim nobody made.
 *
 * One field here has no counterpart in the health-factor document.
 * `authorityScope` records whether the authority under test can be granted on a
 * live chain at all. A trial run against a venue that `(target, selector, spend
 * cap)` cannot bound is still a real trial of the agent's reasoning, and it is
 * not evidence that the agent may be given a live session. Putting that
 * distinction in the artifact rather than in a README is what stops a fork-only
 * result being read as a grant-ready one.
 */
import {
  STRATEGY_TRIAL_EVIDENCE_SCHEMA_VERSION,
  StrategyTrialEvidenceSchema,
  canonicalHash,
} from "@mandate/domain";
import type {
  AgentCategory,
  CanonicalValue,
  EvaluationCheck,
  RawProtocolObservation,
  StateModification,
  StrategyReferenceResult,
  StrategyTrialEvidence,
  TransactionEvidence,
} from "@mandate/domain";
import type { Address, Hex } from "viem";
import type { ForkHandle } from "./anvil.js";
import type { InvocationRecord } from "./invoke.js";
import { EvidenceAssemblyError, describeProposal, type AgentIdentity } from "./evidence.js";
import { RUNNER_VERSION } from "./identity.js";

/**
 * What the reference model was configured with, beside the observation.
 *
 * Disclosed rather than only committed to. A hash proves nothing changed after
 * publication; it does not let a reader re-run the model, and an expectation
 * nobody can recompute is a claim rather than a check.
 *
 * `policyParameters` is a flat string map because the parameters differ per
 * category and per agent. A typed field per knob would have to be revised every
 * time an agent published a new one, silently invalidating every artifact
 * written under the old shape.
 */
export interface StrategyReferenceInputsRecord {
  readonly permittedTargets: readonly Address[];
  readonly permittedSelectors: readonly Hex[];
  readonly policyId: string;
  readonly policyParameters: Readonly<Record<string, string>>;
  readonly amountToleranceBps: number;
}

/**
 * Whether the tested authority is grantable with no calldata predicate.
 *
 * `boundable: false` requires a reason, and the reason has to name the specific
 * argument or invariant. "This needs a guard" is not a finding; "argument 4 is
 * an arbitrary recipient" is.
 */
export interface AuthorityScope {
  readonly boundable: boolean;
  readonly unboundableReason?: string;
}

export interface StrategyEvidenceInput {
  readonly category: AgentCategory;
  readonly trialSpecHash: Hex;
  readonly trialSpecUri?: string;
  readonly fork: ForkHandle;
  readonly chainId: number;
  readonly modifications: readonly StateModification[];
  readonly agent: AgentIdentity;
  readonly authorityScope: AuthorityScope;
  readonly invocation: InvocationRecord;
  readonly preState: RawProtocolObservation;
  readonly postState: RawProtocolObservation;
  readonly transactions: readonly TransactionEvidence[];
  readonly referenceImplementationHash: Hex;
  readonly referenceInputs: StrategyReferenceInputsRecord;
  readonly reference: StrategyReferenceResult;
  readonly evaluatorImplementationHash: Hex;
  readonly checks: readonly EvaluationCheck[];
  readonly result: "PASS" | "FAIL";
  readonly failureReason?: string;
  readonly observedAt: number;
}

export interface AssembledStrategyEvidence {
  readonly evidence: StrategyTrialEvidence;
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
export function assembleStrategyEvidence(
  input: StrategyEvidenceInput,
  wallet: Address,
  skill: string,
): AssembledStrategyEvidence {
  const disclosedInputs: CanonicalValue = {
    permittedTargets: [...input.referenceInputs.permittedTargets],
    permittedSelectors: [...input.referenceInputs.permittedSelectors],
    policyId: input.referenceInputs.policyId,
    policyParameters: { ...input.referenceInputs.policyParameters },
    amountToleranceBps: input.referenceInputs.amountToleranceBps,
  };

  const document: CanonicalValue = {
    schemaVersion: STRATEGY_TRIAL_EVIDENCE_SCHEMA_VERSION,
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
    authorityScope: {
      boundable: input.authorityScope.boundable,
      ...(input.authorityScope.unboundableReason === undefined
        ? {}
        : { unboundableReason: input.authorityScope.unboundableReason }),
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

  const parsed = StrategyTrialEvidenceSchema.safeParse(document);
  if (!parsed.success) {
    throw new EvidenceAssemblyError(
      `the assembled artifact is not valid strategy evidence: ${JSON.stringify(parsed.error.issues)}`,
    );
  }

  return {
    evidence: parsed.data,
    evidenceHash: canonicalHash(parsed.data as unknown as CanonicalValue),
  };
}

/** Re-derive an artifact's hash, the way a verifier does. */
export function strategyEvidenceHashOf(evidence: StrategyTrialEvidence): Hex {
  return canonicalHash(evidence as unknown as CanonicalValue);
}
