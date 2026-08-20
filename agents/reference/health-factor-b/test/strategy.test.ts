import { describe, expect, it } from "vitest";
import type { Proposal } from "@mandate/agent-runtime";
import { createHealthFactorStrategy } from "@mandate/agent-health-factor-a";
import {
  CONSERVATIVE_GUARDIAN_POLICY,
  describePolicy as describeSibling,
} from "@mandate/agent-health-factor-a/policy";
import { MANTISSA, REPAY_BORROW_SELECTOR, VENUS_BSC_TESTNET } from "@mandate/agent-health-factor-a/venus";
import type { VenusAccountState } from "@mandate/agent-health-factor-a/venus";
import {
  ACCOUNT,
  USDC_PRICE_6DP,
  USDT_PRICE_6DP,
  VCOLLATERAL,
  account,
  fixedReader,
  market,
  position,
} from "@mandate/agent-health-factor-a/test-fixtures";
import { EFFICIENT_GUARDIAN_POLICY, describePolicy } from "../src/policy.js";
import { createStrategy } from "../src/strategy.js";

const REQUEST = {
  requestId: "req-1",
  skill: "restore-health-factor",
  chainId: 97,
  wallet: ACCOUNT,
  parameters: {},
} as const;

function efficient(state: VenusAccountState): Promise<Proposal> {
  return createStrategy({
    deployment: VENUS_BSC_TESTNET,
    reader: fixedReader(state),
  }).propose(REQUEST);
}

/** The sibling agent, run on the same state, so the two can be compared directly. */
function conservative(state: VenusAccountState): Promise<Proposal> {
  return createHealthFactorStrategy({
    slug: "health-factor-a",
    displayName: "Conservative Guardian",
    description: "Fixture.",
    policy: CONSERVATIVE_GUARDIAN_POLICY,
    deployment: VENUS_BSC_TESTNET,
    reader: fixedReader(state),
  }).propose(REQUEST);
}

function amountOf(proposal: Proposal): bigint {
  if (proposal.decision !== "PROPOSE") throw new Error(`expected PROPOSE, got ${proposal.decision}`);
  return BigInt(proposal.action.args[0]?.value ?? "-1");
}

function observationsOf(proposal: Proposal): Record<string, unknown> {
  return proposal.observations as Record<string, unknown>;
}

/**
 * $1,050 of collateral against $850 of USDC debt and 300 USDT of USDT debt at
 * fifty cents, so the health factor is 1.05 and only $150 of the liability sits
 * in the one market this agent may act on.
 *
 * The shape exists to put the authority's own limit in front of the policy's:
 * the repay the sibling needs is larger than the debt it is allowed to retire,
 * and this agent's is not.
 */
function mixedDebtBoard(): VenusAccountState {
  return account({
    markets: [
      market({
        vToken: VCOLLATERAL,
        collateralUsd: 1050,
        liquidationThresholdMantissa: MANTISSA,
        borrowBalance: 850_000_000n,
        priceMantissa: USDC_PRICE_6DP,
        underlyingDecimals: 6,
      }),
      market({
        vToken: VENUS_BSC_TESTNET.vToken,
        collateralUsd: 0,
        liquidationThresholdMantissa: (80n * MANTISSA) / 100n,
        borrowBalance: 300_000_000n,
        priceMantissa: USDT_PRICE_6DP,
        underlyingDecimals: 6,
      }),
    ],
  });
}

