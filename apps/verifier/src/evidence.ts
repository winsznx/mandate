/**
 * The integrity gate.
 *
 * Everything downstream — the reference replay, the authority documents, the
 * subset relation — reads fields out of the evidence document. All of it is
 * worthless if the document is not the one the chain committed to, so nothing
 * interprets a single field until `keccak256(canonical bytes) == evidenceHash`
 * has been established.
 *
 * Two encodings satisfy that equality and both are legitimate:
 *
 *  - The stored object is already the canonical MCJ/1 byte string. Hashing the
 *    downloaded bytes directly settles it, with no parse at all.
 *  - The store pretty-printed or re-ordered the JSON. MCJ/1 hashes the *value*,
 *    not the file, so re-canonicalising and hashing is still a sound check.
 *
 * The second path has to `JSON.parse` before it knows the answer, which looks
 * like it violates the rule. It does not, and the distinction is worth being
 * precise about: that parse is structural only. Its result is used for exactly
 * one thing — re-encoding — and is discarded unless the hash then matches. No
 * schema is applied, no field is read, and nothing escapes this module until an
 * equality has held.
 */
import { canonicalize, CanonicalEncodingError } from "@mandate/domain/canonical";
import type { CanonicalValue } from "@mandate/domain/canonical";
import { keccak256, toHex } from "viem";
import type { Hex } from "viem";

/**
 * How the stored bytes related to the committed hash.
 *
 * Reported rather than hidden, because "the object we serve is byte-identical
 * to what was hashed" is a stronger property than "it re-encodes to the same
 * value", and a reader is entitled to know which one they got.
 */
export type EvidenceEncoding = "CANONICAL_BYTES" | "RECANONICALISED";

export interface EvidenceIntegrityOk {
  ok: true;
  encoding: EvidenceEncoding;
  hash: Hex;
  /** Structurally parsed, not yet schema-validated. Safe to interpret: the hash held. */
  document: unknown;
  byteLength: number;
}

export interface EvidenceIntegrityFailure {
  ok: false;
  reason: string;
  /** Hash of the raw bytes as downloaded, for the failure report. */
  rawHash: Hex;
  /** Hash of the re-canonicalised value, when the document could be re-encoded at all. */
  canonicalHash?: Hex;
  byteLength: number;
}

export type EvidenceIntegrityResult = EvidenceIntegrityOk | EvidenceIntegrityFailure;

function equalHash(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Check downloaded evidence bytes against the hash the receipt committed to.
 *
 * A mismatch is terminal. It is not a partial result and never degrades to a
 * skip: the publisher committed to specific content and the bytes on offer are
 * something else, which is the one failure that says the record itself is
 * false rather than merely incomplete.
 */
export function checkEvidenceIntegrity(bytes: Uint8Array, expected: Hex): EvidenceIntegrityResult {
  const byteLength = bytes.byteLength;
  const rawHash = keccak256(toHex(bytes));

  if (equalHash(rawHash, expected)) {
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
      reason: `evidence hash does not match and the body is not valid UTF-8 JSON: ${String(error)}`,
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
        : `${String(error)} — MCJ/1 rejects floats and integers beyond 2^53, which travel as decimal strings`;
    return {
      ok: false,
      reason: `evidence hash does not match and the document is not MCJ/1-encodable: ${detail}`,
      rawHash,
      byteLength,
    };
  }

  if (equalHash(recanonicalised, expected)) {
    return { ok: true, encoding: "RECANONICALISED", hash: recanonicalised, document: parsed, byteLength };
  }

  return {
    ok: false,
    reason: `evidence hash mismatch: receipt commits to ${expected}, downloaded bytes hash to ${rawHash} raw and ${recanonicalised} re-canonicalised`,
    rawHash,
    canonicalHash: recanonicalised,
    byteLength,
  };
}
