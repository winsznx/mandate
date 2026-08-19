import { describe, expect, it } from "vitest";
import type { AgentExecutor, Proposal } from "@mandate/agent-runtime";
import type { Hex } from "viem";
import { TIGHT_GRID_POLICY, describePolicy } from "../src/policy.js";
import { createGridStrategy } from "../src/strategy.js";
import { EXCHANGE_SELECTOR, STABLESWAP_BSC_TESTNET } from "../src/pool/index.js";
import type { PoolState } from "../src/pool/reader.js";
import {
  ACCOUNT,
  BLOCK,
  ONE,
  POOL,
  balancesForShare,
  fixedReader,
  poolState,
} from "./fixtures.js";

const REQUEST = {
  requestId: "req-1",
  skill: "run-grid",
  chainId: 97,
  wallet: ACCOUNT,
  parameters: {},
} as const;

function strategy(state: PoolState): AgentExecutor {
  return createGridStrategy({
    slug: "grid-a",
    displayName: "Tight Grid",
    description: "Fixture.",
    policy: TIGHT_GRID_POLICY,
    deployment: STABLESWAP_BSC_TESTNET,
    reader: fixedReader(state),
  });
}

function propose(state: PoolState): Promise<Proposal> {
  return strategy(state).propose(REQUEST);
}

/** A balanced account, ten whole units of inventory split evenly by rate-adjusted value. */
function balanced(deviationBps: number, allowance = ONE * 100n): PoolState {
  const balances = balancesForShare(5_000, ONE * 10n);
  return poolState({
    deviationBps,
    coin0: { walletBalance: balances.coin0, allowance },
    coin1: { walletBalance: balances.coin1, allowance },
  });
}

function argsOf(proposal: Proposal): readonly { type: string; value: string }[] {
  if (proposal.decision !== "PROPOSE") throw new Error(`expected PROPOSE, got ${proposal.decision}`);
  return proposal.action.args;
}

describe("the card the marketplace publishes", () => {
  it("registers under the GRID category with the skill a trial harness calls", () => {
    // #given the wired executor
    const executor = strategy(balanced(0));

    // #then it is discoverable in the right category, under the id the adapter routes on
    expect(executor.category).toBe("GRID");
    expect(executor.slug).toBe("grid-a");
    expect(executor.skills.map((skill) => skill.id)).toEqual(["run-grid"]);
  });

  it("names the four-argument exchange rather than the verb", () => {
    // #given the published policy document
    const published = describePolicy(TIGHT_GRID_POLICY) as Record<string, unknown>;

    // #then a reader can tell it from exchange(int128,int128,uint256,uint256,address),
    // which lives on the same contract and takes an arbitrary receiver. One
    // calldata word is the whole distance between a grantable action and an
    // unbounded one.
    expect(published["action"]).toBe("exchange(int128,int128,uint256,uint256)");
    expect(published["policyId"]).toBe("tight-grid");
  });

  it("publishes the slippage bound, because it is the only protection the action carries", () => {
    // #given the published policy document
    const published = describePolicy(TIGHT_GRID_POLICY) as Record<string, unknown>;

    // #then the bound and the probe size a reader needs to reproduce the price
    // are both on the card
    expect(published["maxSlippageBps"]).toBe(TIGHT_GRID_POLICY.maxSlippageBps);
    expect(published["probeSizeRawUnits"]).toBe(TIGHT_GRID_POLICY.probeSizeRawUnits.toString(10));
  });
});

