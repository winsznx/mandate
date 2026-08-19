/**
 * What judged the run, as a hash of the code that did it.
 *
 * A `TrialReceipt` names an `evaluatorHash` so a reader can fetch the exact
 * checks that produced a verdict and disagree with them on the merits. A
 * hand-maintained version string would be a promise about that; hashing the
 * source is a measurement of it, and it cannot drift from what ran.
 *
 * Keys are repo-relative, so the identity belongs to the source tree rather
 * than to anyone's checkout.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "@mandate/domain";
import type { CanonicalValue } from "@mandate/domain";
import type { Hex } from "viem";

export const RUNNER_VERSION = "1.0.0";

const SOURCE_ROOT = "services/trial-runner/src";

/**
 * The files that decide a verdict.
 *
 * Deliberately narrower than the whole service. The fork lifecycle and the
 * scenario executor shape what the agent was shown, and they are pinned through
 * the scenario hash and the environment record instead. Folding them in here
 * would invalidate every published receipt on a change to a timeout constant.
 */
const EVALUATOR_SOURCES = ["evaluator.ts"] as const;

/**
 * The files that decide a verdict for the allocation and trading categories.
 *
 * Hashed separately from the health-factor evaluator rather than together with
 * it. A receipt names the code that judged that run, and folding both files
 * into one identity would mean a change to the yield checks superseded every
 * published health-factor receipt — invalidating evidence that the change could
 * not possibly have affected.
 */
const STRATEGY_EVALUATOR_SOURCES = ["strategy-evaluator.ts"] as const;

function readSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

function hashSources(names: readonly string[]): Hex {
  const sources: Record<string, CanonicalValue> = {};
  for (const name of names) {
    sources[`${SOURCE_ROOT}/${name}`] = readSource(name);
  }
  return canonicalHash(sources);
}

export function evaluatorImplementationHash(): Hex {
  return hashSources(EVALUATOR_SOURCES);
}

export function strategyEvaluatorImplementationHash(): Hex {
  return hashSources(STRATEGY_EVALUATOR_SOURCES);
}
