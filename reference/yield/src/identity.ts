/**
 * The model's identity, as a hash of the code that produced an answer.
 *
 * A trial receipt names a `referenceModelHash` so a reader can ask which model
 * said this, and so a change to the model supersedes the receipts it backed
 * rather than silently inheriting them. Hashing the source is the only form of
 * that claim which cannot drift from what actually ran; a hand-bumped version
 * string is a promise, and this is a measurement.
 *
 * The preimage keys are repo-relative paths, so the hash is a property of the
 * source tree rather than of anyone's checkout directory.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "@mandate/domain";
import type { CanonicalValue } from "@mandate/domain";
import type { Hex } from "viem";
import type { RawSupplyObservation } from "@mandate/venus-bsc";

const SOURCE_ROOT = "reference/yield/src";

/**
 * Every file that contributes to an answer.
 *
 * Listed explicitly rather than globbed: a directory read would fold a stray
 * scratch file into the identity of a published model, and would make the hash
 * depend on filesystem ordering.
 */
const SOURCE_FILES = ["scale.ts", "allocation.ts", "model.ts", "index.ts"] as const;

function readSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

/** keccak256 over the canonical encoding of this model's source tree. */
export function referenceImplementationHash(): Hex {
  const sources: Record<string, CanonicalValue> = {};
  for (const name of SOURCE_FILES) {
    sources[`${SOURCE_ROOT}/${name}`] = readSource(name);
  }
  return canonicalHash(sources);
}

/**
 * Hash of exactly the observation the model was handed.
 *
 * Recorded separately from the observation itself so a verifier can confirm the
 * model was fed the same pre-state the artifact publishes, rather than a
 * differently-filtered view of it that happened to produce a friendlier answer.
 */
export function referenceInputsHash(observation: RawSupplyObservation): Hex {
  return canonicalHash(observation as unknown as CanonicalValue);
}
