import { describe, expect, it } from "vitest";
import { StrategyNotImplementedError } from "@mandate/agent-runtime";
import { createStrategy } from "../src/strategy.js";
import { HEALTH_FACTOR_B_POLICY, describePolicy } from "../src/policy.js";

const REQUEST = {
  requestId: "req-1",
  skill: "restore-health-factor",
  chainId: 97,
  wallet: "0x1111111111111111111111111111111111111111",
  parameters: {},
} as const;

describe("Efficient Guardian", () => {
  it("registers under the HEALTH_FACTOR category", () => {
    // #given the scaffolded executor
    const executor = createStrategy();

    // #then it is discoverable in the right marketplace category
    expect(executor.category).toBe("HEALTH_FACTOR");
    expect(executor.slug).toBe("health-factor-b");
  });

  it("advertises the skill a trial harness will call", () => {
    // #given the scaffolded executor
    const executor = createStrategy();

    // #then the skill id is present, so the card-driven adapter can reach it
    expect(executor.skills.map((skill) => skill.id)).toEqual(["restore-health-factor"]);
  });

  it("publishes its policy even though the strategy is pending", () => {
    // #given the published policy document
    const published = describePolicy(HEALTH_FACTOR_B_POLICY) as Record<string, unknown>;

    // #then the parameters a trial would bind to already exist
    expect(published["policyId"]).toBe(HEALTH_FACTOR_B_POLICY.policyId);
    expect(Object.keys(published).length).toBeGreaterThan(1);
  });

  it("refuses to deliberate, naming itself and the skill", async () => {
    // #given the scaffolded executor
    const executor = createStrategy();

    // #when asked to propose an action
    // #then it refuses with the declared-gap error rather than inventing a proposal
    await expect(executor.propose(REQUEST)).rejects.toThrow(StrategyNotImplementedError);
    await expect(executor.propose(REQUEST)).rejects.toThrow(/health-factor-b/);
  });
});