describe("the card the marketplace publishes", () => {
  it("registers under the HEALTH_FACTOR category with the shared skill id", async () => {
    // #given the wired executor
    const executor = createStrategy({
      deployment: VENUS_BSC_TESTNET,
      reader: fixedReader(position(1100, 2_000_000_000n)),
    });

    // #then it is discoverable beside its sibling, under the same skill, so a
    // buyer comparing the two is comparing agents rather than interfaces
    expect(executor.category).toBe("HEALTH_FACTOR");
    expect(executor.slug).toBe("health-factor-b");
    expect(executor.skills.map((skill) => skill.id)).toEqual(["restore-health-factor"]);
    await expect(executor.propose(REQUEST)).resolves.toBeDefined();
  });

  it("renders its policy through the same function as its sibling", () => {
    // #given both published policy documents
    const mine = describePolicy(EFFICIENT_GUARDIAN_POLICY) as Record<string, unknown>;
    const sibling = describeSibling(CONSERVATIVE_GUARDIAN_POLICY) as Record<string, unknown>;

    // #then they carry the same fields and differ only in the values, which is
    // what makes a side-by-side comparison a comparison rather than a
    // reconciliation
    expect(Object.keys(mine).sort()).toEqual(Object.keys(sibling).sort());
    expect(mine["policyId"]).toBe("efficient-guardian");
    expect(mine["interventionThresholdMantissa"]).toBe("1150000000000000000");
    expect(mine["targetHealthFactorMantissa"]).toBe("1200000000000000000");
    expect(sibling["interventionThresholdMantissa"]).toBe("1300000000000000000");
    expect(sibling["targetHealthFactorMantissa"]).toBe("1350000000000000000");
  });

  it("publishes the same weighting and the same action as its sibling", () => {
    // #given both published policy documents
    const mine = describePolicy(EFFICIENT_GUARDIAN_POLICY) as Record<string, unknown>;
    const sibling = describeSibling(CONSERVATIVE_GUARDIAN_POLICY) as Record<string, unknown>;

    // #then the pair differ in tolerance and in nothing else. A buyer choosing
    // between them is choosing a threshold, not a different protocol reading or
    // a different call.
    expect(mine["healthFactorSource"]).toBe(sibling["healthFactorSource"]);
    expect(mine["healthFactorWeighting"]).toBe("LIQUIDATION_THRESHOLD");
    expect(mine["action"]).toBe(sibling["action"]);
  });
});

describe("the threshold is the whole difference", () => {
  it("holds a position its sibling repairs", async () => {
    // #given $1,200 of collateral against 2,000 USDT at $0.50, so the health
    // factor is 1.20: below the sibling's 1.30 and above this agent's 1.15
    const board = position(1200, 2_000_000_000n);

    // #when both agents in the category deliberate over it
    const mine = await efficient(board);
    const sibling = await conservative(board);

    // #then they diverge on the decision itself and not merely on the size. An
    // evaluator holding one policy cannot certify an agent that ran the other,
    // which is what makes a receipt a statement about an agent rather than
    // about its category.
    expect(observationsOf(mine)["healthFactor"]).toBe("1.200000");
    expect(sibling.decision).toBe("PROPOSE");
    expect(amountOf(sibling)).toBe(222_222_223n);
    expect(mine.decision).toBe("HOLD");
  });

  it("says which threshold held it, so the hold is legible rather than silent", async () => {
    // #given the same board
    const proposal = await efficient(position(1200, 2_000_000_000n));

    // #then the rationale names 1.15. Two agents that both hold for different
    // reasons must not produce the same artifact.
    if (proposal.decision !== "HOLD") throw new Error("expected a hold");
    expect(proposal.rationale).toContain("1.150000");
    expect(proposal.rationale).toContain("at or above");
  });

  it("spends less than its sibling on a position both agents act on", async () => {
    // #given $1,100 of collateral against 2,000 USDT at $0.50, so the health
    // factor is 1.10 and both thresholds are breached
    const board = position(1100, 2_000_000_000n);

    // #when both deliberate
    const mine = await efficient(board);
    const sibling = await conservative(board);

    // #then both propose the same call on the same market and size it to their
    // own target: 166.666667 USDT to reach 1.20 against 370.370371 to reach
    // 1.35. Running closer to the line is cheaper at the moment of the
    // intervention, which is the whole trade this agent offers.
    expect(amountOf(mine)).toBe(166_666_667n);
    expect(amountOf(sibling)).toBe(370_370_371n);

    // The gap is 5,499 bps against the 50 bps an evaluator allows for rounding
    // and a block of accrued interest, so no tolerance can make the two agree.
    // An evaluator holding one agent's policy fails the other, which is the
    // property that makes a receipt a statement about an agent rather than
    // about its category.
    const gapBps = ((amountOf(sibling) - amountOf(mine)) * 10_000n) / amountOf(sibling);
    expect(gapBps).toBe(5_499n);
  });

  it("restores exactly its own target and not its sibling's", async () => {
    // #given the 1.10 board
    const proposal = await efficient(position(1100, 2_000_000_000n));
    if (proposal.decision !== "PROPOSE") throw new Error("expected an action");

    // #when the resulting position is recomputed from the proposed amount
    const observations = observationsOf(proposal);
    const repaidUsd = (amountOf(proposal) * USDT_PRICE_6DP) / MANTISSA;
    const collateral = BigInt(String(observations["weightedCollateralUsdMantissa"]));
    const borrows = BigInt(String(observations["totalBorrowUsdMantissa"]));
    const restored = (collateral * MANTISSA) / (borrows - repaidUsd);

    // #then the health factor lands on 1.20 and stops there. Repaying to the
    // sibling's 1.35 would retire debt this policy never promised to retire.
    expect(restored).toBeGreaterThanOrEqual(EFFICIENT_GUARDIAN_POLICY.targetHealthFactorMantissa);
    expect(restored).toBeLessThan(CONSERVATIVE_GUARDIAN_POLICY.targetHealthFactorMantissa);
  });
});

