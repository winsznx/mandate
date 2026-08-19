import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "@mandate/domain";
import type { CanonicalValue } from "@mandate/domain";
import type { RawStableswapObservation } from "@mandate/stableswap-bsc";
import { referenceImplementationHash } from "../src/identity.js";
import { runReferenceModel } from "../src/model.js";
import {
  AMPLIFICATION_PRECISION,
  EXCHANGE_SELECTOR,
  ONE,
  TEST_POLICY,
  balancesForShare,
  observation,
} from "./fixtures.js";

/**
 * The architectural invariant the whole trial rests on.
 *
 * The agent under test and this model must reach their conclusions separately.
 * They are allowed to share raw facts — `@mandate/stableswap-bsc` exists so
 * both read the same balances, rates and parameters — and nothing else. If they
 * shared a pricing implementation, a bug in it would make the agent wrong and
 * make the evaluator agree, and the trial would certify the error with a
 * receipt.
 *
 * In this category the split is unusually sharp, and it is worth naming. The
 * agent asks the pool's own `get_dy` what a swap returns, which is a defensible
 * thing for an agent to do: it is the number the trade will execute at, from
 * the contract that will execute it. This model refuses to ask and solves the
 * invariant itself. `invariant.test.ts` shows the reconstruction reproduces the
 * deployed pool wei for wei, so the two routes agreeing means both are right
 * rather than that one was copied.
 */

const AGENT_ROOTS = [
  new URL("../../../agents/reference/grid-a/", import.meta.url),
  new URL("../../../agents/reference/grid-b/", import.meta.url),
];
const REFERENCE_ROOT = new URL("../", import.meta.url);

function sourceFiles(root: URL, subdirectory: string): { name: string; content: string }[] {
  const directory = fileURLToPath(new URL(subdirectory, root));
  const files: { name: string; content: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    files.push({
      name: entry.name,
      content: readFileSync(`${entry.parentPath}/${entry.name}`, "utf8"),
    });
  }
  return files;
}

function packageManifest(root: URL): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(fileURLToPath(new URL("package.json", root)), "utf8")) as {
    dependencies?: Record<string, string>;
  };
}

