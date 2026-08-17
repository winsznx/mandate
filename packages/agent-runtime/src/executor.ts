/**
 * The contract every MANDATE reference agent implements.
 *
 * An executor PROPOSES an action and never performs one. That is not a
 * convenience of this codebase, it is the load-bearing rule of the threat
 * model: an agent — and in particular anything an LLM influences — must never
 * be the thing that determines authority. The deterministic layer receives a
 * `ProposedAction`, checks it against the compiled mandate, and only then
 * encodes and submits it. An executor therefore holds no session key, no
 * signer, and no RPC write path, and there is nothing it can return that
 * widens what its wallet is permitted to do.
 *
 * `ProposedAction` is deliberately shaped so it maps one-to-one onto an
 * `AuthorityCall`: `target` plus `selector` is exactly the pair Altana's
 * permission model constrains, and `args` carries its ABI types so the
 * deterministic layer can encode calldata without inferring anything.
 */
import type { AgentCategory, CanonicalValue } from "@mandate/domain";
import type { Address, Hex } from "viem";

/**
 * One ABI-encodable argument, self-describing.
 *
 * Values travel as strings because a proposal is hashed into evidence through
 * the canonical JSON encoding, which rejects integers wider than 2^53.
 */
export interface AbiArgument {
  readonly type: string;
  readonly value: string;
}

/**
 * What an agent asks the deterministic layer to do.
 *
 * `rationale` is for the human reading the proof page. Nothing downstream
 * parses it, and no part of the authorisation decision may depend on it.
 */
export interface ProposedAction {
  readonly target: Address;
  readonly selector: Hex;
  readonly args: readonly AbiArgument[];
  readonly rationale: string;
}

/**
 * The outcome of one deliberation.
 *
 * `HOLD` is a normal business outcome rather than a fault. Report 02 §4.4
 * draws that line at the wire level too: faults become JSON-RPC errors,
 * classified outcomes come back as a result with a status field. Confusing the
 * two makes a working agent look broken in a trial record.
 */
export type Proposal =
  | {
      readonly decision: "PROPOSE";
      readonly action: ProposedAction;
      readonly observations: CanonicalValue;
    }
  | {
      readonly decision: "HOLD";
      readonly rationale: string;
      readonly observations: CanonicalValue;
    };

export interface ProposalRequest {
  /** Correlates the wire request, the log lines and the evidence record. */
  readonly requestId: string;
  readonly skill: string;
  readonly chainId: number;
  /** The account whose position is being reasoned about. */
  readonly wallet: Address;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** A skill as it appears in the agent card, matching the A2A card shape in report 02 §4.2. */
export interface AgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
}

export interface AgentExecutor {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: AgentCategory;
  readonly skills: readonly AgentSkill[];
  /**
   * The risk policy this agent applies, published in the agent card.
   *
   * Publishing it is what lets a trial bind to the parameters that produced a
   * result: `TrialTask.parametersHash` is the canonical hash of this document.
   */
  readonly policy: CanonicalValue;
  propose(request: ProposalRequest): Promise<Proposal>;
}

/**
 * Raised by a reference agent whose strategy is scaffolded but not yet written.
 *
 * It is a declared gap rather than a fault, so the server maps it to its own
 * JSON-RPC code instead of the generic internal error. A trial harness that
 * meets one should record "not implemented", never "the agent crashed".
 */
export class StrategyNotImplementedError extends Error {
  readonly slug: string;
  readonly skill: string;

  constructor(slug: string, skill: string) {
    super(`Strategy '${slug}' does not implement skill '${skill}' yet`);
    this.name = "StrategyNotImplementedError";
    this.slug = slug;
    this.skill = skill;
  }
}

export interface PendingStrategyDefinition {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: AgentCategory;
  readonly skills: readonly AgentSkill[];
  readonly policy: CanonicalValue;
}

/**
 * A fully-formed agent whose deliberation is still to be written.
 *
 * The scaffold is real — it serves a card, answers health checks, and routes
 * skills — so the seven agents behind the first Venus proof are wired into the
 * marketplace and the trial harness before their strategies exist. They refuse
 * loudly instead of returning a plausible-looking proposal.
 */
export function pendingStrategy(definition: PendingStrategyDefinition): AgentExecutor {
  return {
    ...definition,
    propose(request: ProposalRequest): Promise<Proposal> {
      return Promise.reject(new StrategyNotImplementedError(definition.slug, request.skill));
    },
  };
}