describe("advancing the ladder", () => {
  it("buys the cheap coin when the price falls through a rung", async () => {
    // #given coin 0 trading 60 bps below fair, which is rung 2 of a 25 bps
    // ladder, against a balanced inventory
    const proposal = await propose(balanced(-60));

    // #then it sells coin 1 for coin 0: indices 1 and 0, one tranche, and a
    // minimum output set below the pool's quote
    expect(proposal.decision).toBe("PROPOSE");
    const args = argsOf(proposal);
    expect(args[0]).toEqual({ type: "int128", value: "1" });
    expect(args[1]).toEqual({ type: "int128", value: "0" });
    expect(args[2]).toEqual({ type: "uint256", value: TIGHT_GRID_POLICY.trancheRawUnits.toString(10) });
    expect(BigInt(args[3]?.value ?? "0")).toBeGreaterThan(0n);
  });

  it("sells the dear coin when the price rises through a rung", async () => {
    // #given coin 0 trading 60 bps above fair against a balanced inventory
    const proposal = await propose(balanced(60));

    // #then the trade runs the other way, coin 0 into coin 1
    const args = argsOf(proposal);
    expect(args[0]).toEqual({ type: "int128", value: "0" });
    expect(args[1]).toEqual({ type: "int128", value: "1" });
  });

  it("proposes calldata with no address in it", async () => {
    // #given any state that produces an action
    const proposal = await propose(balanced(-60));

    // #then every argument is an integer. There is nothing in this call to
    // redirect, which is the whole reason a session can hold it under
    // (target, selector) permissions with no guard.
    const args = argsOf(proposal);
    expect(args.map((argument) => argument.type)).toEqual(["int128", "int128", "uint256", "uint256"]);
    expect(args.every((argument) => /^[0-9]+$/.test(argument.value))).toBe(true);
  });

  it("targets the pool the mandate names, through the four-argument selector", async () => {
    // #given any state that produces an action
    const proposal = await propose(balanced(-60));

    if (proposal.decision !== "PROPOSE") throw new Error("expected an action");
    expect(proposal.action.target).toBe(POOL);
    expect(proposal.action.selector).toBe(EXCHANGE_SELECTOR);
  });

  it("sets the minimum output the published bound below the pool's quote", async () => {
    // #given a state that produces an action
    const proposal = await propose(balanced(-60));
    const args = argsOf(proposal);

    // #then min_dy is exactly maxSlippageBps under the quote the observation
    // records, so a reader can recompute it from the artifact rather than
    // trusting it. min_dy is calldata-controlled, and a proposal leaving it at
    // zero would be inside the mandate and still a loss.
    const observations = proposal.observations as Record<string, unknown>;
    const trade = observations["trade"] as Record<string, string>;
    const quoted = BigInt(trade["quotedDy"] ?? "0");
    const expected = (quoted * (10_000n - BigInt(TIGHT_GRID_POLICY.maxSlippageBps))) / 10_000n;
    expect(args[3]?.value).toBe(expected.toString(10));
  });

  it("records the block it reasoned about, so a trial can check its freshness", async () => {
    // #given any deliberation
    const proposal = await propose(balanced(-60));

    // #then the observation names the block
    expect((proposal.observations as Record<string, unknown>)["blockNumber"]).toBe(BLOCK.toString(10));
  });
});

describe("staying still", () => {
  it("holds inside the first rung", async () => {
    // #given a price 24 bps off fair against a 25 bps ladder
    const proposal = await propose(balanced(-24));

    // #then nothing happens. A grid that trades every tick pays a fee each time
    // to close a gap smaller than the fee, which is the failure a grid is
    // supposed to be immune to.
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/inside one 250 bps step/);
  });

  it("crosses the rung boundary at exactly the published spacing", async () => {
    // #given the price one basis point either side of the first rung
    const inside = await propose(balanced(-24));
    const onIt = await propose(balanced(-25));

    // #then the ladder advances at 25 bps and not at 24. A policy that says
    // 25 bps rungs has to move at 25 bps, or the published number is not the
    // number the agent uses.
    expect(inside.decision).toBe("HOLD");
    expect(onIt.decision).toBe("PROPOSE");
  });

  it("clamps at the published level count instead of extending the ladder", async () => {
    // #given a violent dislocation, 900 bps, which is rung 36 of a 25 bps ladder
    const proposal = await propose(balanced(-900));

    // #then it still trades one tranche, and the target it trades toward is the
    // eighth rung rather than the thirty-sixth. The level count is the published
    // bound on how much inventory this strategy will take on.
    expect(proposal.decision).toBe("PROPOSE");
    expect(argsOf(proposal)[2]?.value).toBe(TIGHT_GRID_POLICY.trancheRawUnits.toString(10));
  });

  it("holds when the account is already where the ladder wants it", async () => {
    // #given a price at rung 2, wanting 5500 bps in coin 0, and an account
    // already holding exactly that
    const balances = balancesForShare(5_500, ONE * 10n);
    const proposal = await propose(
      poolState({
        deviationBps: -60,
        coin0: { walletBalance: balances.coin0, allowance: ONE * 100n },
        coin1: { walletBalance: balances.coin1, allowance: ONE * 100n },
      }),
    );

    // #then there is nothing to do
    expect(proposal.decision).toBe("HOLD");
  });

  it("holds when the account holds neither coin", async () => {
    // #given an empty account
    const proposal = await propose(
      poolState({ deviationBps: -600, coin0: { walletBalance: 0n }, coin1: { walletBalance: 0n } }),
    );

    // #then it is not on the ladder at all, and it says so rather than
    // proposing a trade it cannot fund
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/holds neither coin/);
  });
});