describe("the reference model and the agents are separate implementations", () => {
  it("hashes to a different implementation than either agent's source", () => {
    // #given each side's source tree hashed the same way
    for (const root of AGENT_ROOTS) {
      const agentSources: Record<string, CanonicalValue> = {};
      for (const file of sourceFiles(root, "src/")) {
        agentSources[file.name] = file.content;
      }

      // #then the identities differ, so a receipt naming one cannot be read as
      // having been produced by the other
      expect(referenceImplementationHash()).not.toBe(canonicalHash(agentSources));
    }
  });

  it("produces a stable identity across calls", () => {
    // #given the same unmodified source tree
    // #then the hash a receipt commits to does not move between runs
    expect(referenceImplementationHash()).toBe(referenceImplementationHash());
  });

  it("imports nothing from any agent under test", () => {
    // #given every source file in this model
    const files = sourceFiles(REFERENCE_ROOT, "src/");
    expect(files.length).toBeGreaterThan(0);

    // #then none of them reaches into an agent package or an agent directory
    for (const file of files) {
      expect(file.content).not.toMatch(/from\s+["'][^"']*agent-grid/);
      expect(file.content).not.toMatch(/from\s+["'][^"']*agents\/reference/);
      expect(file.content).not.toMatch(/from\s+["']@mandate\/agent-runtime["']/);
    }
  });

  it("is imported by no agent under test", () => {
    // #given every source file in both agents
    for (const root of AGENT_ROOTS) {
      const files = sourceFiles(root, "src/");
      expect(files.length).toBeGreaterThan(0);

      // #then none of them reaches into this model. The dependency has to be
      // absent in both directions: an agent that could read the answer key
      // would pass by copying it.
      for (const file of files) {
        expect(file.content).not.toMatch(/from\s+["'][^"']*reference-grid/);
        expect(file.content).not.toMatch(/from\s+["'][^"']*reference\/grid/);
      }
    }
  });

  it("declares no dependency on an agent, and no agent declares one on it", () => {
    // #given every package manifest involved
    const reference = Object.keys(packageManifest(REFERENCE_ROOT).dependencies ?? {});
    expect(reference).not.toContain("@mandate/agent-grid-a");
    expect(reference).not.toContain("@mandate/agent-grid-b");

    // #then neither side can resolve the other even if a future import were added
    for (const root of AGENT_ROOTS) {
      expect(Object.keys(packageManifest(root).dependencies ?? {})).not.toContain(
        "@mandate/reference-grid",
      );
    }
  });

  it("shares only facts and encodings with the agents", () => {
    // #given the packages each side depends on
    const reference = Object.keys(packageManifest(REFERENCE_ROOT).dependencies ?? {});
    for (const root of AGENT_ROOTS) {
      const agent = Object.keys(packageManifest(root).dependencies ?? {});
      const shared = reference.filter((name) => agent.includes(name));

      // #then the overlap carries facts and encodings, never a price.
      // `@mandate/stableswap-bsc` exports no invariant solver and no trade
      // sizing at all, which is what makes it safe for this model to depend on
      // and the agents not to.
      expect(shared.sort()).toEqual(["@mandate/domain", "viem"]);
    }
  });

  it("does not solve the invariant anywhere in the agents' source", () => {
    // #given every source file in both agents
    for (const root of AGENT_ROOTS) {
      for (const file of sourceFiles(root, "src/")) {
        // #then the agents price by asking, never by deriving. Two
        // implementations of Newton's method on the same curve would be the same
        // implementation with different variable names, and the whole value of
        // the comparison would be gone.
        expect(file.content).not.toMatch(/solveInvariant|solveOutputBalance|dynamicFee/);
      }
    }
  });
});

describe("the model reaches its answer without the route the agent uses", () => {
  /**
   * The sharpest form of the independence claim on this category.
   *
   * The agent's entire price comes from `get_dy`. If this model quietly leaned
   * on the same reading, corrupting it would move this model's answer. It does
   * not — and the reconstruction still reports the disagreement, so the artifact
   * shows the two routes were compared rather than merging into one.
   */
  const balances = balancesForShare(5_000, ONE * 10n);
  const board = observation({
    skewNumerator: 150n,
    walletBalance0: balances.coin0,
    walletBalance1: balances.coin1,
  });

  const corrupted: RawStableswapObservation = {
    ...board,
    poolQuotes: board.poolQuotes.map((quote) => ({ ...quote, dy: "1" })),
  };

  function outcome(input: RawStableswapObservation) {
    const { result, position } = runReferenceModel({
      observation: input,
      policy: TEST_POLICY,
      exchangeSelector: EXCHANGE_SELECTOR,
      amplificationPrecision: AMPLIFICATION_PRECISION,
    });
    return {
      decisionState: result.decisionState,
      expectedAction: result.expectedAction,
      deviationBps: position?.deviationBps,
      effectiveRateMantissa: position?.effectiveRateMantissa,
    };
  }

  it("returns the same verdict when get_dy is replaced with nonsense", () => {
    // #given a tradeable board, and the same board with the pool's own quotes
    // corrupted to one wei
    // #when both are run
    // #then every derived figure is identical, because none of them came from
    // the reading that changed
    expect(outcome(corrupted)).toEqual(outcome(board));
  });

  it("still reports the corrupted reading as drift, so the disagreement is visible", () => {
    // #given the corrupted board
    const { result } = runReferenceModel({
      observation: corrupted,
      policy: TEST_POLICY,
      exchangeSelector: EXCHANGE_SELECTOR,
      amplificationPrecision: AMPLIFICATION_PRECISION,
    });
    const drift = result.metrics.find((entry) => entry.key === "reconstruction-drift");

    // #then the model records that it disagrees with the pool rather than
    // discarding the comparison. Drift is a cross-check on this module, not an
    // input to it, and it has to stay legible in the artifact either way.
    expect(BigInt(drift?.value ?? "0")).toBeGreaterThan(9_000n);
  });

  it("moves its answer when a reading it does use changes", () => {
    // #given the same board with a pool balance changed instead of a quote
    const rebalanced = observation({
      skewNumerator: 100n,
      walletBalance0: balances.coin0,
      walletBalance1: balances.coin1,
    });

    // #then the verdict does move. A model that ignored the corrupted reading
    // and also ignored the real ones would pass the test above by being inert,
    // which is why this one is here.
    expect(outcome(rebalanced).deviationBps).not.toBe(outcome(board).deviationBps);
  });
});
