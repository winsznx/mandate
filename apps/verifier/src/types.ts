/**
 * The verifier's dependency surface on the canonical domain types.
 *
 * Collected in one file on purpose. The verifier reads documents it did not
 * write, produced by a runner it does not control, so a rename or a shape
 * change upstream must break here — loudly, in one place — rather than
 * scattering silent `unknown`s through the checks.
 */
import type { z } from "zod";
import type { StateReadingSchema } from "@mandate/domain/schemas";

export type StateReading = z.infer<typeof StateReadingSchema>;

export type {
  AuthorityIR,
  EvidenceArtifact,
  /** The richer trial document. A bundle may commit to either form. */
  TrialEvidence,
  /** The strategy trial document. Its own bundle commits to it. */
  StrategyTrialEvidence,
  TrialOutcome,
} from "@mandate/domain/schemas";