describe("the boundary is not itself an intervention", () => {
  it("holds when the health factor sits exactly on 1.15", async () => {
    // #given $1,150 of collateral against 2,000 USDT at $0.50, so the health
    // factor is exactly the threshold
    const proposal = await efficient(position(1150, 2_000_000_000n));

    // #then the policy acts strictly below the threshold, so the threshold
    // itself is a hold
    expect(observationsOf(proposal)["healthFactor"]).toBe("1.150000");
    expect(proposal.decision).toBe("HOLD");
  });

  it("acts one base unit of debt past it", async () => {
    // #given the same board with a single extra base unit of USDT borrowed —
    // half a millionth of a dollar, the smallest move the market can express
    const proposal = await efficient(position(1150, 2_000_000_001n));

    // #then it proposes. The boundary is a boundary rather than a band: an
    // agent that needed a margin past its published threshold before acting
    // would be running a threshold it did not publish.
    expect(observationsOf(proposal)["healthFactor"]).toBe("1.149999");
    expect(amountOf(proposal)).toBe(83_333_335n);
  });

  it("holds an account with no debt at all rather than dividing by zero", async () => {
    // #given collateral and no borrows
    const proposal = await efficient(position(5000, 0n));

    // #then there is no ratio to defend, and the observation says so instead of
    // reporting a very large number
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toContain("no outstanding Venus debt");
    expect(observationsOf(proposal)["healthFactor"]).toBe("infinite");
  });
});

describe("the tighter reconstruction tolerance follows from the thinner buffer", () => {
  it("holds a board its sibling acts on, because it cannot reproduce the collateral figure", async () => {
    // #given a position whose getAccountLiquidity overstates collateral by $17
    // against a $1,100 reconstruction, which is 152 bps of drift: inside the
    // sibling's 200 bps tolerance and outside this agent's 100 bps
    const base = position(1100, 2_000_000_000n);
    const board: VenusAccountState = { ...base, liquidityUsd: base.liquidityUsd + 17n * MANTISSA };

    // #when both deliberate
    const mine = await efficient(board);
    const sibling = await conservative(board);

    // #then the agent with less room to be wrong refuses the number, and says
    // which comparison refused it
    expect(observationsOf(mine)["reconstructionDriftBps"]).toBe(152);
    expect(sibling.decision).toBe("PROPOSE");
    expect(mine.decision).toBe("HOLD");
    if (mine.decision !== "HOLD") return;
    expect(mine.rationale).toContain("reconstruction");
    expect(mine.rationale).toContain("100 bps");
  });

  it("publishes the tolerance it actually applies", () => {
    // #given both published policy documents
    const mine = describePolicy(EFFICIENT_GUARDIAN_POLICY) as Record<string, unknown>;
    const sibling = describeSibling(CONSERVATIVE_GUARDIAN_POLICY) as Record<string, unknown>;

    // #then a reader can see that the closer agent is the stricter one about
    // the reading, which is the direction the arithmetic requires
    expect(mine["maxReconstructionDriftBps"]).toBe(100);
    expect(sibling["maxReconstructionDriftBps"]).toBe(200);
  });
});

