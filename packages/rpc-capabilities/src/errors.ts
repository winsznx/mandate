/**
 * The one failure this package is allowed to produce, mirrored from the runner.
 *
 * `services/trial-runner/src/errors.ts` owns the canonical `TrialErrorKind`
 * union and the rule that `FORK_STATE_UNAVAILABLE` pauses the queue. This
 * package restates the record shape rather than importing it, because the
 * dependency runs the other way: a service may depend on a package, and a
 * package that reached back into a service would make the two impossible to
 * build in order. `test/error-shape.test.ts` reads the runner's source and
 * fails if the two definitions drift, so the duplication cannot rot quietly.
 *
 * Nothing here invents a second meaning for the kind. A capability probe that
 * says a block cannot be forked produces exactly the record the runner would
 * have produced on a failed pin, and for the same reason: a trial run against
 * substituted state certifies nothing, so the correct response is to stop
 * queueing trials rather than to quietly move the scenario to a newer block.
 */

/** The only kind this package raises. The runner's union is the superset. */
export const FORK_STATE_UNAVAILABLE = "FORK_STATE_UNAVAILABLE" as const;

export type CapabilityErrorKind = typeof FORK_STATE_UNAVAILABLE;

export class RpcCapabilityError extends Error {
  readonly kind: CapabilityErrorKind;
  /** Free-form context for the operator. Never rendered as an agent-facing result. */
  readonly detail: string;

  constructor(detail: string) {
    super(`${FORK_STATE_UNAVAILABLE}: ${detail}`);
    this.name = "RpcCapabilityError";
    this.kind = FORK_STATE_UNAVAILABLE;
    this.detail = detail;
  }
}

/**
 * Field-for-field the runner's `TrialErrorRecord`, narrowed to this one kind.
 *
 * `pausesQueue` is `true` rather than `boolean` so that a caller cannot write a
 * branch on it that silently does nothing: there is no capability failure this
 * package raises that a queue may keep running through.
 */
export interface ForkStateUnavailableRecord {
  readonly status: "ERROR";
  readonly kind: CapabilityErrorKind;
  readonly detail: string;
  readonly pausesQueue: true;
  readonly observedAt: number;
}

export function forkStateUnavailable(
  detail: string,
  observedAt: number,
): ForkStateUnavailableRecord {
  return { status: "ERROR", kind: FORK_STATE_UNAVAILABLE, detail, pausesQueue: true, observedAt };
}
