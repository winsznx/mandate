import { describe, expect, it } from "vitest";
import type { AgentExecutor, Proposal } from "@mandate/agent-runtime";
import type { Address } from "viem";
import {
  NARROW_BAND_ALLOCATOR_POLICY,
  createRebalancingPolicy,
  describePolicy,
} from "../src/policy.js";
import { createRebalancingStrategy } from "../src/strategy.js";
import { MINT_SELECTOR, VENUS_ALLOCATION_BSC_TESTNET } from "../src/venus/index.js";
import type { AllocationAccountState } from "../src/venus/reader.js";
import {
  ACCOUNT,
  BLOCK,
  USDC,
  USDC_PRICE_6DP,
  VBUSD,
  VUSDC,
  boundaryBoard,
  driftedBoard,
  fixedReader,
  insideBandBoard,
  market,
  position,
  retiredBusd,
  starvedBoard,
  state,
  usdtMarket,
} from "./fixtures.js";

const REQUEST = {
  requestId: "req-1",
  skill: "rebalance-allocation",
  chainId: 97,
  wallet: ACCOUNT,
  parameters: {},
} as const;

function strategy(accountState: AllocationAccountState): AgentExecutor {
  return createRebalancingStrategy({
    slug: "rebalancing-a",
    displayName: "Narrow Band Allocator",
    description: "Fixture.",
    policy: NARROW_BAND_ALLOCATOR_POLICY,
    deployment: VENUS_ALLOCATION_BSC_TESTNET,
    reader: fixedReader(accountState),
  });
}

function propose(accountState: AllocationAccountState): Promise<Proposal> {
  return strategy(accountState).propose(REQUEST);
}

function amountOf(proposal: Proposal): bigint {
  if (proposal.decision !== "PROPOSE") throw new Error(`expected PROPOSE, got ${proposal.decision}`);
  return BigInt(proposal.action.args[0]?.value ?? "-1");
}

function rationaleOf(proposal: Proposal): string {
  return proposal.decision === "HOLD" ? proposal.rationale : proposal.action.rationale;
}

describe("the card the marketplace publishes", () => {
  it("registers under the REBALANCING category with the skill a trial harness calls", () => {
    // #given the wired executor
    const executor = strategy(driftedBoard());

    // #then it is discoverable in the right category, under the id the adapter routes on
    expect(executor.category).toBe("REBALANCING");
    expect(executor.slug).toBe("rebalancing-a");
    expect(executor.skills.map((skill) => skill.id)).toEqual(["rebalance-allocation"]);
  });

  it("publishes the allocation it holds, not only the band it holds it to", () => {
    // #given the published policy document
    const published = describePolicy(NARROW_BAND_ALLOCATOR_POLICY) as Record<string, unknown>;

    // #then a buyer can read the destination as well as the tolerance.
    // "Rebalanced" says nothing without saying rebalanced towards what.
    expect(published["policyId"]).toBe("narrow-band-allocator");
    expect(published["driftTriggerBps"]).toBe(100);
    expect(published["targets"]).toEqual([
      { vToken: "0xb7526572ffe56ab9d7489838bf2e18e3323b441a", weightBps: 5_000 },
      { vToken: "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7", weightBps: 5_000 },
    ]);
  });

  it("publishes the action by signature and the action it is missing", () => {
    // #given the published policy document
    const published = describePolicy(NARROW_BAND_ALLOCATOR_POLICY) as Record<string, unknown>;

    // #then a reader can tell mint(uint256) from mintBehalf(address,uint256),
    // and can see that this agent only ever adds to the under-weight side
    expect(published["action"]).toBe("mint(uint256)");
    expect(published["rebalanceDirection"]).toBe("top-up only");
    expect(published["withheldAction"]).toBe("redeemUnderlying(uint256)");
  });

  it("refuses to construct a policy whose weights do not describe a whole portfolio", () => {
    // #given weights summing to 9000 bps
    // #then construction fails. Every market's dollar target is a share of one
    // total, so a short book leaves a tenth of it with no home and every market
    // permanently at target — a failure that looks exactly like working.
    expect(() =>
      createRebalancingPolicy({
        ...NARROW_BAND_ALLOCATOR_POLICY,
        policyId: "broken-allocator",
        targets: [
          { vToken: VUSDC, weightBps: 4_000 },
          { vToken: VBUSD, weightBps: 5_000 },
        ],
      }),
    ).toThrow(/9000 bps/);
  });
});

