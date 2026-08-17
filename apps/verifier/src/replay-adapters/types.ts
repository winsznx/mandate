/**
 * Replay projection.
 *
 * The flat artifact records the reference model's prediction as a list of named
 * readings, so replaying it is a value comparison. The richer artifact records
 * raw protocol observations instead, which is strictly better evidence and
 * cannot be replayed the same way — there is no list of readings to compare.
 *
 * A projector bridges that gap. It turns raw observations into the inputs a
 * reference model accepts, and then the MODEL computes. The division is the
 * whole point:
 *
 *     project raw facts  ≠  derive financial result
 *
 * A projector that computed a health factor would become a second, unreviewed
 * implementation of the thing the trial exists to check independently. So a
 * projector may rename, reshape and normalise; it may not decide anything.
 *
 * Replaying the rich form is therefore stronger than replaying the flat one:
 * the verifier re-runs the reference model over the disclosed observation and
 * checks that the published result follows from it, rather than comparing two
 * numbers the publisher chose.
 */
import type { AnyArtifact } from "../artifact-view.js";

export type ProjectionFailureCode =
  /** No adapter claims this artifact's category or protocol. */
  | "NO_ADAPTER"
  /** The artifact is the flat form, which needs no projection. */
  | "NOT_APPLICABLE"
  /** A field the model requires is absent from the disclosure. */
  | "INCOMPLETE_DISCLOSURE"
  /** A disclosed field is present but structurally unusable. */
  | "MALFORMED_OBSERVATION";

export interface ReplayProjectionError {
  code: ProjectionFailureCode;
  message: string;
}

export type ProjectionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ReplayProjectionError };

/**
 * Projects one artifact shape into one reference model's inputs.
 *
 * `supports` narrows rather than returning a bare boolean so a caller that
 * passes the check gets the concrete type without casting.
 */
export interface ReferenceReplayAdapter<TArtifact extends AnyArtifact, TInput> {
  /** Stable identifier, reported so a reader knows which projector ran. */
  readonly id: string;
  supports(artifact: AnyArtifact): artifact is TArtifact;
  /** The pre-state inputs the model was run with, and the post-state inputs to re-run it on. */
  project(artifact: TArtifact): ProjectionResult<{ pre: TInput; post: TInput }>;
}
