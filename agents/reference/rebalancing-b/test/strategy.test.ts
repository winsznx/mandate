import { describe, expect, it } from "vitest";
import type { Proposal } from "@mandate/agent-runtime";
import { createRebalancingStrategy } from "@mandate/agent-rebalancing-a";
import {
  NARROW_BAND_ALLOCATOR_POLICY,
  describePolicy as describeSibling,
} from "@mandate/agent-rebalancing-a/policy";
import { VENUS_ALLOCATION_BSC_TESTNET } from "@mandate/agent-rebalancing-a/venus";
import type { AllocationAccountState } from "@mandate/agent-rebalancing-a/venus";
import {
  ACCOUNT,
  VUSDC,
  boundaryBoard,
  driftedBoard,
  fixedReader,
  starvedBoard,
} from "@mandate/agent-rebalancing-a/test-fixtures";
import { WIDE_BAND_ALLOCATOR_POLICY, describePolicy } from "../src/policy.js";
import { createStrategy } from "../src/strategy.js";

const REQUEST = {
  requestId: "req-1",
  skill: "rebalance-allocation",
  chainId: 97,
  wallet: ACCOUNT,
  parameters: {},
} as const;

function wideBand(state: AllocationAccountState): Promise<Proposal> {
  return createStrategy({
    deployment: VENUS_ALLOCATION_BSC_TESTNET,
    reader: fixedReader(state),
  }).propose(REQUEST);
}

/** The sibling agent, run on the same state, so the two can be compared directly. */
function narrowBand(state: AllocationAccountState): Promise<Proposal> {
  return createRebalancingStrategy({
    slug: "rebalancing-a",
    displayName: "Narrow Band Allocator",
    description: "Fixture.",
    policy: NARROW_BAND_ALLOCATOR_POLICY,
    deployment: VENUS_ALLOCATION_BSC_TESTNET,
    reader: fixedReader(state),
  }).propose(REQUEST);
}

function amountOf(proposal: Proposal): bigint {
  if (proposal.decision !== "PROPOSE") throw new Error(`expected PROPOSE, got ${proposal.decision}`);
  return BigInt(proposal.action.args[0]?.value ?? "-1");
}

describe("the card the marketplace publishes", () => {
  it("registers under the REBALANCING category with the shared skill id", async () => {
    // #given the wired executor
    const executor = createStrategy({
      deployment: VENUS_ALLOCATION_BSC_TESTNET,
      reader: fixedReader(driftedBoard()),
    });

    // #then it is discoverable beside its sibling, under the same skill, so a
    // buyer comparing the two is comparing agents rather than interfaces
    expect(executor.category).toBe("REBALANCING");
    expect(executor.slug).toBe("rebalancing-b");
    expect(executor.skills.map((skill) => skill.id)).toEqual(["rebalance-allocation"]);
    await expect(executor.propose(REQUEST)).resolves.toBeDefined();
  });

  it("renders its policy through the same function as its sibling", () => {
    // #given both published policy documents
    const mine = describePolicy(WIDE_BAND_ALLOCATOR_POLICY) as Record<string, unknown>;
    const sibling = describeSibling(NARROW_BAND_ALLOCATOR_POLICY) as Record<string, unknown>;

    // #then they carry the same fields and the same destination, and differ
    // only in the band, which is what makes a side-by-side comparison a
    // comparison rather than a reconciliation
    expect(Object.keys(mine).sort()).toEqual(Object.keys(sibling).sort());
    expect(mine["targets"]).toEqual(sibling["targets"]);
    expect(mine["policyId"]).toBe("wide-band-allocator");
    expect(mine["driftTriggerBps"]).toBe(600);
    expect(sibling["driftTriggerBps"]).toBe(100);
  });
});

describe("the band is the whole difference", () => {
  it("holds a portfolio its sibling corrects", async () => {
    // #given a $1000 book whose USDC leg is exactly $10 — 100 bps — short
    const state = boundaryBoard();

    // #when both agents in the category deliberate over it
    const mine = await wideBand(state);
    const sibling = await narrowBand(state);

    // #then they diverge on the decision itself and not merely on the size. An
    // evaluator holding one policy cannot certify an agent that ran the other,
    // which is what makes a receipt a statement about an agent rather than
    // about its category.
    expect(sibling.decision).toBe("PROPOSE");
    expect(mine.decision).toBe("HOLD");
  });

  it("diverges by more than any tolerance could absorb", async () => {
    // #given the same board
    const state = boundaryBoard();
    const mine = await wideBand(state);
    const sibling = await narrowBand(state);

    // #then one agent moves $10 of capital and the other moves nothing. A
    // decision difference is not a size within tolerance — there is no size on
    // this side of it — so no `amountToleranceBps` can make the two agree.
    expect(amountOf(sibling)).toBe(10_000_000n);
    expect(mine.decision).not.toBe("PROPOSE");
    expect(WIDE_BAND_ALLOCATOR_POLICY.amountToleranceBps).toBe(50);
  });

  it("says which band held it, so the hold is legible rather than silent", async () => {
    // #given the same board
    const proposal = await wideBand(boundaryBoard());

    // #then the rationale names the 600 bps band. Two agents that both hold for
    // different reasons must not produce the same artifact.
    if (proposal.decision !== "HOLD") throw new Error("expected a hold");
    expect(proposal.rationale).toMatch(/inside the 600 bps band/);
  });

  it("agrees with its sibling once the drift is past both bands", async () => {
    // #given a book 4000 bps out of balance, which is outside either band
    const state = driftedBoard();

    // #when both deliberate
    const mine = await wideBand(state);
    const sibling = await narrowBand(state);

    // #then they propose the same call. The band decides whether to act; it
    // does not decide how much, so a wider band is a less twitchy agent rather
    // than a different strategy.
    if (mine.decision !== "PROPOSE" || sibling.decision !== "PROPOSE") {
      throw new Error("expected both agents to act");
    }
    expect(mine.action.target).toBe(VUSDC);
    expect(amountOf(mine)).toBe(amountOf(sibling));
  });
});

describe("the top-up-only limitation is inherited, not re-argued", () => {
  it("names redeemUnderlying when only a withdrawal would close the gap", async () => {
    // #given $900 of USDT against $100 of USDC with no idle capital
    const proposal = await wideBand(starvedBoard());

    // #then this agent refuses in the same terms its sibling does. The
    // limitation belongs to the authority, not to the band.
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/redeemUnderlying\(uint256\)/);
    expect(proposal.rationale).toMatch(/health factor/);
  });
});