describe("correcting a portfolio that has drifted", () => {
  it("proposes a mint into the most under-weight market", async () => {
    // #given $700 of USDT supplied against $100 of USDC and $200 idle USDC,
    // which is a $1000 book 4000 bps away from its equal-weight target
    const proposal = await propose(driftedBoard());

    // #then the capital goes to USDC through mint(uint256), sized by the idle
    // balance because the $400 gap is larger than the cash available to close it
    expect(proposal.decision).toBe("PROPOSE");
    if (proposal.decision !== "PROPOSE") return;
    expect(proposal.action.target).toBe(VUSDC);
    expect(proposal.action.selector).toBe(MINT_SELECTOR);
    expect(proposal.action.args).toEqual([{ type: "uint256", value: "200000000" }]);
  });

  it("proposes one argument and nothing that names a recipient", async () => {
    // #given any state that produces an action
    const proposal = await propose(driftedBoard());

    // #then the calldata is a selector and a size. There is no address in it to
    // constrain, which is the whole reason this action is grantable under
    // (target, selector, spend cap) permissions with no guard.
    if (proposal.decision !== "PROPOSE") throw new Error("expected an action");
    expect(proposal.action.args).toHaveLength(1);
    expect(proposal.action.args.every((argument) => argument.type === "uint256")).toBe(true);
  });

  it("measures weights in dollars rather than in token units", async () => {
    // #given 1000 units supplied on each side: 1000 USDT is $500 at fifty cents
    // and 1000 USDC is $1000, so a portfolio that looks balanced in tokens is
    // two thirds USDC in dollars
    const proposal = await propose(
      position({ supplied: 1_000_000_000n, idle: 100_000_000n }, { supplied: 1_000_000_000n, idle: 0n }),
    );

    // #then USDT is the under-weight side. An agent counting tokens would see
    // parity here and hold.
    if (proposal.decision !== "PROPOSE") throw new Error("expected an action");
    expect(proposal.action.target).toBe("0xb7526572ffe56ab9d7489838bf2e18e3323b441a");
  });

  it("records the block it reasoned about, so a trial can check its freshness", async () => {
    // #given any deliberation
    const proposal = await propose(driftedBoard());

    // #then the observation names the block. A weight is a ratio between
    // markets, so an answer assembled from two blocks describes a portfolio
    // that never existed.
    const observations = proposal.observations as Record<string, unknown>;
    expect(observations["blockNumber"]).toBe(BLOCK.toString(10));
  });
});

describe("the drift trigger is exact at its boundary", () => {
  it("acts on a market exactly one trigger-width short of its target", async () => {
    // #given $495 USDT supplied, $490 USDC supplied and $15 USDC idle: a $1000
    // book whose USDC leg is $10 short, which is exactly 100 bps
    const proposal = await propose(boundaryBoard());

    // #then the comparison is inclusive at the line. A policy that says "act at
    // 100 bps" has to act at 100 bps, or the published number is not the number
    // the agent uses.
    expect(proposal.decision).toBe("PROPOSE");
    expect(amountOf(proposal)).toBe(10_000_000n);
  });

  it("holds one base unit inside the band", async () => {
    // #given the same board with one more base unit of USDC supplied
    const proposal = await propose(insideBandBoard());

    // #then it holds. The predicate is cross-multiplied and divides by nothing,
    // so the line falls between two adjacent readings rather than somewhere
    // inside the gap between them.
    expect(proposal.decision).toBe("HOLD");
    expect(rationaleOf(proposal)).toMatch(/inside the 100 bps band/);
  });
});

