import { describe, expect, it } from "vitest";
import type { Proposal } from "@mandate/agent-runtime";
import { COST_AWARE_OPTIMIZER_POLICY, describePolicy as describeSibling } from "@mandate/agent-yield-a/policy";
import { createYieldStrategy } from "@mandate/agent-yield-a";
import { VENUS_SUPPLY_BSC_TESTNET } from "@mandate/agent-yield-a/venus";
import type { SupplyAccountState } from "@mandate/agent-yield-a/venus";
import {
  ACCOUNT,
  VUSDC,
  fixedReader,
  position,
} from "@mandate/agent-yield-a/test-fixtures";
import { DIVERSIFIED_OPTIMIZER_POLICY, describePolicy } from "../src/policy.js";
import { createStrategy } from "../src/strategy.js";

const REQUEST = {
  requestId: "req-1",
  skill: "optimise-yield",
  chainId: 97,
  wallet: ACCOUNT,
  parameters: {},
} as const;

function diversified(state: SupplyAccountState): Promise<Proposal> {
  return createStrategy({
    deployment: VENUS_SUPPLY_BSC_TESTNET,
    reader: fixedReader(state),
  }).propose(REQUEST);
}

/** The sibling agent, run on the same state, so the two can be compared directly. */
function costAware(state: SupplyAccountState): Promise<Proposal> {
  return createYieldStrategy({
    slug: "yield-a",
    displayName: "Cost-Aware Optimizer",
    description: "Fixture.",
    policy: COST_AWARE_OPTIMIZER_POLICY,
    deployment: VENUS_SUPPLY_BSC_TESTNET,
    reader: fixedReader(state),
  }).propose(REQUEST);
}

function amountOf(proposal: Proposal): bigint {
  if (proposal.decision !== "PROPOSE") throw new Error(`expected PROPOSE, got ${proposal.decision}`);
  return BigInt(proposal.action.args[0]?.value ?? "-1");
}

/**
 * 1000 USDT at fifty cents and 1000 USDC at a dollar, so the account's capital
 * is $1500 and the 6000 bps ceiling permits $900 in any one market.
 */
function balancedIdle(): SupplyAccountState {
  return position(
    { annualRateBps: 120, walletBalance: 1_000_000_000n },
    { annualRateBps: 300, walletBalance: 1_000_000_000n },
  );
}

describe("the card the marketplace publishes", () => {
  it("registers under the YIELD category with the shared skill id", async () => {
    // #given the wired executor
    const executor = createStrategy({
      deployment: VENUS_SUPPLY_BSC_TESTNET,
      reader: fixedReader(balancedIdle()),
    });

    // #then it is discoverable beside its sibling, under the same skill, so a
    // buyer comparing the two is comparing agents rather than interfaces
    expect(executor.category).toBe("YIELD");
    expect(executor.slug).toBe("yield-b");
    expect(executor.skills.map((skill) => skill.id)).toEqual(["optimise-yield"]);
    await expect(executor.propose(REQUEST)).resolves.toBeDefined();
  });

  it("renders its policy through the same function as its sibling", () => {
    // #given both published policy documents
    const mine = describePolicy(DIVERSIFIED_OPTIMIZER_POLICY) as Record<string, unknown>;
    const sibling = describeSibling(COST_AWARE_OPTIMIZER_POLICY) as Record<string, unknown>;

    // #then they carry the same fields and differ only in the values, which is
    // what makes a side-by-side comparison a comparison rather than a
    // reconciliation
    expect(Object.keys(mine).sort()).toEqual(Object.keys(sibling).sort());
    expect(mine["policyId"]).toBe("diversified-optimizer");
    expect(mine["maxVenueShareBps"]).toBe(6_000);
    expect(sibling["maxVenueShareBps"]).toBeNull();
  });
});

