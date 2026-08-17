/**
 * What a publisher has to disclose for a receipt to be checkable.
 *
 * The registry stores commitments: `trialSpecHash`, `testedAuthorityHash`,
 * `evidenceHash`. Hashes alone prove that nothing changed after publication;
 * they prove nothing about what was published. Re-running the subset comparator
 * needs the AuthorityIR documents themselves, and re-deriving the verdict needs
 * the trace. So the object at `evidenceURI` is a bundle: the evidence artifact
 * plus every document a receipt field commits to.
 *
 * A bare `EvidenceArtifact` is still accepted at that URI. It is what a runner
 * that only publishes the artifact will produce, and refusing it outright would
 * turn a partial disclosure into an unreadable one. The consequence is stated
 * in the report instead: the authority steps skip, and the verdict cannot rise
 * above PARTIALLY VERIFIED.
 *
 * The mandate disclosure is separate and for a structural reason, not a
 * stylistic one. A trial's evidence is published before any mandate exists, so
 * it cannot contain the grant that was later derived from it. The registry's
 * `Activation` record has no URI field, so there is nowhere on chain to hang
 * that second document — see `verify.ts` for what the verifier does about it.
 */
import { z } from "zod";
import {
  AddressSchema,
  AuthorityIRSchema,
  Bytes32Schema,
  EvidenceArtifactSchema,
  TrialEvidenceSchema,
  TrialSpecSchema,
} from "@mandate/domain/schemas";

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = "mandate.evidence-bundle/1" as const;
export const MANDATE_DISCLOSURE_SCHEMA_VERSION = "mandate.mandate-disclosure/1" as const;

export const EvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_BUNDLE_SCHEMA_VERSION),
    /**
     * The run itself: trace, checks, reference outcome.
     *
     * A union dispatching on the document's own `schemaVersion`, so the richer
     * `mandate.trial-evidence/1` can be committed to directly. The flat form
     * projects both conclusions down into `StateReading` lists, which loses the
     * one distinction the trial exists to make: a reader cannot tell from it
     * whether the reference model enumerated the same debt the agent did.
     *
     * The alternative — publishing the flat form and recording the richer
     * document's hash in a free-text notes field — would put a commitment
     * somewhere nothing validates. Both forms are accepted so a runner emitting
     * either still verifies.
     */
    artifact: z.union([TrialEvidenceSchema, EvidenceArtifactSchema]),
    /** The frozen question. Must canonical-hash to the receipt's `trialSpecHash`. */
    trialSpec: TrialSpecSchema,
    /**
     * The envelope the agent was tested inside, disclosed in full.
     *
     * Carried separately from `trialSpec.authority` even though the two are the
     * same document, because the receipt commits to it under its own hash and a
     * verifier that folded them together could not report which one diverged.
     */
    testedAuthority: AuthorityIRSchema,
  })
  .strict();

export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

/** A transaction the disclosure claims demonstrates something. Everything about it is re-read from chain. */
export const DisclosedExecutionSchema = z
  .object({
    txHash: Bytes32Schema,
    /** Human label for the timeline, e.g. `repay 20 USDT`. Display only. */
    label: z.string().min(1),
  })
  .strict();

export const MandateDisclosureSchema = z
  .object({
    schemaVersion: z.literal(MANDATE_DISCLOSURE_SCHEMA_VERSION),
    /** Checked against the activation's `grantedAuthorityHash`, so a wrong document cannot pass. */
    grantedAuthority: AuthorityIRSchema,
    session: z
      .object({
        wallet: AddressSchema,
        /** Index into the account's permission storage. Checked against the activation's `sessionKeyHash`. */
        keyHash: Bytes32Schema,
        grantTxHash: Bytes32Schema.optional(),
      })
      .optional(),
    /** Transactions that were inside the granted authority and succeeded. */
    allowedExecutions: z.array(DisclosedExecutionSchema).default([]),
    /** Transactions that crossed the boundary and were rejected by the enforcement layer. */
    blockedExecutions: z.array(DisclosedExecutionSchema).default([]),
  })
  .strict();

export type MandateDisclosure = z.infer<typeof MandateDisclosureSchema>;

export type EvidenceDocumentKind = "BUNDLE" | "ARTIFACT_ONLY";

export interface ParsedEvidenceDocument {
  kind: EvidenceDocumentKind;
  bundle?: EvidenceBundle;
  artifact: z.infer<typeof EvidenceArtifactSchema> | z.infer<typeof TrialEvidenceSchema>;
}

/**
 * Interpret an evidence document whose hash has already been checked.
 *
 * Dispatch is on `schemaVersion` rather than on which schema happens to parse,
 * so a bundle with one bad field reports that field instead of silently
 * degrading to "not a bundle" and skipping the authority steps.
 */
export function parseEvidenceDocument(document: unknown):
  | { ok: true; value: ParsedEvidenceDocument }
  | { ok: false; reason: string } {
  const version =
    typeof document === "object" && document !== null
      ? (document as Record<string, unknown>)["schemaVersion"]
      : undefined;

  if (version === EVIDENCE_BUNDLE_SCHEMA_VERSION) {
    const parsed = EvidenceBundleSchema.safeParse(document);
    if (!parsed.success) {
      return { ok: false, reason: `evidence bundle is malformed: ${formatIssues(parsed.error)}` };
    }
    return { ok: true, value: { kind: "BUNDLE", bundle: parsed.data, artifact: parsed.data.artifact } };
  }

  const artifact = EvidenceArtifactSchema.safeParse(document);
  if (artifact.success) {
    return { ok: true, value: { kind: "ARTIFACT_ONLY", artifact: artifact.data } };
  }

  return {
    ok: false,
    reason: `evidence document is neither ${EVIDENCE_BUNDLE_SCHEMA_VERSION} nor a bare evidence artifact: ${formatIssues(artifact.error)}`,
  };
}

export function parseMandateDisclosure(document: unknown):
  | { ok: true; value: MandateDisclosure }
  | { ok: false; reason: string } {
  const parsed = MandateDisclosureSchema.safeParse(document);
  if (!parsed.success) {
    return { ok: false, reason: `mandate disclosure is malformed: ${formatIssues(parsed.error)}` };
  }
  return { ok: true, value: parsed.data };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
    .join("; ");
}
