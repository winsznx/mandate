/**
 * Asking the agent, and recording exactly what came back.
 *
 * The line drawn here is the one from report 02 §4.4 and from
 * `AgentExecutor`'s own contract: a fault is not a verdict. An endpoint that is
 * offline, times out, or declares a skill unimplemented has told us nothing
 * about whether the agent would have acted correctly, so it raises an
 * infrastructure error and the trial produces no artifact at all. A `HOLD` is
 * the opposite — a considered answer, frequently the correct one, and it goes
 * through evaluation like any proposal.
 *
 * Getting this backwards is how a working agent acquires a permanent public
 * failure because a container restarted mid-queue.
 */
import { randomUUID } from "node:crypto";
import { canonicalHash } from "@mandate/domain";
import type { CanonicalValue } from "@mandate/domain";
import {
  StrategyNotImplementedError,
  type AgentExecutor,
  type Proposal,
  type ProposalRequest,
} from "@mandate/agent-runtime";
import type { Address, Hex } from "viem";
import { TrialInfrastructureError } from "./errors.js";

export const DEFAULT_INVOCATION_TIMEOUT_MS = 30_000;

export type InvocationProtocol = "A2A" | "MCP" | "STUDIO" | "REFERENCE" | "HTTP_JSON";

export interface InvocationRequest {
  readonly executor: AgentExecutor;
  readonly protocol: InvocationProtocol;
  /** The endpoint the agent is published at, hashed into the artifact. */
  readonly endpoint: string;
  readonly skill: string;
  readonly chainId: number;
  readonly wallet: Address;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}

export interface InvocationRecord {
  readonly requestId: string;
  readonly proposal: Proposal;
  readonly endpointHash: Hex;
  readonly requestHash: Hex;
  readonly responseHash: Hex;
  readonly observationsHash: Hex;
  readonly latencyMs: number;
  readonly protocol: InvocationProtocol;
  readonly reportedVersion?: string;
}

function hashString(value: string): Hex {
  return canonicalHash(value);
}

/**
 * The proposal as a canonical document.
 *
 * Hashed rather than stored whole in the invocation record because the
 * artifact already carries the decoded proposal; the hash is what binds the two
 * together and proves the decoded form was not edited afterwards.
 */
function describeProposal(proposal: Proposal): CanonicalValue {
  if (proposal.decision === "HOLD") {
    return { decision: "HOLD", rationale: proposal.rationale, observations: proposal.observations };
  }
  return {
    decision: "PROPOSE",
    action: {
      target: proposal.action.target,
      selector: proposal.action.selector,
      args: proposal.action.args.map((argument) => ({ type: argument.type, value: argument.value })),
      rationale: proposal.action.rationale,
    },
    observations: proposal.observations,
  };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TrialInfrastructureError("AGENT_UNREACHABLE", `${label} did not answer within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Invoke an agent through the adapter and record the exchange. */
export async function invokeAgent(request: InvocationRequest): Promise<InvocationRecord> {
  const requestId = randomUUID();
  const proposalRequest: ProposalRequest = {
    requestId,
    skill: request.skill,
    chainId: request.chainId,
    wallet: request.wallet,
    parameters: request.parameters,
  };

  const requestDocument: CanonicalValue = {
    requestId,
    skill: request.skill,
    chainId: request.chainId,
    wallet: request.wallet,
    parameters: request.parameters as CanonicalValue,
  };

  const startedAt = Date.now();
  let proposal: Proposal;
  try {
    proposal = await withTimeout(
      request.executor.propose(proposalRequest),
      request.timeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS,
      request.executor.slug,
    );
  } catch (error) {
    if (error instanceof TrialInfrastructureError) throw error;
    if (error instanceof StrategyNotImplementedError) {
      // A declared gap, not a crash and not a wrong answer. Recording it as a
      // failure would put a verdict on an agent that was never asked a question
      // it claims to answer.
      throw new TrialInfrastructureError(
        "AGENT_PROTOCOL_ERROR",
        `${error.slug} does not implement skill '${error.skill}'`,
      );
    }
    throw new TrialInfrastructureError(
      "AGENT_PROTOCOL_ERROR",
      `${request.executor.slug} raised: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const latencyMs = Date.now() - startedAt;

  const response = describeProposal(proposal);

  return {
    requestId,
    proposal,
    endpointHash: hashString(request.endpoint),
    requestHash: canonicalHash(requestDocument),
    responseHash: canonicalHash(response),
    observationsHash: canonicalHash(proposal.observations),
    latencyMs,
    protocol: request.protocol,
  };
}
