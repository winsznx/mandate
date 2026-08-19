/**
 * Fetching the documents the chain points at, and checking them against it.
 *
 * The receipt stores a URI and a hash. Only the hash is trusted: the URI is a
 * hint about where a copy might be found, and any host serving the right bytes
 * is as good as any other. Nothing here reaches for a MANDATE endpoint, sends a
 * credential, or consults an index.
 *
 * The integrity rule is the CLI verifier's rule, restated because the page has
 * to hold to it too: no field of an evidence document is interpreted until
 * `keccak256(canonical bytes) == evidenceHash` has held. Two encodings satisfy
 * that equality — the stored bytes may already be the canonical MCJ/1 string,
 * or the host may have re-ordered or pretty-printed them — and the page reports
 * which one it got, because byte-identical is a stronger property than
 * re-encodes-alike and a reader is entitled to know the difference.
 */
import { canonicalize, CanonicalEncodingError } from "@mandate/domain/canonical";
import type { CanonicalValue } from "@mandate/domain/canonical";
import { AuthorityIRSchema, TrialSpecSchema } from "@mandate/domain/schemas";
import { keccak256, toHex } from "viem";
import type { Hex } from "viem";
import { z } from "zod";

const FETCH_TIMEOUT_MS = 15_000;
/** A receipt's evidence is a JSON document, not a dataset. */
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;

export class DocumentUnavailableError extends Error {
  readonly uri: string;

  constructor(uri: string, message: string) {
    super(message);
    this.name = "DocumentUnavailableError";
    this.uri = uri;
  }
}

/** Resolve the schemes a receipt may carry. `r2://` and `ipfs://` are not fetchable from a page. */
export function resolveUri(uri: string): URL {
  if (uri.startsWith("https://") || uri.startsWith("http://")) return new URL(uri);
  if (uri.startsWith("ipfs://")) {
    const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    if (path.length === 0) throw new DocumentUnavailableError(uri, "ipfs:// URI carries no CID");
    return new URL(path, "https://ipfs.io/ipfs/");
  }
  throw new DocumentUnavailableError(
    uri,
    `"${uri}" is not a scheme a browser can dereference. Run the CLI verifier, which resolves r2:// and file:// as well.`,
  );
}

export async function fetchBytes(uri: string): Promise<Uint8Array> {
  const resolved = resolveUri(uri);

  let response: Response;
  try {
    response = await fetch(resolved, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // The hash is the authority, so a cached copy is as good as a fresh one
      // for correctness. An hour keeps a judge's reload off the origin.
      next: { revalidate: 3600 },
    });
  } catch (error) {
    throw new DocumentUnavailableError(uri, `request to ${resolved.href} failed: ${describe(error)}`);
  }

  if (!response.ok) {
    throw new DocumentUnavailableError(uri, `${resolved.href} returned HTTP ${response.status}`);
  }

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_EVIDENCE_BYTES) {
    throw new DocumentUnavailableError(
      uri,
      `body is ${body.byteLength} bytes, above the ${MAX_EVIDENCE_BYTES}-byte ceiling`,
    );
  }
  return body;
}

export type EvidenceEncoding = "CANONICAL_BYTES" | "RECANONICALISED";

export interface IntegrityOk {
  ok: true;
  encoding: EvidenceEncoding;
  hash: Hex;
  /** Structurally parsed, not yet schema-validated. Safe to interpret: the hash held. */
  document: unknown;
  byteLength: number;
}

export interface IntegrityFailure {
  ok: false;
  reason: string;
  rawHash: Hex;
  byteLength: number;
}

export type IntegrityResult = IntegrityOk | IntegrityFailure;

/**
 * Check downloaded bytes against the hash the receipt committed to.
 *
 * A mismatch is terminal and never degrades to a skip: the publisher committed
 * to specific content and the bytes on offer are something else, which says the
 * record is false rather than merely incomplete.
 */
