import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalHash } from "@mandate/domain";
import type { CanonicalValue } from "@mandate/domain";
import { referenceImplementationHash } from "../src/identity.js";
import { runReferenceModel } from "../src/model.js";
import { REPAY_BORROW_SELECTOR, TEST_POLICY, VUSDT, positionWith } from "./fixtures.js";

/**
 * The architectural invariant the whole trial rests on.
 *
 * The agent under test and this model must reach their conclusions separately.
 * They are allowed to share raw facts — `@mandate/venus-bsc` exists so they
 * read the same balances, prices and weights — and nothing else. If they shared
 * an accounting implementation, a bug in it would make the agent wrong and make
 * the evaluator agree, and the trial would certify the error with a receipt.
 *
 * That is not a hypothetical failure mode. VENUS-ACCOUNTING-001 is a frozen
 * case where a shared reconstruction derived the debt universe from
 * `getAssetsIn`, missed VAI entirely, and reported an account at health factor
 * 2.505 as carrying no debt at all.
 */

const AGENT_ROOT = new URL("../../../agents/reference/health-factor-a/", import.meta.url);
const REFERENCE_ROOT = new URL("../", import.meta.url);

function sourceFiles(root: URL, subdirectory: string): { name: string; content: string }[] {
  const directory = fileURLToPath(new URL(subdirectory, root));
  const files: { name: string; content: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const path = fileURLToPath(new URL(`${subdirectory}${entry.name}`, root));
    files.push({ name: entry.name, content: readFileSync(entry.parentPath ? `${entry.parentPath}/${entry.name}` : path, "utf8") });
  }
  return files;
}

function packageManifest(root: URL): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(fileURLToPath(new URL("package.json", root)), "utf8")) as {
    dependencies?: Record<string, string>;
  };
}

describe("the reference model and the agent are separate implementations", () => {
  it("hashes to a different implementation than the agent's source", () => {
    // #given each side's source tree hashed the same way
    const agentSources: Record<string, CanonicalValue> = {};
    for (const file of sourceFiles(AGENT_ROOT, "src/")) {
      agentSources[file.name] = file.content;
    }

    // #then the two identities differ, so a receipt naming one cannot be read
    // as having been produced by the other
    expect(referenceImplementationHash()).not.toBe(canonicalHash(agentSources));
  });

  it("produces a stable identity across calls", () => {
    // #given the same unmodified source tree
    // #then the hash a receipt commits to does not move between runs
    expect(referenceImplementationHash()).toBe(referenceImplementationHash());
  });

  it("imports nothing from the agent under test", () => {
    // #given every source file in this model
    const files = sourceFiles(REFERENCE_ROOT, "src/");
    expect(files.length).toBeGreaterThan(0);

    // #then none of them reaches into an agent package or an agent directory
    for (const file of files) {
      expect(file.content).not.toMatch(/from\s+["'][^"']*agent-health-factor/);
      expect(file.content).not.toMatch(/from\s+["'][^"']*agents\/reference/);
      expect(file.content).not.toMatch(/from\s+["']@mandate\/agent-runtime["']/);
    }
  });

  it("is imported by no agent under test", () => {
    // #given every source file in the agent
    const files = sourceFiles(AGENT_ROOT, "src/");
    expect(files.length).toBeGreaterThan(0);

    // #then none of them reaches into this model. The dependency has to be
    // absent in both directions: an agent that could read the answer key would
    // pass by copying it.
    for (const file of files) {
      expect(file.content).not.toMatch(/from\s+["'][^"']*reference-health-factor/);
      expect(file.content).not.toMatch(/from\s+["'][^"']*reference\/health-factor/);
    }
  });

  it("declares no dependency on the agent, and the agent declares none on it", () => {
    // #given both package manifests
    const reference = packageManifest(REFERENCE_ROOT).dependencies ?? {};
    const agent = packageManifest(AGENT_ROOT).dependencies ?? {};

    // #then neither can resolve the other even if a future import were added
    expect(Object.keys(reference)).not.toContain("@mandate/agent-health-factor-a");
    expect(Object.keys(agent)).not.toContain("@mandate/reference-health-factor");
  });

  it("shares only the raw-facts adapter with the agent", () => {
    // #given the packages both sides depend on
    const reference = Object.keys(packageManifest(REFERENCE_ROOT).dependencies ?? {});
    const agent = Object.keys(packageManifest(AGENT_ROOT).dependencies ?? {});
    const shared = reference.filter((name) => agent.includes(name));

    // #then the overlap carries facts and encodings, never a risk judgement.
    // `@mandate/venus-bsc` is asserted elsewhere to export no health
    // computation at all, which is what makes sharing it safe.
    expect(shared.sort()).toEqual(["@mandate/domain", "viem"]);
  });
});

describe("the model reaches its answer without the protocol's verdict", () => {
  /**
   * The sharpest form of the independence claim. The agent derives its
   * collateral figure from `Comptroller.getAccountLiquidity` and works
   * backwards to the pieces. If this model did the same, corrupting that
   * reading would move its answer. It does not.
   */
  const observation = positionWith({ usdcCollateral: 493_526_039_240n, vaiOwed: 0n, usdtBorrow: 140_000_000n });

  const corrupted = {
    ...observation,
    accountLiquidity: { errorCode: "0", liquidity: "999999999999999999999999", shortfall: "0" },
  };

  function outcome(input: typeof observation) {
    const { result } = runReferenceModel({
      observation: input,
      policy: TEST_POLICY,
      actionableMarket: VUSDT,
      repaySelector: REPAY_BORROW_SELECTOR,
    });
    return {
      riskState: result.riskState,
      healthFactorMantissa: result.healthFactorMantissa,
      weightedCollateralUsdMantissa: result.weightedCollateralUsdMantissa,
      totalBorrowUsdMantissa: result.totalBorrowUsdMantissa,
      liquidityUsdMantissa: result.liquidityUsdMantissa,
      shortfallUsdMantissa: result.shortfallUsdMantissa,
      expectedAction: result.expectedAction,
    };
  }

  it("returns the same verdict when getAccountLiquidity is replaced with nonsense", () => {
    // #given an at-risk position, and the same position with the protocol's
    // liquidity reading corrupted to an absurd surplus
    // #when both are run
    // #then every derived figure is identical, because none of them came from
    // the reading that changed
    expect(outcome(corrupted)).toEqual(outcome(observation));
  });

  it("still reports the corrupted reading as drift, so the disagreement is visible", () => {
    // #given the corrupted observation
    const drift = (input: typeof observation) =>
      runReferenceModel({
        observation: input,
        policy: TEST_POLICY,
        actionableMarket: VUSDT,
        repaySelector: REPAY_BORROW_SELECTOR,
      }).reconstruction.protocolDriftBps;

    // #then the model records that it disagrees with the protocol rather than
    // discarding the comparison. Drift is a cross-check on this model, not an
    // input to it, and it has to stay legible in the artifact either way.
    expect(drift(corrupted) ?? 0n).toBeGreaterThan(9_000n);
  });
});
