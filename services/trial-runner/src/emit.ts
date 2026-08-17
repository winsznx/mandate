/**
 * Writing a completed trial to disk.
 *
 * Two files, because they answer different questions. The bundle is what goes
 * to `evidenceURI` and what the receipt's `evidenceHash` covers; the full
 * artifact is the richer document the bundle's flat summary points at by hash.
 * Both are written through the canonical encoding, so the bytes on disk are the
 * bytes that were hashed rather than a re-serialisation that might differ in
 * key order and quietly fail a verifier's integrity check.
 *
 * The manifest carries the three commitments a publisher has to put in the
 * receipt. Deriving them at publication time from a document someone re-read
 * and re-encoded is how a receipt ends up committing to something nobody has.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize } from "@mandate/domain";
import type { CanonicalValue, TrialEvidence } from "@mandate/domain";
import type { Hex } from "viem";
import type { EvidenceBundle } from "./bundle.js";

export const BUNDLE_FILENAME = "evidence-bundle.json";
export const EVIDENCE_FILENAME = "trial-evidence.json";
export const MANIFEST_FILENAME = "receipt-fields.json";

export interface CompletedTrial {
  readonly evidence: TrialEvidence;
  readonly evidenceHash: Hex;
  readonly bundle: EvidenceBundle;
  readonly bundleHash: Hex;
  readonly trialSpecHash: Hex;
  readonly testedAuthorityHash: Hex;
}

export interface EmittedTrial {
  readonly directory: string;
  readonly bundlePath: string;
  readonly evidencePath: string;
  readonly manifestPath: string;
}

/**
 * The receipt fields this run determines.
 *
 * `evidenceHash` is the bundle's. A receipt carrying the bare artifact's hash
 * fails the verifier's integrity step before it reaches the authority steps, so
 * naming the source of each field here removes the one place a publisher could
 * reasonably pick the wrong hash.
 */
function manifest(trial: CompletedTrial): CanonicalValue {
  return {
    evidenceHash: trial.bundleHash,
    evidenceHashCoversheet: "canonical hash of evidence-bundle.json, not of trial-evidence.json",
    trialSpecHash: trial.trialSpecHash,
    testedAuthorityHash: trial.testedAuthorityHash,
    trialEvidenceHash: trial.evidenceHash,
    result: trial.evidence.evaluator.result,
    scenarioBlock: trial.evidence.environment.forkBlock,
    rpcSourceClass: trial.evidence.environment.rpcSourceClass,
    referenceModelHash: trial.evidence.reference.implementationHash,
    evaluatorHash: trial.evidence.evaluator.implementationHash,
  };
}

/** Write a completed trial into `directory`, creating it if needed. */
export async function emitTrial(
  trial: CompletedTrial,
  directory: string,
): Promise<EmittedTrial> {
  await mkdir(directory, { recursive: true });

  const bundlePath = join(directory, BUNDLE_FILENAME);
  const evidencePath = join(directory, EVIDENCE_FILENAME);
  const manifestPath = join(directory, MANIFEST_FILENAME);

  await Promise.all([
    writeFile(bundlePath, canonicalize(trial.bundle as unknown as CanonicalValue), "utf8"),
    writeFile(evidencePath, canonicalize(trial.evidence as unknown as CanonicalValue), "utf8"),
    writeFile(manifestPath, canonicalize(manifest(trial)), "utf8"),
  ]);

  return { directory, bundlePath, evidencePath, manifestPath };
}
