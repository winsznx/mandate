/**
 * Infrastructure failures, kept structurally separate from verdicts.
 *
 * A dead fork, an RPC that stopped answering, an agent endpoint that timed out
 * — none of these is evidence about the agent, and none of them may become a
 * `FAIL`. A `FAIL` goes on an agent's public record permanently and is supposed
 * to mean "this agent did the wrong thing"; recording a crashed container that
 * way is a false statement about a third party that MANDATE cannot later
 * retract from a chain.
 *
 * The type system carries the distinction rather than a convention: a trial
 * that could not run returns a `TrialErrorRecord` and produces no
 * `TrialEvidence` at all, so there is no artifact for a receipt to commit to.
 * PRD §82.3 states the resulting queue behaviour — retry from the deterministic
 * scenario, no reputation effect.
 */

/**
 * Why a trial could not produce a verdict.
 *
 * `FORK_STATE_UNAVAILABLE` is the PRD §82.4 case, and reaching it pauses the
 * queue. It is deliberately not recoverable by substituting fabricated state:
 * a trial run against invented balances certifies nothing, and publishing it as
 * though it did would be worse than publishing nothing.
 */
export type TrialErrorKind =
  | "FORK_SPAWN_FAILED"
  | "FORK_STATE_UNAVAILABLE"
  | "FORK_DIED"
  | "RPC_UNAVAILABLE"
  | "OBSERVATION_FAILED"
  | "AGENT_UNREACHABLE"
  | "AGENT_PROTOCOL_ERROR"
  | "TRANSACTION_SUBMISSION_FAILED"
  | "REFERENCE_MODEL_FAILED"
  | "SCENARIO_SETUP_FAILED";

export class TrialInfrastructureError extends Error {
  readonly kind: TrialErrorKind;
  /** Free-form context for the operator. Never rendered as an agent-facing result. */
  readonly detail: string;

  constructor(kind: TrialErrorKind, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = "TrialInfrastructureError";
    this.kind = kind;
    this.detail = detail;
  }
}

export interface TrialErrorRecord {
  readonly status: "ERROR";
  readonly kind: TrialErrorKind;
  readonly detail: string;
  /** True for the §82.4 case, where the correct response is to stop queueing trials. */
  readonly pausesQueue: boolean;
  readonly observedAt: number;
}

const QUEUE_PAUSING: readonly TrialErrorKind[] = ["FORK_STATE_UNAVAILABLE", "RPC_UNAVAILABLE"];

export function toErrorRecord(error: unknown, observedAt: number): TrialErrorRecord {
  const kind: TrialErrorKind =
    error instanceof TrialInfrastructureError ? error.kind : "FORK_SPAWN_FAILED";
  const detail =
    error instanceof TrialInfrastructureError
      ? error.detail
      : error instanceof Error
        ? error.message
        : String(error);

  return {
    status: "ERROR",
    kind,
    detail,
    pausesQueue: QUEUE_PAUSING.includes(kind),
    observedAt,
  };
}