export function checkIntegrity(bytes: Uint8Array, expected: Hex): IntegrityResult {
  const byteLength = bytes.byteLength;
  const rawHash = keccak256(toHex(bytes));

  if (sameHash(rawHash, expected)) {
    return {
      ok: true,
      encoding: "CANONICAL_BYTES",
      hash: rawHash,
      document: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      byteLength,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: `evidence hash does not match and the body is not valid UTF-8 JSON: ${describe(error)}`,
      rawHash,
      byteLength,
    };
  }

  let recanonicalised: Hex;
  try {
    recanonicalised = keccak256(toHex(new TextEncoder().encode(canonicalize(parsed as CanonicalValue))));
  } catch (error) {
    const detail =
      error instanceof CanonicalEncodingError
        ? error.message
        : `${describe(error)} — MCJ/1 rejects floats and integers beyond 2^53, which travel as decimal strings`;
    return {
      ok: false,
      reason: `evidence hash does not match and the document is not MCJ/1-encodable: ${detail}`,
      rawHash,
      byteLength,
    };
  }

  if (sameHash(recanonicalised, expected)) {
    return { ok: true, encoding: "RECANONICALISED", hash: recanonicalised, document: parsed, byteLength };
  }

  return {
    ok: false,
    reason: `evidence hash mismatch: receipt commits to ${expected}, downloaded bytes hash to ${rawHash} raw and ${recanonicalised} re-canonicalised`,
    rawHash,
    byteLength,
  };
}

/**
 * The parts of the published documents this page reads.
 *
 * Deliberately narrower than `@mandate/verifier`'s schemas and deliberately
 * non-strict. The page renders a subset of each document, and a publisher
 * adding a field it does not render is not a reason to show a judge an error.
 * Every field the page makes a claim from is still validated.
 */
/**
 * The evidence artifact, read through the one shape both published forms share.
 *
 * A receipt may commit to the flat `mandate.evidence/1` or to the richer
 * `mandate.trial-evidence/1`. The two carry the same facts under different
 * names, and a page whose checks depended on which form a publisher chose would
 * be worth very little.
 */
export const EvidenceArtifactViewSchema = z.looseObject({
  schemaVersion: z.string(),
  environment: z.looseObject({
    forkBlock: z.string(),
    rpcSourceClass: z.string().optional(),
    modifiedState: z.boolean().optional(),
  }),
  evaluator: z
    .looseObject({
      result: z.enum(["PASS", "FAIL"]),
      evaluatorId: z.string().optional(),
      checks: z.array(z.looseObject({})).optional(),
    })
    .optional(),
  result: z.enum(["PASS", "FAIL"]).optional(),
});

export type EvidenceArtifactView = z.infer<typeof EvidenceArtifactViewSchema>;

/** `PASS` or `FAIL`, whichever spelling the artifact used. */
export function artifactResult(artifact: EvidenceArtifactView): "PASS" | "FAIL" | undefined {
  return artifact.evaluator?.result ?? artifact.result;
}

export function artifactCheckCount(artifact: EvidenceArtifactView): number | undefined {
  return artifact.evaluator?.checks?.length;
}

export const EvidenceBundleViewSchema = z.looseObject({
  schemaVersion: z.literal("mandate.evidence-bundle/1"),
  testedAuthority: AuthorityIRSchema,
  trialSpec: TrialSpecSchema,
  artifact: EvidenceArtifactViewSchema,
});

export type EvidenceBundleView = z.infer<typeof EvidenceBundleViewSchema>;

/**
 * An action the account refused before any transaction existed.
 *
 * `allowanceAtAttemptRaw` carries more weight than it looks. It is what rules
 * out an exhausted ERC-20 allowance as the real cause, which is the failure
 * most likely to impersonate a spend-cap rejection.
 */
export const RejectedIntentSchema = z.looseObject({
  label: z.string().min(1),
  target: z.string(),
  selector: z.string(),
  amountRaw: z.string().optional(),
  validatorError: z.string(),
  mechanism: z.enum(["SPEND_CAP", "OUT_OF_SCOPE_CALL", "SESSION_INVALID"]),
  accountState: z.looseObject({
    callPermitted: z.boolean().optional(),
    keyRegistered: z.boolean().optional(),
    spendCapRaw: z.string().optional(),
    spentInBucketRaw: z.string().optional(),
    allowanceAtAttemptRaw: z.string().optional(),
  }),
});