describe("what it will not do with the authority it holds", () => {
  it("proposes only the one call the mandate can bound", async () => {
    // #given an actionable position
    const proposal = await efficient(position(1100, 2_000_000_000n));
    if (proposal.decision !== "PROPOSE") throw new Error("expected an action");

    // #then the call is repayBorrow(uint256) on the one authorised market, with
    // an amount and nothing else. An address argument would be a beneficiary,
    // and repayBorrowBehalf(address,uint256) is not boundable by target and
    // selector alone, so it is never proposed.
    expect(proposal.action.target).toBe(VENUS_BSC_TESTNET.vToken);
    expect(proposal.action.selector).toBe(REPAY_BORROW_SELECTOR);
    expect(proposal.action.args.map((argument) => argument.type)).toEqual(["uint256"]);
    expect(proposal.action.rationale).toContain("repayBorrow(uint256)");
    expect(proposal.action.rationale).not.toContain("repayBorrowBehalf");
  });

  it("never proposes more than the account owes in the market it may act on", async () => {
    // #given a board where reaching either target needs more than the $150 of
    // USDT debt the authority covers
    const board = mixedDebtBoard();

    // #when both deliberate
    const mine = await efficient(board);
    const sibling = await conservative(board);

    // #then the sibling is capped at the outstanding 300 USDT and falls short of
    // 1.35, while this agent's smaller target fits inside the same debt. Neither
    // proposes a repay the account cannot fund, because an amount above the
    // balance is an overspend the mandate would have to reject.
    expect(amountOf(sibling)).toBe(300_000_000n);
    expect(amountOf(mine)).toBe(250_000_000n);
    if (sibling.decision !== "PROPOSE") return;
    expect(sibling.action.rationale).toContain("capped at the account's own outstanding debt");
    if (mine.decision !== "PROPOSE") return;
    expect(mine.action.rationale).not.toContain("capped");
  });

  it("holds when the account owes nothing in that market at all", async () => {
    // #given a health factor of 1.00 driven entirely by debt in another market
    const board = account({
      markets: [
        market({
          vToken: VCOLLATERAL,
          collateralUsd: 1000,
          liquidationThresholdMantissa: MANTISSA,
          borrowBalance: 1_000_000_000n,
          priceMantissa: USDC_PRICE_6DP,
          underlyingDecimals: 6,
        }),
      ],
    });

    // #when asked to deliberate on a position that is one tick from liquidation
    const proposal = await efficient(board);

    // #then it does not reach for authority it was never granted. Running
    // closer to the line widens the set of positions this agent sees at risk,
    // and none of them widens what it may do about one.
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toContain("USDT debt");
  });

  it("asks for the same call twice rather than a different one", async () => {
    // #given one board deliberated over twice
    const board = position(1100, 2_000_000_000n);

    // #then the two proposals are identical. Nothing accumulates between
    // deliberations, so a harness that retries a request cannot be handed a
    // second repay it would then submit alongside the first.
    expect(await efficient(board)).toEqual(await efficient(board));
  });

  it("holds on the position its own repay produced", async () => {
    // #given the board that follows the 166.666667 USDT repay landing on the
    // 1.10 board, which is the same book at 1.20
    const settled = position(1100, 2_000_000_000n - 166_666_667n);

    // #when asked again
    const proposal = await efficient(settled);

    // #then it does not repeat the call. An agent that proposes a second repay
    // on the state its first repay created spends the user's balance twice for
    // one intervention, and the duplicate would be indistinguishable from a
    // replay in the evidence record.
    expect(observationsOf(proposal)["healthFactor"]).toBe("1.200000");
    expect(proposal.decision).toBe("HOLD");
  });

  it("holds when the vToken implementation is not the audited one", async () => {
    // #given an otherwise actionable position behind a proxy whose
    // implementation Venus governance has swapped
    const board: VenusAccountState = {
      ...position(1100, 2_000_000_000n),
      vTokenImplementation: "0xdeadbeef00000000000000000000000000000000",
    };

    // #when asked to deliberate
    const proposal = await efficient(board);

    // #then it refuses, because the authority analysis behind the policy is an
    // analysis of the bytecode that is no longer there
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toContain("implementation");
  });
});
