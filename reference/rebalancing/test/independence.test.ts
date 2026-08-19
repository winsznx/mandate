import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "@mandate/domain";
import type { CanonicalValue } from "@mandate/domain";
import { reconstruct } from "../src/allocation.js";
import { referenceImplementationHash } from "../src/identity.js";
import { runReferenceModel } from "../src/model.js";
import { EXCHANGE_RATE, MINT_SELECTOR, TEST_POLICY, driftedBoard } from "./fixtures.js";

/**
 * The architectural invariant the whole trial rests on.
 *
 * The agent under test and this model must reach their conclusions separately.
 * They are allowed to share raw facts — `@mandate/venus-bsc` exists so both
 * read the same balances, caps and prices — and nothing else. If they shared an
 * accounting implementation, a bug in it would make the agent wrong and make
 * the evaluator agree, and the trial would certify the error with a receipt.
 *
 * That is not a hypothetical failure mode. VENUS-ACCOUNTING-001 is a frozen
 * case where a shared reconstruction derived the debt universe from
 * `getAssetsIn`, missed VAI entirely, and reported an account at health factor
 * 2.505 as carrying no debt at all.
 */

const AGENT_ROOTS = [
  new URL("../../../agents/reference/rebalancing-a/", import.meta.url),
  new URL("../../../agents/reference/rebalancing-b/", import.meta.url),
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
      expect(file.content).not.toMatch(/from\s+["'][^"']*agent-rebalancing/);
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
        expect(file.content).not.toMatch(/from\s+["'][^"']*reference-rebalancing/);
        expect(file.content).not.toMatch(/from\s+["'][^"']*reference\/rebalancing/);
      }
    }
  });

  it("declares no dependency on an agent, and no agent declares one on it", () => {
    // #given every package manifest involved
    const reference = Object.keys(packageManifest(REFERENCE_ROOT).dependencies ?? {});
    expect(reference).not.toContain("@mandate/agent-rebalancing-a");
    expect(reference).not.toContain("@mandate/agent-rebalancing-b");

    // #then neither side can resolve the other even if a future import were added
    for (const root of AGENT_ROOTS) {
      expect(Object.keys(packageManifest(root).dependencies ?? {})).not.toContain(
        "@mandate/reference-rebalancing",
      );
    }
  });

  it("shares only facts and encodings with the agents", () => {
    // #given the packages each side depends on
    const reference = Object.keys(packageManifest(REFERENCE_ROOT).dependencies ?? {});
    for (const root of AGENT_ROOTS) {
      const agent = Object.keys(packageManifest(root).dependencies ?? {});
      const shared = reference.filter((name) => agent.includes(name));

      // #then the overlap carries facts and encodings, never a judgement.
      // `@mandate/venus-bsc` is asserted elsewhere to export no weight, no
      // ranking and no sizing at all, which is what makes it safe for this
      // model to depend on and the agents not to.
      expect(shared.sort()).toEqual(["@mandate/domain", "viem"]);
    }
  });

  it("writes the drift predicate out on both sides rather than sharing one", () => {
    // #given the two modules that decide whether a market is out of band
    const modelSide = readFileSync(
      fileURLToPath(new URL("src/allocation.ts", REFERENCE_ROOT)),
      "utf8",
    );
    const agentSide = readFileSync(
      fileURLToPath(new URL("src/venus/weights.ts", AGENT_ROOTS[0] ?? REFERENCE_ROOT)),
      "utf8",
    );

    // #then each carries its own cross-multiplied comparison, and neither
    // divides. A shared helper here would be the single point of failure the
    // whole two-implementation arrangement exists to remove, and a division on
    // either side would put the two boundaries a base unit apart.
    expect(modelSide).toMatch(
      /targetWeightBps \* portfolioUsd - positionUsd \* BASIS_POINTS >= triggerBps \* portfolioUsd/,
    );
    expect(agentSide).toMatch(
      /targetWeightBps \* portfolioUsd - positionUsd \* BASIS_POINTS >= triggerBps \* portfolioUsd/,
    );
    expect(agentSide).not.toMatch(/from\s+["'][^"']*reference/);
  });
});

describe("the model reaches its answer without the route the agent uses", () => {
  /**
   * The sharpest form of the independence claim on this category.
   *
   * The agent derives how much underlying a market holds — and therefore how
   * much room is left under its supply cap — from `totalSupply * exchangeRate`.
   * This model adds up `cash + borrows - reserves`. Both read the same
   * quantity, and if this model quietly leaned on the agent's route, corrupting
   * that route would move this model's answer. It does not.
   */
  const board = driftedBoard();

  const supplyCorrupted = {
    ...board,
    markets: board.markets.map((entry) => ({
      ...entry,
      // Ten times the vToken supply the balance sheet supports, which is what a
      // wrong exchange-rate decode produces.
      totalSupplyVTokens: (BigInt(entry.totalSupplyVTokens ?? "0") * 10n).toString(10),
    })),
  };

  function outcome(input: typeof board) {
    const result = runReferenceModel({
      observation: input,
      policy: TEST_POLICY,
      mintSelector: MINT_SELECTOR,
    }).result;
    return { decisionState: result.decisionState, expectedAction: result.expectedAction };
  }

  it("returns the same verdict when the vToken supply is replaced with nonsense", () => {
    // #given a drifted board, and the same board with its vToken supply
    // inflated tenfold
    // #when both are run
    // #then the decision and the sized action are identical, because neither
    // came from the reading that changed
    expect(outcome(supplyCorrupted)).toEqual(outcome(board));
  });

  it("still reports the corrupted reading as drift, so the disagreement is visible", () => {
    // #given the corrupted board
    const drift = reconstruct(supplyCorrupted).markets.map((entry) => entry.identityDriftBps);

    // #then the model records that its balance sheet disagrees with the vToken
    // supply rather than discarding the comparison. Drift is a cross-check on
    // this model, not an input to it, and it has to stay legible in the
    // artifact either way.
    expect(drift).toEqual([90_000n, 90_000n, 90_000n]);
  });

  it("keeps the exchange rate out of the figures it takes off the balance sheet", () => {
    // #given the same board with only the exchange rate corrupted
    const rateCorrupted = {
      ...board,
      markets: board.markets.map((entry) => ({
        ...entry,
        exchangeRateMantissa: (EXCHANGE_RATE * 3n).toString(10),
      })),
    };

    // #then the supplied totals and the supply headroom this model reports are
    // untouched, because both come off `cash + borrows - reserves` and the
    // exchange rate is not part of it.
    //
    // The claim stops there, and stopping there is deliberate. Valuing the
    // account's own vToken balance does depend on `exchangeRateStored`, on both
    // sides, because the protocol offers no second route from a vToken balance
    // to underlying. Asserting that this model ignored it would be asserting
    // something false, and an independence test that overstated its own reach
    // would be the least trustworthy file in the repository.
    const before = reconstruct(board).markets;
    const after = reconstruct(rateCorrupted).markets;
    expect(after.map((entry) => entry.suppliedUnderlyingRaw)).toEqual(
      before.map((entry) => entry.suppliedUnderlyingRaw),
    );
    expect(after.map((entry) => entry.headroomRaw)).toEqual(
      before.map((entry) => entry.headroomRaw),
    );
    expect(after.every((entry) => (entry.identityDriftBps ?? 0n) === 20_000n)).toBe(true);
  });
});