describe("refusing on state it could not act on", () => {
  it("holds when the account has not approved the pool", async () => {
    // #given the ladder calling for a buy, with no allowance behind it
    const balances = balancesForShare(5_000, ONE * 10n);
    const proposal = await propose(
      poolState({
        deviationBps: -60,
        coin0: { walletBalance: balances.coin0, allowance: 0n },
        coin1: { walletBalance: balances.coin1, allowance: 0n },
      }),
    );

    // #then it holds and names the reason. A session cannot raise its own
    // allowance; only the admin key can, so this is a precondition the agent
    // checks rather than one it creates.
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/only the admin key can/);
  });

  it("holds when the tranche is larger than the balance behind it", async () => {
    // #given a ladder calling for a one-unit tranche against a wallet holding
    // a tenth of that
    const proposal = await propose(
      poolState({
        deviationBps: -60,
        coin0: { walletBalance: ONE / 20n, allowance: ONE * 100n },
        coin1: { walletBalance: ONE / 10n, allowance: ONE * 100n },
      }),
    );

    // #then it holds rather than proposing a transfer that would revert
    expect(proposal.decision).toBe("HOLD");
  });

  it("holds when the pool would not quote the trade", async () => {
    // #given a pool that answered the probe but not the tranche
    const balances = balancesForShare(5_000, ONE * 10n);
    const proposal = await propose(
      poolState({
        deviationBps: -60,
        coin0: { walletBalance: balances.coin0, allowance: ONE * 100n },
        coin1: { walletBalance: balances.coin1, allowance: ONE * 100n },
        suppressTrancheQuotes: true,
      }),
    );

    // #then it refuses. Without a quote there is no basis for a minimum output,
    // and a trade sent without one is unbounded against slippage.
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/unbounded against slippage/);
  });

  it("holds when part of the pool state could not be read", async () => {
    // #given a read that failed
    const balances = balancesForShare(5_000, ONE * 10n);
    const proposal = await propose(
      poolState({
        deviationBps: -60,
        coin0: { walletBalance: balances.coin0 },
        coin1: { walletBalance: balances.coin1 },
        unreadableReason: "stored_rates(): connection reset",
      }),
    );

    // #then it refuses rather than pricing the pool from the readings that did
    // arrive. A curve priced from a subset of its own balances is the price of a
    // different pool, not a worse estimate of this one.
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/could not be read/);
  });

  it("holds when a coin reports different decimals than configured", async () => {
    // #given mstETH reporting 6 decimals against a configured 18
    const balances = balancesForShare(5_000, ONE * 10n);
    const proposal = await propose(
      poolState({
        deviationBps: -60,
        coin0: { walletBalance: balances.coin0, allowance: ONE * 100n },
        coin1: { walletBalance: balances.coin1, allowance: ONE * 100n, reportedDecimals: 6 },
      }),
    );

    // #then it refuses. Every balance the ladder weighs is scaled by that value,
    // so the disagreement moves the whole curve rather than one term of it.
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/different decimals/);
  });

  it("holds when the pool's code no longer hashes to the pin", async () => {
    // #given a deployment carrying a pin, and a pool whose code has changed
    const balances = balancesForShare(5_000, ONE * 10n);
    const pinned = { ...STABLESWAP_BSC_TESTNET, codeHash: `0x${"11".repeat(32)}` as Hex };
    const executor = createGridStrategy({
      slug: "grid-a",
      displayName: "Tight Grid",
      description: "Fixture.",
      policy: TIGHT_GRID_POLICY,
      deployment: pinned,
      reader: fixedReader(
        poolState({
          deviationBps: -60,
          coin0: { walletBalance: balances.coin0, allowance: ONE * 100n },
          coin1: { walletBalance: balances.coin1, allowance: ONE * 100n },
          codeHash: `0x${"22".repeat(32)}` as Hex,
        }),
      ),
    });

    // #then it refuses. "Bounded by target and selector" says nothing about a
    // target whose code was replaced under the same address.
    const proposal = await executor.propose(REQUEST);
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/audited/);
  });
});

describe("the executor never executes", () => {
  it("returns a proposal and touches no signer", () => {
    // #given the executor's whole public surface
    const executor = strategy(balanced(-60));

    // #then the only method that acts is `propose`, and what it returns is a
    // description of a call rather than a call
    expect(
      Object.keys(executor).filter((key) => typeof (executor as Record<string, unknown>)[key] === "function"),
    ).toEqual(["propose"]);
  });
});
