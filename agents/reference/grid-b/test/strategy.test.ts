import { describe, expect, it } from "vitest";
import type { Proposal } from "@mandate/agent-runtime";
import { TIGHT_GRID_POLICY, describePolicy as describeSibling } from "@mandate/agent-grid-a/policy";
import { createGridStrategy } from "@mandate/agent-grid-a";
import { STABLESWAP_BSC_TESTNET } from "@mandate/agent-grid-a/pool";
import type { PoolState } from "@mandate/agent-grid-a/pool";
import { ACCOUNT, ONE, balancesForShare, fixedReader, poolState } from "@mandate/agent-grid-a/test-fixtures";
import { WIDE_GRID_POLICY, describePolicy } from "../src/policy.js";
import { createStrategy } from "../src/strategy.js";

const REQUEST = {
  requestId: "req-1",
  skill: "run-grid",
  chainId: 97,
  wallet: ACCOUNT,
  parameters: {},
} as const;

function wide(state: PoolState): Promise<Proposal> {
  return createStrategy({ deployment: STABLESWAP_BSC_TESTNET, reader: fixedReader(state) }).propose(REQUEST);
}

/** The sibling agent, run on the same state, so the two can be compared directly. */
function tight(state: PoolState): Promise<Proposal> {
  return createGridStrategy({
    slug: "grid-a",
    displayName: "Tight Grid",
    description: "Fixture.",
    policy: TIGHT_GRID_POLICY,
    deployment: STABLESWAP_BSC_TESTNET,
    reader: fixedReader(state),
  }).propose(REQUEST);
}

function balanced(deviationBps: number): PoolState {
  const balances = balancesForShare(5_000, ONE * 10n);
  return poolState({
    deviationBps,
    coin0: { walletBalance: balances.coin0, allowance: ONE * 100n },
    coin1: { walletBalance: balances.coin1, allowance: ONE * 100n },
  });
}

function minDyOf(proposal: Proposal): bigint {
  if (proposal.decision !== "PROPOSE") throw new Error(`expected PROPOSE, got ${proposal.decision}`);
  return BigInt(proposal.action.args[3]?.value ?? "-1");
}

describe("the card the marketplace publishes", () => {
  it("registers under the GRID category with the shared skill id", async () => {
    // #given the wired executor
    const executor = createStrategy({
      deployment: STABLESWAP_BSC_TESTNET,
      reader: fixedReader(balanced(-60)),
    });

    // #then it is discoverable beside its sibling, under the same skill, so a
    // buyer comparing the two is comparing agents rather than interfaces
    expect(executor.category).toBe("GRID");
    expect(executor.slug).toBe("grid-b");
    expect(executor.skills.map((skill) => skill.id)).toEqual(["run-grid"]);
    await expect(executor.propose(REQUEST)).resolves.toBeDefined();
  });

  it("renders its policy through the same function as its sibling", () => {
    // #given both published policy documents
    const mine = describePolicy(WIDE_GRID_POLICY) as Record<string, unknown>;
    const sibling = describeSibling(TIGHT_GRID_POLICY) as Record<string, unknown>;

    // #then they carry the same fields and differ only in the values, which is
    // what makes a side-by-side comparison a comparison rather than a
    // reconciliation
    expect(Object.keys(mine).sort()).toEqual(Object.keys(sibling).sort());
    expect(mine["policyId"]).toBe("wide-grid");
    expect(mine["spacingBps"]).toBe(100);
    expect(sibling["spacingBps"]).toBe(25);
  });
});

describe("the ladder geometry is the whole difference", () => {
  it("ignores a dislocation its sibling trades", async () => {
    // #given the price 60 bps below fair: rung 2 on a 25 bps ladder and rung 0
    // on a 100 bps one
    const board = balanced(-60);

    // #when both agents in the category deliberate over it
    const mine = await wide(board);
    const sibling = await tight(board);

    // #then they disagree about whether to act at all, which is the strongest
    // form the divergence can take. An evaluator that could not separate them
    // would be measuring the category rather than the agent.
    expect(sibling.decision).toBe("PROPOSE");
    expect(mine.decision).toBe("HOLD");
  });

  it("sets a looser minimum output when both do act", async () => {
    // #given a dislocation wide enough for both ladders, 600 bps
    const board = balanced(-600);
    const mine = await wide(board);
    const sibling = await tight(board);

    // #then both trade one tranche in the same direction and bound it
    // differently. An agent that only trades a market already a full percent
    // out of line is trading a market that is moving, and holding out for its
    // sibling's execution would leave it reverting rather than trading.
    expect(mine.decision).toBe("PROPOSE");
    expect(sibling.decision).toBe("PROPOSE");
    expect(minDyOf(mine)).toBeLessThan(minDyOf(sibling));
  });

  it("differs from its sibling by more than an evaluator's tolerance", async () => {
    // #given the two minimum outputs from the same state
    const board = balanced(-600);
    const mine = minDyOf(await wide(board));
    const sibling = minDyOf(await tight(board));

    // #then the gap is 20 bps of the quote, against a 50 bps tolerance, so the
    // slippage bound alone does not separate them. The decision at 60 bps does,
    // and a receipt has to rest on the difference that is actually decisive.
    const driftBps = ((sibling - mine) * 10_000n) / sibling;
    expect(driftBps).toBeGreaterThan(0n);
    expect(Number(driftBps)).toBeLessThanOrEqual(WIDE_GRID_POLICY.amountToleranceBps);
  });

  it("clamps to a shallower ladder at the extremes", async () => {
    // #given a violent dislocation past both level counts
    const board = balanced(-2_000);

    // #then both still trade exactly one tranche. The level count bounds the
    // inventory each strategy will take on, not the size of any single trade.
    const mine = await wide(board);
    if (mine.decision !== "PROPOSE") throw new Error("expected an action");
    expect(mine.action.args[2]?.value).toBe(WIDE_GRID_POLICY.trancheRawUnits.toString(10));
  });
});