export const ExecutedEvidenceSchema = z.looseObject({
  txHash: z.string(),
  label: z.string().min(1),
});

export const MandateDisclosureViewSchema = z.looseObject({
  schemaVersion: z.literal("mandate.mandate-disclosure/1"),
  grantedAuthority: AuthorityIRSchema,
  session: z
    .looseObject({
      wallet: z.string(),
      keyHash: z.string(),
      grantTxHash: z.string().optional(),
    })
    .optional(),
  allowedExecutions: z.array(ExecutedEvidenceSchema).optional(),
  blockedExecutions: z.array(ExecutedEvidenceSchema).optional(),
  rejectedIntents: z.array(RejectedIntentSchema).optional(),
});

export type MandateDisclosureView = z.infer<typeof MandateDisclosureViewSchema>;

/**
 * The run record.
 *
 * Nothing on chain commits to this document, and the page says so wherever it
 * shows a value that came from here. It is the only place a rejection that
 * never became a transaction is written down when the disclosure predates
 * `rejectedIntents`, and a reader deserves to know that its provenance is the
 * publisher's own log rather than a chain commitment.
 */
export const ProofManifestViewSchema = z.looseObject({
  schemaVersion: z.string(),
  runId: z.string(),
  network: z.looseObject({ chainId: z.number(), name: z.string() }),
  startedAt: z.number(),
  finishedAt: z.number(),
  spendBucket: z
    .looseObject({
      period: z.string(),
      bucketStart: z.string(),
      bucketEnd: z.string(),
      semanticsMatchUtcMidnight: z.boolean().optional(),
    })
    .optional(),
  /**
   * Who held which key.
   *
   * Carried because "the owner granted, the agent executed, the owner revoked"
   * is the shortest true statement of what this product does, and a reader who
   * cannot see three distinct addresses has to take the arm's-length
   * relationship on trust.
   */
  roles: z
    .looseObject({
      owner: z.looseObject({ address: z.string(), holds: z.string(), grants: z.string() }),
      agent: z.looseObject({
        address: z.string(),
        holds: z.string(),
        sessionKey: z.string(),
        designationSignature: z.string().optional(),
        designationNote: z.string().optional(),
      }),
      publisher: z.looseObject({ address: z.string(), sameAs: z.string().optional() }),
      separation: z.looseObject({
        assertion: z.string(),
        ownerIsAgent: z.boolean(),
        agentIsPublisher: z.boolean(),
      }),
    })
    .optional(),
  steps: z.array(
    z.looseObject({
      id: z.string(),
      phase: z.string(),
      status: z.enum(["PASS", "FAIL", "SKIP", "SKIPPED", "BLOCKED", "NOT_RUN", "RUNNING"]),
      observed: z.string().optional(),
      writes: z.boolean().optional(),
      evidence: z.array(z.looseObject({ label: z.string(), value: z.string() })).optional(),
    }),
  ),
  executions: z.array(
    z.looseObject({
      step: z.string(),
      label: z.string(),
      status: z.string(),
      target: z.string(),
      selector: z.string(),
      amountRaw: z.string().optional(),
      txHash: z.string().optional(),
    }),
  ),
  verifier: z
    .looseObject({
      trialVerdict: z.string(),
      mandateVerdict: z.string(),
      trialExitCode: z.number().optional(),
      mandateExitCode: z.number().optional(),
    })
    .optional(),
});

export type ProofManifestView = z.infer<typeof ProofManifestViewSchema>;

export function parseJsonDocument<T>(
  schema: z.ZodType<T>,
  document: unknown,
): { ok: true; value: T } | { ok: false; reason: string } {
  const parsed = schema.safeParse(document);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, reason: formatIssues(parsed.error) };
}

export async function fetchJsonDocument<T>(
  uri: string,
  schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  let bytes: Uint8Array;
  try {
    bytes = await fetchBytes(uri);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    return { ok: false, reason: `${uri} is not valid UTF-8 JSON: ${describe(error)}` };
  }

  return parseJsonDocument(schema, document);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
    .join("; ");
}

function sameHash(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.name;
  return String(error);
}