describe("the half of a rebalance this authority does not carry", () => {
  it("holds and names redeemUnderlying when only a withdrawal would close the gap", async () => {
    // #given $900 of USDT against $100 of USDC and no idle capital anywhere
    const proposal = await propose(starvedBoard());

    // #then it refuses and says which function it would need. Reporting a
    // balanced portfolio it did not achieve, or proposing a call it cannot be
    // granted, would both be worse than naming the half of the job it has.
    expect(proposal.decision).toBe("HOLD");
    const rationale = rationaleOf(proposal);
    expect(rationale).toMatch(/redeemUnderlying\(uint256\)/);
    expect(rationale).toMatch(/health factor/);
    expect(rationale).toMatch(/top-up only/);
  });

  it("never proposes into a market with mint paused, even holding its token", async () => {
    // #given 1000 BUSD idle on the retired market — listed, priced, mint paused,
    // supply cap zero, exactly as chain 97 holds it — beside a drifted book
    const withRetiredHoldings = position(
      { supplied: 1_400_000_000n, idle: 0n },
      { supplied: 100_000_000n, idle: 200_000_000n },
      1_000n * 10n ** 18n,
    );
    const proposal = await propose(withRetiredHoldings);

    // #then the capital goes to USDC and never to vBUSD, whose mint would revert
    if (proposal.decision !== "PROPOSE") throw new Error("expected an action");
    expect(proposal.action.target).toBe(VUSDC);
    expect(proposal.action.target).not.toBe(VBUSD);
  });

  it("counts idle capital in a market it cannot act on toward the portfolio total", async () => {
    // #given the same book with and without 1000 BUSD sitting idle
    const without = await propose(driftedBoard());
    const withBusd = await propose(
      position(
        { supplied: 1_400_000_000n, idle: 0n },
        { supplied: 100_000_000n, idle: 200_000_000n },
        1_000n * 10n ** 18n,
      ),
    );

    // #then the BUSD widens the denominator every weight is measured against.
    // Leaving un-targeted markets out would let an account hold most of its
    // value in BUSD while both named markets reported perfect balance.
    const before = (without.observations as Record<string, string>)["portfolioUsdMantissa"];
    const after = (withBusd.observations as Record<string, string>)["portfolioUsdMantissa"];
    expect(BigInt(after ?? "0")).toBeGreaterThan(BigInt(before ?? "0"));
  });

  it("holds when the most under-weight market has mint paused", async () => {
    // #given a book 4000 bps out of balance whose under-weight side is paused,
    // with $200 of idle USDC ready to deploy into it
    const paused = position(
      { supplied: 1_400_000_000n, idle: 0n },
      { supplied: 100_000_000n, idle: 200_000_000n, mintPaused: true },
    );
    const proposal = await propose(paused);

    // #then it holds rather than topping up the second-worst market. A proposal
    // that silently substitutes a different market is one a reader has to
    // reverse-engineer from the numbers.
    expect(proposal.decision).toBe("HOLD");
    expect(rationaleOf(proposal)).toMatch(/mint paused/);
  });
});

describe("sizing the top-up down to what is permitted", () => {
  it("sizes down to the allowance the admin key granted", async () => {
    // #given $200 of idle USDC against a $400 gap, with only 50 USDC approved
    const limited = position(
      { supplied: 1_400_000_000n, idle: 0n },
      { supplied: 100_000_000n, idle: 200_000_000n, allowance: 50_000_000n },
    );

    // #then the proposal stays inside what the account will actually let the
    // vToken pull. The session cannot grant this approval; only the admin key can.
    expect(amountOf(await propose(limited))).toBe(50_000_000n);
  });

  it("sizes down to the market's remaining supply cap", async () => {
    // #given a market holding 10000 units under a cap that leaves room for 40
    const capped = position(
      { supplied: 1_400_000_000n, idle: 0n },
      {
        supplied: 100_000_000n,
        idle: 200_000_000n,
        marketSupplied: 10_000_000_000n,
        supplyCapRaw: 10_040_000_000n,
      },
    );

    // #then it asks for the headroom rather than the balance. A proposal above
    // the cap is not a bolder correction, it is a call that reverts.
    expect(amountOf(await propose(capped))).toBe(40_000_000n);
  });

  it("holds when the largest permitted top-up is below the minimum size floor", async () => {
    // #given a $1000 book — $515 USDT, $480 USDC, $5 idle USDC — whose USDC leg
    // is $20 short of its $500 target and has only $5 of cash behind it
    const dust = position(
      { supplied: 1_030_000_000n, idle: 0n },
      { supplied: 480_000_000n, idle: 5_000_000n },
    );
    const proposal = await propose(dust);

    // #then the transaction is not worth making, and it says so in dollars
    expect(proposal.decision).toBe("HOLD");
    expect(rationaleOf(proposal)).toMatch(/below the 10\.00 USD floor/);
  });

  it("holds when there is nothing supplied and nothing idle", async () => {
    // #given an empty account
    const proposal = await propose(position({ supplied: 0n, idle: 0n }, { supplied: 0n, idle: 0n }));

    // #then there is no allocation to hold, and it says so rather than
    // proposing a zero-sized mint
    expect(proposal.decision).toBe("HOLD");
    expect(rationaleOf(proposal)).toMatch(/no allocation to hold/);
  });
});

