import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { referenceImplementationHash } from "@mandate/reference-health-factor";
import { evaluatorImplementationHash, strategyEvaluatorImplementationHash } from "../src/identity.js";

/**
 * Three implementations, three separate conclusions.
 *
 * The agent decides what to do, the reference model decides what should have
 * been done, and the evaluator decides whether those agree. If any two of them
 * shared the arithmetic, the trial would stop being a check and become a
 * restatement: a bug in the shared code would make the agent wrong and its
 * judge agree, and the receipt would certify the error.
 *
 * `@mandate/venus-bsc` is the one thing all three may share, because it exports
 * balances, prices and weights and no judgement at all. Its own suite asserts
 * the absence of a `computeHealthFactor` on its public surface.
 */

const RUNNER_SOURCE = new URL("../src/", import.meta.url);

function sources(root: URL): { name: string; content: string }[] {
  const directory = fileURLToPath(root);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => ({
      name: entry.name,
      content: readFileSync(fileURLToPath(new URL(entry.name, root)), "utf8"),
    }));
}

describe("the evaluator holds no opinion of its own", () => {
  it("computes no health factor anywhere in its source", () => {
    // #given the file that decides verdicts
    const evaluator = readFileSync(fileURLToPath(new URL("evaluator.ts", RUNNER_SOURCE)), "utf8");

    // #then it contains no risk arithmetic. It compares documents it was
    // handed; it does not produce a third answer to break the tie with.
    expect(evaluator).not.toMatch(/healthFactor\s*=/);
    expect(evaluator).not.toMatch(/liquidationThresholdMantissa\s*\)/);
    expect(evaluator).not.toMatch(/MANTISSA/);
  });

  it("imports neither the reference model nor any agent", () => {
    // #given the same file
    const evaluator = readFileSync(fileURLToPath(new URL("evaluator.ts", RUNNER_SOURCE)), "utf8");

    // #then it reaches into neither side's accounting
    expect(evaluator).not.toMatch(/from\s+["']@mandate\/reference-health-factor["']/);
    expect(evaluator).not.toMatch(/from\s+["'][^"']*agent-health-factor/);
  });

  it("depends on the raw-facts adapter for facts only", () => {
    // #given every runner source file
    const files = sources(RUNNER_SOURCE);
    expect(files.length).toBeGreaterThan(5);

    // #then none of them imports a risk predicate from the adapter. The
    // adapter exports none, and this asserts the runner has not grown one.
    for (const file of files) {
      expect(file.content).not.toMatch(/computeHealthFactor|isAtRisk|calculateRequiredRepay/);
    }
  });
});

describe("the three implementations are distinct", () => {
  it("gives the reference model and the evaluator different identities", () => {
    // #given each side's source hashed the same way
    // #then a receipt naming both is naming two different things, and a reader
    // can fetch each one separately
    expect(referenceImplementationHash()).not.toBe(evaluatorImplementationHash());
  });

  it("keeps the evaluator's identity stable across calls", () => {
    // #given an unchanged source tree
    // #then the hash a receipt commits to does not move between runs
    expect(evaluatorImplementationHash()).toBe(evaluatorImplementationHash());
  });

  it("names the reference model in the artifact separately from the agent", () => {
    // #given the schema refinement that guards the collapse
    // #then it is the artifact, not a convention, that forbids one
    // implementation standing in for two. Asserted in evidence.test.ts against
    // a real assembly; restated here as the statement of the invariant.
    expect(referenceImplementationHash()).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

/**
 * The same three-way separation, for the categories that do not compute a
 * health factor.
 *
 * `strategy-evaluator.ts` judges the yield, grid and rebalancing runs. It has to
 * hold no opinion of its own for exactly the reason the health-factor evaluator
 * does, and it goes one step further: it does not even know what the numbers it
 * compares count. The caller reads the two chain figures and hands them over
 * with the direction they were expected to move, so the protocol knowledge stays
 * where the protocol is already known.
 */
describe("the strategy evaluator holds no opinion of its own", () => {
  const strategyEvaluator = readFileSync(
    fileURLToPath(new URL("strategy-evaluator.ts", RUNNER_SOURCE)),
    "utf8",
  );

  it("computes no price, rate or allocation anywhere in its source", () => {
    // #given the file that decides verdicts for these categories
    // #then it contains no financial arithmetic. It compares documents it was
    // handed; it does not produce a third answer to break the tie with.
    expect(strategyEvaluator).not.toMatch(/MANTISSA/);
    expect(strategyEvaluator).not.toMatch(/annualB|supplyRate|exchangeRate|storedRate/);
    expect(strategyEvaluator).not.toMatch(/solveInvariant|get_dy|getUnderlyingPrice/);
    expect(strategyEvaluator).not.toMatch(/priceMantissa|1e18|10n \*\* 18n/);
  });

  it("imports neither a reference model nor any agent", () => {
    // #given the same file
    // #then it reaches into neither side's reasoning
    expect(strategyEvaluator).not.toMatch(/from\s+["']@mandate\/reference-/);
    expect(strategyEvaluator).not.toMatch(/from\s+["'][^"']*agent-(?:yield|grid|rebalancing|health-factor)/);
  });

  it("learns nothing about the protocol from the post-state check", () => {
    // #given the same file
    // #then it never reaches into an observation to find a balance. The
    // health-factor evaluator does, which is a small piece of protocol knowledge
    // living somewhere that should have none; here the caller supplies the two
    // readings and this file compares two integers.
    //
    // Matched against property access rather than free text, because the
    // comments in this file necessarily name the protocol concepts the code
    // refuses to know about.
    expect(strategyEvaluator).not.toMatch(/\.vToken\b|\.borrowBalance\b|\.markets\b/);
    expect(strategyEvaluator).toMatch(/effect\.before/);
  });

  it("gives every judging implementation a different identity", () => {
    // #given each judge's source hashed the same way
    // #then a receipt naming one is naming one thing, and a change to the
    // strategy checks cannot supersede a published health-factor receipt
    expect(strategyEvaluatorImplementationHash()).not.toBe(evaluatorImplementationHash());
    expect(strategyEvaluatorImplementationHash()).not.toBe(referenceImplementationHash());
  });

  it("keeps its identity stable across calls", () => {
    // #given an unchanged source tree
    // #then the hash a receipt commits to does not move between runs
    expect(strategyEvaluatorImplementationHash()).toBe(strategyEvaluatorImplementationHash());
  });
});