describe("the concentration ceiling is the whole difference", () => {
  it("deploys less than its sibling into the same best market", async () => {
    // #given one account with $1500 of capital and USDC paying the best rate
    const state = balancedIdle();

    // #when both agents in the category deliberate over it
    const mine = await diversified(state);
    const sibling = await costAware(state);

    // #then both pick USDC and size it differently: the sibling commits the
    // whole idle balance, this agent stops at 60% of the account's capital,
    // which is $900 of a $1500 book.
    if (mine.decision !== "PROPOSE" || sibling.decision !== "PROPOSE") {
      throw new Error("expected both agents to act");
    }
    expect(mine.action.target).toBe(VUSDC);
    expect(sibling.action.target).toBe(VUSDC);
    expect(amountOf(sibling)).toBe(1_000_000_000n);
    expect(amountOf(mine)).toBe(900_000_000n);
  });

  it("differs from its sibling by far more than an evaluator's tolerance", async () => {
    // #given the two amounts from the same state
    const state = balancedIdle();
    const mine = amountOf(await diversified(state));
    const sibling = amountOf(await costAware(state));

    // #then the gap is 1000 bps against a 50 bps tolerance. An evaluator holding
    // one agent's policy fails the other, which is the property that makes a
    // receipt a statement about an agent rather than about its category.
    const driftBps = ((sibling - mine) * 10_000n) / sibling;
    expect(driftBps).toBe(1_000n);
    expect(Number(driftBps)).toBeGreaterThan(DIVERSIFIED_OPTIMIZER_POLICY.amountToleranceBps);
  });

  it("holds when the best market is already at its ceiling", async () => {
    // #given an account whose USDC position is already 60% of its capital.
    // A vToken balance of 4.5e12 at the fixture exchange rate of 2e14 is
    // 900 USDC supplied, against 500 USDT and 100 USDC left idle.
    const concentrated = position(
      { annualRateBps: 120, walletBalance: 1_000_000_000n },
      { annualRateBps: 300, walletBalance: 100_000_000n, vTokenBalance: 4_500_000_000_000n },
    );

    // #when both agents deliberate
    const mine = await diversified(concentrated);
    const sibling = await costAware(concentrated);

    // #then the sibling tops the winning market up further and this agent
    // refuses to, because the ceiling binds before the rate does
    expect(sibling.decision).toBe("PROPOSE");
    expect(mine.decision).toBe("PROPOSE");
    if (mine.decision !== "PROPOSE") return;
    expect(mine.action.target).not.toBe(VUSDC);
  });

  it("accepts a worse rate rather than breaching the ceiling", async () => {
    // #given the same concentrated account
    const concentrated = position(
      { annualRateBps: 120, walletBalance: 1_000_000_000n },
      { annualRateBps: 300, walletBalance: 100_000_000n, vTokenBalance: 4_500_000_000_000n },
    );

    // #when this agent deliberates
    const proposal = await diversified(concentrated);

    // #then it deploys into the 120 bps market rather than the 300 bps one. The
    // rationale has to say the rate it took, not the rate it wanted, or the
    // proof page would misdescribe the trade the user got.
    if (proposal.decision !== "PROPOSE") throw new Error("expected an action");
    expect(proposal.action.rationale).toMatch(/USDT supplies at 120 bps/);
  });
});

describe("the lower rate floor follows from the ceiling", () => {
  it("acts on a market its sibling holds on", async () => {
    // #given both markets paying 80 bps gross, which is 55 bps net: above this
    // agent's 50 bps floor and below the sibling's 75 bps floor
    const modest = position(
      { annualRateBps: 80, walletBalance: 1_000_000_000n },
      { annualRateBps: 80, walletBalance: 1_000_000_000n },
    );

    // #then the pair diverge on the decision itself and not only on the size.
    // An agent constrained to spread its capital cannot also hold out for the
    // best headline rate, or it would sit idle permanently.
    expect((await diversified(modest)).decision).toBe("PROPOSE");
    expect((await costAware(modest)).decision).toBe("HOLD");
  });
});