describe("refusing on state it could not reconstruct", () => {
  it("holds when a market's implementation has moved off the pin", async () => {
    // #given a vToken whose delegator now points at different code
    const moved = state([
      usdtMarket({ supplied: 1_400_000_000n, idle: 0n }),
      market({
        vToken: VUSDC,
        underlying: USDC,
        symbol: "USDC",
        underlyingDecimals: 6,
        priceMantissa: USDC_PRICE_6DP,
        supplied: 100_000_000n,
        idle: 200_000_000n,
        implementation: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Address,
      }),
      retiredBusd(),
    ]);

    // #then it refuses. "Bounded by target and selector" is only as strong as
    // the governance timelock that can replace the code behind the proxy.
    const proposal = await propose(moved);
    expect(proposal.decision).toBe("HOLD");
    expect(rationaleOf(proposal)).toMatch(/implementation has moved/);
  });

  it("holds when any market could not be fully read", async () => {
    // #given one market whose reads failed, alongside two good ones
    const partial = state([
      usdtMarket({ supplied: 1_400_000_000n, idle: 0n }),
      market({
        vToken: VUSDC,
        underlying: USDC,
        symbol: "USDC",
        underlyingDecimals: 6,
        priceMantissa: USDC_PRICE_6DP,
        supplied: 100_000_000n,
        idle: 200_000_000n,
        unreadableReason: "vToken.balanceOf(): connection reset",
      }),
      retiredBusd(),
    ]);

    // #then it refuses rather than weighing the markets it could read. A
    // position defaulted to zero reads as maximally under-weight, so an
    // unreadable market would not be ignored — it would be the one it chose.
    const proposal = await propose(partial);
    expect(proposal.decision).toBe("HOLD");
    expect(rationaleOf(proposal)).toMatch(/could not be read/);
  });

  it("holds when a token reports different decimals than it was configured with", async () => {
    // #given USDC configured at 6 decimals but reporting 18
    const misdeclared = state([
      usdtMarket({ supplied: 1_400_000_000n, idle: 0n }),
      market({
        vToken: VUSDC,
        underlying: USDC,
        symbol: "USDC",
        underlyingDecimals: 6,
        reportedDecimals: 18,
        priceMantissa: USDC_PRICE_6DP,
        supplied: 100_000_000n,
        idle: 200_000_000n,
      }),
      retiredBusd(),
    ]);

    // #then it refuses. The oracle scale is 1e(36 - decimals), so one wrong
    // market makes every other market's weight wrong too — they all share a
    // denominator.
    const proposal = await propose(misdeclared);
    expect(proposal.decision).toBe("HOLD");
    expect(rationaleOf(proposal)).toMatch(/different decimals/);
  });

  it("holds when an oracle price cannot be right for the decimals it was read with", async () => {
    // #given a 6-decimal token quoted at the 18-decimal scale, which is the
    // exact shape of the testnet decimal trap
    const mispriced = state([
      usdtMarket({ supplied: 1_400_000_000n, idle: 0n }),
      market({
        vToken: VUSDC,
        underlying: USDC,
        symbol: "USDC",
        underlyingDecimals: 6,
        priceMantissa: 10n ** 18n,
        supplied: 100_000_000n,
        idle: 200_000_000n,
      }),
      retiredBusd(),
    ]);

    // #then it refuses rather than sizing a correction against a price that
    // implies the token is worth a millionth of a cent
    const proposal = await propose(mispriced);
    expect(proposal.decision).toBe("HOLD");
    expect(rationaleOf(proposal)).toMatch(/not consistent with its decimals/);
  });
});

describe("the executor never executes", () => {
  it("returns a proposal and touches no signer", async () => {
    // #given the executor's whole public surface
    const executor = strategy(driftedBoard());
    await expect(executor.propose(REQUEST)).resolves.toBeDefined();

    // #then the only method that acts is `propose`, and what it returns is a
    // description of a call rather than a call. The deterministic layer decides
    // whether it is permitted; nothing an agent returns can widen its authority.
    expect(
      Object.keys(executor).filter((key) => typeof (executor as Record<string, unknown>)[key] === "function"),
    ).toEqual(["propose"]);
  });
});
